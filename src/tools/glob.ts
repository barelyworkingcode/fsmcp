import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';
import { ToolRegistry, schema, stringProp, requireStringArg, optionalStringArg, virtualPathDescription } from '../registry';
import { textResult, errorResult, scopeViolationResult, ToolContext } from '../types';
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
 * name a location at all -- it may only describe names underneath one -- and
 * anything that could make it name a location is refused before a single
 * syscall runs.
 */

/**
 * A pattern component of `..`, in any brace alternative.
 *
 * Deliberately conservative, and deliberately not an expansion: brace
 * alternatives really can hide one (`{sub,..}/*` returned this fixture's
 * parent directory, measured), and the only exact test would be to expand
 * the braces the way `glob` does -- which means either taking a direct
 * dependency on `minimatch` (a transitive dep, not a declared one) or
 * hand-writing an expander that must agree with glob's forever. A rule that
 * has to track someone else's parser is a hole waiting for a version bump,
 * so this matches the `..` TOKEN wherever expansion could put it at a
 * component boundary: start/end of the pattern, or next to `/`, `{`, `}` or
 * `,`.
 *
 * What it over-refuses: a literal directory genuinely named `..something`
 * is untouched (`foo..bar`, `*..*` and `a..b` do not match), but a pattern
 * with escaped braces around a literal `..` does. That is the same tradeoff
 * `LABELED_ENTRY_RE` (vpath.ts) already takes for a host path containing
 * `=` -- a vanishingly rare name, refused rather than given an escaping
 * rule -- and it fails in the safe direction.
 *
 * What it does NOT need to catch: a `..` produced by a magic component
 * (`[.][.]`, `*`). Node's `readdir` never reports `.` or `..` as entries, so
 * a pattern component with magic in it can only ever match a real directory
 * entry; a literal `..` component is the only way glob climbs, and it climbs
 * by path arithmetic rather than by matching.
 */
const DOTDOT_COMPONENT = /(^|[/{,])\.\.($|[/},])/;

/**
 * A brace alternative that starts at the filesystem root, e.g.
 * `{/etc,sub}/ho*` -- which glob expands to `/etc/ho*` and then walks with
 * `cwd` ignored entirely (measured: it returned `/etc/hosts`). `path.isAbsolute`
 * on the raw pattern does not see this one, so it gets its own test, for the
 * same reason and with the same conservatism as DOTDOT_COMPONENT.
 */
const ABSOLUTE_ALTERNATIVE = /[{,]\//;

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
  'pattern must not contain a ".." path component (including inside a brace alternative). A path ' +
  'ARGUMENT containing ".." can be resolved and checked against this call\'s scope; a pattern ' +
  'cannot, because a pattern with a wildcard in it does not resolve to one path -- so ".." in a ' +
  'pattern is refused outright rather than guessed at. Every directory in scope is reachable by ' +
  'naming it with the `path` argument (`/<label>/...`).';

/**
 * Wall-clock bound on the walk itself (issue #25, consequence 3).
 *
 * The 1000-result cap bounds the OUTPUT and not the traversal: a pattern
 * that matches nothing walks every directory it is pointed at and returns an
 * empty list, having done all the work anyway. `fs_grep` and `fs_find`
 * already share `grepBudgetMs()` for exactly this hazard, and this reuses it
 * rather than inventing a third budget with its own env var -- the hazard is
 * "one synchronous process serves every caller", which is a property of the
 * server, not of any one tool.
 *
 * It is enforced through glob's own `ignore` hook rather than by checking
 * the clock between results, because a pattern that matches nothing yields
 * nothing to check between: `globIterateSync` would walk /System/Library to
 * the end without ever giving the loop a turn. `ignored`/`childrenIgnored`
 * are called as the walk descends, whether or not anything matches, and
 * `childrenIgnored` prunes a subtree outright -- so once the deadline passes
 * every remaining branch is pruned and the walk unwinds. Measured: `**` over
 * /System/Library returns at the budget, to the millisecond, instead of
 * running for 18s.
 *
 * `timedOut` is a floor marker, not an error: whatever was found before the
 * deadline is real and is kept (the same call fs_find makes for the same
 * case). What must never happen is the truncation going unmentioned -- an
 * incomplete answer that reads as a complete one is the empty-success shape
 * this issue and #21 are both about.
 */
function budgetedIgnore(deadline: number): { ignored: () => boolean; childrenIgnored: () => boolean; expired: () => boolean } {
  let expired = false;
  const check = (): boolean => {
    if (!expired && Date.now() >= deadline) expired = true;
    return expired;
  };
  return { ignored: check, childrenIgnored: check, expired: () => expired };
}

export function registerGlob(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_glob',
      description:
        'Find files matching a glob pattern. The pattern is relative to the directory being searched and may not name a location: a pattern that begins at the filesystem root, or contains a ".." component, is refused. Returns virtual paths ("/<label>/...", never a host filesystem path) sorted by modification time (newest first). Capped at 1000 results, and the walk itself is bounded in wall-clock time.',
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

      // Issue #25. These run FIRST -- before the `path` argument is decoded,
      // before `existsSync`, before anything reaches the filesystem -- so a
      // pattern that could name a location is refused without the refusal
      // ever depending on what is or is not on disk. A check that ran after
      // a walk, or that varied with the walk's outcome, would be the oracle
      // it is meant to close.
      if (pattern.includes('\0')) {
        // Malformed input, not a scope violation: the same clean-refusal
        // treatment `basicPathError` (security.ts) gives a NUL in a path,
        // rather than an exception thrown from inside a readdir (C6).
        return errorResult('pattern must not contain a NUL byte');
      }
      if (path.isAbsolute(pattern) || ABSOLUTE_ALTERNATIVE.test(pattern)) {
        return scopeViolationResult(ABSOLUTE_PATTERN_REFUSAL);
      }
      if (DOTDOT_COMPONENT.test(pattern)) {
        return scopeViolationResult(DOTDOT_PATTERN_REFUSAL);
      }

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
      const searchRoots: string[] = [];
      for (const dir of searchDirs) {
        const real = canonicalizePath(dir);
        if (real !== null) searchRoots.push(real);
      }
      if (searchRoots.length === 0) {
        // Never an empty success: a directory that cannot be resolved is an
        // error about the directory, not an answer about its contents.
        return errorResult('search directory could not be resolved (too many levels of symbolic links)');
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
      const budgetMs = grepBudgetMs();
      const budget = budgetedIgnore(Date.now() + budgetMs);

      const seen = new Set<string>();
      const allMatches: string[] = [];
      for (const dir of searchRoots) {
        try {
          // One budget across every search directory, not one each: the
          // hazard being bounded is how long this process is unavailable to
          // every other caller, and that does not get a fresh allowance per
          // granted root.
          const hits = globSync(pattern, { cwd: dir, absolute: true, nodir: true, ignore: budget });
          for (const h of hits) {
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

      // Sort by mtime descending
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

      const timedOut = budget.expired();

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
