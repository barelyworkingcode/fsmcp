import * as fs from 'fs';
import { ToolRegistry, schema, stringProp, boolProp, parseBoolArg, requireStringArg, virtualPathDescription } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { checkPathV, decodeInboundPath, refuseAllowedDirRootWriteV, translateResult } from '../vpath';
import { decodeUtf8Strict, hasLoneSurrogate } from '../encoding';
import { writeFileAtomic } from '../atomicWrite';
import { canonicalizePath } from '../security';
import { MAX_RESPONSE_BYTES, wireBytes } from '../limits';

// Issue #38, the inbound half. #19 bounded what crosses the stdio transport
// and bounded it for `fs_write` only, so `fs_edit` -- the OTHER tool that
// takes caller-supplied file content off the wire -- had no inbound bound at
// all. Measured by an independent verifier: a 3 MB `new_string` landed on
// disk through `fs_edit` while the byte-identical `fs_write` refused at
// 1,048,576. The effective inbound ceiling was therefore 1 MiB through one
// tool and ~10 MiB through the other (relay's own `bridge.MaxMessageSize`,
// which refuses an oversized REQUEST frame cleanly -- the inbound direction
// was never the outage direction; #19's outage was on stdout). What was
// wrong is not an outage, it is that the limit fsMCP publishes was untrue
// for half its own write surface, and `fs_edit` was the one mutating tool
// whose input nothing here bounded.
//
// The same number as `fs_write`'s inbound cap, for the same reason and out
// of the same constant: these are two spellings of one operation ("put
// caller-supplied text into a file"), and a caller should not have to learn
// which tool it picked in order to know what fits.
//
// Applied to `old_string` AS WELL AS `new_string`. `old_string` is equally
// caller-supplied, equally unbounded, and equally a whole file's worth of
// text in the shape this tool is used for (replace this large block with
// that one); bounding only the half that reaches the disk would leave the
// message -- the thing that actually has to fit -- unbounded.
const MAX_STRING_WIRE_BYTES = MAX_RESPONSE_BYTES;

// Issue #38, the allocation half, and the same number `fs_read` uses for the
// same hazard. `fs_edit` read its target with a bare `fs.readFileSync` and
// no size check whatsoever: an `fs_edit` against a multi-gigabyte file is an
// unbounded synchronous allocation in a process that serves every other
// caller from one loop -- precisely what `MAX_READ_BYTES` exists to prevent,
// reached through a different door. (`fs_write` has the same floor in
// `MAX_WRITE_BYTES`; `fs_edit` was the only file-loading path without one.)
//
// Duplicated as a local constant rather than imported from `read.ts`,
// matching what `write.ts` already does with `MAX_WRITE_BYTES`: these are
// per-tool allocation floors that issue #16 turns into separate operator
// flags, and collapsing them into one shared constant now would pre-empt
// that by deciding they must always be equal. They are equal today because
// nothing justifies making a caller reason about two numbers, not because
// they are the same knob.
const MAX_EDIT_READ_BYTES = 10 * 1024 * 1024;

export function registerEdit(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_edit',
      description:
        'Perform exact string replacement in a file. By default, old_string must appear exactly ' +
        'once (fails if 0 or >1 matches). Use replace_all to replace every occurrence. ' +
        'old_string must be a non-empty string different from new_string: an empty search ' +
        'string, and a search string identical to its replacement, are both refused rather than ' +
        'performed (see below). new_string may be empty -- that is a deletion. old_string and ' +
        'new_string are each refused above 1MiB as they appear in the request (after JSON ' +
        'escaping), the same bound fs_write puts on content, and the file being edited is ' +
        'refused above 10MiB because the whole of it has to be loaded to find old_string. ' +
        'There is no offset, append or windowed mode: a file over that size cannot be edited ' +
        'through fsMCP, and a replacement over that size has to be made as several smaller ' +
        'edits anchored on the surrounding text.',
      inputSchema: schema(
        {
          file_path: stringProp(virtualPathDescription()),
          // minLength is spelled inline rather than by extending
          // registry.ts's stringProp: this is the only argument in the whole
          // server that has a length floor, and a shared helper for one
          // caller would put the constraint further from the refusal that
          // actually enforces it. The handler's own check below is the real
          // enforcement -- a JSON Schema keyword is a courtesy to a caller
          // that validates before sending, and fsmcp validates nothing off
          // the wire by schema.
          old_string: { ...stringProp('Exact string to find. Must not be empty.'), minLength: 1 },
          new_string: stringProp('Replacement string. May be empty (deletes old_string).'),
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

      // Issue #38: measured on the WIRE FORM of each string -- what it costs
      // inside the JSON request line -- not on `.length`, which is UTF-16
      // code units and under-counts every non-ASCII character and by 6x
      // every C0 control byte. `wireBytes` calls the same JSON encoder the
      // transport does, so this is the real number rather than an estimate;
      // estimating is the mistake #19 is about. See limits.ts.
      //
      // Before the surrogate scan and before the file is opened, for
      // `fs_write`'s reason: a message this server is not willing to accept
      // should not first pay for a full walk of the string, and nothing
      // should be read (let alone written) on account of a request that is
      // too big to be carrying it.
      for (const [name, value] of [['new_string', newString], ['old_string', oldString]] as const) {
        const bytes = wireBytes(value);
        if (bytes > MAX_STRING_WIRE_BYTES) {
          return errorResult(
            `${name} is ${bytes} bytes on the wire, over fs_edit's ${MAX_STRING_WIRE_BYTES}-byte ` +
              `message byte limit -- fsMCP bounds what crosses the stdio transport, not just what ` +
              `lands on disk, because a request line this long is dropped (or kills the ` +
              `connection) before it ever reaches a size check here. fs_edit has no offset, ` +
              `append or streaming mode, so "send the rest in the next call" is not available the ` +
              `way it sounds -- but an edit does not need one to be divisible, because the file's ` +
              `own text is the anchor: replace one smaller region whose surrounding text is ` +
              `unique, then anchor the next call on the text the previous call just wrote, and ` +
              `repeat. If the whole file is being replaced rather than edited, that is fs_write, ` +
              `which is bounded at the same ${MAX_STRING_WIRE_BYTES} bytes per call and equally ` +
              `has no append mode.`
          );
        }
      }

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

      // Issue #30. An empty old_string is refused here, before the file is
      // read, because there is no such thing as "the place where the empty
      // string occurs" -- and the code below would otherwise answer that
      // non-question with something actively destructive rather than with a
      // miss. `content.split("")` splits into individual CHARACTERS, so
      // `parts.length - 1` counts (length - 1) phantom "occurrences" and
      // `parts.join(newString)` interleaves new_string between every
      // character of the file: "hello" with new_string "X" becomes
      // "hXeXlXlXoX", written to disk, reported as `Replaced 5
      // occurrence(s)` on a SUCCESS result. Nothing downstream catches it,
      // because from split/join's point of view nothing went wrong.
      //
      // The un-flagged path is worse than it looks, not better: with
      // replace_all absent the caller gets `old_string found 5 times. Use
      // replace_all or provide more context to make it unique.` -- a
      // sensible sentence about a real string, a nonsense one about an
      // empty one, and a refusal whose own remedy is the flag that destroys
      // the file. So the refusal has to happen HERE, on the emptiness,
      // rather than being left to the uniqueness check to express badly.
      //
      // The realistic trigger is not a caller typing "": it is an agent
      // whose old_string came from a variable that resolved empty -- a
      // templated edit, or a value it failed to extract from a previous
      // fs_read. It believes it is making a targeted replacement.
      //
      // This is the same "the operation has no meaning, so refuse it rather
      // than pick a behaviour" stance the rest of this codebase already
      // takes: fs_edit's own non-unique match, assignLabels on a duplicate
      // label, validatePath on an empty scope, narrowAllowedDirs keeping
      // absent and empty distinct instead of collapsing them.
      if (oldString === '') {
        return errorResult(
          'old_string must not be empty. An empty search string does not identify a location in ' +
            'the file -- fs_edit would interleave new_string between every character and report ' +
            'that as a successful replacement. If old_string came from a variable, it resolved ' +
            'empty; re-derive it (for example from an fs_read of this file) before retrying. ' +
            'To insert text at a known point, pass the surrounding text as old_string and the ' +
            'surrounding text with the insertion as new_string.'
        );
      }

      // Issue #30, the neighbouring case: old_string === new_string is
      // refused too, and for the same reason rather than by analogy.
      //
      // It is not a harmless no-op that this could let through and report
      // honestly. fs_edit rewrites through writeFileAtomic, which renames a
      // fresh temp file over the target -- so an identical-strings "edit"
      // still replaces the inode, breaks any hard link to it, and bumps
      // mtime, while the content is byte-for-byte what it already was. That
      // is a real mutation of the file with no change to show for it, and
      // `Replaced 3 occurrence(s)` is a true sentence that will be read as
      // "the change landed" by the one reader it is written for. An agent
      // told that moves on; the edit it believed in never existed.
      //
      // The trigger is the same shape as the empty case -- two template
      // variables that resolved to the same value, or a new_string
      // re-derived from the file it was about to be written into -- and it
      // runs into the same misleading remedy first: without replace_all it
      // is told to add the flag "to make it unique", which for identical
      // strings makes a bigger nothing happen.
      //
      // Refused rather than reported as a no-op success because a refusal
      // is the answer that makes the caller look at its own strings. A
      // success result saying "0 changes" would still be counted as a
      // completed step by anything scanning for isError, which is exactly
      // the reading that is wrong here. Nothing legitimate is lost: a
      // caller that genuinely wants the file's bytes unchanged has already
      // got them.
      if (oldString === newString) {
        return errorResult(
          'old_string and new_string are identical, so this edit would change nothing. It is ' +
            'refused rather than performed: fs_edit rewrites the file through a temp-file rename, ' +
            'so it would still replace the file (new inode, new mtime, any hard link to it broken) ' +
            'and report a replacement count that reads as a change that did not happen. If these ' +
            'two came from separate variables, they resolved to the same value -- re-derive ' +
            'new_string before retrying.'
        );
      }

      // The stat comes FIRST now (issue #38), and it does two jobs.
      //
      // The size is the one this issue is about: `fs.readFileSync` on a file
      // of any size was the whole of fs_edit's read path, so the allocation
      // was decided by whatever happened to be on disk inside the grant.
      // Asking `stat` before opening anything is how `fs_read` and
      // `fs_write` already bound theirs, and it means an over-size file
      // costs one syscall rather than a gigabyte of resident memory in a
      // process every other caller is waiting on.
      //
      // The mode is the second job and is unchanged in purpose: this file is
      // about to be rewritten onto a fresh inode (writeFileAtomic below),
      // which gets the process's default mode unless told otherwise --
      // silently dropping, say, a script's execute bit on every edit. It
      // used to be read after the content, from the same successfully-opened
      // path; it is read here instead, from the stat that has to happen
      // anyway, and the read below still has its own failure branch.
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return translateResult(errorResult(`file not found: ${filePath}`), [filePath], ctx.labels);
      }

      // The refusal says what a caller can actually do, which for fs_edit is
      // not what it is for fs_write. fs_write's over-size message can
      // suggest writing in pieces; fs_edit has to load the whole file to
      // find `old_string` at all, and there is no windowed edit to fall back
      // to, so the honest answer is that a file this large cannot be edited
      // through fsMCP -- it can be inspected, and that is a different verb.
      if (stat.size > MAX_EDIT_READ_BYTES) {
        return translateResult(
          errorResult(
            `${filePath} is ${stat.size} bytes, over fs_edit's ${MAX_EDIT_READ_BYTES}-byte read ` +
              `limit. fs_edit has to load the whole file to find old_string, and fsMCP is a ` +
              `single synchronous process, so a read this large stalls every other caller; there ` +
              `is no windowed or streaming edit to fall back to. Inspect it with fs_read ` +
              `(encoding: "base64" plus byte_offset/byte_length reads a file of any size in ` +
              `windows), but a file this large cannot be edited in place through fsMCP at all.`
          ),
          [filePath],
          ctx.labels
        );
      }

      const existingMode = stat.mode;
      let raw: Buffer;
      try {
        raw = fs.readFileSync(filePath);
      } catch {
        // Still reachable and still the right answer after the stat above:
        // `statSync` succeeds for a directory (and for a file this process
        // may not open), and `readFileSync` is what then fails with EISDIR
        // or EACCES.
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
