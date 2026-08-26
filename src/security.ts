import * as fs from 'fs';
import * as path from 'path';
import { MCPCallResult, errorResult, scopeViolationResult } from './types';

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

/**
 * Upper bound on the length of a path string this server will even look at,
 * matching Linux's PATH_MAX. Nothing here traverses a path that long without
 * this check -- the difference is *how* it fails. Left unchecked, a path
 * this long either throws deep inside `fs.lstatSync` (an exception the
 * per-component loop below would swallow as "does not exist yet", changing
 * the answer, not just the failure mode) or degrades into a very slow
 * component-by-component walk. Checked up front, it is a clean refusal (C6):
 * an error result, not a surprise thrown from three stack frames away.
 */
const MAX_PATH_LENGTH = 4096;

/**
 * The checks every path-governed operation needs regardless of which flavour
 * of containment check runs afterwards (canonicalize-everything for
 * validatePath, canonicalize-the-parent-only for validatePathNoFollowFinal).
 * Factored out so both stay in exact agreement on what counts as a
 * malformed path (C6), rather than each re-deriving it.
 *
 * A NUL byte is refused here rather than left to Node: `fs.lstatSync` throws
 * synchronously for one (`ERR_INVALID_ARG_VALUE`), which is exactly the kind
 * of exception-across-the-tool-boundary C6 exists to rule out, and it is a
 * clearer refusal than whatever message that exception happens to carry.
 */
function basicPathError(filePath: string): string | null {
  if (!path.isAbsolute(filePath)) return 'path must be absolute';
  if (filePath.includes('\0')) return 'path must not contain a NUL byte';
  if (filePath.length > MAX_PATH_LENGTH) {
    return `path exceeds the maximum length of ${MAX_PATH_LENGTH} characters`;
  }
  return null;
}

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
 *
 * C7 restates this for fs_mkdir, fs_move and fs_delete, since it would be
 * easy to read "mutating tools" as a reason this reasoning needs
 * revisiting: it does not. Every one of them still checks a path and then
 * acts on it in a later syscall, and the race described above still grants
 * its winner nothing beyond what they could already do by writing into the
 * allowed directory directly -- there is no privilege boundary here for a
 * race to cross. This is a documented non-goal, not an oversight, and it
 * stays one for exactly as long as fsmcp runs as the same user as everyone
 * who can write into an allowed_dir.
 */
export function validatePath(filePath: string, allowedDirs: string[]): string | null {
  const basicErr = basicPathError(filePath);
  if (basicErr) return basicErr;

  if (allowedDirs.length === 0) {
    return NO_ALLOWED_DIRS_MESSAGE;
  }

  const resolved = canonicalizePath(filePath);
  if (resolved === null) {
    return `path ${filePath} could not be resolved (too many levels of symbolic links)`;
  }

  if (isWithinAnyDir(resolved, allowedDirs)) return null;
  return `path ${filePath} is outside allowed directories`;
}

/**
 * True if `resolved` -- already canonicalized -- sits inside (or is exactly)
 * one of `allowedDirs`. Shared between validatePath (which canonicalizes the
 * whole path) and validatePathNoFollowFinal (which canonicalizes only the
 * dirname), so the two agree on what "inside" means and differ only in what
 * they canonicalize before asking.
 */
function isWithinAnyDir(resolved: string, allowedDirs: string[]): boolean {
  for (const dir of allowedDirs) {
    const resolvedDir = canonicalizePath(dir);
    // A directory that will not resolve cannot contain anything; skip it
    // rather than letting it widen the scope.
    if (resolvedDir === null) continue;

    // Ensure trailing separator for prefix check, so /foo does not match
    // /foobar.
    const prefix = resolvedDir.endsWith(path.sep) ? resolvedDir : resolvedDir + path.sep;
    if (resolved === resolvedDir || resolved.startsWith(prefix)) {
      return true; // within this allowed dir
    }
  }
  return false;
}

/**
 * C2: validate a path the way `fs_delete` needs -- everything up to the
 * final component canonicalized and checked as usual, but the final
 * component itself taken literally, un-followed.
 *
 * `validatePath` canonicalizes the whole path, which is the right answer for
 * every other tool: reading or writing "through" a symlink means the data
 * really does end up at the link's target, so that target is what must be in
 * scope. Delete is the one operation where that is the wrong question.
 * Deleting `<root>/link-out` (a symlink living inside the sandbox, pointing
 * at `/etc`) must remove the link -- an in-scope directory entry -- and must
 * never touch `/etc`. Canonicalizing first resolves the path onto `/etc` and
 * (correctly) refuses it, but that also makes an in-scope symlink
 * impossible to ever clean up: the sandbox can accrete escape hatches that
 * `fs_delete` can never reach, because every attempt to name one resolves
 * onto its target instead of the link.
 *
 * So: canonicalize `dirname(filePath)` (symlinks in a path *up to* the entry
 * being deleted are still real traversal and must still be resolved and
 * checked -- this is not a blanket "don't follow anything" mode), re-join
 * `basename(filePath)` without resolving it, and check containment on that.
 * The caller then uses `lstat`/`unlink` on the exact path handed back --
 * never `stat`, or the same follow happens one line later.
 */
export function validatePathNoFollowFinal(filePath: string, allowedDirs: string[]): string | null {
  const basicErr = basicPathError(filePath);
  if (basicErr) return basicErr;

  if (allowedDirs.length === 0) {
    return NO_ALLOWED_DIRS_MESSAGE;
  }

  const base = path.basename(filePath);
  if (base === '' || base === '.' || base === '..') {
    return `path ${filePath} does not name a removable entry`;
  }

  const resolvedDir = canonicalizePath(path.dirname(filePath));
  if (resolvedDir === null) {
    return `path ${filePath} could not be resolved (too many levels of symbolic links)`;
  }

  const resolved = path.join(resolvedDir, base);
  if (isWithinAnyDir(resolved, allowedDirs)) return null;
  return `path ${filePath} is outside allowed directories`;
}

/**
 * A refusal message qualifies as a *scope* violation -- as opposed to a
 * refusal for some other reason (bad regex, file not found, malformed path)
 * -- exactly when it is one of the two sentences above: "no allowed
 * directories are configured" (an empty scope refuses everything) or "is
 * outside allowed directories" (a real scope, but this path is not in it).
 * String comparison rather than a shared error-code enum is deliberate: it
 * keeps validatePath's return type exactly `string | null`, which
 * security.test.js already asserts against directly, and it means a new
 * failure mode added to validatePath in future is *not* a scope violation by
 * default -- it has to spell out one of these two sentences to become one.
 */
function isScopeViolationMessage(message: string): boolean {
  return message === NO_ALLOWED_DIRS_MESSAGE || message.endsWith('is outside allowed directories');
}

/**
 * Convenience for tool handlers: run a path check and, on failure, hand back
 * the exact MCPCallResult the tool should return -- with
 * `_meta.scope_violation` set when (and only when) the refusal is "this is
 * outside what you're allowed to touch," never for a malformed-input
 * refusal (not absolute, NUL byte, unresolvable symlink chain) or any other
 * kind of tool error. Relay's audit reads `_meta.scope_violation` off a
 * `tool_error` result and records it as a field on that outcome rather than
 * a distinct outcome of its own, so getting this classification right is
 * what lets an operator tell "the sandbox held" apart from "the tool broke"
 * in the log -- see the acceptance table in issue #5, row 18.
 */
export function checkPath(filePath: string, allowedDirs: string[]): MCPCallResult | null {
  const message = validatePath(filePath, allowedDirs);
  if (message === null) return null;
  return isScopeViolationMessage(message) ? scopeViolationResult(message) : errorResult(message);
}

/** Same as checkPath, but built on validatePathNoFollowFinal (C2) for fs_delete. */
export function checkPathNoFollowFinal(filePath: string, allowedDirs: string[]): MCPCallResult | null {
  const message = validatePathNoFollowFinal(filePath, allowedDirs);
  if (message === null) return null;
  return isScopeViolationMessage(message) ? scopeViolationResult(message) : errorResult(message);
}

/**
 * Refuse an operation that is about to remove an allowed_dir root outright.
 *
 * Originally this check lived only inside fs_delete: "the sandbox root must
 * survive its occupant." It was not actually a delete-shaped rule, though --
 * it is a rule about the syscall `fs.rmSync(recursive: true)`, and fs_delete
 * is not the only tool that makes that call. fs_move's `overwrite: true`
 * branch runs exactly the same `fs.rmSync(destination, { recursive: true,
 * force: true })` to clear the destination before renaming onto it, with no
 * guard of its own -- a recursive delete wearing fs_move's name rather than
 * fs_delete's. `checkPath(<allowed_dir root>)` passes, because a root is
 * inside itself, so
 *
 *     fs_move { source: "<root>/a.txt", destination: "<root>", overwrite: true }
 *
 * reached that rmSync with nothing standing between the caller and the
 * sandbox root, and erased it. Hoisting the guard here means every tool
 * whose syscall removes a path checks the same thing the same way, instead
 * of each mutating tool having to remember, on its own, that this is a rule
 * it also needs.
 *
 * An unresolvable `targetPath` (e.g. a symlink cycle) is not guarded here --
 * `canonicalizePath` returning null means the path-governed check upstream
 * (checkPath / checkPathNoFollowFinal) already refused the call before this
 * function would ever run, so there is no path left for this to protect.
 */
export function refuseAllowedDirRoot(
  targetPath: string,
  allowedDirs: string[],
  action: string
): MCPCallResult | null {
  const resolved = canonicalizePath(targetPath);
  if (resolved === null) return null;
  for (const dir of allowedDirs) {
    if (canonicalizePath(dir) === resolved) {
      return errorResult(`refusing to ${action} an allowed_dir root: ${targetPath}`);
    }
  }
  return null;
}

/** The result of combining CLI and _meta allowed dirs: see narrowAllowedDirs. */
export interface NarrowedDirs {
  allowedDirs: string[];
  /** _meta dirs that were supplied but rejected for not narrowing the CLI grant. */
  droppedMetaDirs: string[];
}

/**
 * C1 (highest severity): combine `--allowed-dir` CLI flags with relay's
 * per-call `_meta.allowed_dirs` under the rule that `_meta` may only ever
 * *narrow* what the operator already granted, never widen it.
 *
 * main.ts used to compute `[...cliAllowedDirs, ...metaDirs]` -- a union. Under
 * relay, `_meta` is a field relay populates from context an operator
 * configured elsewhere in the chain, so it looks like a trusted input. But
 * fsmcp cannot verify that anything upstream of `_meta` enforced anything:
 * it must treat `_meta` as caller-supplied, the same as any other argument on
 * the wire. A union lets a caller who can put *any* value into `_meta` widen
 * its own sandbox -- `_meta.allowed_dirs: ["/"]` against a server launched
 * with `--allowed-dir <root>` was a one-line, unauthenticated escape from
 * `<root>` to the whole filesystem.
 *
 * The table this implements (all four rows, in one place, so no call site
 * has to re-derive it and no call site can get away with only handling the
 * cases it happened to think of):
 *
 *   CLI set   | _meta set   | effective scope
 *   ----------|-------------|----------------------------------------------
 *   yes       | yes         | intersection: each _meta dir kept only if it
 *             |             | canonicalizes inside some CLI dir; the rest
 *             |             | are dropped (and reported -- see below)
 *   yes       | no          | CLI dirs, unchanged
 *   no        | yes         | _meta dirs (relay-mediated mode: the operator's
 *             |             | grant lives entirely in relay's context, and
 *             |             | there is no CLI grant for it to be checked
 *             |             | against)
 *   no        | no          | empty, i.e. deny all (fefb031, unchanged)
 *
 * "`_meta` set" means the caller supplied an `allowed_dirs` array at all --
 * including an empty one, which is a caller *asserting* a scope of nothing,
 * not the absence of an opinion. The caller in main.ts is responsible for
 * telling "absent" (`undefined`) apart from "present but empty" (`[]`)
 * before this function ever sees `metaDirs`; conflating them (as the old
 * `?? []` did) is exactly what made "no _meta key" and "no _meta.allowed_dirs
 * key" and "_meta.allowed_dirs: []" indistinguishable, which happened not to
 * matter for a union but would silently break the "no" row above for an
 * intersection.
 *
 * A dropped `_meta` dir is returned, not swallowed: the caller (main.ts)
 * reports it on the result rather than narrowing the scope in a way nothing
 * ever tells the operator about.
 */
export function narrowAllowedDirs(cliDirs: string[], metaDirs: string[] | undefined): NarrowedDirs {
  if (cliDirs.length === 0) {
    // No CLI grant to intersect against: _meta is the whole scope when
    // present, and an absent _meta leaves the (correct, fail-closed) empty
    // default alone.
    return { allowedDirs: metaDirs ?? [], droppedMetaDirs: [] };
  }

  if (metaDirs === undefined) {
    return { allowedDirs: cliDirs, droppedMetaDirs: [] };
  }

  const allowedDirs: string[] = [];
  const droppedMetaDirs: string[] = [];
  for (const metaDir of metaDirs) {
    const resolvedMeta = canonicalizePath(metaDir);
    const contained = resolvedMeta !== null && isWithinAnyDir(resolvedMeta, cliDirs);
    if (contained) {
      allowedDirs.push(metaDir);
    } else {
      droppedMetaDirs.push(metaDir);
    }
  }
  return { allowedDirs, droppedMetaDirs };
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
