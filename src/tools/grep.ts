import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ToolRegistry, schema, stringProp, intProp, enumProp } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { validatePath } from '../security';

// Detect ripgrep at load time
let rgAvailable = false;
try {
  execSync('rg --version', { stdio: 'pipe' });
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
          path: stringProp('File or directory to search in (defaults to cwd)'),
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
      const searchPath = (args.path as string) ?? process.cwd();
      const globFilter = args.glob as string | undefined;
      const typeFilter = args.type as string | undefined;
      const outputMode = (args.output_mode as string) ?? 'files_with_matches';
      const contextLines = args.context as number | undefined;
      const headLimit = args.head_limit as number | undefined;

      const pathErr = validatePath(searchPath, ctx.allowedDirs);
      if (pathErr) return errorResult(pathErr);

      if (rgAvailable) {
        return grepWithRg(
          pattern, searchPath, globFilter, typeFilter,
          outputMode, contextLines, headLimit
        );
      }
      return grepFallback(
        pattern, searchPath, globFilter, typeFilter,
        outputMode, contextLines, headLimit
      );
    }
  );
}

function grepWithRg(
  pattern: string,
  searchPath: string,
  globFilter: string | undefined,
  typeFilter: string | undefined,
  outputMode: string,
  contextLines: number | undefined,
  headLimit: number | undefined,
) {
  const rgArgs: string[] = ['rg'];

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

  rgArgs.push('--', pattern, searchPath);

  try {
    const output = execSync(rgArgs.join(' '), {
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
  searchPath: string,
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

  const files = walkFiles(searchPath, globFilter, typeFilter);
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
