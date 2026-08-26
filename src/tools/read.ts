import * as fs from 'fs';
import { ToolRegistry, schema, stringProp, intProp, enumProp, requireStringArg, optionalStringArg, virtualPathDescription } from '../registry';
import { textResult, errorResult, MCPCallResult, ToolContext } from '../types';
import { checkPathV, decodeInboundPath, translateResult } from '../vpath';
import { decodeUtf8Strict } from '../encoding';

const MAX_LINE_LENGTH = 2000;
const DEFAULT_LIMIT = 2000;

// C5 ("max bytes on fs_read and fs_write") named this explicitly and it was
// simply never implemented: every read below loaded the *entire* file into
// memory with fs.readFileSync before offset/limit ever got a chance to trim
// it down to a handful of lines. fsmcp is one synchronous process serving
// every caller; a file this large already sitting inside an allowed_dir (put
// there by the same agent this tool serves, or by anything else with write
// access to that directory) turns an ordinary `fs_read` into a
// multi-hundred-megabyte synchronous allocation that blocks -- and can
// exhaust memory in -- the one process every other caller is also waiting
// on. Checked against `stat.size` (already available before any read is
// attempted) rather than after reading, so the refusal costs nothing.
//
// This bound applies identically to both encodings: `encoding: "base64"`
// still has to load the whole file to emit it (fsMCP has no streaming
// transfer path), so it is not exempt just because it skips the line-
// boundary work text mode needs the full buffer for too.
const MAX_READ_BYTES = 10 * 1024 * 1024;

export function registerRead(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_read',
      description:
        'Read a file. encoding: "text" (default) decodes the file as UTF-8 and returns a ' +
        'line-numbered VIEW (cat -n format) -- lines over 2000 characters are truncated, and ' +
        '"offset"/"limit" select a line range. That view is NOT byte-faithful, even for a file ' +
        'that is clean UTF-8: it is decoded, truncated, and line-split before it reaches you. ' +
        'Text mode refuses a file whose bytes are not valid UTF-8 rather than guessing at a lossy ' +
        'decoding. encoding: "base64" is the byte-exact path: the file\'s exact bytes, unmodified, ' +
        'with no line numbers, no truncation, and no offset/limit (those are rejected in base64 ' +
        'mode, not silently ignored). Refuses files over 10MB either way -- use fs_grep to search ' +
        'a larger one instead.',
      inputSchema: schema(
        {
          file_path: stringProp(virtualPathDescription()),
          offset: intProp('Line number to start reading from (1-based). Text mode only.'),
          limit: intProp('Maximum number of lines to read (default: 2000). Text mode only.'),
          encoding: enumProp(
            '"text" (default): decode as UTF-8, line-numbered view, refuses non-UTF-8 content. ' +
              '"base64": exact bytes on disk, no decoding, no view formatting, works on any file.',
            ['text', 'base64']
          ),
        },
        ['file_path']
      ),
      // Reads a local file only; never contacts anything off this machine.
      annotations: { readOnlyHint: true, openWorldHint: false },
      category: 'File System',
    },
    (args: Record<string, unknown>, ctx: ToolContext): MCPCallResult => {
      const filePathArg = requireStringArg(args, 'file_path');
      if (typeof filePathArg !== 'string') return filePathArg;

      // Issue #7: the client addresses files in the virtual space this call
      // was granted (/<label>/...), never a host path -- decodeInboundPath
      // is the only thing standing between the caller's argument and every
      // check below, and it does not replace any of them: checkPathV runs
      // security.ts's own checkPath, unmodified, on the host path it hands
      // back, and only translates the message THAT returns.
      const decoded = decodeInboundPath(filePathArg, ctx.labels);
      if (typeof decoded !== 'string') return decoded;
      const filePath = decoded;

      const encodingArg = optionalStringArg(args, 'encoding');
      if (typeof encodingArg === 'object') return encodingArg;
      if (encodingArg !== undefined && encodingArg !== 'text' && encodingArg !== 'base64') {
        return errorResult(`encoding must be "text" or "base64"; received ${JSON.stringify(encodingArg)}`);
      }
      const encoding: 'text' | 'base64' = encodingArg === 'base64' ? 'base64' : 'text';

      // offset/limit are a line-based view over decoded text; base64 mode
      // has no lines at all, so accepting them there would mean either
      // silently ignoring an argument the caller explicitly set (exactly
      // the kind of quiet mismatch issue #11 is about) or inventing a
      // byte-range meaning for them that nothing documents. Refusing is the
      // only option that doesn't guess at what the caller meant.
      if (encoding === 'base64' && (args.offset !== undefined || args.limit !== undefined)) {
        return errorResult(
          'offset/limit are a line-based view and do not apply to encoding: "base64" (which ' +
            'returns the whole file\'s exact bytes); omit them for a base64 read.'
        );
      }

      const pathErr = checkPathV(filePath, ctx.allowedDirs, ctx.labels);
      if (pathErr) return pathErr;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return translateResult(errorResult(`file not found: ${filePath}`), [filePath], ctx.labels);
      }

      if (stat.isDirectory()) return errorResult('path is a directory, not a file');

      if (stat.size > MAX_READ_BYTES) {
        return translateResult(
          errorResult(
            `${filePath} is ${stat.size} bytes, over fs_read's ${MAX_READ_BYTES}-byte limit; ` +
              `narrow with offset/limit is not possible because the whole file must be loaded ` +
              `to find line boundaries -- use fs_grep to search it instead`
          ),
          [filePath],
          ctx.labels
        );
      }

      // From here down: real file bytes. Neither this nor the formatted
      // text below is EVER passed through translateResult/hostToVirtual --
      // this is a file's own content, which can legitimately contain
      // something that reads like the sandbox's own host path (a config, a
      // log, a script mentioning its own location), and must reach the
      // caller byte for byte regardless (PR #10 review: a whole-result
      // rewrite used to run here too, and a write-then-read round trip
      // showed it silently corrupting exactly this case).
      const buf = fs.readFileSync(filePath);

      if (encoding === 'base64') {
        // The byte-exact path: no extension check, no content sniffing --
        // any file's bytes, base64-encoded, unconditionally. This is what
        // makes a PNG (or any other non-UTF-8 file) readable at all now
        // that there is no extension-keyed auto-base64 special case; the
        // caller declares the encoding instead of fsMCP guessing it from a
        // filename.
        return textResult(`[base64: ${buf.length} bytes]\n${buf.toString('base64')}`);
      }

      let content: string;
      try {
        content = decodeUtf8Strict(buf);
      } catch {
        // Representability check, not a content judgement: these bytes do
        // not survive a round trip through UTF-8 text, so text mode cannot
        // deliver them losslessly. Refusing beats returning U+FFFD -- a
        // caller that gets a wall of replacement characters back with no
        // error has no way to know its own next fs_write of that content
        // would corrupt the file (issue #11's core mechanism) -- and
        // base64 mode names the one encoding that does work for these
        // bytes rather than leaving the caller to guess.
        return translateResult(
          errorResult(
            `${filePath}'s bytes are not valid UTF-8, so encoding: "text" cannot represent them ` +
              `losslessly. Pass encoding: "base64" to read the exact bytes.`
          ),
          [filePath],
          ctx.labels
        );
      }

      const allLines = content.split('\n');

      const offset = Math.max(1, (args.offset as number) ?? 1);
      const limit = (args.limit as number) ?? DEFAULT_LIMIT;
      const startIdx = offset - 1;
      const lines = allLines.slice(startIdx, startIdx + limit);

      const maxLineNum = startIdx + lines.length;
      const numWidth = Math.max(String(maxLineNum).length, 1);

      // Structured alongside the inline "... [truncated]" marker (issue
      // #11): the marker alone is a hint a human reader might catch and a
      // caller program has to pattern-match English to notice, which is
      // exactly the kind of silent-in-practice signal this issue exists to
      // replace with something a caller can branch on directly.
      let truncatedAnyLine = false;

      const formatted = lines
        .map((line, i) => {
          const lineNum = String(startIdx + i + 1).padStart(numWidth);
          let displayLine = line;
          if (line.length > MAX_LINE_LENGTH) {
            displayLine = line.substring(0, MAX_LINE_LENGTH) + '... [truncated]';
            truncatedAnyLine = true;
          }
          return `${lineNum}\t${displayLine}`;
        })
        .join('\n');

      const result = textResult(formatted);
      if (truncatedAnyLine) {
        result._meta = { truncated: true };
      }
      return result;
    }
  );
}
