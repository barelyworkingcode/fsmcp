import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry, schema, stringProp, boolProp, parseBoolArg, requireStringArg } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { checkPath, canonicalizePath, refuseAllowedDirRoot } from '../security';
import { decodeInboundPath } from '../vpath';

export function registerMove(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_move',
      description:
        'Move or rename a file or directory. Refuses if the destination already exists unless ' +
        'overwrite is set to true.',
      inputSchema: schema(
        {
          source: stringProp('Absolute path of the file or directory to move'),
          destination: stringProp('Absolute destination path'),
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
      const sourceErr = checkPath(source, ctx.allowedDirs);
      if (sourceErr) return sourceErr;
      const destErr = checkPath(destination, ctx.allowedDirs);
      if (destErr) return destErr;

      let sourceStat: fs.Stats;
      try {
        sourceStat = fs.lstatSync(source);
      } catch {
        return errorResult(`source not found: ${source}`);
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
        return errorResult(`cannot move a directory into itself: ${source} -> ${destination}`);
      }

      const destExists = fs.existsSync(destination);
      if (destExists && !overwrite) {
        return errorResult(
          `destination already exists: ${destination} (pass overwrite: true to replace it)`
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
      if (destExists) {
        const rootErr = refuseAllowedDirRoot(destination, ctx.allowedDirs, 'overwrite');
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
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`move failed: ${message}`);
      }

      return textResult(`Moved ${source} to ${destination}`);
    }
  );
}
