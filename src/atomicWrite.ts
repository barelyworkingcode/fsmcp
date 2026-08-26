import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

/**
 * `/bin/cp`, spelled absolutely and on purpose.
 *
 * Every other subprocess in this tree (`rg`, for fs_grep and fs_find) is
 * resolved through PATH, because ripgrep is an optional third-party binary
 * that lives wherever the operator installed it and the tools that use it
 * fall back to a Node implementation when it is missing. Neither is true
 * here: this is a platform binary at a fixed location, it is not optional
 * on the branch that reaches it, and a PATH lookup would mean the metadata
 * of a granted file depends on a `cp` an unrelated part of the environment
 * put earlier on PATH than /bin. There is no fallback to make that safe, so
 * there is no PATH lookup.
 */
const CP = '/bin/cp';

/**
 * Copy the target's extended attributes and ACL onto the temp file that is
 * about to replace it, by seeding that temp file as a full copy of the
 * target and then overwriting its content.
 *
 * ## Why a subprocess at all
 *
 * rename(2) replaces the target's directory entry, inode and all, so the
 * replacement carries exactly what fsMCP put on the new inode and nothing
 * else. Node can put the content there (`writeFileSync`) and the permission
 * bits (`chmodSync`) -- it has no binding for anything else an inode
 * carries. There is no `listxattr`/`getxattr`/`setxattr` in `fs`, no ACL
 * API at all, and no FFI in core Node, so a fix that keeps them cannot be
 * written in Node calls. macOS's own answer is `copyfile(3)` with
 * `COPYFILE_XATTR | COPYFILE_ACL`, and `/bin/cp -p` is that call with a
 * command-line front end (its man page states the guarantee explicitly:
 * "Access Control Lists (ACLs) and Extended Attributes (EAs), including
 * resource forks, will also be preserved").
 *
 * ## What was tried and rejected
 *
 * - **`fs.copyFileSync`**, with and without `COPYFILE_FICLONE`. Measured on
 *   macOS 26: it preserves neither. libuv copies through already-open file
 *   descriptors, so the xattrs and the ACL are simply not part of what it
 *   moves. It would also have meant arguing a link-primitive back into
 *   `no-link-primitive.test.js`'s forbidden list for a call that does not
 *   solve the problem.
 * - **`cp -c`** (clonefile(2), O(1) on APFS regardless of file size, with an
 *   automatic fallback to copyfile elsewhere). This is the obvious way to
 *   stop paying for the copy of the old content below, and it is wrong:
 *   measured on macOS 26, `cp -pcN` of a file carrying both an ACL and
 *   xattrs produced a copy with the xattrs and NO ACL, silently. Buying
 *   speed by dropping the exact metadata this function exists to preserve
 *   is the bug, not the fix, so `-c` is not passed.
 * - **`xattr(1)` in a loop plus `ls -le` piped into `chmod -E`** -- read each
 *   attribute out and set it back, then parse the ACL out of `ls` and
 *   re-apply it. Binary-safe in principle (`xattr -p -x` / `-w -x` speak
 *   hex), but it is one spawn per attribute plus two more for the ACL, it
 *   makes fsMCP a parser of `ls(1)`'s human-readable output, and it
 *   round-trips ACEs through a text form that has already been observed to
 *   lose information (a `chmod -E` fed `ls -le`'s own output verbatim fails
 *   outright -- the leading ACE index is not part of the grammar it reads).
 *   One `copyfile(3)` that the platform maintains beats five spellings of it
 *   that fsMCP maintains.
 *
 * ## Containment
 *
 * This is the only subprocess in fsMCP that writes anything (`rg` only
 * reads), so it needs the argument `no-link-primitive.test.js` asks for.
 *
 * - It is `execFileSync` with an argv array, like every other spawn in this
 *   codebase. There is no shell anywhere in this process and this does not
 *   introduce one: no string is ever concatenated into a command line, so
 *   there is no quoting, globbing, `$(...)` or `;` for a path to smuggle
 *   anything through.
 * - It takes exactly two operands and both belong to fsMCP. `to` is
 *   `tmpPath`, which `writeFileAtomic` built itself, one line earlier, from
 *   `path.dirname(filePath)` and six bytes of `crypto.randomBytes` -- it is
 *   never derived from a client argument and cannot be aimed. `from` is the
 *   same `filePath` that `writeFileSync` and `renameSync` are about to
 *   operate on, which every caller has already put through `checkPathV` and
 *   `canonicalizePath`. So `cp` cannot reach a path the five fs calls in
 *   this function could not already reach, in either direction, and the
 *   direction that WRITES is the one pointed at fsMCP's own temp file.
 * - It is not `fs.copyFileSync`'s problem in a new costume. What
 *   `no-link-primitive.test.js` says about that call is "it writes to a
 *   destination that no handler in this tree validates"; the destination
 *   here is not caller-derived at all, so there is no destination to
 *   validate.
 * - No `-R`: it cannot descend into a directory. No `-l`/`-s`: it cannot
 *   create a hard link or a symlink, which is the property that whole test
 *   file exists to protect. `--` terminates option parsing, so neither
 *   operand can be read as a flag even though both are absolute and could
 *   not be anyway.
 * - `-N` suppresses BSD file flags. Without it, `uchg` (user-immutable) on
 *   the target would be copied onto the temp file, and the very next
 *   `writeFileSync` would fail EPERM against a temp file that then cannot
 *   be unlinked either -- turning a failed write into a permanent stray
 *   file inside a granted directory. Flags were not preserved across the
 *   replace before this change and are not preserved now; that is stated
 *   rather than quietly fixed.
 *
 * ## Cost
 *
 * `cp` copies the old content too, and that content is then thrown away by
 * the `writeFileSync` that follows. There is no metadata-only copy in the
 * platform's command-line surface (see `-c` above for the fast path that
 * would have avoided it, and why it is not usable), so a replace of an
 * existing file now reads and writes the old bytes once more than it used
 * to. Peak disk usage is unchanged -- the temp file holds the old content
 * or the new one, never both -- and the extra I/O is bounded by the size of
 * the file being replaced.
 */
function copyAttributes(from: string, to: string): void {
  // stdio: 'pipe', not the default. execFileSync lets a child's stderr
  // through to the parent's stderr unless told otherwise, and this process
  // speaks JSON-RPC on stdout with stderr as its only diagnostic channel;
  // cp's own diagnostics are handled by the caller instead, which knows how
  // to say what actually went wrong.
  execFileSync(CP, ['-pN', '--', from, to], { stdio: 'pipe' });
}

/**
 * Replace `filePath`'s content with `data`, atomically.
 *
 * fs.writeFileSync(filePath, data) opens the target with O_TRUNC before a
 * single byte of `data` is written, so ANY failure after that point --
 * ENOSPC, EDQUOT, the process being killed, the machine losing power --
 * leaves the file exactly where the truncate left it: usually zero bytes,
 * never the old content and never the new content. Measured against a
 * deliberately undersized filesystem (a 1MB HFS+ volume, hdiutil-created): a
 * write of 2MB over a 512000-byte file hit ENOSPC partway through and left
 * the file at 0 bytes, with fs_write correctly reporting the error -- but
 * the original 512000 bytes were already gone by the time the error was
 * reported. fs_edit reproduced the identical loss through its own
 * fs.writeFileSync call on the same kind of small volume. Neither tool did
 * anything wrong by the standard of "did it report failure honestly"; the
 * bug is that the ON-DISK file has three possible states after a call that
 * touches it this way (old content, new content, or truncated garbage) when
 * a caller can only plan for two.
 *
 * The fix is the standard one: write the new bytes to a fresh file in the
 * SAME directory (same filesystem, so the rename below is a metadata
 * operation, not a copy across devices that could itself fail midway) and
 * rename it over the target. rename(2) is specified to atomically replace
 * an existing destination on POSIX -- there is no window where a reader
 * observes a partial file, and if writing the temp file fails, `filePath`
 * itself was never opened, so it is untouched. Writing to `filePath`
 * directly and hoping nothing goes wrong between open and close is not an
 * alternative; that is exactly the mechanism that lost the 512000 bytes
 * above.
 *
 * ## What the replace preserves, and what it does not (issue #20)
 *
 * The replaced file is a NEW INODE. Everything the old inode carried is
 * therefore lost unless this function puts it back, and "the permission
 * bits" is not the whole list -- an earlier version of this comment argued
 * that case correctly for `st_mode` and then stopped there, which is how
 * every fs_edit and fs_write on a Finder-tagged, Spotlight-indexed,
 * quarantined or ACL'd file came to destroy that metadata silently, on a
 * success result, with a clean `ok` in the audit log.
 *
 * Preserved, deliberately:
 *   - **the permission bits**, exactly (see the `mode` section below),
 *   - **extended attributes** -- Finder tags and comments, Spotlight
 *     metadata, `com.apple.quarantine`, and whatever else an application
 *     hung off the file,
 *   - **the ACL**, on macOS.
 *
 * NOT preserved, and each for a stated reason:
 *   - **hard links.** rename(2) replaces the directory entry `filePath`
 *     names; a second name for the OLD inode still points at the old inode,
 *     which still holds the old content. Verified: after an fs_write, the
 *     target has a fresh inode with `st_nlink` 1 and the sibling link is
 *     unchanged. This is not a defect to fix -- it is what atomic replace
 *     IS. A version that kept the link would have to write through the
 *     existing inode, which is the truncate-then-write this function exists
 *     to replace, and it would trade a visible, local surprise (one of two
 *     names diverged) for the invisible, unrecoverable one (the file is
 *     zero bytes and the old content is gone). It is documented in the
 *     README rather than repaired.
 *   - **setuid, setgid and the sticky bit.** Dropped on purpose, by the
 *     `& 0o777` below; see the `mode` section.
 *   - **BSD file flags** (`uchg`, `hidden`, ...). Not preserved before this
 *     change and not preserved now -- `cp -N` in copyAttributes suppresses
 *     them, for a reason that is about not stranding temp files rather than
 *     about the flags themselves.
 *   - **ownership, and the mtime/ctime/birthtime of the old inode.** The
 *     replacement is owned by whoever runs fsMCP, and its timestamps are
 *     those of the write that just happened -- which is correct: the file
 *     really was just modified, and a replace that restored the old mtime
 *     would lie to every build system and backup tool that reads it.
 *
 * ## Extended attributes and ACLs
 *
 * Copied by `copyAttributes` above, which seeds the temp file as a `cp -p`
 * of the target before the new content is written over it. The order is
 * what makes this work with no extra mechanism: truncating and rewriting a
 * file does NOT clear its xattrs or its ACL (they belong to the inode, not
 * to its contents), so the temp file still carries everything the target
 * carried once `writeFileSync` has replaced its bytes.
 *
 * Three properties this deliberately has:
 *
 *   - **It is skipped entirely when there is nothing to preserve.** No
 *     existing file (`mode === undefined`) means no attributes and no
 *     subprocess; fs_write creating a new file costs exactly what it cost
 *     before.
 *   - **It is skipped for anything that is not a regular file.** `mode` is
 *     the caller's raw `st_mode`, file-type bits included, so this costs no
 *     syscall and opens no second race window. It matters for more than
 *     tidiness: `cp` on a FIFO reads the FIFO, and this server is
 *     synchronous and single-threaded, so a `cp` of a named pipe nobody is
 *     writing to would hang fsMCP forever. A caller that passes only
 *     permission bits reads as "not a regular file" and gets the old
 *     behaviour, which is the safe direction for that mistake to fail in.
 *   - **A failure to copy the attributes fails the WRITE.** If `cp` cannot
 *     read the target (mode 0200, say), fsMCP cannot know what metadata is
 *     on it, let alone preserve it -- and the one outcome ruled out here is
 *     replacing the file anyway and destroying whatever was there. The
 *     write is refused, the original is untouched (nothing has been renamed
 *     yet), and the error says so. This is a real behaviour change for the
 *     narrow case of an unreadable-but-writable target, and it is the
 *     "detect and refuse" fallback from issue #20 applied exactly where
 *     detection is impossible.
 *
 * **macOS only, on purpose, and a no-op elsewhere rather than a throw.**
 * The `-p` guarantee above is BSD `cp`'s; GNU coreutils `cp -p` means
 * `--preserve=mode,ownership,timestamps` and does NOT include xattrs, `-N`
 * is not a GNU flag at all, and the Linux ACL story is a different
 * mechanism again (POSIX ACLs living in `system.posix_acl_access`). Sending
 * the same argv everywhere would fail on Linux immediately and loudly, for
 * every write, which is worse than the bug: shipping an untested argv to a
 * platform this change cannot be verified on is not portability. So
 * non-Darwin platforms keep exactly the behaviour they had -- the mode fix
 * below is portable and applies everywhere -- and the xattr/ACL gap there
 * is recorded in README and CLAUDE.md as a known gap rather than papered
 * over.
 *
 * ## mode
 *
 * `mode`, when given, preserves an existing file's permission bits across
 * the replace. Without it the temp file is a brand-new inode created with
 * the process's default mode (0o666 minus umask), and rename() replaces the
 * target's directory entry -- inode, permissions and all -- with that new
 * one: a shell script edited with fs_edit would lose its execute bit on
 * every single edit, trading one silent corruption (content, fixed by this
 * same function) for another (metadata, introduced by the fix).
 *
 * **It is applied with `fs.chmodSync`, and passing it to `writeFileSync`'s
 * own `mode` option instead is a bug, not an optimisation.** An earlier
 * version of this function did exactly that, to stay inside the five-call
 * mutating surface `no-link-primitive.test.js` pins, and the result was
 * that it did not preserve the mode at all: `writeFileSync`'s `mode` is
 * `open(2)`'s `mode`, and `open(2)`'s mode is masked by the process umask.
 * Under the macOS default `umask 022`, measured: a 0664 file came back 0644
 * and a 0777 file came back 0755 -- the group-write bit silently removed
 * from every group-writable file in a shared folder, on the agent's first
 * edit, with a success result. `chmod(2)` does not consult the umask, which
 * is why the correct call is the one the surface argument talked the
 * previous version out of making. The right response to a syscall budget
 * and a correctness requirement disagreeing is to spend the syscall and
 * write the containment argument, which is below.
 *
 * `mode & 0o777`: `fs.statSync`'s mode carries file-type bits (S_IFREG,
 * ...) alongside the permission bits, and only the permission bits are this
 * function's business. The setuid/setgid/sticky bits are dropped
 * deliberately rather than replicated blind, and that reasoning survives
 * this change intact -- nothing about "preserve the execute bit across an
 * edit" implies "also preserve setuid across a rewrite to a fresh inode,"
 * and it is now load-bearing in a way it was not before: `cp -p` DOES copy
 * setuid, so without this mask a `cp`-seeded temp file could carry the
 * setuid bit of a file whose content an agent just rewrote. **fsMCP cannot
 * create a setuid, setgid or sticky file, and this line is why.** The
 * `chmodSync` runs on both branches, after `cp`, for exactly that reason.
 *
 * The temp file is still CREATED with `{ mode: mode & 0o777 }` on the
 * non-`cp` branch even though `chmodSync` will set it again a line later.
 * That is not redundant: umask can only ever REMOVE bits, so the file is
 * never, at any instant, more permissive than the target it is replacing.
 * Creating it at the default 0o666-minus-umask and widening it afterwards
 * would open a window -- short, but real, and on a 0600 file it is a window
 * where the new content is world-readable.
 *
 * **Peak disk usage roughly doubles while this runs.** The old file and the
 * new temp file are both resident on disk at once until the rename -- unlike
 * a direct truncate-then-write, which never needs more than the larger of
 * the two. Measured: on a 2MB volume holding a 540KB file, writing 1.9MB of
 * new content succeeded with the old truncate-then-write (540KB + 1.9MB
 * exceeds 2MB, but the write only ever needed to hold 1.9MB at once) and
 * fails here with ENOSPC (540KB + 1.9MB together do not fit). This is the
 * trade being made, deliberately, not a regression to explain away: a write
 * that fails leaves the ORIGINAL file intact and reports the failure, which
 * is strictly better than a write that fails and leaves the original
 * destroyed (the bug this function exists to fix, and the whole reason it
 * exists). A volume sized to hold exactly one copy of its largest file, with
 * nothing to spare, can no longer safely rewrite that file in place --
 * that is a real capacity requirement this trade introduces, not a bug in
 * how it is met. The error a caller sees in that case is a plain ENOSPC,
 * with nothing in the message pointing at "atomic write needs headroom" as
 * the reason -- worth knowing before assuming a full disk means the disk is
 * actually full.
 *
 * The temp name is dot-prefixed and carries a random suffix, not a fixed
 * one (e.g. `filePath + '.tmp'`): two calls racing the same target (or a
 * crash that leaves one behind) must not collide on, or be mistaken for, a
 * real file the next fs_glob/fs_list turns up.
 */
export function writeFileAtomic(filePath: string, data: Buffer, mode?: number): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.fsmcp-tmp-${crypto.randomBytes(6).toString('hex')}`
  );
  // Regular file, and an existing one: see "Extended attributes and ACLs"
  // above for why both halves of this gate matter and why the file-type
  // question is answered from the caller's own stat rather than a fresh
  // one.
  const preserveAttributes =
    process.platform === 'darwin' &&
    mode !== undefined &&
    (mode & fs.constants.S_IFMT) === fs.constants.S_IFREG;

  try {
    // Seeded from the target so the temp file inherits its xattrs and ACL,
    // then overwritten with `data` -- see copyAttributes above, and the doc
    // comment's "Extended attributes and ACLs" section for why truncating
    // the seed does not undo it.
    let seeded = false;
    if (preserveAttributes) {
      try {
        copyAttributes(filePath, tmpPath);
        seeded = true;
      } catch {
        if (fs.existsSync(filePath)) {
          // Refuse rather than destroy. cp's own stderr is deliberately not
          // forwarded: it names the TEMP path, which sits inside a granted
          // directory and is not one of the paths vpath.ts translates on
          // the way out, so echoing it would trip redactLeakedHostPaths and
          // replace this explanation with a generic "internal error".
          // `.path` is set so describeError rewrites the one host path this
          // message does carry into the caller's virtual space.
          const refusal: NodeJS.ErrnoException = new Error(
            `refusing to replace ${filePath}: its extended attributes and ACL could not be read, ` +
              `so replacing it (which writes a new inode) would destroy them. The file is ` +
              `unchanged. This usually means fsmcp can write the file but not read it.`
          );
          refusal.path = filePath;
          throw refusal;
        }
        // The target went away between the caller's stat and this call.
        // There is no metadata left to preserve and nothing to refuse over,
        // so this is now an ordinary create -- fall through rather than
        // fail a write that would have succeeded a microsecond earlier.
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // cp may not have got as far as creating anything.
        }
      }
    }

    // This is the line the peak-disk-usage tradeoff in this function's doc
    // comment is about: `data` lands on disk here, in full, ALONGSIDE the
    // still-intact original at `filePath` -- there is no point before the
    // rename below where only one copy exists. A volume with room for the
    // new content but not for both copies fails here with plain ENOSPC.
    if (seeded) {
      // No `mode` option: the temp file already exists (cp made it,
      // carrying the target's own permission bits), so open(2) would ignore
      // one. The chmodSync below is what pins the mode on either branch.
      fs.writeFileSync(tmpPath, data);
    } else {
      // See the doc comment's `mode` section: created at the target's own
      // permission bits (umask can only narrow that, never widen it) so the
      // temp file is never briefly more permissive than what it replaces,
      // then set exactly by the chmodSync below.
      fs.writeFileSync(tmpPath, data, mode !== undefined ? { mode: mode & 0o777 } : undefined);
    }

    // chmod(2), not open(2)'s mode: open's is masked by the umask and
    // chmod's is not, which is the whole of issue #20's second half. Runs
    // on both branches -- after `cp -p`, which copies the target's mode
    // faithfully INCLUDING setuid/setgid, this is also what guarantees
    // fsmcp can never produce a setuid file. Contained by construction:
    // `tmpPath` is fsmcp's own temp file, built in this function from
    // random bytes and never derived from a client argument, and it has
    // existed for exactly as long as the writeFileSync above; the mode is
    // derived from the target's own st_mode, so this can only ever restore
    // a bit the target already had and can never grant one it did not.
    if (mode !== undefined) {
      fs.chmodSync(tmpPath, mode & 0o777);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Best-effort: the write or rename above already failed, and a failure
    // HERE (there was nothing at tmpPath to remove, say, because the write
    // itself never created it) must not shadow that real error -- which
    // would report "cleanup failed" for a call that actually failed with
    // ENOSPC, pointing the caller at the wrong problem.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Nothing to clean up, or cleanup itself failed -- either way the
      // error thrown below is the one that matters.
    }
    throw err;
  }
}
