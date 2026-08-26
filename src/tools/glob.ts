import * as fs from 'fs';
import { globSync } from 'glob';
import { ToolRegistry, schema, stringProp, requireStringArg, optionalStringArg } from '../registry';
import { textResult, errorResult, scopeViolationResult, ToolContext } from '../types';
import { validatePath, NO_ALLOWED_DIRS_MESSAGE } from '../security';
import { checkPathV, decodeInboundPath, describeError, hostToVirtualOrRedact, translateResult } from '../vpath';

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
      const patternArg = requireStringArg(args, 'pattern');
      if (typeof patternArg !== 'string') return patternArg;
      const pattern = patternArg;

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

      const capped = withMtime.slice(0, MAX_RESULTS);
      // Issue #7, outbound: every hit already passed validatePath above (the
      // real, unmodified security check); hostToVirtualOrRedact only
      // decides how to SHOW a path that check already accepted, and redacts
      // rather than emits one it somehow can't map -- see vpath.ts.
      const result = capped.map((f) => hostToVirtualOrRedact(f.path, ctx.labels)).join('\n');

      const suffix = allMatches.length > MAX_RESULTS
        ? `\n\n(showing ${MAX_RESULTS} of ${allMatches.length} matches)`
        : '';

      return textResult(result + suffix);
    }
  );
}
