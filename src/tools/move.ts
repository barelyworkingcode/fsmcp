import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry, schema, stringProp, boolProp, parseBoolArg, requireStringArg, virtualPathDescription } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { canonicalizePath } from '../security';
import {
  checkPathV,
  decodeInboundPath,
  describeError,
  refuseAllowedDirRootV,
  refuseAllowedDirRootWriteV,
  translateResult,
} from '../vpath';

export function registerMove(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_move',
      description:
        'Move or rename a file or directory. Refuses if the destination already exists unless ' +
        'overwrite is set to true.',
      inputSchema: schema(
        {
          source: stringProp(virtualPathDescription()),
          destination: stringProp(virtualPathDescription()),
          overwrite: boolProp('Replace an existing destination (default: false)'),
        },
        ['source', 'destination']
      ),
      // Renames a local path; never contacts anything off this machine.
      annotations: { readOnlyHint: false, openWorldHint: false },
      category: 'File System',
    },
    (args: Record<string, unknown>, ctx: ToolContext) => {
      const sourceArg = requireStringArg(args, 'source');
      if (typeof sourceArg !== 'string') return sourceArg;
      // Issue #7: decode both endpoints' virtual-space addresses into host
      // paths before either reaches checkPath -- see read.ts for the full
      // reasoning. C4 (both endpoints checked independently and in full)
      // still applies to the decoded host paths exactly as before; decoding
      // is not a scope decision of its own.
      const decodedSource = decodeInboundPath(sourceArg, ctx.labels);
      if (typeof decodedSource !== 'string') return decodedSource;
      const source = decodedSource;

      const destinationArg = requireStringArg(args, 'destination');
      if (typeof destinationArg !== 'string') return destinationArg;
      const decodedDestination = decodeInboundPath(destinationArg, ctx.labels);
      if (typeof decodedDestination !== 'string') return decodedDestination;
      const destination = decodedDestination;

      const overwriteArg = parseBoolArg(args.overwrite, 'overwrite', false);
      if (typeof overwriteArg !== 'boolean') return overwriteArg;
      const overwrite = overwriteArg;

      // C4: both endpoints are validated, independently and in full. A move
      // is really two path-governed operations wearing one name -- the
      // source name goes away, the destination name comes into being -- and
      // checking only one would leave the other free to land outside the
      // sandbox.
      const sourceErr = checkPathV(source, ctx.allowedDirs, ctx.labels);
      if (sourceErr) return sourceErr;
      const destErr = checkPathV(destination, ctx.allowedDirs, ctx.labels);
      if (destErr) return destErr;

      // Issue #24: a path that resolves to a grant root is not a valid
      // target for a tool that creates or replaces something at it, and
      // `destination` is exactly such a target -- fs_move brings the
      // destination name into being (C4's own framing). `checkPathV` cannot
      // refuse it, because a root is inside itself, so this is the same
      // blind spot fs_write had. It is checked here, before the
      // does-it-exist branching below, rather than only in the
      // `overwrite: true` branch: without it the answer for a root
      // destination depended on whether the root happened to exist and on
      // whether `overwrite` was set -- "destination already exists" for the
      // ordinary case, a scope refusal for the overwrite case, and, for a
      // grant root that does not exist yet, an actual rename of a file onto
      // the sandbox root. One rule, one answer, on the resolved path, so
      // the alias spellings (`/d0`, `/d0/`, `/d0/.`, `/d0/notes/..`) are
      // one case rather than four.
      const destRootErr = refuseAllowedDirRootWriteV(destination, ctx.allowedDirs, 'move onto', ctx.labels);
      if (destRootErr) return destRootErr;

      let sourceStat: fs.Stats;
      try {
        sourceStat = fs.lstatSync(source);
      } catch {
        return translateResult(errorResult(`source not found: ${source}`), [source], ctx.labels);
      }

      // A directory moved into (or onto) its own descendant is refused by
      // the kernel too (EINVAL on Linux and macOS), but that message says
      // nothing about why and depends on kernel behaviour fsmcp does not
      // control, so it is checked and named explicitly here rather than
      // left to whatever rename(2) happens to report.
      const resolvedSource = canonicalizePath(source);
      const resolvedDestParent = canonicalizePath(path.dirname(destination));
      if (
        sourceStat.isDirectory() &&
        resolvedSource !== null &&
        resolvedDestParent !== null &&
        (resolvedDestParent === resolvedSource ||
          resolvedDestParent.startsWith(resolvedSource + path.sep))
      ) {
        return translateResult(
          errorResult(`cannot move a directory into itself: ${source} -> ${destination}`),
          [source, destination],
          ctx.labels
        );
      }

      const destExists = fs.existsSync(destination);
      if (destExists && !overwrite) {
        return translateResult(
          errorResult(`destination already exists: ${destination} (pass overwrite: true to replace it)`),
          [destination],
          ctx.labels
        );
      }

      // `overwrite: true` on an existing destination is a recursive delete
      // wearing this tool's name (see the rmSync call just below) -- and
      // checkPath(destination) above passes for an allowed_dir root itself,
      // because a root is inside itself. Without this, `fs_move { source:
      // "<root>/a.txt", destination: "<root>", overwrite: true }` reached
      // that rmSync with nothing guarding it and erased the sandbox root.
      // Same guard fs_delete uses (security.ts's refuseAllowedDirRoot),
      // applied here because this is the other place that syscall happens.
      //
      // Unreachable as of issue #24 -- the destination root is refused
      // above, before the branch that gets here -- and kept anyway, on
      // purpose. The two guards answer different questions about the same
      // path: the one above is "this is not a valid target for a write"
      // (the write half of the rule, a scope violation), this one is "this
      // rmSync must not remove a sandbox root" (the delete half, an
      // ordinary tool error). If the check above is ever narrowed or moved,
      // the syscall on the next line must still not be reachable with a
      // root in hand.
      if (destExists) {
        const rootErr = refuseAllowedDirRootV(destination, ctx.allowedDirs, 'overwrite', ctx.labels);
        if (rootErr) return rootErr;
      }

      try {
        // No tool in this surface creates a symlink or a hard link -- that
        // would be a sandbox-escape primitive with a friendly name, handed
        // to whichever grant this tool carries. `overwrite` replaces the
        // destination outright (recursively, if it is a directory) rather
        // than merging into it, so what fs_move creates at `destination` is
        // always exactly what fs_move moved there, never a blend of two
        // trees.
        if (destExists) {
          fs.rmSync(destination, { recursive: true, force: true });
        }
        fs.renameSync(source, destination);
      } catch (err: unknown) {
        return errorResult(`move failed: ${describeError(err, ctx.labels)}`);
      }

      return translateResult(textResult(`Moved ${source} to ${destination}`), [source, destination], ctx.labels);
    }
  );
}
