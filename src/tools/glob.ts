import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';
import { ToolRegistry, schema, stringProp } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { validatePath, NO_ALLOWED_DIRS_MESSAGE } from '../security';

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
          path: stringProp('Directory to search in (defaults to all allowed directories)'),
        },
        ['pattern']
      ),
      // Matches file names against the local filesystem only.
      annotations: { readOnlyHint: true, openWorldHint: false },
      category: 'File System',
    },
    (args: Record<string, unknown>, ctx: ToolContext) => {
      const pattern = args.pattern as string;

      // Determine search directories ("." is treated as omitted)
      let searchDirs: string[];
      if (args.path && args.path !== '.') {
        const p = args.path as string;
        if (!path.isAbsolute(p)) return errorResult('path must be absolute');
        const pathErr = validatePath(p, ctx.allowedDirs);
        if (pathErr) return errorResult(pathErr);
        if (!fs.existsSync(p)) return errorResult(`directory not found: ${p}`);
        searchDirs = [p];
      } else if (ctx.allowedDirs.length > 0) {
        searchDirs = ctx.allowedDirs.filter((d) => fs.existsSync(d));
        if (searchDirs.length === 0) return errorResult('none of the allowed directories exist');
      } else {
        // No allowed dirs configured: an absent path must resolve to the
        // (empty) scope, not to an unrestricted cwd fallback.
        return errorResult(NO_ALLOWED_DIRS_MESSAGE);
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
      // is shown must be the scope they actually have.
      const seen = new Set<string>();
      const allMatches: string[] = [];
      for (const dir of searchDirs) {
        try {
          const hits = globSync(pattern, { cwd: dir, absolute: true, nodir: true });
          for (const h of hits) {
            if (seen.has(h)) continue;
            seen.add(h);
            if (validatePath(h, ctx.allowedDirs)) continue; // resolves outside
            allMatches.push(h);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return errorResult(`glob error: ${msg}`);
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

      const capped = withMtime.slice(0, MAX_RESULTS);
      const result = capped.map((f) => f.path).join('\n');

      const suffix = allMatches.length > MAX_RESULTS
        ? `\n\n(showing ${MAX_RESULTS} of ${allMatches.length} matches)`
        : '';

      return textResult(result + suffix);
    }
  );
}
