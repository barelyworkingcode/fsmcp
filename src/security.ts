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
 * at all -- a symlink cycle, or a symlink this process is not allowed to
 * read. Both are the same fact to every caller ("this path has no canonical
 * form I can determine"), and every caller treats it as outside the grant.
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
      let target: string;
      try {
        target = fs.readlinkSync(candidate);
      } catch {
        // A link this process cannot read (issue #36: measured as EACCES
        // from `readlink` on a path under another user's home, reached by
        // an fs_glob walk that had left the grant). `lstat` succeeding and
        // `readlink` failing is a real, ordinary combination -- readdir
        // permission on the parent is enough for the first and not for the
        // second -- and it used to escape this function as a THROW, from
        // three frames inside `validatePath`, in the middle of a tool's
        // result loop. That is the failure shape C6 exists to remove: a
        // path that cannot be resolved is a clean refusal, not an
        // exception. It joins the symlink-cycle case as `null` because it
        // is the same fact -- this path does not have a canonical form
        // this process can determine -- and every caller already treats
        // that as "outside", which is the fail-closed direction: an
        // unreadable link is not evidence of containment.
        return null;
      }
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
    return `path ${filePath} could not be resolved (too many levels of symbolic links, or a symbolic link this server cannot read)`;
  }

  if (isWithinAnyDir(resolved, allowedDirs)) return null;
  return `path ${filePath} is outside allowed directories`;
}

/**
 * Every allowed directory that contains -- or is exactly -- `resolved`,
 * which must already have been through `canonicalizePath`. The entries come
 * back MOST SPECIFIC FIRST (longest resolved directory), matching
 * `hostToVirtual`'s rule for choosing between nested grants, so a caller
 * that wants only one gets the same grant the client sees the path
 * addressed through.
 *
 * This is the single definition of what "inside" means. `isWithinAnyDir`
 * (validatePath, validatePathNoFollowFinal) and `refuseMissingAllowedDirRoot`
 * (issue #33) both go through it rather than each writing a containment loop
 * of its own: two loops asking "is this in scope" and "which grant is it in"
 * separately would be free to drift, and the second one would then be
 * deciding, on its own authority, which grant a path belongs to.
 *
 * It does not short-circuit on the first hit, unlike the loop it replaces.
 * `allowedDirs` is an operator's grant list -- one entry in the deployment
 * this server exists for, a handful at worst -- so the extra
 * `canonicalizePath` calls cost less than a second, subtly different loop
 * would.
 */
function containingAllowedDirs(resolved: string, allowedDirs: string[]): string[] {
  const hits: { dir: string; resolvedDir: string }[] = [];
  for (const dir of allowedDirs) {
    const resolvedDir = canonicalizePath(dir);
    // A directory that will not resolve cannot contain anything; skip it
    // rather than letting it widen the scope.
    if (resolvedDir === null) continue;

    // Ensure trailing separator for prefix check, so /foo does not match
    // /foobar.
    const prefix = resolvedDir.endsWith(path.sep) ? resolvedDir : resolvedDir + path.sep;
    if (resolved === resolvedDir || resolved.startsWith(prefix)) {
      hits.push({ dir, resolvedDir }); // within this allowed dir
    }
  }
  hits.sort((a, b) => b.resolvedDir.length - a.resolvedDir.length);
  return hits.map((h) => h.dir);
}

/**
 * True if `resolved` -- already canonicalized -- sits inside (or is exactly)
 * one of `allowedDirs`. Shared between validatePath (which canonicalizes the
 * whole path) and validatePathNoFollowFinal (which canonicalizes only the
 * dirname), so the two agree on what "inside" means and differ only in what
 * they canonicalize before asking.
 */
function isWithinAnyDir(resolved: string, allowedDirs: string[]): boolean {
  return containingAllowedDirs(resolved, allowedDirs).length > 0;
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
    return `path ${filePath} could not be resolved (too many levels of symbolic links, or a symbolic link this server cannot read)`;
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
 * True when `targetPath` resolves to exactly one of `allowedDirs` -- i.e. it
 * names a grant root itself rather than something inside one.
 *
 * The question is asked of the RESOLVED path, never of the string, because
 * every one of `/d0`, `/d0/`, `/d0/.` and `/d0/notes/..` reaches the same
 * root and only the first of them looks like it (issue #24 confirmed
 * `/d0/notes/..` works). `canonicalizePath` already collapses `.` and
 * applies `..` to what the path has resolved to so far, so routing both
 * sides of the comparison through it is what makes the alias spellings one
 * case instead of four, and makes an in-scope symlink pointing back at the
 * root one case as well.
 *
 * An unresolvable `targetPath` (a symlink cycle) is not a root: the
 * path-governed check upstream (checkPath / checkPathNoFollowFinal) already
 * refused the call before either caller below would run, so there is no
 * path left for them to protect.
 */
function resolvesToAllowedDirRoot(targetPath: string, allowedDirs: string[]): boolean {
  const resolved = canonicalizePath(targetPath);
  if (resolved === null) return false;
  for (const dir of allowedDirs) {
    if (canonicalizePath(dir) === resolved) return true;
  }
  return false;
}

/**
 * ONE rule, two halves: **a path that resolves to a grant root is not a
 * valid target for a tool that removes it (`refuseAllowedDirRoot`, below)
 * and not a valid target for a tool that writes, creates or replaces
 * something at it (`refuseAllowedDirRootWrite`, here).** They live next to
 * each other, share `resolvesToAllowedDirRoot`, and word their refusal
 * identically -- `refusing to <action> an allowed_dir root: <path>` -- so a
 * reader (or an operator reading an audit log) sees one rule with two
 * halves rather than two unrelated accidents that happen to rhyme.
 *
 * The write half is issue #24. `checkPath(<allowed_dir root>)` passes,
 * because a root is inside itself, and then every tool that writes derives
 * a *sibling* path from the target and lands it one level up:
 *
 *   - `writeFileAtomic` (fs_write, fs_edit) builds its temp file at
 *     `path.dirname(filePath)` -- for a root, the directory ABOVE the
 *     sandbox. Reproduced: `fs_write { file_path: "/d0", content: <5MB> }`
 *     left `.grant.fsmcp-tmp-0d851bf52ab9`, 5,000,000 bytes of
 *     caller-chosen content, in the grant's PARENT. Only the `rename` at
 *     the end failed (EISDIR), and only after the bytes were already on
 *     disk outside the grant; with the parent chmod'd 0555 the failure
 *     moves to the `open`, which is what proves the creation was attempted
 *     there rather than merely that the call failed.
 *   - `fs_write`'s `fs.mkdirSync(path.dirname(resolvedPath), { recursive:
 *     true })`, one line earlier, has the same shape and no cleanup at all.
 *   - `fs_mkdir`'s own `fs.mkdirSync(dirPath, { recursive: true })` creates
 *     every missing ancestor of the root, outside it. Reproduced against a
 *     grant whose root did not exist yet: `fs_mkdir { path: "/d0" }`
 *     answered "Created directory: /d0" and created the grant's parent on
 *     the way.
 *
 * "The temp file is unlinked in `writeFileAtomic`'s catch" is not a
 * defence: cleanup is best-effort, it does not run if the process is
 * killed, and a transient file of caller-chosen size and caller-influenced
 * name in `~/Documents` is still a write outside the grant. The whole claim
 * of this server is that `allowed_dirs` is the complete answer to what a
 * client can reach.
 *
 * **The write half is a `scopeViolationResult`; the delete half is a plain
 * `errorResult`. That difference is deliberate, and it is the reason these
 * two are not literally the same function.** `_meta.scope_violation` means
 * "you asked for something outside your scope" and must be set on nothing
 * else (types.ts). Servicing `fs_write` at a root really would have put
 * bytes outside `allowed_dirs`, so refusing it is the sandbox holding, and
 * relay's audit has to record it as such -- before this, the operator saw a
 * bare `tool_error` carrying an `EISDIR` from three stack frames down, with
 * nothing anywhere in the log saying a file had been created outside the
 * granted directory. Servicing `fs_delete` at a root, by contrast, would
 * have removed only something INSIDE the grant (the root itself); that is
 * refused because the sandbox must survive its occupant, not because
 * anything out of scope was addressed, so it stays an ordinary tool error.
 *
 * The caller-side refusal is the fix. `writeFileAtomic` asserting that
 * `path.dirname(filePath)` is in scope is worth having as defence in depth
 * and is deliberately NOT done here (it belongs to that file, which is
 * being rewritten on another branch for a different issue) -- so today this
 * function is the only thing standing between a root-addressed write and
 * the parent directory. Do not remove a call to it without adding that
 * assert first.
 */
export function refuseAllowedDirRootWrite(
  targetPath: string,
  allowedDirs: string[],
  action: string
): MCPCallResult | null {
  if (!resolvesToAllowedDirRoot(targetPath, allowedDirs)) return null;
  return scopeViolationResult(`refusing to ${action} an allowed_dir root: ${targetPath}`);
}

/**
 * Refuse an operation that is about to remove an allowed_dir root outright.
 * The delete-side half of the rule above -- read that comment first.
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
 */
export function refuseAllowedDirRoot(
  targetPath: string,
  allowedDirs: string[],
  action: string
): MCPCallResult | null {
  if (!resolvesToAllowedDirRoot(targetPath, allowedDirs)) return null;
  return errorResult(`refusing to ${action} an allowed_dir root: ${targetPath}`);
}

/**
 * Why `dir` is not usable as a grant root right now, phrased to slot into
 * the sentence `refuseMissingAllowedDirRoot` builds, or null if it is fine.
 *
 * `fs.statSync`, not `lstatSync`: a grant that IS a symlink to a real
 * directory is a perfectly ordinary configuration and must pass, while a
 * DANGLING symlink (the shape a removed volume or a deleted target leaves
 * behind) must not -- following the link is what tells those two apart.
 * Anything that throws is reported as "does not exist": EACCES on the way
 * down is not literally absence, but from this process's position it is the
 * same fact -- fsmcp cannot see a directory there, and it must not create
 * one on the strength of not being able to look.
 */
function grantRootProblem(dir: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch {
    return 'does not exist on the host';
  }
  return st.isDirectory() ? null : 'exists on the host but is not a directory';
}

/**
 * Issue #33: **refuse a call that would create directories inside a grant
 * whose root is not there.** The wider half of the rule above -- #24 closed
 * the grant root ADDRESSED AS THE TARGET, this closes an ordinary,
 * entirely legitimate target whose ancestors do not exist.
 *
 * `fs_write` runs `fs.mkdirSync(path.dirname(resolvedPath), { recursive:
 * true })` and `fs_mkdir` runs `fs.mkdirSync(dirPath, { recursive: true })`.
 * `recursive: true` walks up until it finds a directory that exists, and
 * nothing in it knows where the grant is: the grant root is just another
 * missing component on the way. Reproduced with a grant at
 * `<R>/level1/level2/level3/grant` where only `<R>` existed -- one
 * `fs_write { file_path: "/d0/sub/file.txt" }` created `level1`,
 * `level2` and `level3`, three directories ABOVE the boundary, and reported
 * `Wrote 31 bytes`.
 *
 * **The grant root existing IS the bound.** That is the whole reason this
 * check is sufficient and a per-component mkdir walk (considered, and not
 * written) is not needed: `checkPath` has already established that the
 * canonicalized target sits at or under a grant root, so every directory
 * `recursive: true` would create is a strict descendant of that root -- as
 * long as the root itself is already there for the walk to stop at. Make
 * the root's existence a precondition and the recursive create can no
 * longer reach past it, with the tool's actual job (creating intermediate
 * directories INSIDE the grant, which is documented behaviour) untouched.
 *
 * **Refusing, rather than creating the root and stopping there.** Creating
 * the root cannot be done without creating its missing parents, which are
 * outside the grant by definition, so the "weaker alternative" is not
 * actually available in the case that matters -- it only helps when exactly
 * one component is missing. And an operator's grant that does not describe
 * anything on the host is a configuration mistake that wants to be visible:
 * a typo (`~/Documnets/project`) leaves the agent working productively in a
 * folder nobody will ever look in, and an unmounted volume is worse --
 * granting `/Volumes/Work/project` with the drive unplugged creates
 * `/Volumes/Work/project` on the BOOT DISK, which then shadows the mount
 * point, so macOS mounts the real volume as `/Volumes/Work 1` when it
 * appears. Two directories with confusingly similar names, the agent's work
 * in the wrong one, and no error at any point. `isWithinAnyDir` already
 * treats a granted directory that will not resolve as a real condition and
 * skips it rather than letting it widen the scope; this is the same
 * condition reached by a different route, and it gets the same answer
 * instead of the opposite one.
 *
 * **A plain `errorResult`, NOT `scopeViolationResult`, and that is the
 * considered choice.** `_meta.scope_violation` means "the client addressed
 * something outside its scope" and must keep meaning only that (types.ts).
 * Here the client addressed something squarely INSIDE its scope; the scope
 * itself points at nothing. Flagging it would tell an operator reading
 * `relay audit` that the sandbox caught a client reaching out of bounds,
 * which is false, and would put a configuration error in the same column as
 * a real containment event -- devaluing the one signal that column exists to
 * carry. The unhelpful consequence is that relay currently renders this as a
 * generic `tool_error`; the right fix for that is a distinct operator-facing
 * signal in relay (a `grant_unavailable` field, say), not borrowing this
 * one. Recommended in the issue, deliberately not built here.
 *
 * The message names the GRANT, not the caller's path, and says the retry is
 * pointless. An agent told "no such file or directory" for
 * `/d0/sub/file.txt` concludes it typed something wrong and tries again,
 * possibly forever; it has to be told the failure is in the server's
 * configuration -- something it cannot fix from the client side -- so that
 * it stops and surfaces the problem instead of looping.
 *
 * Callers pass the ALREADY-DECODED host path and wrap the result in
 * `translateResult(result, ctx.allowedDirs, ctx.labels)`. That is why there
 * is no `...V` wrapper in vpath.ts next to `refuseAllowedDirRootWriteV`: the
 * wrappers there translate the TARGET path, and the path embedded here is
 * the granted directory instead, so the host path to rename is the grant,
 * not the argument. Wrapping matters -- an untranslated grant path in an
 * error result trips `redactLeakedHostPaths` and the caller gets the
 * internal-error backstop instead of the explanation.
 *
 * Returns null for a target outside every grant (`checkPath`'s refusal is
 * the right one and comes first anyway) and for an unresolvable one, on the
 * same reasoning as `resolvesToAllowedDirRoot`.
 */
export function refuseMissingAllowedDirRoot(
  targetPath: string,
  allowedDirs: string[],
  action: string
): MCPCallResult | null {
  const resolved = canonicalizePath(targetPath);
  if (resolved === null) return null;

  const containing = containingAllowedDirs(resolved, allowedDirs);
  if (containing.length === 0) return null;

  // Most specific first. A single usable root anywhere in the list is
  // enough: the recursive create stops at whichever ancestor exists, and if
  // that ancestor is itself a granted directory then nothing was created
  // outside the operator's grant, which is the only thing being protected
  // here. Only when EVERY grant containing this path is missing is the
  // creation unbounded.
  let problem: string | null = null;
  let offender = containing[0];
  for (const dir of containing) {
    const dirProblem = grantRootProblem(dir);
    if (dirProblem === null) return null;
    if (problem === null) {
      problem = dirProblem;
      offender = dir;
    }
  }

  return errorResult(
    `the granted directory ${offender} ${problem}, so fsmcp will not ${action} anything inside ` +
      `it. This is a problem with this server's configuration, not with the path you asked for: ` +
      `the path is inside the grant and is not the reason this failed. Retrying, or trying a ` +
      `different path, will not help -- every write into that grant fails until an operator fixes ` +
      `it, usually a typo in the granted path or a volume that is not mounted. fsmcp will not ` +
      `create the granted directory itself: the only way to create it is to create its missing ` +
      `parent directories too, and those are outside the grant.`
  );
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
/**
 * The result of sanitizeMetaAllowedDirs: see below for what each field means
 * and why this exists as a separate step before narrowAllowedDirs at all.
 */
export interface SanitizedMetaDirs {
  metaDirs: string[] | undefined;
  /** True when the raw value was present but not an array of strings. */
  malformed: boolean;
}

/**
 * Validate that a raw `_meta.allowed_dirs` value off the wire is actually
 * the `string[] | undefined` narrowAllowedDirs assumes it is, before it ever
 * reaches that function -- narrowAllowedDirs's own type signature used to be
 * the only thing asserting this, and a type assertion at the wire boundary
 * (`meta?.allowed_dirs as string[] | undefined` in main.ts) checks nothing:
 * it changes what TypeScript believes the value is, not what it is.
 *
 * A caller (or a misbehaving relay) sending `_meta.allowed_dirs` as `null`,
 * a bare object, a number, a boolean, or an array containing a non-string
 * element used to reach `for (const metaDir of metaDirs)` in
 * narrowAllowedDirs's "CLI set" branches with something JavaScript cannot
 * iterate, or reach `canonicalizePath(metaDir)` with something
 * `path.isAbsolute` cannot accept -- both throw synchronously, and that
 * throw happens in main.ts's request handler, OUTSIDE registry.call's
 * try/catch (which wraps only the tool handler, reached later). fsmcp is
 * one synchronous stdio loop serving every caller; an uncaught exception
 * there crashes the whole process, taking down every OTHER in-flight or
 * future call along with the one that sent the bad value. That is a worse
 * outcome than any answer this one call could give, including a wrong one.
 *
 * The fix is not "reject the call with a clean error" alone -- fsmcp does
 * that too, via `malformed`, so an operator can see what happened -- it is
 * that a malformed value is treated exactly like a `_meta.allowed_dirs: []`
 * a caller sent on purpose: an explicit assertion of an empty scope.
 * narrowAllowedDirs already has a rule for "present but empty" (it is not
 * the same as absent, and it does not fall back to the CLI grant -- see its
 * own doc comment), so routing a malformed value through that existing rule
 * means the fail-closed behaviour is proven once, by the tests that already
 * cover the empty-array row, rather than needing a second, parallel
 * fail-closed path that could drift from the first.
 */
export function sanitizeMetaAllowedDirs(raw: unknown): SanitizedMetaDirs {
  if (raw === undefined) return { metaDirs: undefined, malformed: false };
  if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    return { metaDirs: raw as string[], malformed: false };
  }
  return { metaDirs: [], malformed: true };
}

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
