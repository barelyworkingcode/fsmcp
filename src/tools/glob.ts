import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';
import { ToolRegistry, schema, stringProp } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { validatePath } from '../security';

const MAX_RESULTS = 1000;

export function registerGlob(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_glob',
      description:
        'Find files matching a glob pattern. Returns absolute paths sorted by modification time (newest first). Capped at 1000 results.',
      inputSchema: schema(
        {
          pattern: stringProp("Glob pattern (e.g. '**/*.ts')"),
          path: stringProp('Directory to search in (defaults to cwd)'),
        },
        ['pattern']
      ),
      annotations: { readOnlyHint: true },
      category: 'File System',
    },
    (args: Record<string, unknown>, ctx: ToolContext) => {
      const pattern = args.pattern as string;
      const searchPath = (args.path as string) ?? process.cwd();

      if (args.path && !path.isAbsolute(searchPath)) {
        return errorResult('path must be absolute');
      }

      const pathErr = validatePath(searchPath, ctx.allowedDirs);
      if (pathErr) return errorResult(pathErr);

      if (!fs.existsSync(searchPath)) {
        return errorResult(`directory not found: ${searchPath}`);
      }

      let matches: string[];
      try {
        matches = globSync(pattern, { cwd: searchPath, absolute: true, nodir: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`glob error: ${msg}`);
      }

      // Sort by mtime descending
      const withMtime = matches.map((f) => {
        try {
          return { path: f, mtime: fs.statSync(f).mtimeMs };
        } catch {
          return { path: f, mtime: 0 };
        }
      });
      withMtime.sort((a, b) => b.mtime - a.mtime);

      const capped = withMtime.slice(0, MAX_RESULTS);
      const result = capped.map((f) => f.path).join('\n');

      const suffix = matches.length > MAX_RESULTS
        ? `\n\n(showing ${MAX_RESULTS} of ${matches.length} matches)`
        : '';

      return textResult(result + suffix);
    }
  );
}
