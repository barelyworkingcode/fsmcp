import * as fs from 'fs';
import { globSync } from 'glob';
import { ToolRegistry, schema, stringProp, requireStringArg, optionalStringArg, virtualPathDescription } from '../registry';
import { textResult, errorResult, scopeViolationResult, ToolContext } from '../types';
import { validatePath, NO_ALLOWED_DIRS_MESSAGE } from '../security';
import { checkPathV, decodeInboundPath, describeError, hostToVirtualOrRedact, translateResult } from '../vpath';
import { capLines, MAX_RESPONSE_BYTES } from '../limits';

const MAX_RESULTS = 1000;

export function registerGlob(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_glob',
      description:
        'Find files matching a glob pattern. Returns virtual paths ("/<label>/...", never a host filesystem path) sorted by modification time (newest first). Capped at 1000 results.',
      inputSchema: schema(
        {
          pattern: stringProp("Glob pattern (e.g. '**/*.ts')"),
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

      // Issue #7, outbound: every hit already passed validatePath above (the
      // real, unmodified security check); hostToVirtualOrRedact only
      // decides how to SHOW a path that check already accepted, and redacts
      // rather than emits one it somehow can't map -- see vpath.ts.
      // Rendered before the cap is applied, not after, so the byte budget
      // measures the strings that will actually be sent rather than the host
      // paths they were built from.
      const rendered = withMtime
        .slice(0, MAX_RESULTS)
        .map((f) => hostToVirtualOrRedact(f.path, ctx.labels));

      // Issue #19: 1000 matches was a cap on the COUNT only, and a match is a
      // whole path -- at PATH_MAX that is a megabyte of result from a bound
      // that looks small. capLines adds the shared byte budget; the
      // "(showing X of Y matches)" wording is unchanged.
      const capped = capLines(rendered, MAX_RESULTS, allMatches.length);
      if (!capped.capped) return textResult(capped.text);

      const why =
        capped.reason === 'bytes' ? `, cut at fs_glob's ${MAX_RESPONSE_BYTES}-byte response limit` : '';
      const result = textResult(
        `${capped.text}\n\n(showing ${capped.shown} of ${capped.total} matches${why})`
      );
      result._meta = { truncated: true };
      return result;
    }
  );
}
