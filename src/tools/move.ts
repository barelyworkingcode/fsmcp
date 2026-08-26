import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry, schema, stringProp, boolProp, parseBoolArg, requireStringArg, virtualPathDescription } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { canonicalizePath } from '../security';
import { checkPathV, decodeInboundPath, describeError, refuseAllowedDirRootV, translateResult } from '../vpath';

/**
 * Do these two paths name the same directory entry?
 *
 * Issue #23: this is the question `fs_move` used to answer by not asking it.
 * `overwrite: true` was `rmSync(destination)` followed by
 * `renameSync(source, destination)`, and when the two paths were the same
 * file the unlink took the source's own data with it -- the rename then
 * failed ENOENT with nothing left to move. On macOS's default APFS volume,
 * which is case-INSENSITIVE, `meeting.md` and `Meeting.md` are one entry, so
 * "capitalise that filename" was enough to destroy a file. The tool even
 * instructed the caller into it: the first attempt refused with "destination
 * already exists (pass overwrite: true to replace it)", and obeying that
 * sentence was the call that lost the data.
 *
 * `{dev, ino}` is the only comparison that answers this correctly. String
 * comparison of `path.resolve`d paths does not know the filesystem is
 * case-insensitive and never will -- case-folding is a property of the
 * volume (and of its normalization form: APFS also folds some Unicode
 * equivalences), not of the string -- so any lexical check is a guess that
 * happens to be right on Linux and wrong here. The inode pair is the
 * filesystem's own answer, and it makes the case-insensitive case, the
 * literal self-move and the `.`-component alias all correct at once instead
 * of three string comparisons that each miss something.
 *
 * `lstat`, not `stat`, deliberately: `rename(2)` operates on directory
 * ENTRIES, so the entry is what has to be identified. Following the final
 * component would make a symlink and the file it points at compare equal,
 * and `fs_move source=<link> destination=<its target>` is a real (if odd)
 * operation -- replacing the target with the link -- not a self-move to be
 * short-circuited. This is the same reason `fs_delete` uses `lstat`/`unlink`
 * on the exact path it was given (C2).
 *
 * Two entries CAN legitimately share `{dev, ino}` without being one name:
 * hard links. `rename(2)` is specified for that case too -- "if the old
 * argument and the new argument resolve to different directory entries for
 * the same existing file, rename() shall return successfully and perform no
 * other action" -- so routing it here is exactly what `/bin/mv` does with a
 * hard-link pair, and, more to the point, destroys nothing. fsMCP cannot
 * create a hard link (see README's "no link primitive"), so reaching this
 * requires someone else to have made one inside the grant.
 */
function isSameEntry(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Build the refusal for a destination that already exists AND is a
 * directory (issue #23, defect 2). `entryCount` is null when the directory
 * could not be read at all, in which case the count is left out rather than
 * guessed at.
 *
 * The message names the call the caller almost certainly meant --
 * `<destination>/<basename(source)>` -- because the whole shape of this bug
 * was a refusal that talked the caller into a destructive call instead of
 * the correct one.
 */
function directoryDestinationMessage(
  source: string,
  destination: string,
  entryCount: number | null
): string {
  const into = path.join(destination, path.basename(source));
  const count = entryCount === null ? '' : ` (${entryCount} entries)`;
  return (
    `destination is an existing directory: ${destination}${count}. fs_move does not replace a ` +
    `directory, and overwrite: true does not either. To move ${source} INTO this directory, name ` +
    `the full destination path: ${into}. To replace the directory itself, delete it with ` +
    `fs_delete first.`
  );
}

export function registerMove(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_move',
      description:
        'Move or rename a file or directory. Refuses if the destination already exists unless ' +
        'overwrite is set to true, which replaces an existing file -- never a directory. ' +
        'Renaming a file to a different spelling of the same name (a case-only rename on a ' +
        'case-insensitive filesystem) works and needs no flag. Deletes nothing: rename(2) is the ' +
        'only syscall this tool makes.',
      inputSchema: schema(
        {
          source: stringProp(virtualPathDescription()),
          destination: stringProp(virtualPathDescription()),
          overwrite: boolProp(
            'Replace an existing file at the destination (default: false). Never replaces a ' +
              'directory that has contents -- delete it with fs_delete first if that is what you mean.'
          ),
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
      // sandbox. Nothing below weakens this: every guard issue #23 added
      // runs AFTER both of these, on the same two already-validated host
      // paths, and none of them is reached by a call that either check
      // refuses.
      const sourceErr = checkPathV(source, ctx.allowedDirs, ctx.labels);
      if (sourceErr) return sourceErr;
      const destErr = checkPathV(destination, ctx.allowedDirs, ctx.labels);
      if (destErr) return destErr;

      let sourceStat: fs.Stats;
      try {
        sourceStat = fs.lstatSync(source);
      } catch {
        return translateResult(errorResult(`source not found: ${source}`), [source], ctx.labels);
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
        return translateResult(
          errorResult(`cannot move a directory into itself: ${source} -> ${destination}`),
          [source, destination],
          ctx.labels
        );
      }

      // `lstat`, not `fs.existsSync`, for the same reason isSameEntry uses
      // it: the question is whether there is a directory ENTRY at
      // `destination` for rename(2) to land on, and existsSync answers a
      // different one -- it follows the final symlink, so an in-scope
      // symlink whose target does not exist reported "no destination here"
      // while rename would in fact have replaced the link.
      let destStat: fs.Stats | null;
      try {
        destStat = fs.lstatSync(destination);
      } catch {
        destStat = null;
      }

      if (destStat !== null) {
        // The sandbox root is not a destination. checkPath(destination)
        // passes for an allowed_dir root itself, because a root is inside
        // itself, so without this an ordinary-looking move could rename the
        // grant's own floor away (before issue #23 it was worse still: this
        // is where `overwrite: true` reached an unguarded recursive
        // rmSync). Same guard fs_delete uses (security.ts's
        // refuseAllowedDirRoot). Checked before everything below, including
        // the same-entry short-circuit, so `fs_move { source: "/d0",
        // destination: "/d0/sub/.." }` -- one entry, spelled two ways -- is
        // refused rather than turned into a no-op rename of the root.
        const rootErr = refuseAllowedDirRootV(destination, ctx.allowedDirs, 'move onto', ctx.labels);
        if (rootErr) return rootErr;

        // Issue #23, defect 1. One entry, two names: this is a RENAME, not
        // a replacement, so it takes the plain-rename path and does not
        // require (or consult) `overwrite` at all. A case-only rename is an
        // ordinary thing to want, `renameSync` alone already performs it
        // correctly on APFS -- the case change lands, the bytes never move
        // -- and refusing it would leave the tool unable to do something
        // `mv` does in one line. Reached before the "destination already
        // exists" refusal precisely so that refusal can no longer be the
        // sentence that talks a caller into destroying the file.
        if (isSameEntry(sourceStat, destStat)) {
          const resolvedDest = canonicalizePath(destination);
          if (resolvedSource !== null && resolvedSource === resolvedDest) {
            // The same entry AND the same name, just spelled differently
            // (a literal self-move, or a `.`/trailing-slash alias).
            // rename(2) would succeed and do nothing; say that instead of
            // reporting a move that did not happen. A success, not an
            // error: nothing failed, nothing was destroyed, and an error
            // here would be one more audit entry that reads as a failure
            // when the truth is "already so".
            return translateResult(
              textResult(`${source} is already at ${destination}; nothing to move`),
              [source, destination],
              ctx.labels
            );
          }
          // Different names for one entry: a case-only rename on a
          // case-insensitive volume, or a hard-link pair (see isSameEntry).
          // Fall through to the single renameSync below.
        } else if (destStat.isDirectory()) {
          // Issue #23, defect 2. `mv file dir/` is the POSIX idiom every
          // agent knows, and fs_move used to read it as "replace that
          // directory", handing it to `rmSync(recursive: true)`: one call
          // erased a five-file tree and relay's audit logged `ok`, because
          // as far as this tool was concerned the move succeeded.
          //
          // The decision (documented in CLAUDE.md and README): a directory
          // destination is REFUSED, and `overwrite` is not a way to get it.
          // fs_move is not the tool that deletes things. The one exception
          // is an EMPTY directory replaced by another directory, which
          // rename(2) does atomically and which destroys nothing -- that is
          // not an exception to the rule "fs_move never deletes data", it
          // is the rule.
          //
          // The POSIX reading (silently move INTO the directory) was
          // considered and rejected: it would make the meaning of
          // `destination` depend on the state of the filesystem at call
          // time -- "the new name" usually, "the parent of the new name"
          // when something happens to be a directory there -- so the audit
          // log would record an argument that is not where the data went,
          // and `overwrite: true` would then govern a path the caller never
          // named. Refusing costs the caller one corrected call, and the
          // message below names it for them.
          let entryCount: number | null;
          try {
            entryCount = fs.readdirSync(destination).length;
          } catch {
            // Unreadable: treat as "may have contents" and refuse. The
            // safe default is the one that removes nothing.
            entryCount = null;
          }
          const replaceableEmptyDir = entryCount === 0 && sourceStat.isDirectory();
          if (!replaceableEmptyDir) {
            return translateResult(
              errorResult(directoryDestinationMessage(source, destination, entryCount)),
              [source, destination],
              ctx.labels
            );
          }
          if (!overwrite) {
            return translateResult(
              errorResult(`destination already exists: ${destination} (pass overwrite: true to replace it)`),
              [destination],
              ctx.labels
            );
          }
        } else if (!overwrite) {
          return translateResult(
            errorResult(`destination already exists: ${destination} (pass overwrite: true to replace it)`),
            [destination],
            ctx.labels
          );
        }
      }

      try {
        // The ONLY mutating syscall in this tool, in every branch above.
        //
        // There is deliberately no `fs.rmSync` here any more (issue #23).
        // The old `overwrite` branch unlinked the destination first and
        // then renamed onto the hole it had just made, which was wrong
        // three separate ways: it destroyed the source when the two paths
        // were one entry (defect 1), it recursively destroyed a whole tree
        // when the destination was a directory (defect 2), and even in the
        // ordinary file-onto-file case it opened a window where NEITHER
        // file existed -- so a rename that then failed (EXDEV, EACCES, a
        // read-only mount, a full disk) left the caller with the
        // destination gone and only an error to show for it.
        //
        // rename(2) replaces an existing file atomically all by itself, so
        // the unlink bought nothing it did not also break. It also means
        // `overwrite` cannot be made to destroy more than the single entry
        // the caller named: the kernel refuses ENOTEMPTY rather than
        // replace a directory with contents, and there is no walk here to
        // bound. That is why fs_delete's 10,000-entry cap has no equivalent
        // in this file: a cap counts entries a recursive delete is about to
        // remove, and this tool has no recursive delete to count -- it
        // removes exactly zero directory entries and creates exactly one.
        //
        // No tool in this surface creates a symlink or a hard link -- that
        // would be a sandbox-escape primitive with a friendly name, handed
        // to whichever grant this tool carries. `overwrite` replaces the
        // destination outright rather than merging into it, so what fs_move
        // creates at `destination` is always exactly what fs_move moved
        // there, never a blend of two trees.
        fs.renameSync(source, destination);
      } catch (err: unknown) {
        // EXDEV: rename(2) cannot cross a filesystem boundary, and a grant
        // legitimately can -- two `--allowed-dir`s on two volumes, or one
        // directory with an external disk mounted underneath it. fsMCP does
        // NOT fall back to copy-and-delete, and this message says so rather
        // than leaving the caller with a bare errno. That fallback would be
        // a different operation wearing rename's name: non-atomic, unable
        // to preserve what a rename preserves for free (inode, hard links,
        // xattrs, permissions), potentially leaving a half-copied file if
        // it fails partway, and -- the part that matters here -- it would
        // put a delete back inside fs_move, which is the thing issue #23
        // was about. Nothing is destroyed when this fires: both endpoints
        // are exactly as they were.
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code === 'EXDEV') {
          return translateResult(
            errorResult(
              `cannot move ${source} to ${destination}: they are on different filesystems, and ` +
                `fs_move only renames -- it has no copy-and-delete fallback, so nothing was ` +
                `changed. Copy the bytes with fs_read (encoding: "base64") and fs_write ` +
                `(encoding: "base64"), then remove the original with fs_delete.`
            ),
            [source, destination],
            ctx.labels
          );
        }
        return errorResult(`move failed: ${describeError(err, ctx.labels)}`);
      }

      return translateResult(textResult(`Moved ${source} to ${destination}`), [source, destination], ctx.labels);
    }
  );
}
