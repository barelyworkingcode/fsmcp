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
 * Upper bound on symlink hops while canonicalising a single path. Linux's
 * own limit is 40; matching it means anything this refuses would have been
 * ELOOP at the syscall anyway.
 */
const MAX_SYMLINK_HOPS = 40;

/** Split a path fragment into its non-empty components. */
function splitComponents(fragment: string): string[] {
  return fragment.split(path.sep).filter((c) => c.length > 0);
}

/**
 * Resolve `inputPath` the way the kernel would, component by component from
 * the root, following every symlink in the part that exists and carrying
 * only the not-yet-existing tail lexically.
 *
 * `fs.realpathSync` cannot do this on its own: it is all-or-nothing, and it
 * throws for a path whose last component does not exist yet -- which is the
 * ordinary case for fs_write creating a new file. Falling back to a flat
 * `path.resolve` for that case (what this used to do) leaves every symlink
 * *component* in the string, so `<allowed>/link/new.txt`, where `link`
 * points outside the allowed directory, passed the containment check and
 * the write then followed the symlink out. An existing file behind the same
 * symlink was correctly refused, so the hole was reachable exactly once per
 * filename and invisible to every read afterwards.
 *
 * Two things this does that a "realpath the parent directory" shortcut does
 * not:
 *
 *  - **`..` is applied to what the path has resolved to so far**, never to
 *    the requested string. Collapsing `..` lexically up front is itself a
 *    hole: with `link -> /elsewhere/deep`, the path
 *    `<allowed>/sub/link/../../x` reads lexically as `<allowed>/x` (inside)
 *    while the kernel resolves it to `/x` (outside).
 *  - **A dangling symlink is followed, not treated as absent.** `realpath`
 *    throws ENOENT for one, which would have put it in the lexical tail --
 *    but a write through `<allowed>/dangling` still creates the file at the
 *    link's target. `lstat` + `readlink` sees the link whether or not its
 *    target exists.
 *
 * Returns the resolved absolute path, or null if it could not be resolved
 * at all (a symlink cycle).
 */
export function canonicalizePath(inputPath: string): string | null {
  const absolute = path.isAbsolute(inputPath) ? inputPath : path.resolve(inputPath);
  const root = path.parse(absolute).root;

  // Everything in `resolved` has already had its symlinks followed, so it is
  // canonical and `path.dirname` of it is canonical too. `tail` holds the
  // components past the last one that exists.
  let resolved = root;
  const tail: string[] = [];
  let pending = splitComponents(absolute.slice(root.length));
  let hops = 0;

  while (pending.length > 0) {
    const comp = pending.shift() as string;
    if (comp === '.') continue;

    if (comp === '..') {
      if (tail.length > 0) tail.pop();
      else resolved = path.dirname(resolved); // dirname('/') === '/', as at the real root
      continue;
    }

    if (tail.length > 0) {
      // Past the last component that exists: nothing below it can be a
      // symlink, so the rest is carried lexically.
      tail.push(comp);
      continue;
    }

    const candidate = path.join(resolved, comp);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(candidate);
    } catch {
      // Does not exist yet (fs_write creating a file), or is not readable --
      // either way nothing further resolves through it, and an operation
      // that cannot traverse it here cannot traverse it later either.
      tail.push(comp);
      continue;
    }

    if (st.isSymbolicLink()) {
      if (++hops > MAX_SYMLINK_HOPS) return null;
      const target = fs.readlinkSync(candidate);
      if (path.isAbsolute(target)) {
        const targetRoot = path.parse(target).root;
        resolved = targetRoot;
        pending = [...splitComponents(target.slice(targetRoot.length)), ...pending];
      } else {
        pending = [...splitComponents(target), ...pending];
      }
      continue;
    }

    resolved = candidate;
  }

  return tail.length > 0 ? path.join(resolved, ...tail) : resolved;
}

/**
 * Validate that a path is within the allowed directories.
 * Returns null if valid, or an error message if not.
 *
 * An empty allowedDirs list is a refusal, not "no restrictions": absent and
 * empty scope both mean deny (see relay ADR-011 decision 4 / ADR-009 decision
 * 3). A caller that wants unrestricted access must say so explicitly, e.g.
 * `--allowed-dir /` -- emptiness is never allowed to mean "everything."
 *
 * TOCTOU: this is a check-then-use, and a correct resolution can still be
 * raced -- an attacker who can swap a component for a symlink between this
 * call and the tool's own open() defeats it, as it defeats any check-then-use.
 * That is deliberately not defended against here. allowed_dirs is a scope
 * limit on what *this* process will do on behalf of a caller, not a boundary
 * between two security principals: winning the race requires the ability to
 * create a symlink inside an allowed directory, which is the same user who
 * already runs fsmcp and can therefore write those files directly, with no
 * MCP server involved. The race grants no capability its winner lacks. If
 * fsmcp ever runs as a user more privileged than whoever can write into an
 * allowed directory, the fix is not a better check but enforcement at the
 * syscall: open the file with `O_NOFOLLOW` (and each directory along the way
 * with `O_NOFOLLOW | O_DIRECTORY`, i.e. openat-per-component from a pinned
 * root fd), so the kernel refuses the traversal instead of this function
 * predicting it.
 */
export function validatePath(filePath: string, allowedDirs: string[]): string | null {
  if (!path.isAbsolute(filePath)) {
    return 'path must be absolute';
  }

  if (allowedDirs.length === 0) {
    return NO_ALLOWED_DIRS_MESSAGE;
  }

  const resolved = canonicalizePath(filePath);
  if (resolved === null) {
    return `path ${filePath} could not be resolved (too many levels of symbolic links)`;
  }

  for (const dir of allowedDirs) {
    const resolvedDir = canonicalizePath(dir);
    // A directory that will not resolve cannot contain anything; skip it
    // rather than letting it widen the scope.
    if (resolvedDir === null) continue;

    // Ensure trailing separator for prefix check, so /foo does not match
    // /foobar.
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
