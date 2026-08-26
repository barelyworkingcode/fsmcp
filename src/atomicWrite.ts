import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

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
 * `mode`, when given, preserves an existing file's permission bits across
 * the replace. A version of this fix that skipped it would silently drop
 * them: the temp file is a brand-new inode created with the process's
 * default mode (0o666 minus umask), and rename() replaces the target's
 * directory entry -- inode, permissions and all -- with that new one. A
 * shell script edited with fs_edit would lose its execute bit on every
 * single edit, trading one silent corruption (content, fixed by this same
 * function) for another (metadata, introduced by the fix). Passed to
 * writeFileSync's own `mode` option rather than a follow-up fs.chmodSync
 * call so this stays within the five-syscall mutating surface
 * no-link-primitive.test.js pins (mkdirSync, renameSync, rmSync,
 * unlinkSync, writeFileSync) instead of adding a sixth call that would need
 * its own containment argument written before it ships.
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
  try {
    // `mode & 0o777`: fs.statSync's mode carries file-type bits (S_IFREG,
    // ...) alongside the permission bits, and only the permission bits are
    // this function's business -- the temp file is created as a regular
    // file by writeFileSync regardless, and the setuid/setgid/sticky bits
    // are dropped deliberately rather than replicated blind, since nothing
    // about "preserve the execute bit across an edit" implies "also
    // preserve setuid across a rewrite to a fresh inode."
    fs.writeFileSync(tmpPath, data, mode !== undefined ? { mode: mode & 0o777 } : undefined);
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
