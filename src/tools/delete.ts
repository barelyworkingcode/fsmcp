import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry, schema, stringProp, boolProp, parseBoolArg, requireStringArg } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { checkPathNoFollowFinal, refuseAllowedDirRoot } from '../security';
import { decodeInboundPath } from '../vpath';

// C3: cap total entries a single recursive delete may remove, so a runaway
// (or a caller-supplied path several directories too high) is a loud
// refusal rather than however long it takes to walk and remove everything
// under it.
const MAX_DELETE_ENTRIES = 10_000;

/**
 * Count entries under `dir`, stopping the moment the count exceeds `limit`
 * rather than walking the whole tree first -- a delete this large should be
 * refused quickly, not after fsmcp has already spent the time enumerating
 * everything it was about to remove.
 *
 * A symlink is counted once and never descended into: deleting it is a
 * single unlink() regardless of what it points at or how large that is, the
 * same reasoning `fs_delete`'s handler applies to the entry it was actually
 * asked to remove (C2), extended to everything nested beneath it.
 */
function countEntries(dir: string, limit: number): number {
  let count = 0;

  function walk(current: string): boolean {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      count++;
      if (count > limit) return false;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (!walk(path.join(current, entry.name))) return false;
      }
    }
    return true;
  }

  walk(dir);
  return count;
}

export function registerDelete(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_delete',
      description:
        'Delete a file or directory. Refuses a non-empty directory unless recursive is true. ' +
        'Deleting a symlink removes the link itself, never whatever it points at. Capped at ' +
        `${MAX_DELETE_ENTRIES} entries per recursive delete.`,
      inputSchema: schema(
        {
          path: stringProp('Absolute path to delete'),
          recursive: boolProp('Delete a non-empty directory and its contents (default: false)'),
        },
        ['path']
      ),
      // Removes a local path; never contacts anything off this machine.
      annotations: { readOnlyHint: false, openWorldHint: false },
      category: 'File System',
    },
    (args: Record<string, unknown>, ctx: ToolContext) => {
      const targetPathArg = requireStringArg(args, 'path');
      if (typeof targetPathArg !== 'string') return targetPathArg;

      // Issue #7: decode the client's virtual-space address into the host
      // path checkPathNoFollowFinal (and everything after it) already
      // expects -- see read.ts for the full reasoning. This runs BEFORE C2's
      // no-follow-final check, not instead of it: the decoded string is
      // still literal, un-followed, all the way to basename().
      const decoded = decodeInboundPath(targetPathArg, ctx.labels);
      if (typeof decoded !== 'string') return decoded;
      const targetPath = decoded;

      const recursiveArg = parseBoolArg(args.recursive, 'recursive', false);
      if (typeof recursiveArg !== 'boolean') return recursiveArg;
      const recursive = recursiveArg;

      // C2: validated WITHOUT following the final component. The ordinary,
      // fully-canonicalizing validatePath is right for read and write --
      // the data really does end up wherever a symlink leads, so that is
      // what must be in scope -- and wrong here. Canonicalizing
      // `<root>/link-out` resolves it onto wherever the link points (say,
      // `/etc`), which refuses for the wrong reason and, worse, makes an
      // in-scope symlink permanently undeletable: every attempt to name it
      // resolves onto its target instead of the link, so the sandbox
      // accretes escape hatches it can never clean up. What must be in
      // scope is the directory entry being removed, not whatever it points
      // at.
      const pathErr = checkPathNoFollowFinal(targetPath, ctx.allowedDirs);
      if (pathErr) return pathErr;

      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(targetPath);
      } catch {
        return errorResult(`not found: ${targetPath}`);
      }

      // The sandbox root itself must survive its occupant. Without this, a
      // recursive delete of the allowed_dir root removes the very directory
      // allowed_dirs points at, and every call after it refuses with "path
      // is outside allowed directories" for a root that no longer exists to
      // be inside of -- the tool would have deleted its own floor. Shared
      // with fs_move (security.ts's refuseAllowedDirRoot): this is a rule
      // about the `fs.rmSync(recursive: true)` syscall, not a rule specific
      // to this tool's name, and fs_move makes that same call in its
      // `overwrite: true` branch.
      const rootErr = refuseAllowedDirRoot(targetPath, ctx.allowedDirs, 'delete');
      if (rootErr) return rootErr;

      // A symlink is unlinked directly, whether or not `recursive` was
      // passed and regardless of what it points at -- following it, even to
      // decide whether it "is a directory", is the one thing this branch
      // must never do.
      if (stat.isSymbolicLink() || stat.isFile()) {
        try {
          fs.unlinkSync(targetPath);
        } catch (err: unknown) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
        return textResult(`Deleted ${targetPath}`);
      }

      let children: string[];
      try {
        children = fs.readdirSync(targetPath);
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }

      if (children.length > 0 && !recursive) {
        return errorResult(
          `${targetPath} is not empty (${children.length} entries); pass recursive: true to ` +
            `delete it and its contents`
        );
      }

      if (recursive && children.length > 0) {
        const count = countEntries(targetPath, MAX_DELETE_ENTRIES);
        if (count > MAX_DELETE_ENTRIES) {
          return errorResult(
            `refusing to delete ${targetPath}: contains more than ${MAX_DELETE_ENTRIES} entries; ` +
              `delete a narrower path instead`
          );
        }
      }

      try {
        // Node's recursive fs.rmSync unlinks a symlink it encounters rather
        // than following it into whatever it points at -- which is exactly
        // the containment the rest of this tool depends on for everything
        // under targetPath that was not, and could not have been,
        // individually re-validated on the way in.
        fs.rmSync(targetPath, { recursive: true, force: false });
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }

      return textResult(`Deleted ${targetPath}`);
    }
  );
}
