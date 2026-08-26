import * as fs from 'fs';
import { globSync } from 'glob';
import { ToolRegistry, schema, stringProp, requireStringArg, optionalStringArg, virtualPathDescription } from '../registry';
import { textResult, errorResult, scopeViolationResult, ToolContext } from '../types';
import { canonicalizePath, validatePath, NO_ALLOWED_DIRS_MESSAGE } from '../security';
import { checkPathV, decodeInboundPath, describeError, hostToVirtualOrRedact, translateResult } from '../vpath';

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
      const seen = new Set<string>();
      const allMatches: string[] = [];
      for (const dir of searchRoots) {
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
      // rather than emits one it somehow can't map -- see vpath.ts. Issue
      // #21's second half lives on the other side of this call: these hits
      // are now spelled with the RESOLVED root, and `hostToVirtual` had only
      // the operator's unresolved spelling to match against, so resolving
      // the walk without teaching the map both spellings would have turned
      // an empty answer into a page of redaction placeholders.
      const result = capped.map((f) => hostToVirtualOrRedact(f.path, ctx.labels)).join('\n');

      const suffix = allMatches.length > MAX_RESULTS
        ? `\n\n(showing ${MAX_RESULTS} of ${allMatches.length} matches)`
        : '';

      return textResult(result + suffix);
    }
  );
}
