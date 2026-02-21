import * as fs from 'fs';
import * as path from 'path';

/**
 * Validate that a path is within the allowed directories.
 * Returns null if valid, or an error message if not.
 */
export function validatePath(filePath: string, allowedDirs: string[]): string | null {
  if (!path.isAbsolute(filePath)) {
    return 'path must be absolute';
  }

  if (allowedDirs.length === 0) {
    return null; // no restrictions
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
