import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ToolRegistry, schema, stringProp, requireStringArg, optionalStringArg } from '../registry';
import { textResult, errorResult, scopeViolationResult, ToolContext } from '../types';
import { validatePath, checkPath, NO_ALLOWED_DIRS_MESSAGE } from '../security';
import { grepBudgetMs } from './grep';

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
 */
function listFilesRg(dirs: string[], timeoutMs: number): { files: string[]; truncated: boolean } {
  try {
    const output = execFileSync('rg', ['--files', '--no-follow', '--', ...dirs], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { files: output.split('\n').filter(Boolean), truncated: false };
  } catch (err: unknown) {
    const e = (err ?? {}) as { code?: string; stdout?: unknown };
    if (e.code === 'ETIMEDOUT' && typeof e.stdout === 'string') {
      return { files: e.stdout.split('\n').filter(Boolean), truncated: true };
    }
    return { files: [], truncated: false };
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
function listFilesFallback(dirs: string[], deadline: number): { files: string[]; truncated: boolean } {
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
  return { files, truncated };
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
        `name matches pattern (subsequence match with contiguity/word-boundary bonuses). ` +
        `Backed by "rg --files --no-follow" with a Node walker fallback. Capped at ${MAX_RESULTS} results.`,
      inputSchema: schema(
        {
          pattern: stringProp('Fuzzy filename pattern (subsequence match, e.g. "fmain" matches "fs/main.ts")'),
          path: stringProp('Directory to search in (defaults to all allowed directories)'),
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
        const p = pathArg;
        const pathErr = checkPath(p, ctx.allowedDirs);
        if (pathErr) return pathErr;
        if (!fs.existsSync(p)) return errorResult(`directory not found: ${p}`);
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

      const { files, truncated } = rgAvailable
        ? listFilesRg(searchDirs, budgetMs)
        : listFilesFallback(searchDirs, deadline);

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
        return textResult(truncated
          ? 'No matches found (the file walk was cut short by the search budget, so this is a floor, not a complete answer).'
          : 'No matches found.');
      }

      const lines = capped.map((r) => r.file).join('\n');
      const notes: string[] = [];
      if (scored.length > MAX_RESULTS) {
        notes.push(`(showing ${MAX_RESULTS} of ${scored.length} matches)`);
      }
      if (truncated) {
        notes.push(
          `[fsmcp: the file walk was cut short after ${budgetMs}ms; this ranking is a floor over ` +
            `the files found before then, not every file in scope]`
        );
      }

      return textResult(notes.length > 0 ? `${lines}\n\n${notes.join('\n')}` : lines);
    }
  );
}
