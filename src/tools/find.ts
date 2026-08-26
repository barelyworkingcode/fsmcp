import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ToolRegistry, schema, stringProp, requireStringArg, optionalStringArg, virtualPathDescription } from '../registry';
import { textResult, errorResult, scopeViolationResult, ToolContext } from '../types';
import { validatePath, NO_ALLOWED_DIRS_MESSAGE } from '../security';
import { checkPathV, decodeInboundPath, hostToVirtualOrRedact, translateResult } from '../vpath';
import { capLines, MAX_RESPONSE_BYTES } from '../limits';
import { escapePathField, pathFieldEscapingRules, RESULT_TRAILER_RULE } from '../resultFormat';
import { grepBudgetMs, unsearchableReason } from './grep';

const MAX_RESULTS = 200;

// rg availability is probed once, at load, exactly the way fs_grep does it --
// see grep.ts for why this is execFileSync and not execSync: an `rg` that is
// a shell function or alias must not be reported "available" by a probe that
// consults the shell and then isn't there for the real walk.
let rgAvailable = false;
try {
  execFileSync('rg', ['--version'], { stdio: 'pipe' });
  rgAvailable = true;
} catch {
  // rg not installed
}

/**
 * List every file under `dirs`, `rg --files`-style: fast, parallel,
 * ignore-aware, and -- like the rest of this file -- never following a
 * symlink. `--no-follow` is passed explicitly rather than relied on as
 * ripgrep's default, for the same reason fs_delete spells out its own
 * containment reasoning instead of trusting a library default to keep
 * meaning what it means today.
 *
 * Bounded by `timeoutMs`, honoured the same way fs_grep honours it: on a
 * timeout, ripgrep is killed and whatever it had already written to its
 * stdout pipe is kept as a floor, not discarded -- unlike fs_grep's ETIMEDOUT
 * handling, discarding here would be discarding a plain file listing (no
 * regex, no risk of "these are the matches I found" reading as more complete
 * than it is), so there is nothing to lose by keeping it and reporting the
 * truncation instead.
 *
 * `failed` is the same argument applied to ripgrep's OTHER way of not
 * finishing (issue #22, found alongside fs_grep's leak). rg exits 2 for any
 * error it hit, including one it walked straight past -- one unreadable
 * directory anywhere under the scope is enough -- and this used to answer
 * that with `{ files: [], truncated: false }`, which the caller then
 * reported as `No matches found.`, a SUCCESS. Two things wrong with it, both
 * measured: a whole granted root that could not be read (mode 000) made
 * fs_find claim there was nothing matching in ANY root, silently discarding
 * the real hits from the readable ones, and it made "the search found
 * nothing" and "the search could not run" the same reply -- the exact
 * distinction the timeout handling above already refuses to blur. So the
 * partial listing is kept, like the timeout's, and the failure is reported
 * to the caller, which decides what to say.
 *
 * ripgrep's stderr is deliberately NOT read here. fs_find never showed it
 * and does not start now: the caller diagnoses the search roots itself
 * (`unsearchableReason`, grep.ts) rather than repeating rg's free text,
 * which is where fs_grep's host-path leak came from.
 *
 * `--null`, and it is not cosmetic (found while fixing issue #37). This
 * split its stdout on "\n", and `rg --files` writes one path per line -- so
 * a filename containing a newline arrived as TWO strings, neither of which
 * names anything. Measured against ripgrep 15.2.0: a file called
 * `we<LF>ird.txt` came back as `./we` and `ird.txt`, both were dropped by
 * the `validatePath` re-check, and the file was simply INVISIBLE to fs_find
 * on every host with ripgrep installed -- while the Node fallback, which
 * builds its paths from `readdir` entries, listed it fine. That is issue
 * #37's defect pointing inward: the same character, the same separator
 * assumption, one layer earlier. Escaping the path on the way out (which
 * #37 does) would have been a promise about output fs_find could not keep,
 * since it never had the name to escape. `--null` makes ripgrep terminate
 * each path with a NUL, which is the one byte a POSIX filename cannot
 * contain, so the split is exact rather than probable. The trailing empty
 * string a NUL-TERMINATED (not separated) stream leaves is dropped by the
 * same `filter(Boolean)` that was already there.
 */
function listFilesRg(dirs: string[], timeoutMs: number): { files: string[]; truncated: boolean; failed: boolean } {
  try {
    const output = execFileSync('rg', ['--files', '--no-follow', '--null', '--', ...dirs], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { files: output.split('\0').filter(Boolean), truncated: false, failed: false };
  } catch (err: unknown) {
    const e = (err ?? {}) as { code?: string; stdout?: unknown };
    // A killed rg may have been cut off mid-path; splitting on NUL means the
    // survivors are whole paths and only the unterminated tail is lost,
    // where splitting on "\n" could have kept a truncated one.
    const partial = typeof e.stdout === 'string' ? e.stdout.split('\0').filter(Boolean) : [];
    if (e.code === 'ETIMEDOUT') {
      return { files: partial, truncated: true, failed: false };
    }
    return { files: partial, truncated: false, failed: true };
  }
}

/**
 * The Node fallback walker, for a host with no ripgrep on PATH.
 *
 * Every entry is inspected with `lstat` and a symlink -- file or directory
 * alike -- is skipped outright rather than followed, which is `--no-follow`
 * done by hand: nothing here ever resolves a symlink's target, so nothing
 * here can be handed a name that lives outside the directory being walked
 * because of one.
 */
function listFilesFallback(dirs: string[], deadline: number): { files: string[]; truncated: boolean; failed: boolean } {
  const files: string[] = [];
  let truncated = false;

  function walk(dir: string): void {
    if (Date.now() >= deadline) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (Date.now() >= deadline) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.' || entry.name === '..') continue;
        walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }

  for (const dir of dirs) {
    walk(dir);
    if (truncated) break;
  }
  // No `failed` from this walker: it reports what it could read and skips
  // what it could not, per-directory, and has no aggregate failure to
  // report. The search roots themselves are checked before either backend
  // runs (see the handler), which is the case that matters -- an unreadable
  // directory deeper in the tree is skipped silently here exactly as it
  // always has been.
  return { files, truncated, failed: false };
}

/**
 * fzf-style subsequence scoring: every character of `pattern` must appear,
 * in order, in `candidate` (case-insensitive), with bonuses for runs of
 * consecutive matches and for matches that land on a word boundary (after a
 * `/`, `_`, `-`, `.` or space, or at the very start). Returns null when
 * `pattern` is not a subsequence at all -- not a low score, no match.
 *
 * This is the same shape of heuristic fzf and Telescope use over `fd`'s file
 * list; it runs in-process, over the (already validated, already bounded)
 * file list ripgrep or the fallback produced, so it adds no new attack
 * surface of its own -- it is pure scoring over strings already known to be
 * in scope.
 */
export function fuzzyScore(pattern: string, candidate: string): number | null {
  const p = pattern.toLowerCase();
  const c = candidate.toLowerCase();
  if (p.length === 0) return 0;

  let score = 0;
  let pIdx = 0;
  let prevMatchIdx = -2;
  let consecutive = 0;

  for (let cIdx = 0; cIdx < c.length && pIdx < p.length; cIdx++) {
    if (c[cIdx] !== p[pIdx]) continue;

    let bonus = 1;
    if (prevMatchIdx === cIdx - 1) {
      consecutive++;
      bonus += consecutive * 2;
    } else {
      consecutive = 0;
    }
    const boundary = cIdx === 0 || /[/_\-. ]/.test(c[cIdx - 1]);
    if (boundary) bonus += 3;

    score += bonus;
    prevMatchIdx = cIdx;
    pIdx++;
  }

  if (pIdx < p.length) return null; // pattern was not a subsequence

  // A shorter candidate matching the same pattern is a tighter match.
  score -= (c.length - p.length) * 0.1;
  return score;
}

export function registerFind(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_find',
      description:
        'Fast fuzzy filename search: ranks files under the allowed directories by how well their ' +
        'name matches pattern (subsequence match with contiguity/word-boundary bonuses). ' +
        'Returns virtual paths ("/<label>/...", never a host filesystem path), best match first, ' +
        'one per line and nothing else on the line. ' +
        pathFieldEscapingRules('result') + ' ' +
        RESULT_TRAILER_RULE + ' ' +
        `Backed by "rg --files --no-follow --null" with a Node walker fallback. Capped at ${MAX_RESULTS} results.`,
      inputSchema: schema(
        {
          pattern: stringProp('Fuzzy filename pattern (subsequence match, e.g. "fmain" matches "fs/main.ts")'),
          path: stringProp(virtualPathDescription('Optional; defaults to every directory in this call\'s granted scope.')),
        },
        ['pattern']
      ),
      // Walks the local filesystem only; never opens a socket.
      annotations: { readOnlyHint: true, openWorldHint: false },
      category: 'File System',
    },
    (args: Record<string, unknown>, ctx: ToolContext) => {
      const patternArg = requireStringArg(args, 'pattern');
      if (typeof patternArg !== 'string') return patternArg;
      const pattern = patternArg;

      const pathArg = optionalStringArg(args, 'path');
      if (typeof pathArg === 'object') return pathArg; // a wrong-typed path is an MCPCallResult refusal

      let searchDirs: string[];
      if (pathArg && pathArg !== '.') {
        // Issue #7: decode the client's virtual-space address into the host
        // path checkPath (and the file walk below) already expect -- see
        // read.ts for the full reasoning.
        const decoded = decodeInboundPath(pathArg, ctx.labels);
        if (typeof decoded !== 'string') return decoded;
        const p = decoded;
        const pathErr = checkPathV(p, ctx.allowedDirs, ctx.labels);
        if (pathErr) return pathErr;
        // Issue #22: "is it there" was never the whole question. A granted
        // directory this process cannot READ (mode 000, or a macOS
        // TCC-protected folder) passes existsSync, then produces no files
        // and no error, and fs_find answered `No matches found.` for it --
        // a success, about a directory it never looked inside.
        // `unsearchableReason` (grep.ts) answers both, in the same words.
        const reason = unsearchableReason(p);
        if (reason) {
          return translateResult(errorResult(`${reason}: ${p}`), [p], ctx.labels);
        }
        searchDirs = [p];
      } else if (ctx.allowedDirs.length > 0) {
        searchDirs = ctx.allowedDirs.filter((d) => fs.existsSync(d));
        if (searchDirs.length === 0) return errorResult('none of the allowed directories exist');
      } else {
        // An absent path must resolve to the (empty) scope, not to cwd or to
        // everything.
        return scopeViolationResult(NO_ALLOWED_DIRS_MESSAGE);
      }

      const budgetMs = grepBudgetMs();
      const deadline = Date.now() + budgetMs;

      const { files, truncated, failed } = rgAvailable
        ? listFilesRg(searchDirs, budgetMs)
        : listFilesFallback(searchDirs, deadline);

      // What fsmcp can say for itself about why the walk failed, in the same
      // words fs_glob/fs_list/fs_grep use -- never ripgrep's own text (see
      // listFilesRg). Only computed on failure: the syscalls are pointless
      // otherwise, and asking about a directory nothing went wrong with
      // would be work for its own sake.
      const unsearchable = failed
        ? searchDirs
            .map((d) => ({ dir: d, reason: unsearchableReason(d) }))
            .filter((x): x is { dir: string; reason: string } => x.reason !== null)
        : [];

      // Every returned path is re-validated before it reaches the caller --
      // the same treatment fs_glob's hits get and for the same reason: what
      // walked the tree chose what got reported, so the check that matters
      // is on the way out, not on the confidence that nothing upstream could
      // have gone wrong.
      const inScope = files.filter((f) => validatePath(f, ctx.allowedDirs) === null);

      const scored: { file: string; score: number }[] = [];
      for (const file of inScope) {
        const score = fuzzyScore(pattern, path.basename(file));
        if (score !== null) scored.push({ file, score });
      }
      scored.sort((a, b) => b.score - a.score);

      const capped = scored.slice(0, MAX_RESULTS);
      if (capped.length === 0) {
        if (failed) {
          // Nothing to report and the walk did not finish: this is an error,
          // not an empty answer. "No matches found." is a claim about every
          // file in scope and this call cannot make it.
          if (unsearchable.length > 0) {
            return translateResult(
              errorResult(unsearchable.map(({ dir, reason }) => `${reason}: ${dir}`).join('; ')),
              unsearchable.map(({ dir }) => dir),
              ctx.labels
            );
          }
          return errorResult(
            'find error: the file walk did not complete and produced nothing, so nothing can be '
              + 'reported about the files in scope.'
          );
        }
        return textResult(truncated
          ? 'No matches found (the file walk was cut short by the search budget, so this is a floor, not a complete answer).'
          : 'No matches found.');
      }

      // Issue #7, outbound: `inScope` above already re-validated every file
      // through validatePath (the real, unmodified security check);
      // hostToVirtualOrRedact only decides how to show a path that check
      // already accepted, and redacts rather than emits one it can't map.
      //
      // Issue #37: escaped on the way out, `fs_list`'s scheme unchanged --
      // one path per line, nothing else on the line, so a name containing a
      // newline stays one result instead of becoming two. After the virtual
      // translation, never before (escaping first would change the string
      // the prefix match runs against).
      const rendered = capped.map((r) => escapePathField(hostToVirtualOrRedact(r.file, ctx.labels)));

      // Issue #19: 200 results is the tightest of this codebase's four
      // existing caps and the least likely of them to reach a megabyte, but
      // it is still a count and a result is still a whole path, so it goes
      // through the same shared byte budget as fs_grep/fs_glob/fs_list rather
      // than being the one tool left arguing that its own cap is small
      // enough. That argument is exactly what fs_grep's content mode was
      // relying on.
      const bounded = capLines(rendered, MAX_RESULTS, scored.length);
      const notes: string[] = [];
      if (bounded.capped) {
        const why =
          bounded.reason === 'bytes'
            ? `, cut at fs_find's ${MAX_RESPONSE_BYTES}-byte response limit`
            : '';
        notes.push(`(showing ${bounded.shown} of ${bounded.total} matches${why})`);
      }
      if (truncated) {
        notes.push(
          `[fsmcp: the file walk was cut short after ${budgetMs}ms; this ranking is a floor over ` +
            `the files found before then, not every file in scope]`
        );
      }
      if (failed) {
        // Results exist, so this is a floor rather than an error -- but it
        // must say so, the same way the truncation note does. Virtual paths
        // only, and fsmcp's own words: this note rides on a SUCCESS result,
        // which `redactLeakedHostPaths` is `isError`-scoped and cannot see
        // (PR #10), so nothing derived from ripgrep's output belongs in it.
        const what = unsearchable.length > 0
          ? unsearchable.map(({ dir, reason }) => `${reason}: ${hostToVirtualOrRedact(dir, ctx.labels)}`).join('; ')
          : 'one or more paths in scope could not be read';
        notes.push(
          `[fsmcp: the file walk did not cover every file in scope -- ${what}. This ranking is a ` +
            `floor over the files that could be listed, not every file in scope]`
        );
      }

      const result = textResult(
        notes.length > 0 ? `${bounded.text}\n\n${notes.join('\n')}` : bounded.text
      );
      if (bounded.capped || truncated) result._meta = { truncated: true };
      return result;
    }
  );
}
