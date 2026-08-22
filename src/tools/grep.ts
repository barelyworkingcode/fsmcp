import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ToolRegistry, schema, stringProp, intProp, enumProp } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { validatePath, NO_ALLOWED_DIRS_MESSAGE } from '../security';

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
      annotations: { readOnlyHint: true },
      category: 'File System',
    },
    (args: Record<string, unknown>, ctx: ToolContext) => {
      const pattern = args.pattern as string;
      const globFilter = args.glob as string | undefined;
      const typeFilter = args.type as string | undefined;
      const outputMode = (args.output_mode as string) ?? 'files_with_matches';
      const contextLines = args.context as number | undefined;
      const headLimit = args.head_limit as number | undefined;

      // Determine search paths ("." is treated as omitted)
      let searchPaths: string[];
      if (args.path && args.path !== '.') {
        const p = args.path as string;
        const pathErr = validatePath(p, ctx.allowedDirs);
        if (pathErr) return errorResult(pathErr);
        searchPaths = [p];
      } else if (ctx.allowedDirs.length > 0) {
        searchPaths = ctx.allowedDirs.filter((d) => fs.existsSync(d));
        if (searchPaths.length === 0) return errorResult('none of the allowed directories exist');
      } else {
        // No allowed dirs configured: an absent path must resolve to the
        // (empty) scope, not to an unrestricted cwd fallback.
        return errorResult(NO_ALLOWED_DIRS_MESSAGE);
      }

      if (rgAvailable) {
        return grepWithRg(
          pattern, searchPaths, globFilter, typeFilter,
          outputMode, contextLines, headLimit
        );
      }
      return grepFallback(
        pattern, searchPaths, globFilter, typeFilter,
        outputMode, contextLines, headLimit
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

function grepWithRg(
  pattern: string,
  searchPaths: string[],
  globFilter: string | undefined,
  typeFilter: string | undefined,
  outputMode: string,
  contextLines: number | undefined,
  headLimit: number | undefined,
) {
  const rgArgs = buildRgArgs(
    pattern, searchPaths, globFilter, typeFilter,
    outputMode, contextLines, headLimit
  );

  try {
    const output = execFileSync('rg', rgArgs, {
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return textResult(output.trimEnd());
  } catch (err: unknown) {
    // rg exits 1 when no matches found
    if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 1) {
      return textResult('No matches found.');
    }
    const stderr = err && typeof err === 'object' && 'stderr' in err
      ? String((err as { stderr: unknown }).stderr)
      : String(err);
    return errorResult(`grep error: ${stderr}`);
  }
}

function grepFallback(
  pattern: string,
  searchPaths: string[],
  globFilter: string | undefined,
  typeFilter: string | undefined,
  outputMode: string,
  contextLines: number | undefined,
  headLimit: number | undefined,
) {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return errorResult(`invalid regex: ${pattern}`);
  }

  const files = searchPaths.flatMap((p) => walkFiles(p, globFilter, typeFilter));
  const results: string[] = [];
  let resultCount = 0;

  for (const file of files) {
    if (headLimit && resultCount >= headLimit) break;

    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    const matchingLines: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matchingLines.push(i);
      }
    }

    if (matchingLines.length === 0) continue;

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

  if (results.length === 0) {
    return textResult('No matches found.');
  }

  return textResult(results.join('\n'));
}

function walkFiles(
  dir: string,
  globFilter: string | undefined,
  typeFilter: string | undefined,
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
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
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
