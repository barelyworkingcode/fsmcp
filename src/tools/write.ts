import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry, schema, stringProp, enumProp, requireStringArg, optionalStringArg, virtualPathDescription } from '../registry';
import { textResult, errorResult, ToolContext } from '../types';
import { checkPathV, decodeInboundPath, translateResult } from '../vpath';
import { hasLoneSurrogate, isValidBase64 } from '../encoding';

// C5 ("max bytes on fs_read and fs_write"), same reasoning as fs_read's
// MAX_READ_BYTES: an unbounded write is an unbounded synchronous allocation
// (the whole `content` string, plus whatever V8 needs to convert it to the
// UTF-8 bytes fs.writeFileSync sends to the kernel) in the one process
// every other caller is also waiting on. Checked against the argument's
// byte length before either mkdirSync or writeFileSync runs, so a refusal
// creates nothing -- not even the parent directories.
const MAX_WRITE_BYTES = 10 * 1024 * 1024;

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
        'file). Refuses content over 10MB.',
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

      if (bytes.length > MAX_WRITE_BYTES) {
        return errorResult(
          `content is ${bytes.length} bytes, over fs_write's ${MAX_WRITE_BYTES}-byte limit; write it ` +
            `in smaller pieces (e.g. with fs_edit against an existing file) instead`
        );
      }

      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      // Written from the already-computed `bytes` buffer, not `content` +
      // an encoding name, for both branches: text mode's bytes are already
      // exactly the UTF-8 encoding fs.writeFileSync(..., 'utf-8') would
      // produce, and base64 mode's bytes are the decoded raw bytes, which
      // fs.writeFileSync must write with NO encoding argument -- passing
      // 'utf-8' here would re-interpret and re-encode an arbitrary byte
      // buffer as if it were UTF-8 text, corrupting exactly the bytes this
      // escape hatch exists to preserve.
      fs.writeFileSync(filePath, bytes);

      return translateResult(textResult(`Wrote ${bytes.length} bytes to ${filePath}`), [filePath], ctx.labels);
    }
  );
}
