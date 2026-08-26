import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry, schema, stringProp, enumProp, requireStringArg, optionalStringArg, virtualPathDescription } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { checkPathV, decodeInboundPath, refuseAllowedDirRootWriteV, translateResult } from '../vpath';
import { hasLoneSurrogate, isValidBase64 } from '../encoding';
import { writeFileAtomic } from '../atomicWrite';
import { canonicalizePath, refuseMissingAllowedDirRoot } from '../security';
import { MAX_RESPONSE_BYTES, base64SourceCeiling, wireBytes } from '../limits';

// C5 ("max bytes on fs_read and fs_write"), same reasoning as fs_read's
// MAX_READ_BYTES: an unbounded write is an unbounded synchronous allocation
// (the whole `content` string, plus whatever V8 needs to convert it to the
// UTF-8 bytes fs.writeFileSync sends to the kernel) in the one process
// every other caller is also waiting on. Checked against the argument's
// byte length before either mkdirSync or writeFileSync runs, so a refusal
// creates nothing -- not even the parent directories.
//
// This is a bound on the ALLOCATION and it cannot fire at today's defaults,
// because the message bound below is ~10x tighter and every path reaches it
// first (a JSON-escaped string is never SHORTER than its own UTF-8 encoding,
// so 1 MiB on the wire implies at most 1 MiB of bytes; base64's ceiling is
// tighter still at 768 KiB decoded). It is kept rather than deleted for the
// same reason fs_read keeps MAX_READ_BYTES: issue #16 makes these numbers
// operator flags, they answer different questions, and an operator who
// raises the message budget past 10 MiB should still hit an allocation floor
// that was reasoned for this process rather than for relay's scanner. Do not
// remove it as "unreachable" without also removing the reason it exists.
const MAX_WRITE_BYTES = 10 * 1024 * 1024;

// The inbound half of issue #19. fs_read's defect was that it bounded the
// file rather than the response; fs_write had the identical defect pointing
// the other way, and it was worse in one respect: a base64 `content` for a
// 10 MiB file is a ~13.3 MiB REQUEST line, and relay cannot carry that any
// more than it can carry a 13.3 MiB response -- so the call fsmcp was
// advertising as legal could never arrive at all. The refusal here is
// therefore not the primary fix; the tool DESCRIPTION is, because a request
// that is too long to carry never reaches this function to be refused. What
// this check buys is that the two agree: the limit fsmcp publishes is the
// limit fsmcp enforces, so an agent that reads the description and stays
// inside it is not relying on a number nothing checks, and a caller that
// arrives over some other transport with no line cap is held to the same
// bound rather than being quietly special.
const MAX_CONTENT_WIRE_BYTES = MAX_RESPONSE_BYTES;

export function registerWrite(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_write',
      description:
        'Write content to a file. Creates the file and parent directories if they do not exist. ' +
        'Overwrites existing files. encoding: "text" (default) writes the UTF-8 encoding of ' +
        '"content" verbatim -- no normalisation, no newline translation. encoding: "base64" ' +
        'decodes "content" as base64 and writes those exact bytes, unmodified; use it to write ' +
        'back anything read from fs_read with encoding: "base64" (a PNG, or any other non-UTF-8 ' +
        'file). "content" is refused if it exceeds 1MiB as it appears in the request (after JSON ' +
        'escaping), which in encoding: "base64" means a file of at most 768KiB, since base64 ' +
        'inflates by 4/3. There is no offset or append mode: a file larger than that cannot be ' +
        'assembled through fs_write in several calls.',
      inputSchema: schema(
        {
          file_path: stringProp(virtualPathDescription()),
          content: stringProp(
            'Content to write. In encoding: "text" (default), this is the literal text. In ' +
              'encoding: "base64", this is the base64 encoding of the bytes to write.'
          ),
          encoding: enumProp(
            '"text" (default): write the UTF-8 encoding of "content" as-is. "base64": decode ' +
              '"content" as base64 and write those exact bytes.',
            ['text', 'base64']
          ),
        },
        ['file_path', 'content']
      ),
      // Creates/overwrites a local file; never contacts anything off this
      // machine.
      annotations: { readOnlyHint: false, openWorldHint: false },
      category: 'File System',
    },
    (args: Record<string, unknown>, ctx: ToolContext) => {
      const filePathArg = requireStringArg(args, 'file_path');
      if (typeof filePathArg !== 'string') return filePathArg;

      // Issue #7: decode the client's virtual-space address into the host
      // path checkPathV (and everything after it) already expects -- see
      // read.ts for the full reasoning. security.ts's own checkPath is
      // unmodified and still the thing that decides; checkPathV only
      // translates the message it returns.
      const decoded = decodeInboundPath(filePathArg, ctx.labels);
      if (typeof decoded !== 'string') return decoded;
      const filePath = decoded;

      const contentArg = requireStringArg(args, 'content');
      if (typeof contentArg !== 'string') return contentArg;
      const content = contentArg;

      const encodingArg = optionalStringArg(args, 'encoding');
      if (typeof encodingArg === 'object') return encodingArg;
      if (encodingArg !== undefined && encodingArg !== 'text' && encodingArg !== 'base64') {
        return errorResult(`encoding must be "text" or "base64"; received ${JSON.stringify(encodingArg)}`);
      }
      const encoding: 'text' | 'base64' = encodingArg === 'base64' ? 'base64' : 'text';

      const pathErr = checkPathV(filePath, ctx.allowedDirs, ctx.labels);
      if (pathErr) return pathErr;

      // Issue #24: a path that resolves to a grant root is not a valid
      // target for a write, and `checkPathV` above cannot say so -- a root
      // is inside itself, so containment passes. Everything below this
      // point then derives a SIBLING of the target and lands it one level
      // up: `fs.mkdirSync(path.dirname(resolvedPath))` a few lines down,
      // and `writeFileAtomic`'s `.${basename}.fsmcp-tmp-${random}` temp
      // file after it, both of which resolve to the directory ABOVE the
      // sandbox when the target IS the sandbox. Measured: 5,000,000 bytes
      // of caller-chosen content written into the grant's parent, with
      // only the final rename failing (EISDIR) once the bytes were already
      // there. Refused here, up front, as a scope violation rather than as
      // an incidental errno from three frames down -- see
      // security.ts's refuseAllowedDirRootWrite for the whole rule
      // (including why this half sets `_meta.scope_violation` and
      // fs_delete's half does not). Checked on the RESOLVED path, so
      // `/d0`, `/d0/`, `/d0/.` and `/d0/notes/..` are one case, not four.
      const rootErr = refuseAllowedDirRootWriteV(filePath, ctx.allowedDirs, 'write to', ctx.labels);
      if (rootErr) return rootErr;

      // Issue #33: the same rule one step wider. `fs.mkdirSync(dir, {
      // recursive: true })` below walks UP until it finds a directory that
      // exists, and it has no idea where the grant is -- if the grant root
      // itself does not exist, the root is just another missing component on
      // the way and every ancestor above it gets created too. Measured: a
      // grant at `<R>/level1/level2/level3/grant` with only `<R>` on disk,
      // one `fs_write { file_path: "/d0/sub/file.txt" }`, and three new
      // directories OUTSIDE the boundary, reported as `Wrote 31 bytes`.
      // `checkPathV` passes it because the path really is inside the grant;
      // this is not a scope violation and is deliberately not flagged as
      // one (see security.ts). Refusing here, before mkdirSync, is what
      // bounds the recursive create at the grant root -- with the root
      // present, every directory the walk can create is a strict descendant
      // of it, which is fs_write's documented job and is unaffected.
      // Translated against ctx.allowedDirs, not [filePath]: this refusal
      // names the GRANT, not the caller's path.
      const grantErr = refuseMissingAllowedDirRoot(filePath, ctx.allowedDirs, 'write');
      if (grantErr) return translateResult(grantErr, ctx.allowedDirs, ctx.labels);

      // Issue #19, inbound. Measured on the wire form of `content` -- what
      // it costs inside the JSON request line -- not on `content.length`
      // (UTF-16 code units, which under-counts every non-ASCII character)
      // and not on the decoded bytes (which under-counts base64 by 4/3 and
      // is not even computed yet). `wireBytes` calls the same JSON encoder
      // the transport does, so this is the real number rather than an
      // estimate; estimating is the mistake this issue is about.
      //
      // Before the decode, deliberately: the base64 validity check and the
      // surrogate scan below both walk the whole string, and a message this
      // server is not willing to accept should not pay for that first. It
      // does mean an over-size, malformed-base64 `content` is reported as
      // over-size rather than as malformed -- correct precedence, since the
      // size is a property of the message and the malformedness a property
      // of an argument the message was too big to be carrying anyway.
      const contentWireBytes = wireBytes(content);
      if (contentWireBytes > MAX_CONTENT_WIRE_BYTES) {
        const advice =
          encoding === 'base64'
            ? `base64 inflates by 4/3, so the largest file this mode can write in one call is ` +
              `${base64SourceCeiling(MAX_CONTENT_WIRE_BYTES)} bytes. fs_write has no offset or ` +
              `append mode, so a bigger file cannot be assembled from several calls either -- ` +
              `moving a large binary is not something fsMCP can do byte-exactly.`
            : `write it in smaller pieces (e.g. an initial fs_write followed by fs_edit against ` +
              `the file it created) instead.`;
        return errorResult(
          `content is ${contentWireBytes} bytes on the wire, over fs_write's ` +
            `${MAX_CONTENT_WIRE_BYTES}-byte message byte limit -- fsMCP bounds what crosses the ` +
            `stdio transport, not just what lands on disk, because a request line this long is ` +
            `dropped (or kills the connection) before it ever reaches a size check here. ${advice}`
        );
      }

      let bytes: Buffer;
      if (encoding === 'base64') {
        // isValidBase64 first: Buffer.from(s, 'base64') is a lenient
        // decoder that silently DROPS characters outside the base64
        // alphabet and produces whatever bytes are left, rather than
        // throwing -- see encoding.ts's doc. Without this check, a
        // truncated copy-paste or a caller that forgot to base64-encode at
        // all would decode to the WRONG bytes and still report success,
        // which is the exact silent-corruption shape issue #11 exists to
        // close, just moved from the read side to fs_write's escape hatch.
        if (!isValidBase64(content)) {
          return errorResult(
            'content is not valid base64 (encoding: "base64" requires the standard alphabet, ' +
              '"=" padding only, no whitespace, length a multiple of 4)'
          );
        }
        bytes = Buffer.from(content, 'base64');
      } else {
        // A lone UTF-16 surrogate in `content` cannot be encoded as valid
        // UTF-8 at all -- see encoding.ts's hasLoneSurrogate doc. This is
        // refused unconditionally (no acknowledgement flag, unlike nothing
        // else on this path) because there is no lossy-but-intentional
        // reading of it to honour: Node's own UTF-8 encoder would silently
        // substitute U+FFFD for it, which is exactly the silent
        // byte-corruption issue #11 is about, just introduced by the
        // JSON-RPC transport instead of by a disk read.
        if (hasLoneSurrogate(content)) {
          return errorResult(
            'content contains a lone (unpaired) UTF-16 surrogate, which has no valid UTF-8 ' +
              'encoding -- writing it would silently substitute U+FFFD for it. This usually means ' +
              'content was already corrupted before it reached fs_write; re-derive it from the ' +
              'original source rather than writing it as-is.'
          );
        }
        bytes = Buffer.from(content, 'utf-8');
      }

      // The allocation floor (see MAX_WRITE_BYTES above). Unreachable while
      // the message bound is 1 MiB, kept because the two are independent
      // knobs under issue #16 and this one is the one that protects the
      // process rather than the transport.
      if (bytes.length > MAX_WRITE_BYTES) {
        return errorResult(
          `content decodes to ${bytes.length} bytes, over fs_write's ${MAX_WRITE_BYTES}-byte ` +
            `allocation limit; write it in smaller pieces (e.g. with fs_edit against an existing ` +
            `file) instead`
        );
      }

      // writeFileAtomic replaces a path by renaming a temp file OVER it, and
      // rename(2) never follows a symlink at its destination -- it replaces
      // the directory entry itself. A direct fs.writeFileSync(filePath, ...)
      // (what this used to call) DOES follow a symlink, the same as any
      // other open() call, so `filePath` pointing at, say, `real.txt` used
      // to update real.txt's content and leave the symlink alone. Renaming
      // onto `filePath` unchanged would instead sever the link -- replacing
      // it with a plain file holding the new content -- and leave real.txt
      // holding stale content forever, silently, with fs_write still
      // reporting success. Confirmed: without this resolution step, writing
      // through an in-scope symlink to real.txt left real.txt completely
      // untouched. canonicalizePath is the same resolution checkPathV above
      // already ran to decide this call is in scope (validatePath's own
      // rule: "the data really does end up wherever a symlink leads, so
      // that is what must be in scope"), so this cannot land anywhere new;
      // it only makes writeFileAtomic's destination match what checkPathV
      // already approved. `?? filePath`: canonicalizePath returns null only
      // for input basicPathError would already have refused (NUL byte, over
      // PATH_MAX) or a symlink cycle -- checkPathV's own success above rules
      // both out for this exact string, so the fallback is unreachable in
      // practice, not a silent behaviour change for some other case.
      const resolvedPath = canonicalizePath(filePath) ?? filePath;
      const dir = path.dirname(resolvedPath);
      fs.mkdirSync(dir, { recursive: true });

      // Preserve an existing file's permission bits across the replace --
      // see writeFileAtomic's doc for why this matters (a rewrite through a
      // temp file + rename lands on a brand-new inode, which otherwise gets
      // the process's default mode regardless of what was there before).
      // fs.statSync (unlike lstatSync) already follows a symlink at
      // `filePath` on its own, so this reads the TARGET's mode, matching
      // `resolvedPath` above. `undefined` here (file does not exist, or
      // existsSync raced and lost) means "nothing to preserve," which is
      // exactly the new-file case fs.writeFileSync's own default already
      // covered before this change.
      let existingMode: number | undefined;
      try {
        existingMode = fs.statSync(filePath).mode;
      } catch {
        // New file.
      }

      // Written from the already-computed `bytes` buffer, not `content` +
      // an encoding name, for both branches: text mode's bytes are already
      // exactly the UTF-8 encoding fs.writeFileSync(..., 'utf-8') would
      // produce, and base64 mode's bytes are the decoded raw bytes, which
      // must be written with NO text encoding applied -- interpreting them
      // as UTF-8 text would re-encode an arbitrary byte buffer, corrupting
      // exactly the bytes this escape hatch exists to preserve.
      //
      // writeFileAtomic, not a direct fs.writeFileSync(resolvedPath, bytes):
      // the direct call truncates the target before writing a single byte,
      // so a write that fails partway (ENOSPC, the process being killed)
      // leaves the file neither in its old state nor its new one --
      // measured on a deliberately undersized filesystem, where it left a
      // 512000-byte file at 0 bytes. See atomicWrite.ts for the full
      // argument and the repro.
      writeFileAtomic(resolvedPath, bytes, existingMode);

      return translateResult(textResult(`Wrote ${bytes.length} bytes to ${filePath}`), [filePath], ctx.labels);
    }
  );
}
