import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry, schema, stringProp, optionalStringArg } from '../registry';
import { textResult, errorResult, scopeViolationResult, ToolContext } from '../types';
import { checkPath, NO_ALLOWED_DIRS_MESSAGE } from '../security';

const MAX_ENTRIES = 5000;

function entryType(entry: fs.Dirent): string {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  return 'other';
}

/**
 * List one directory's immediate children.
 *
 * `lstat`, never `stat`: fs_list names what physically sits in the directory
 * entry table, not what a symlink among them points at. Reporting a symlink
 * as "symlink", with the size and mtime of the link itself, means an entry
 * pointing outside the allowed directory is disclosed only as a name and a
 * type -- exactly what it is -- with nothing about it resolved or followed.
 * There is no recursion here for the same fs_glob/fs_grep-shaped reasoning
 * to apply to: every path this returns is `path.join(dir, entry.name)` for
 * an `entry.name` readdir itself produced, which cannot contain a path
 * separator or `..`, so it cannot name anything outside `dir` no matter what
 * that entry turns out to be.
 */
function listOneDir(dir: string): { lines: string[] } | { error: string } {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  const lines: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let size = 0;
    let mtime = '';
    try {
      const st = fs.lstatSync(full);
      size = st.size;
      mtime = st.mtime.toISOString();
    } catch {
      // Vanished between readdir and lstat; still name it, with no stats.
    }
    lines.push(`${entryType(entry)}\t${size}\t${mtime}\t${full}`);
  }
  return { lines };
}

export function registerList(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_list',
      description:
        'List the immediate contents of a directory (non-recursive). One line per entry: ' +
        '"type\\tsize\\tmtime\\tpath". Defaults to the allowed directories when path is omitted. ' +
        `Capped at ${MAX_ENTRIES} entries.`,
      inputSchema: schema(
        {
          path: stringProp('Directory to list (defaults to the allowed directories)'),
        },
        []
      ),
      // Reads directory entries on the local filesystem only.
      annotations: { readOnlyHint: true, openWorldHint: false },
      category: 'File System',
    },
    (args: Record<string, unknown>, ctx: ToolContext) => {
      const pathArg = optionalStringArg(args, 'path');
      if (typeof pathArg === 'object') return pathArg; // a wrong-typed path is an MCPCallResult refusal

      let dirs: string[];

      if (pathArg && pathArg !== '.') {
        const p = pathArg;
        const pathErr = checkPath(p, ctx.allowedDirs);
        if (pathErr) return pathErr;
        let st: fs.Stats;
        try {
          st = fs.statSync(p);
        } catch {
          return errorResult(`directory not found: ${p}`);
        }
        if (!st.isDirectory()) return errorResult(`not a directory: ${p}`);
        dirs = [p];
      } else if (ctx.allowedDirs.length > 0) {
        // An absent path resolves to the scope, not to cwd or to everything
        // -- the same reconciliation contract fs_glob/fs_grep already honour
        // (relay's context-schema doc, "What the MCP must do").
        dirs = ctx.allowedDirs.filter((d) => {
          try {
            return fs.statSync(d).isDirectory();
          } catch {
            return false;
          }
        });
        if (dirs.length === 0) return errorResult('none of the allowed directories exist');
      } else {
        return scopeViolationResult(NO_ALLOWED_DIRS_MESSAGE);
      }

      const allLines: string[] = [];
      for (const dir of dirs) {
        const result = listOneDir(dir);
        if ('error' in result) return errorResult(`list error: ${result.error}`);
        allLines.push(...result.lines);
      }

      const truncated = allLines.length > MAX_ENTRIES;
      const capped = allLines.slice(0, MAX_ENTRIES);
      const suffix = truncated
        ? `\n\n(showing ${MAX_ENTRIES} of ${allLines.length} entries)`
        : '';

      if (capped.length === 0) return textResult('(empty)');
      return textResult(capped.join('\n') + suffix);
    }
  );
}
