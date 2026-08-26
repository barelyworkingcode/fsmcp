import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ToolRegistry, schema, stringProp, intProp, enumProp, requireStringArg, optionalStringArg } from '../registry';
import { textResult, errorResult, scopeViolationResult, ToolContext } from '../types';
import { validatePath, checkPath, NO_ALLOWED_DIRS_MESSAGE } from '../security';

// Detect ripgrep at load time.
//
// execFileSync, not execSync: nothing in this file may reach a shell. The
// probe's own arguments are constants and would have been harmless either
// way, but a shell-running spawn sitting in the same file as the search is
// how the search came to use one -- and it changes the answer, too. execSync
// consults the user's shell, so an `rg` that is a shell function or alias
// reports available and then is not there for the real search; execFileSync
// resolves an executable on PATH, which is exactly what the search does.
let rgAvailable = false;
try {
  execFileSync('rg', ['--version'], { stdio: 'pipe' });
  rgAvailable = true;
} catch {
  // rg not installed
}

/**
 * Wall-clock bound on a single fs_grep call, in milliseconds.
 *
 * Both search paths use it, so they behave alike: the ripgrep path passes it
 * as execFileSync's `timeout`, the Node fallback checks it as it walks. It
 * used to exist only on the ripgrep path, which left the fallback -- the path
 * every host without ripgrep takes, including the one this was found on --
 * with no bound at all.
 *
 * That is a process-wide hazard rather than a slow call. fsmcp is one
 * synchronous stdio loop, so a search that does not return does not degrade
 * itself; it takes every tool with it for every caller, the same shape as the
 * deeply-nested MIME message that killed macmcp outright. And `pattern` is
 * caller-supplied and compiled with `new RegExp`, so the caller chooses the
 * work: `(a+)+$` against a few dozen non-matching characters backtracks for
 * longer than the machine will be up.
 *
 * The pattern itself is deliberately NOT inspected. Catastrophic backtracking
 * cannot be decided statically -- any heuristic refuses legitimate patterns
 * and still misses crafted ones -- so the work is bounded and the input is
 * not judged.
 *
 * FSMCP_GREP_TIMEOUT_MS overrides it. That is a test seam: it lets the
 * truncation behaviour be pinned in milliseconds rather than by burning 30
 * real seconds in the suite.
 */
export const GREP_TIMEOUT_MS = 30_000;

export function grepBudgetMs(): number {
  const raw = process.env.FSMCP_GREP_TIMEOUT_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return GREP_TIMEOUT_MS;
}

export function registerGrep(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_grep',
      description:
        'Search file contents with regex. Uses ripgrep if available, falls back to Node.js. Default output mode is files_with_matches (file paths only).',
      inputSchema: schema(
        {
          pattern: stringProp('Regex pattern to search for'),
          path: stringProp('File or directory to search in (defaults to all allowed directories)'),
          glob: stringProp("Glob to filter files (e.g. '*.ts')"),
          type: stringProp("File type filter (e.g. 'ts', 'js', 'py')"),
          output_mode: enumProp('Output mode', [
            'content',
            'files_with_matches',
            'count',
          ]),
          context: intProp('Lines of context around matches (content mode only)'),
          head_limit: intProp('Limit output to first N results'),
        },
        ['pattern']
      ),
      // Searches local files (ripgrep or the Node fallback), both confined
      // to this machine's filesystem.
      annotations: { readOnlyHint: true, openWorldHint: false },
      category: 'File System',
    },
    (args: Record<string, unknown>, ctx: ToolContext) => {
      const patternArg = requireStringArg(args, 'pattern');
      if (typeof patternArg !== 'string') return patternArg;
      const pattern = patternArg;
      const globFilter = args.glob as string | undefined;
      const typeFilter = args.type as string | undefined;
      const outputMode = (args.output_mode as string) ?? 'files_with_matches';
      const contextLines = args.context as number | undefined;
      const headLimit = args.head_limit as number | undefined;

      const pathArg = optionalStringArg(args, 'path');
      if (typeof pathArg === 'object') return pathArg; // a wrong-typed path is an MCPCallResult refusal

      // Determine search paths ("." is treated as omitted)
      let searchPaths: string[];
      if (pathArg && pathArg !== '.') {
        const p = pathArg;
        const pathErr = checkPath(p, ctx.allowedDirs);
        if (pathErr) return pathErr;
        searchPaths = [p];
      } else if (ctx.allowedDirs.length > 0) {
        searchPaths = ctx.allowedDirs.filter((d) => fs.existsSync(d));
        if (searchPaths.length === 0) return errorResult('none of the allowed directories exist');
      } else {
        // No allowed dirs configured: an absent path must resolve to the
        // (empty) scope, not to an unrestricted cwd fallback. Empty scope is
        // itself a scope refusal, not a different kind of error.
        return scopeViolationResult(NO_ALLOWED_DIRS_MESSAGE);
      }

      if (rgAvailable) {
        return grepWithRg(
          pattern, searchPaths, globFilter, typeFilter,
          outputMode, contextLines, headLimit, ctx.allowedDirs
        );
      }
      return grepFallback(
        pattern, searchPaths, globFilter, typeFilter,
        outputMode, contextLines, headLimit, grepBudgetMs(), ctx.allowedDirs
      );
    }
  );
}

/**
 * Build ripgrep's argument vector.
 *
 * This returns an **argv array**, and it is the caller's contract that it is
 * passed to `execFileSync` as one -- never joined into a string. Exported so
 * the construction can be pinned by a test on a host with no ripgrep on it.
 *
 * `--` before the pattern stops *ripgrep* reading a pattern that begins with
 * a dash as a flag. It says nothing about a shell and never did: this code
 * used to hand `rgArgs.join(' ')` to `execSync`, which runs /bin/sh, so the
 * caller-supplied `pattern` (and `glob`, and `type`) were shell source. A
 * pattern of `hello; touch /tmp/pwned; echo done` became
 *
 *     rg -n -- hello; touch /tmp/pwned; echo done /some/allowed/dir
 *
 * -- three commands, of which ripgrep ran one. That is arbitrary command
 * execution with no relation to `allowed_dirs`, from a tool annotated
 * `readOnlyHint: true`, i.e. from the most restricted grant relay can issue.
 * It did not fire on the development host only because the `rg` there is a
 * shell function, so the old `execSync('rg --version')` probe reported it
 * unavailable and the pure-Node fallback ran instead. That is a property of
 * one machine, not a mitigation.
 *
 * The fix is not to quote or to escape: it is that no shell parses any of
 * this. Every element below is one argv element, so a `;`, a backtick, a
 * `$(...)` or a newline in a pattern reaches ripgrep as the text it is.
 */
export function buildRgArgs(
  pattern: string,
  searchPaths: string[],
  globFilter: string | undefined,
  typeFilter: string | undefined,
  outputMode: string,
  contextLines: number | undefined,
  headLimit: number | undefined,
): string[] {
  const rgArgs: string[] = [];

  switch (outputMode) {
    case 'files_with_matches':
      rgArgs.push('-l');
      break;
    case 'count':
      rgArgs.push('-c');
      break;
    case 'content':
      rgArgs.push('-n');
      if (contextLines !== undefined) {
        rgArgs.push('-C', String(contextLines));
      }
      break;
  }

  if (globFilter) rgArgs.push('--glob', globFilter);
  if (typeFilter) rgArgs.push('--type', typeFilter);
  if (headLimit) rgArgs.push('--max-count', String(headLimit));

  rgArgs.push('--', pattern, ...searchPaths);

  return rgArgs;
}

/**
 * Re-validate every path fs_grep is about to hand back.
 *
 * fs_glob already does this for the same reason: whatever *walks* the
 * filesystem chooses what gets reported, and a symlink inside an allowed
 * directory that points outside it can come back looking like an in-scope
 * path. Nothing here ever passes `--follow` to ripgrep, and ripgrep does not
 * follow symlinks unless told to, so the ordinary run of this tool should
 * never produce an out-of-scope hit in the first place -- but "the flag we
 * didn't pass happens to default the right way" describes ripgrep's current
 * behaviour, not a guarantee this file makes, and the very same reasoning
 * (glob's fix, `0be03fe` era) says the output gets checked regardless of
 * how confident the input side is.
 *
 * This parses the exact three shapes `grepWithRg`/`grepFallback` themselves
 * produce, not ripgrep's own `--json` mode: a bare path
 * (files_with_matches), `path:count` (count), and `path:lineno:content`
 * (content, anchored on the numeric line number rather than colon-counting,
 * because `content` can itself contain colons). `--` group separators that
 * `-C`/`-A`/`-B` insert between non-contiguous matches are passed through
 * unfiltered, since they name no path at all. A line that cannot be parsed
 * into one of these shapes is dropped rather than guessed at: it cannot be
 * proven in scope, so it is treated as if it were not.
 */
export function filterPathsInScope(
  output: string,
  outputMode: string,
  allowedDirs: string[],
): string {
  if (!output) return output;
  const lines = output.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (line === '') {
      kept.push(line);
      continue;
    }
    if (outputMode === 'content' && line === '--') {
      kept.push(line);
      continue;
    }

    let candidate: string | null;
    if (outputMode === 'content') {
      const m = /^(.+?):(\d+):/.exec(line);
      candidate = m ? m[1] : null;
    } else if (outputMode === 'count') {
      const m = /^(.+):(\d+)$/.exec(line);
      candidate = m ? m[1] : null;
    } else {
      candidate = line;
    }

    if (candidate !== null && path.isAbsolute(candidate) && validatePath(candidate, allowedDirs) === null) {
      kept.push(line);
    }
  }
  return kept.join('\n');
}

function grepWithRg(
  pattern: string,
  searchPaths: string[],
  globFilter: string | undefined,
  typeFilter: string | undefined,
  outputMode: string,
  contextLines: number | undefined,
  headLimit: number | undefined,
  allowedDirs: string[],
) {
  const rgArgs = buildRgArgs(
    pattern, searchPaths, globFilter, typeFilter,
    outputMode, contextLines, headLimit
  );

  const budgetMs = grepBudgetMs();

  try {
    const output = execFileSync('rg', rgArgs, {
      encoding: 'utf-8',
      timeout: budgetMs,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const filtered = filterPathsInScope(output.trimEnd(), outputMode, allowedDirs);
    return textResult(filtered === '' ? 'No matches found.' : filtered);
  } catch (err: unknown) {
    const e = (err ?? {}) as {
      status?: number | null;
      code?: string;
      stderr?: unknown;
      stdout?: unknown;
      message?: string;
    };

    // rg exits 1 when no matches found
    if (e.status === 1) {
      return textResult('No matches found.');
    }

    // A timeout kills rg with SIGTERM, so `status` is null (never 1) and
    // whatever rg had already written is on `e.stdout`. That partial is
    // discarded rather than returned: it is a prefix of an answer with no way
    // to say so on this path, and returning it would make "these are the
    // matches" and "these are the matches I got to" the same reply. What was
    // missing is that the caller was told any of it -- rg writes nothing to
    // stderr when it is killed, so this used to return the string
    // "grep error: " and nothing else.
    if (e.code === 'ETIMEDOUT') {
      const partial = typeof e.stdout === 'string' && e.stdout.length > 0
        ? ` Partial output (${e.stdout.length} bytes) was discarded because it cannot be `
          + `distinguished from a complete result.`
        : '';
      return errorResult(
        `grep timed out after ${budgetMs}ms and was stopped.${partial} Narrow the search `
          + `with path, glob or type, or simplify the pattern.`
      );
    }

    // Any other failure. stderr first, but it is empty for a whole class of
    // spawn failures, and an error message with nothing in it is the one
    // thing this must not produce.
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
    const detail = stderr || e.message || String(err);
    return errorResult(`grep error: ${detail}`);
  }
}

/**
 * The pure-Node search, used on any host without ripgrep on PATH.
 *
 * `budgetMs` bounds the whole call in wall-clock time and defaults to the
 * same budget the ripgrep path spends. The deadline is checked between files
 * and between lines, which is the only place it CAN be checked: JavaScript
 * offers no way to interrupt a regex mid-match, so `regex.test(line)` runs to
 * completion however long it takes. A single catastrophically-backtracking
 * match against one very long line therefore still overruns the bound, and
 * this comment is the honest statement of that -- the bound stops the search
 * from continuing, it does not stop a match in progress. What it does buy is
 * that the pathological case is one line's worth of overrun instead of
 * unbounded: without it, the same pattern kept matching against every line of
 * every file for as long as the process lived.
 *
 * `allowedDirsForRevalidation` re-validates every file the walk turns up
 * before it is ever opened or reported, the same containment fs_glob already
 * applies to its own hits (see `filterPathsInScope` above for why this
 * fallback needs it too, not just the ripgrep path). It is optional, and
 * defaults to skipping that check, purely as a test seam: the ReDoS-budget
 * tests below call this function directly with a bare tmp directory and no
 * concept of allowed_dirs at all, and defaulting to "no allowed dirs" would
 * make them fail closed for a reason that has nothing to do with what they
 * are testing. The real call site in fs_grep's handler always passes
 * `ctx.allowedDirs`.
 *
 * Exported so a test can hand it a small budget directly.
 */
export function grepFallback(
  pattern: string,
  searchPaths: string[],
  globFilter: string | undefined,
  typeFilter: string | undefined,
  outputMode: string,
  contextLines: number | undefined,
  headLimit: number | undefined,
  budgetMs: number = grepBudgetMs(),
  allowedDirsForRevalidation?: string[],
) {
  const deadline = Date.now() + budgetMs;
  const expired = () => Date.now() >= deadline;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return errorResult(`invalid regex: ${pattern}`);
  }

  // The walk is inside the budget too: enumerating a very large tree is its
  // own way to not come back, and a file list that is itself a floor must not
  // be reported as "N of M".
  const walked = searchPaths.flatMap((p) => walkFiles(p, globFilter, typeFilter, deadline));
  const files = allowedDirsForRevalidation === undefined
    ? walked
    : walked.filter((f) => validatePath(f, allowedDirsForRevalidation) === null);
  const walkTruncated = expired();

  const results: string[] = [];
  let resultCount = 0;
  let filesSearched = 0;
  let stopped = walkTruncated;

  for (const file of files) {
    if (headLimit && resultCount >= headLimit) break;
    if (expired()) {
      stopped = true;
      break;
    }

    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    filesSearched++;
    const lines = content.split('\n');
    const matchingLines: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (expired()) {
        stopped = true;
        break;
      }
      if (regex.test(lines[i])) {
        matchingLines.push(i);
      }
    }

    // Matches found before the deadline are real matches and are reported,
    // even if this file was only partly searched.
    if (matchingLines.length > 0) {
      switch (outputMode) {
        case 'files_with_matches':
          results.push(file);
          resultCount++;
          break;
        case 'count':
          results.push(`${file}:${matchingLines.length}`);
          resultCount++;
          break;
        case 'content': {
          const ctx = contextLines ?? 0;
          const shown = new Set<number>();
          for (const lineIdx of matchingLines) {
            for (let j = Math.max(0, lineIdx - ctx); j <= Math.min(lines.length - 1, lineIdx + ctx); j++) {
              shown.add(j);
            }
          }
          const sortedLines = [...shown].sort((a, b) => a - b);
          for (const idx of sortedLines) {
            results.push(`${file}:${idx + 1}:${lines[idx]}`);
          }
          resultCount += matchingLines.length;
          break;
        }
      }
    }

    if (stopped) break;
  }

  if (stopped) {
    // A search that stopped early and one that finished having found nothing
    // must not give the same answer. "No matches found." is a claim about
    // every file in scope; this call cannot make it.
    const scope = walkTruncated
      ? `at least ${files.length} files (the file list was itself cut short)`
      : `${files.length} files`;

    if (filesSearched === 0) {
      return errorResult(
        `grep stopped after ${budgetMs}ms without finishing a single file, so nothing can `
          + `be reported about ${scope}. Narrow the search with path, glob or type, or `
          + `simplify the pattern.`
      );
    }

    const note =
      `[fsmcp: search stopped after ${budgetMs}ms, having searched ${filesSearched} of `
      + `${scope}. These results are a floor, not a complete answer: a file that was not `
      + `searched may still match.]`;

    if (results.length === 0) {
      return textResult(
        `No matches in the ${filesSearched} file(s) searched before the search stopped.\n${note}`
      );
    }
    return textResult(`${results.join('\n')}\n\n${note}`);
  }

  if (results.length === 0) {
    return textResult('No matches found.');
  }

  return textResult(results.join('\n'));
}

function walkFiles(
  dir: string,
  globFilter: string | undefined,
  typeFilter: string | undefined,
  deadline: number,
): string[] {
  const results: string[] = [];

  // If it's a file, just return it
  try {
    if (fs.statSync(dir).isFile()) return [dir];
  } catch {
    return [];
  }

  const typeExt = typeFilter ? `.${typeFilter}` : undefined;

  function walk(current: string): void {
    if (Date.now() >= deadline) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (Date.now() >= deadline) return;
      const fullPath = path.join(current, entry.name);

      // Skip hidden dirs and node_modules
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      // Type filter
      if (typeExt && !entry.name.endsWith(typeExt)) continue;

      // Basic glob filter (just extension matching for fallback)
      if (globFilter) {
        const ext = globFilter.startsWith('*.') ? globFilter.slice(1) : null;
        if (ext && !entry.name.endsWith(ext)) continue;
      }

      results.push(fullPath);
    }
  }

  walk(dir);
  return results;
}
