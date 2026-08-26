import * as fs from 'fs';
import { ToolRegistry, schema, stringProp, boolProp, parseBoolArg, requireStringArg, virtualPathDescription } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { checkPathV, decodeInboundPath, refuseAllowedDirRootWriteV, translateResult } from '../vpath';
import { decodeUtf8Strict, hasLoneSurrogate } from '../encoding';
import { writeFileAtomic } from '../atomicWrite';
import { canonicalizePath } from '../security';

export function registerEdit(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_edit',
      description:
        'Perform exact string replacement in a file. By default, old_string must appear exactly once (fails if 0 or >1 matches). Use replace_all to replace every occurrence.',
      inputSchema: schema(
        {
          file_path: stringProp(virtualPathDescription()),
          old_string: stringProp('Exact string to find'),
          new_string: stringProp('Replacement string'),
          replace_all: boolProp('Replace all occurrences (default: false)'),
        },
        ['file_path', 'old_string', 'new_string']
      ),
      // Mutates a local file in place; never contacts anything off this
      // machine.
      annotations: { readOnlyHint: false, openWorldHint: false },
      category: 'File System',
    },
    (args: Record<string, unknown>, ctx: ToolContext) => {
      const filePathArg = requireStringArg(args, 'file_path');
      if (typeof filePathArg !== 'string') return filePathArg;

      // Issue #7: decode the client's virtual-space address into the host
      // path checkPath (and everything after it) already expects -- see
      // read.ts for the full reasoning.
      const decoded = decodeInboundPath(filePathArg, ctx.labels);
      if (typeof decoded !== 'string') return decoded;
      const filePath = decoded;

      const oldStringArg = requireStringArg(args, 'old_string');
      if (typeof oldStringArg !== 'string') return oldStringArg;
      const oldString = oldStringArg;

      // Checked explicitly rather than left to `parts.join(newString)`:
      // `Array.prototype.join` stringifies a `null` new_string to the
      // literal text "null" and writes it into the file with no error at
      // all (unlike `undefined`, which join treats as "use the default
      // separator" -- the two are not equivalent here even though `as
      // string` cannot tell them apart). A wrong-typed old_string throws
      // instead (content.split has no such special case), which is also
      // wrong, just louder -- this check catches both the same way.
      const newStringArg = requireStringArg(args, 'new_string');
      if (typeof newStringArg !== 'string') return newStringArg;
      const newString = newStringArg;

      const replaceAllArg = parseBoolArg(args.replace_all, 'replace_all', false);
      if (typeof replaceAllArg !== 'boolean') return replaceAllArg;
      const replaceAll = replaceAllArg;

      const pathErr = checkPathV(filePath, ctx.allowedDirs, ctx.labels);
      if (pathErr) return pathErr;

      // Issue #24, the same rule fs_write applies for the same reason: a
      // path that resolves to a grant root is not a valid target for a
      // tool that replaces a file, and `checkPathV` cannot say so because a
      // root is inside itself. fs_edit reaches the identical
      // `writeFileAtomic` -- whose temp path is `path.dirname(filePath)`,
      // i.e. the directory ABOVE the sandbox when the target is the
      // sandbox -- so the same shape is reachable here as soon as anything
      // gets past the read below. Today it does not: `fs.readFileSync` of a
      // directory throws EISDIR and this handler answers "file not found",
      // so the bytes never reach the write. That is an accident of
      // ordering, not a guarantee -- it depends on a read failing first,
      // for an errno nothing here checks -- and "file not found" is also
      // simply the wrong answer for a path that exists and is a grant root.
      // Refused explicitly, before the read, so the answer does not depend
      // on which syscall happens to fail first.
      const rootErr = refuseAllowedDirRootWriteV(filePath, ctx.allowedDirs, 'edit', ctx.labels);
      if (rootErr) return rootErr;

      // A lone UTF-16 surrogate in new_string cannot be encoded as valid
      // UTF-8 at all (see encoding.ts's hasLoneSurrogate doc) -- refused
      // before the file is even opened, unconditionally, the same as
      // fs_write's identical check on `content`: there is no lossy-but-
      // intentional reading of it to honour, because Node's UTF-8 encoder
      // would silently substitute U+FFFD for it on write.
      if (hasLoneSurrogate(newString)) {
        return errorResult(
          'new_string contains a lone (unpaired) UTF-16 surrogate, which has no valid UTF-8 ' +
            'encoding -- writing it would silently substitute U+FFFD for it. This usually means ' +
            'new_string was already corrupted before it reached fs_edit; re-derive it from the ' +
            'original source rather than writing it as-is.'
        );
      }

      let raw: Buffer;
      let existingMode: number;
      try {
        raw = fs.readFileSync(filePath);
        // Read alongside the content, not after: this file is about to be
        // rewritten onto a fresh inode (writeFileAtomic below), and that
        // inode gets the process's default mode unless told otherwise --
        // silently dropping, say, a script's execute bit on every edit.
        // Fetched from the same successfully-opened path the content came
        // from, so there is no separate failure mode to handle here beyond
        // the one already caught below.
        existingMode = fs.statSync(filePath).mode;
      } catch {
        return translateResult(errorResult(`file not found: ${filePath}`), [filePath], ctx.labels);
      }

      // fs_edit is defined over text: it finds a literal string and
      // replaces it, which has no meaning against bytes that are not text
      // in the first place. Reading with fs.readFileSync(path, 'utf-8')
      // used to answer that question by silently substituting U+FFFD for
      // every byte that failed to decode (issue #11) and then writing the
      // substituted string straight back with fs.writeFileSync(...,
      // 'utf-8') -- corrupting the file on every edit, even one whose
      // old_string/new_string were both correct, because the write step
      // re-encodes the ALREADY-LOSSY in-memory string. Refusing here is not
      // "binary is dangerous"; it is "this operation does not apply to
      // content that cannot be represented as UTF-8 text" -- the same
      // representability question decodeUtf8Strict answers everywhere else
      // in this codebase. There is no base64 escape hatch for fs_edit the
      // way there is for fs_read/fs_write: a byte-level splice is not a
      // string replacement, and fsMCP does not invent a new operation here
      // to paper over that.
      let content: string;
      try {
        content = decodeUtf8Strict(raw);
      } catch {
        return translateResult(
          errorResult(
            `${filePath}'s bytes are not valid UTF-8, so fs_edit cannot represent them as text to ` +
              `edit. Use fs_read with encoding: "base64" to inspect it; fs_edit has no way to ` +
              `perform a literal-string edit against non-UTF-8 content.`
          ),
          [filePath],
          ctx.labels
        );
      }

      // Count occurrences
      const parts = content.split(oldString);
      const count = parts.length - 1;

      if (count === 0) {
        return errorResult('old_string not found in file');
      }

      if (!replaceAll && count > 1) {
        return errorResult(
          `old_string found ${count} times. Use replace_all or provide more context to make it unique.`
        );
      }

      const newContent = parts.join(newString);
      // Resolved through any symlink at `filePath` before the atomic
      // rename, for the same reason fs_write does this: rename(2) replaces
      // the DESTINATION'S OWN directory entry rather than following it, so
      // renaming onto `filePath` unchanged would sever an in-scope symlink
      // (replacing it with a plain file) and leave its real target holding
      // stale pre-edit content forever -- confirmed by writing through a
      // symlink to a real file and finding the real file untouched without
      // this step. The old fs.writeFileSync(filePath, ...) call being
      // replaced here DID follow the symlink (like any ordinary open()),
      // so this resolution is what keeps that behaviour rather than
      // changing it. canonicalizePath is the same resolution checkPathV
      // already ran to approve this call, so this can only land on a path
      // already in scope; `?? filePath` covers canonicalizePath's null
      // return (a symlink cycle, or an input basicPathError would already
      // have refused), which checkPathV's own success above has already
      // ruled out for this exact string.
      const resolvedPath = canonicalizePath(filePath) ?? filePath;
      // writeFileAtomic, not a direct fs.writeFileSync(resolvedPath, ...,
      // 'utf-8'): the direct call truncates the file before writing a byte
      // of the edited content, so a write that fails partway (ENOSPC, the
      // process being killed) leaves neither the pre-edit nor the post-edit
      // content on disk -- measured on a deliberately undersized
      // filesystem, where it destroyed a 500006-byte file down to 0 bytes
      // on a single failed fs_edit. See atomicWrite.ts for the full
      // argument and the repro.
      writeFileAtomic(resolvedPath, Buffer.from(newContent, 'utf-8'), existingMode);

      return translateResult(
        textResult(`Replaced ${count} occurrence(s) in ${filePath}`),
        [filePath],
        ctx.labels
      );
    }
  );
}
