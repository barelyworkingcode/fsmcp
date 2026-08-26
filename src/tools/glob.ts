import * as fs from 'fs';
import * as path from 'path';
import { Glob } from 'glob';
import type { Path as GlobPath } from 'glob';
import { ToolRegistry, schema, stringProp, requireStringArg, optionalStringArg, virtualPathDescription } from '../registry';
import { textResult, errorResult, scopeViolationResult, LabelEntry, MCPCallResult, ToolContext } from '../types';
import { canonicalizePath, validatePath, NO_ALLOWED_DIRS_MESSAGE } from '../security';
import { checkPathV, decodeInboundPath, describeError, hostToVirtualOrRedact, translateResult } from '../vpath';
import { capLines, MAX_RESPONSE_BYTES } from '../limits';
import { grepBudgetMs } from './grep';

const MAX_RESULTS = 1000;

/**
 * Issue #25: `pattern` was the one path-shaped input in this server that
 * never went through `decodeInboundPath`/`checkPathV`, and `globSync`
 * ignores `cwd` completely for an absolute pattern -- so `pattern` was a
 * host-path traversal primitive that the validated `path` argument did not
 * bound. Three things came out of that, and the per-hit `validatePath`
 * filter below only ever addressed the third:
 *
 *  1. **A working host-path oracle** -- the exact capability issue #7 exists
 *     to remove. A pattern naming the grant's own real location returns
 *     hits; one character wrong returns an empty string; `?`, `*` and
 *     `[a-r]` turn that into a character-by-character search of the host's
 *     layout. Measured, on this fix's own fixture:
 *     `<grant>/**` -> `/d0/sub/file.txt`, `<grant-with-one-letter-changed>/**`
 *     -> ``, and `.../fx/[a-r]lain_root/**` vs `[s-z]lain_root/**` separates
 *     the two the same way. Output filtering cannot close this: the SIGNAL is
 *     whether the answer is empty, and filtering produces exactly that
 *     signal. (Issue #21's outbound fix widens this by one spelling on its
 *     own -- an absolute pattern naming the RESOLVED form of a symlinked
 *     grant started mapping to `/d0/...` too -- which is a second reason
 *     these two issues had to be fixed together rather than in sequence.)
 *  2. **An empty success for a location out of scope.** `{"pattern":"/etc/*"}`
 *     and `{"pattern":"../*"}` both returned `ok` with an empty string.
 *     fs_glob was the only tool here where naming somewhere outside the grant
 *     was not a refusal, and "you may not look there" and "there is nothing
 *     there" are not the same answer -- this stack's runbook says a scope
 *     violation must be an error, never an empty result.
 *  3. **An unbounded walk of the host.** A pattern rooted at
 *     `/System/Library` with a globstar in it really walks the whole of it.
 *     fsmcp is one synchronous stdio loop and relay drives one shared
 *     child, so that call head-of-line blocks every OTHER client's calls for
 *     its whole duration -- a denial of service against everyone, from one
 *     call, with no privilege.
 *
 * The rule these three collapse to: **a pattern is a pattern, not an
 * address.** The address is the `path` argument, which is already decoded
 * from the virtual space and already validated. A pattern therefore may not
 * name a location at all -- it may only describe names underneath one.
 *
 * ---
 *
 * Issue #36: **that rule was right and the way it was enforced was not.**
 * #25 enforced it with two regexes over the RAW pattern text, and `glob`
 * does not walk the raw pattern text -- it walks the component list
 * `minimatch` produces from it. Those are not the same string. `[.][.]/*`
 * and `\.\./*` both parse to the components `['..', /…/]`, identical to
 * `../*`, and neither regex sees a `..` in either spelling. Measured on the
 * merged #25 build: `../*` refused, `[.][.]/*` and `\.\./*` not refused,
 * and `[.][.]/[.][.]/[.][.]/**\/*` walked out of the grant for 44.08s
 * against a 30s budget while head-of-line blocking an unrelated client's
 * `fs_read` for 42.17s.
 *
 * Two things changed, and they are different KINDS of thing on purpose.
 *
 *  - **Containment is now structural** (`walkGuard` below). glob's own
 *    `ignore`/`childrenIgnored` hook refuses to descend into any candidate
 *    that is not inside this call's scope. That is the same question the
 *    per-hit `validatePath` filter already asked, moved from "drop it from
 *    the results" to "do not go there" -- so it holds for every spelling of
 *    every pattern, including ones nobody has thought of, and it does not
 *    depend on anyone predicting what a pattern will parse to.
 *  - **The refusal is now derived from glob's own parser** (`patternRefusal`
 *    below), not from a regex guessing at it. `new Glob(pattern).patterns`
 *    is the component list the walker will use; a `..` in it is the literal
 *    string `'..'` whatever the caller spelled it as, and an alternative
 *    that starts at the filesystem root answers `root() === '/'`. This is
 *    NOT "a third regex": it is not a rule ABOUT the parser, it is the
 *    parser's own answer, so there is nothing left to drift out of step
 *    with a version bump.
 *
 * Both, not either. The parser check is what turns an out-of-scope pattern
 * into a refusal that says so before a single syscall runs -- the walk
 * cannot do that, because a pruned candidate and an absent one are the same
 * empty answer, and #25's whole point is that an empty answer is not a
 * refusal. The hook is what makes the containment true rather than
 * predicted: if a future `glob` invents a way to climb that its Pattern API
 * does not describe, the hook still refuses to descend and the walk still
 * cannot leave the grant. Neither has earned sole trust; the per-hit
 * `validatePath` filter is still there under both.
 */

/**
 * Both pattern refusals are `scopeViolationResult`, and neither echoes the
 * pattern back.
 *
 * *Scope violation*, because that is what they are: a pattern that names a
 * location is a pattern trying to address something the `path` argument was
 * not allowed to address, and `decodeInboundPath` already classifies the
 * sibling case ("you did not name anything in fsmcp's address space") the
 * same way, on the same reasoning -- a caller that cannot spell an address
 * inside its grant is, by construction, naming something outside it. It also
 * means relay's audit can tell these apart from a tool error, which is the
 * whole point of `_meta.scope_violation`.
 *
 * *No echo*, because the refusal must be identical for every rejected
 * pattern. An echo is not a leak in itself (the caller wrote it), but a
 * refusal that varies with the input is the oracle again, one level up:
 * anything that distinguishes "refused, and by the way this part matched"
 * from "refused" is a channel. The same reasoning `decodeInboundPath` gives
 * for not echoing a rejected path argument (PR #10 review) applies verbatim.
 */
const ABSOLUTE_PATTERN_REFUSAL =
  'pattern must be relative to the directory being searched: it describes NAMES underneath that ' +
  'directory, it does not name the directory. A pattern beginning at the filesystem root (or a ' +
  'brace alternative that does) would address a host location directly, which no client of this ' +
  'server is able to do. Choose the directory with the `path` argument (`/<label>/...`) and give ' +
  '`pattern` only the part below it.';

const DOTDOT_PATTERN_REFUSAL =
  'pattern must not contain a ".." path component -- in any spelling, and including inside a ' +
  'brace alternative. A path ARGUMENT containing ".." can be resolved and checked against this ' +
  'call\'s scope; a pattern cannot, because a pattern with a wildcard in it does not resolve to ' +
  'one path -- so ".." in a pattern is refused outright rather than guessed at. Every directory ' +
  'in scope is reachable by naming it with the `path` argument (`/<label>/...`).';

/**
 * The backstop's refusal: the walk itself was steered outside this call's
 * scope, by something `patternRefusal` did not recognise as naming a
 * location. Unreachable as this file stands -- the parser check refuses
 * every component that could do it -- and deliberately kept anyway, because
 * "unreachable" here is a claim about someone else's parser, which is
 * exactly the claim issue #36 falsified. If it ever fires, the walk was
 * already stopped at the first candidate; this is what the caller is told
 * instead of a short list that reads as complete.
 */
const WALK_ESCAPED_REFUSAL =
  'pattern steered the search outside this call\'s granted scope. The search was stopped where it ' +
  'left the scope and no results from outside it were collected. A pattern describes NAMES ' +
  'underneath the directory being searched; choose the directory with the `path` argument ' +
  '(`/<label>/...`).';

/**
 * Ask `glob` what it is going to walk, and refuse the two shapes that would
 * make it walk somewhere this call may not go (issue #36).
 *
 * `new Glob(pattern, …).patterns` is the parsed pattern -- one entry per
 * brace alternative, each a linked list of components. It performs no
 * syscalls (the constructor parses and builds a `PathScurry`; nothing
 * touches the filesystem until `walkSync`), so this still runs before
 * anything reaches the disk and the refusal still cannot depend on what is
 * or is not there. It is the same class, given the same pattern and the
 * same parse-affecting options, that does the walk below; the parse is a
 * pure function of those.
 *
 * A component comes back as one of three things, and that is what makes
 * this check complete rather than conservative:
 *
 *  - **a string** -- consumed by path ARITHMETIC (`Path.resolve(p)` in
 *    glob's Processor), never matched against a directory entry. `'..'` is
 *    the string that climbs, and every spelling of it -- `..`, `[.][.]`,
 *    `\.\.`, `.[.]`, `{[.][.],sub}` -- arrives here as exactly `'..'`,
 *    because normalising them is minimatch's job and it has already done
 *    it. This is the one that had to be checked and was not.
 *  - **GLOBSTAR** -- matched against directory entries, plus one special
 *    case in glob's Processor for a `..` FOLLOWING it (`**\/../x`), where
 *    the `..` is itself a string component in this same list and is caught
 *    by the same test.
 *  - **a RegExp** -- matched against directory entries only. THIS is where
 *    #25's "readdir never reports `.` or `..`" argument is sound: a magic
 *    component really can only ever match a real entry. Its mistake was
 *    applying that to `[.][.]`, which does not stay magic -- minimatch
 *    turns a class with one static member into that member, so `[.][.]`
 *    stops being a RegExp and becomes the string `'..'` before the walker
 *    ever sees it. The premise was about `readdir`; the conclusion needed
 *    to be about the parser.
 *
 * `root()`/`isAbsolute()` answer the other half -- an alternative that
 * starts at the filesystem root -- for every spelling at once, including
 * the `{/etc,sub}/*` case that `path.isAbsolute` on the raw pattern cannot
 * see. #25 needed a second regex for that one; it does not need one now.
 *
 * What this deliberately does NOT refuse, where #25 did: a `..` that
 * minimatch has already removed. `sub/../top.txt` parses to `['top.txt']`
 * and `sub/../*` to a single magic component -- glob collapses `<literal>/..`
 * itself, before the walk, so no `..` arithmetic happens and there is
 * nothing to contain. #25 refused these on the grounds that "a pattern
 * cannot be resolved"; it turns out glob resolves exactly the unambiguous
 * prefix of it and leaves the rest (`x/**\/../y` keeps its `..` and is
 * refused). The boundary between the two is drawn by the parser rather than
 * guessed at, and it is not probeable: `sub/../top.txt` and
 * `nosuchdir/../top.txt` both walk `top.txt` and give the same answer, so
 * nothing about the host is visible across it.
 */
function patternRefusal(pattern: string, labels: LabelEntry[]): MCPCallResult | null {
  let alternatives;
  try {
    alternatives = new Glob(pattern, {}).patterns;
  } catch (err: unknown) {
    // A pattern minimatch cannot parse at all. Reported the same way a
    // throw from the walk is, and for the same reason: it is a fact about
    // the pattern the caller wrote, not about the filesystem.
    return errorResult(`glob error: ${describeError(err, labels)}`);
  }

  for (const alternative of alternatives) {
    if (alternative.isAbsolute() || alternative.root() !== '') {
      return scopeViolationResult(ABSOLUTE_PATTERN_REFUSAL);
    }
    for (let component: typeof alternative | null = alternative; component; component = component.rest()) {
      if (component.pattern() === '..') {
        return scopeViolationResult(DOTDOT_PATTERN_REFUSAL);
      }
    }
  }
  return null;
}

interface WalkGuard {
  ignored: (p: GlobPath) => boolean;
  childrenIgnored: (p: GlobPath) => boolean;
  /** True once the wall-clock budget has passed; latches. */
  outOfBudget: () => boolean;
  /** True if the walk was steered outside this call's scope. */
  escaped: () => boolean;
}

/**
 * The walk's containment and its wall-clock bound, both enforced through
 * glob's own `ignore` hook.
 *
 * **Containment** (issue #36). `ignored` is called for every candidate
 * match and `childrenIgnored` before descending into any directory, so this
 * is the point at which "do not go there" can be said at all -- and saying
 * it here rather than filtering afterwards is what makes it independent of
 * how the pattern was spelled. `childrenIgnored` prunes a subtree outright,
 * so a walk that is pointed out of the grant stops at its first candidate
 * instead of enumerating a tree and then discarding it.
 *
 * The ordinary case must stay cheap: this runs several times per match on a
 * walk that can legitimately produce a million of them, and a
 * `canonicalizePath` per candidate would put an lstat-per-component on the
 * hot path of every in-grant `**` in the deployment. So the test is
 * layered, and the layering is not a shortcut -- it is the same answer
 * reached for less:
 *
 *  - a candidate lexically under one of the roots this call is already
 *    walking is in scope, for one string compare and no syscall. The roots
 *    are `canonicalizePath`'d grant roots, so "lexically under" is a claim
 *    about a resolved path, not about the operator's spelling;
 *  - unless it is a SYMLINK, whose target is a different question and gets
 *    the real `validatePath`. glob does not follow a link during a `**`
 *    descent at all (`follow: false`), so this is the narrow case of a
 *    non-globstar pattern naming one;
 *  - a candidate that is not under any of them left by path arithmetic. It
 *    may still be inside another granted directory -- nested or
 *    differently spelled grants are ordinary here -- so `validatePath`
 *    decides, and only a "no" from that is an escape.
 *
 * `escaped` is deliberately set only in that last branch. An in-grant
 * symlink pointing out of the grant is an ordinary thing to find during an
 * ordinary walk; it is dropped, and it must not turn a correct `**\/*` into
 * a scope violation. What the flag means is "the WALK left the scope", not
 * "something out of scope was noticed".
 *
 * **The budget** (issue #25's consequence 3, repaired here). The 1000-result
 * cap bounds the OUTPUT and not the traversal, and checking the clock
 * between results does not work either: a pattern that matches nothing
 * yields nothing to check between. `ignored`/`childrenIgnored` are called as
 * the walk descends whether or not anything matches, so the deadline rides
 * on them and every remaining branch is pruned once it passes.
 *
 * Issue #36 found the hole in that: the budget covered `globSync` and
 * NOTHING AFTER IT. The per-hit `validatePath` loop is `canonicalizePath`
 * per hit -- an lstat and possibly a readlink per component -- over a list
 * with no bound of its own, so a walk that stopped at 30s spent another 14s
 * validating what it had collected (44.08s measured, against a 30s budget)
 * and then died on an EACCES from `readlink` that `canonicalizePath` let
 * escape as a throw. `outOfBudget()` is exported from the guard so the loop
 * after the walk is under the same deadline, and `canonicalizePath` no
 * longer throws for a link it cannot read (security.ts).
 */
function walkGuard(searchRoots: string[], allowedDirs: string[], deadline: number): WalkGuard {
  let expired = false;
  let escaped = false;
  const prefixes = searchRoots.map((root) => (root.endsWith(path.sep) ? root : root + path.sep));

  const outOfBudget = (): boolean => {
    if (!expired && Date.now() >= deadline) expired = true;
    return expired;
  };

  const underAWalkRoot = (full: string): boolean =>
    searchRoots.some((root, i) => full === root || full.startsWith(prefixes[i]));

  const prune = (p: GlobPath): boolean => {
    if (outOfBudget()) return true;
    const full = p.fullpath();
    if (underAWalkRoot(full)) {
      if (!p.isSymbolicLink()) return false;
      return validatePath(full, allowedDirs) !== null;
    }
    if (validatePath(full, allowedDirs) === null) return false;
    escaped = true;
    return true;
  };

  return {
    ignored: prune,
    childrenIgnored: prune,
    outOfBudget,
    escaped: () => escaped,
  };
}

export function registerGlob(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_glob',
      description:
        'Find files matching a glob pattern. The pattern is relative to the directory being searched and may not name a location: a pattern that begins at the filesystem root, or contains a ".." component in any spelling, is refused. Returns virtual paths ("/<label>/...", never a host filesystem path) sorted by modification time (newest first). Capped at 1000 results, and the walk itself is confined to the granted directories and bounded in wall-clock time.',
      inputSchema: schema(
        {
          pattern: stringProp("Glob pattern, relative to the search directory (e.g. '**/*.ts'). May not start at the filesystem root and may not contain a '..' component."),
          path: stringProp(virtualPathDescription('Optional; defaults to every directory in this call\'s granted scope.')),
        },
        ['pattern']
      ),
      // Matches file names against the local filesystem only.
      annotations: { readOnlyHint: true, openWorldHint: false },
      category: 'File System',
    },
    (args: Record<string, unknown>, ctx: ToolContext) => {
      const patternArg = requireStringArg(args, 'pattern');
      if (typeof patternArg !== 'string') return patternArg;
      const pattern = patternArg;

      // Issue #25/#36. These run FIRST -- before the `path` argument is
      // decoded, before `existsSync`, before anything reaches the
      // filesystem -- so a pattern that could name a location is refused
      // without the refusal ever depending on what is or is not on disk. A
      // check that ran after a walk, or that varied with the walk's
      // outcome, would be the oracle it is meant to close.
      if (pattern.includes('\0')) {
        // Malformed input, not a scope violation: the same clean-refusal
        // treatment `basicPathError` (security.ts) gives a NUL in a path,
        // rather than an exception thrown from inside a readdir (C6).
        return errorResult('pattern must not contain a NUL byte');
      }
      const refusal = patternRefusal(pattern, ctx.labels);
      if (refusal) return refusal;

      const pathArg = optionalStringArg(args, 'path');
      if (typeof pathArg === 'object') return pathArg; // a wrong-typed path is an MCPCallResult refusal

      // Determine search directories ("." is treated as omitted)
      let searchDirs: string[];
      if (pathArg && pathArg !== '.') {
        // Issue #7: decode the client's virtual-space address into the host
        // path checkPath (and the glob walk below) already expect -- see
        // read.ts for the full reasoning.
        const decoded = decodeInboundPath(pathArg, ctx.labels);
        if (typeof decoded !== 'string') return decoded;
        const p = decoded;
        const pathErr = checkPathV(p, ctx.allowedDirs, ctx.labels);
        if (pathErr) return pathErr;
        if (!fs.existsSync(p)) {
          return translateResult(errorResult(`directory not found: ${p}`), [p], ctx.labels);
        }
        searchDirs = [p];
      } else if (ctx.allowedDirs.length > 0) {
        searchDirs = ctx.allowedDirs.filter((d) => fs.existsSync(d));
        if (searchDirs.length === 0) return errorResult('none of the allowed directories exist');
      } else {
        // No allowed dirs configured: an absent path must resolve to the
        // (empty) scope, not to an unrestricted cwd fallback. Empty scope is
        // itself a scope refusal (C1's "no ⇒ no" row), not a different kind
        // of error, so it carries scope_violation like any other one.
        return scopeViolationResult(NO_ALLOWED_DIRS_MESSAGE);
      }

      // Issue #21: glob walks from `cwd`, and it will not walk THROUGH a
      // `cwd` that is itself a symlink. `globSync`'s default `follow: false`
      // means `**` stops dead at the granted root when the operator granted
      // a path that goes through a link (`/tmp` on macOS, a relocated home,
      // an external volume, a cloud-storage alias -- none of which an
      // operator has to have thought about), and the caller is told, on a
      // SUCCESS result, that the directory is empty. A pattern whose first
      // component is a literal (`sub/*.txt`) sidesteps the `**` walk and
      // works, which is what made this look intermittent rather than total.
      //
      // The fix is to give glob the directory as `canonicalizePath`
      // (security.ts -- the only resolver in this codebase, and the one
      // `isWithinAnyDir` already uses to decide what "inside this grant"
      // means) resolves it, so the walk starts on a real directory.
      //
      // `follow: true` is NOT the fix and was tried: it does not resolve a
      // symlinked `cwd` (verified), and it would make glob follow every
      // symlink INSIDE the tree as well -- precisely the traversal the
      // re-validation below exists to catch. Resolving the root changes
      // where the walk starts and nothing about what it is willing to walk
      // through: every symlink under the root is still un-followed, and
      // every hit still goes through the real `validatePath`.
      //
      // A directory that will not resolve at all (a symlink cycle) is
      // skipped, which is what `isWithinAnyDir` does with the same case and
      // for the same reason: it cannot contain anything, so there is nothing
      // to search. Unreachable from either branch above (the `path`-argument
      // branch already refused it via `checkPathV`, the scope branch via
      // `existsSync`), and handled rather than assumed away.
      //
      // Issue #36 gives these roots a second job: they are also what
      // `walkGuard` compares a candidate against to decide whether the walk
      // is still where it started. That works BECAUSE they are canonical --
      // a lexical compare against an operator's unresolved spelling would
      // be a different, weaker question.
      const searchRoots: string[] = [];
      for (const dir of searchDirs) {
        const real = canonicalizePath(dir);
        if (real !== null) searchRoots.push(real);
      }
      if (searchRoots.length === 0) {
        // Never an empty success: a directory that cannot be resolved is an
        // error about the directory, not an answer about its contents.
        return errorResult('search directory could not be resolved (too many levels of symbolic links, or a symbolic link this server cannot read)');
      }

      // Run glob against each directory and collect unique matches.
      //
      // Every hit is re-validated rather than trusted for being a descendant
      // of a directory that was itself validated: the pattern chooses which
      // entries are walked, so a symlink inside an allowed directory that
      // points outside it comes back as an in-scope-looking path. Measured --
      // with `link -> <outside>` inside the allowed dir, `linkdir/*` returned
      // `<allowed>/linkdir/secret.txt` and `**/*` listed a symlink-to-file
      // whose bytes live outside. fs_read of those paths is refused, so this
      // was disclosure of names rather than contents, but the scope a caller
      // is shown must be the scope they actually have. Resolving the root
      // above does not weaken this by an inch -- it is still every hit,
      // through the real, unmodified `validatePath`.
      //
      // Issue #36 adds `walkGuard` in front of this and does NOT remove it.
      // The guard is a new mechanism and this is the one that kept #25 and
      // #36 from being disclosure bugs; "now redundant" is precisely the
      // argument that left the `[.][.]` hole open, and it is the same
      // defence-in-depth call CLAUDE.md records for every other tool that
      // re-validates its own output.
      const budgetMs = grepBudgetMs();
      const guard = walkGuard(searchRoots, ctx.allowedDirs, Date.now() + budgetMs);

      const seen = new Set<string>();
      const allMatches: string[] = [];
      for (const dir of searchRoots) {
        try {
          // One budget across every search directory, not one each: the
          // hazard being bounded is how long this process is unavailable to
          // every other caller, and that does not get a fresh allowance per
          // granted root.
          const hits = new Glob(pattern, {
            cwd: dir,
            absolute: true,
            nodir: true,
            ignore: guard,
          }).walkSync();
          for (const h of hits) {
            // Issue #36: the loop AFTER the walk is under the same deadline
            // as the walk. `validatePath` is a resolve-per-component per
            // hit, and an unbounded number of hits made the budget a bound
            // on the cheaper half of the work only.
            if (guard.outOfBudget()) break;
            if (seen.has(h)) continue;
            seen.add(h);
            if (validatePath(h, ctx.allowedDirs)) continue; // resolves outside
            allMatches.push(h);
          }
        } catch (err: unknown) {
          return translateResult(
            errorResult(`glob error: ${describeError(err, ctx.labels)}`),
            [dir],
            ctx.labels
          );
        }
      }

      // Issue #36. The walk left the scope it was given, which means
      // something named a location that `patternRefusal` did not recognise
      // as one. The guard already stopped it there, so what is in
      // `allMatches` is a fragment of an answer to a question this server
      // will not answer -- a refusal, not a short success. Placed after the
      // walk because that is the only place the fact exists; the refusal
      // itself is the same words and the same `_meta.scope_violation` as
      // the checks that run before it, so the two are not distinguishable
      // by a caller probing for the difference.
      if (guard.escaped()) return scopeViolationResult(WALK_ESCAPED_REFUSAL);

      // Sort by mtime descending. Not separately budgeted: this is one
      // `statSync` per match -- cheaper than the `validatePath` above it --
      // over a list the budgeted loop above has already bounded.
      const withMtime = allMatches.map((f) => {
        try {
          return { path: f, mtime: fs.statSync(f).mtimeMs };
        } catch {
          return { path: f, mtime: 0 };
        }
      });
      withMtime.sort((a, b) => b.mtime - a.mtime);

      // Issue #7, outbound: every hit already passed validatePath above (the
      // real, unmodified security check); hostToVirtualOrRedact only decides
      // how to SHOW a path that check already accepted, and redacts rather
      // than emits one it somehow can't map -- see vpath.ts. Issue #21's
      // second half lives on the other side of this call: these hits are now
      // spelled with the RESOLVED root, and `hostToVirtual` had only the
      // operator's unresolved spelling to match against, so resolving the
      // walk without teaching the map both spellings would have turned an
      // empty answer into a page of redaction placeholders.
      //
      // Rendered before the cap is applied, not after, so issue #19's byte
      // budget measures the strings that will actually be sent rather than
      // the host paths they were built from.
      const rendered = withMtime
        .slice(0, MAX_RESULTS)
        .map((f) => hostToVirtualOrRedact(f.path, ctx.labels));

      const timedOut = guard.outOfBudget();

      // Issue #19: 1000 matches was a cap on the COUNT only, and a match is a
      // whole path -- at PATH_MAX that is a megabyte of result from a bound
      // that looks small. capLines adds the shared byte budget; the
      // "(showing X of Y matches)" wording is unchanged.
      const capped = capLines(rendered, MAX_RESULTS, allMatches.length);

      const notes: string[] = [];
      if (capped.capped) {
        const why =
          capped.reason === 'bytes'
            ? `, cut at fs_glob's ${MAX_RESPONSE_BYTES}-byte response limit`
            : '';
        notes.push(`(showing ${capped.shown} of ${capped.total} matches${why})`);
      }
      if (timedOut) {
        // Never a silent floor. An answer cut short that reads as a complete
        // one is the same failure as the empty success in #21: correct as far
        // as it goes, and indistinguishable from the truth.
        notes.push(
          `[fsmcp: the file walk was cut short after ${budgetMs}ms; these are the matches found ` +
            `before then, not every match in scope]`
        );
      }

      if (capped.shown === 0) {
        // An empty answer says which KIND of empty it is, out loud. "Nothing
        // matched" and "the walk ran out of time before it could finish" are
        // different facts about the filesystem, and a bare empty string is the
        // one output that cannot tell them apart.
        return textResult(timedOut ? notes.join('\n') : 'No matches found.');
      }

      const result = textResult(
        notes.length > 0 ? `${capped.text}\n\n${notes.join('\n')}` : capped.text
      );
      // `_meta.truncated` is for a caller that branches programmatically; the
      // notes above are for a human reader. Both, never one -- issue #11's
      // rule, applied to the two ways this result can be short of complete.
      if (capped.capped || timedOut) result._meta = { truncated: true };
      return result;
    }
  );
}
