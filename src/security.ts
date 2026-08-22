import * as fs from 'fs';
import * as path from 'path';

/**
 * Message returned whenever a path-governed operation has no allowed
 * directories to work with. Shared so every caller (validatePath, and any
 * tool that must refuse before it even has a candidate path -- e.g. an
 * omitted `path` argument that would otherwise fall back to cwd) says the
 * same thing in the same voice.
 */
export const NO_ALLOWED_DIRS_MESSAGE =
  'no allowed directories are configured; refusing all path access. Start fsmcp with --allowed-dir <path>, or pass allowed_dirs via _meta.';

/**
 * Validate that a path is within the allowed directories.
 * Returns null if valid, or an error message if not.
 *
 * An empty allowedDirs list is a refusal, not "no restrictions": absent and
 * empty scope both mean deny (see relay ADR-011 decision 4 / ADR-009 decision
 * 3). A caller that wants unrestricted access must say so explicitly, e.g.
 * `--allowed-dir /` -- emptiness is never allowed to mean "everything."
 */
export function validatePath(filePath: string, allowedDirs: string[]): string | null {
  if (!path.isAbsolute(filePath)) {
    return 'path must be absolute';
  }

  if (allowedDirs.length === 0) {
    return NO_ALLOWED_DIRS_MESSAGE;
  }

  // Resolve the path to handle .. and symlinks
  let resolved: string;
  try {
    // If path exists, resolve symlinks
    resolved = fs.realpathSync(filePath);
  } catch {
    // Path doesn't exist yet (e.g. fs_write creating a new file).
    // Normalize without symlink resolution.
    resolved = path.resolve(filePath);
  }

  for (const dir of allowedDirs) {
    let resolvedDir: string;
    try {
      resolvedDir = fs.realpathSync(dir);
    } catch {
      resolvedDir = path.resolve(dir);
    }

    // Ensure trailing separator for prefix check
    const prefix = resolvedDir.endsWith(path.sep) ? resolvedDir : resolvedDir + path.sep;
    if (resolved === resolvedDir || resolved.startsWith(prefix)) {
      return null; // within this allowed dir
    }
  }

  return `path ${filePath} is outside allowed directories`;
}

/** Parse --allowed-dir flags from process.argv */
export function parseAllowedDirs(): string[] {
  const dirs: string[] = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--allowed-dir' && i + 1 < args.length) {
      dirs.push(args[i + 1]);
      i++;
    }
  }
  return dirs;
}
