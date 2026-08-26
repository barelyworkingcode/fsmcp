import * as fs from 'fs';
import { ToolRegistry, schema, stringProp, intProp, enumProp, requireStringArg, optionalStringArg, virtualPathDescription } from '../registry';
import { textResult, errorResult, MCPCallResult, ToolContext } from '../types';
import { checkPathV, decodeInboundPath, translateResult } from '../vpath';
import { decodeUtf8Strict } from '../encoding';
import {
  MAX_RESPONSE_BYTES,
  MAX_BASE64_FILE_BYTES,
  base64EncodedLength,
  wireBytes,
  WIRE_NEWLINE_BYTES,
} from '../limits';

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
// This bounds the ALLOCATION, and is not the same bound as the wire limits
// in src/limits.ts, which bound the MESSAGE (issue #19). Keep both; see that
// file's header for why neither makes the other redundant, and issue #16 for
// the argument that this one in particular "earns its place".
//
// It used to apply to `encoding: "base64"` as well, on the grounds that
// base64 mode "still has to load the whole file to emit it". That stopped
// being true in this change: base64 mode now serves a bounded byte WINDOW
// with a positional read (see readWindow below) and never allocates more
// than MAX_BASE64_FILE_BYTES, so the allocation this constant exists to stop
// cannot happen there any more, and a much tighter bound applies instead.
// That is why base64 mode is now able to reach into a file larger than this
// constant: not an exemption, a stricter limit arrived at by a different
// route.
const MAX_READ_BYTES = 10 * 1024 * 1024;

// Bytes held back from MAX_RESPONSE_BYTES for the "[fsmcp: showing lines
// A-B of C ...]" continuation note, which is appended AFTER the page has
// been measured and whose own size depends on numbers not known until then.
// The note is at most ~130 bytes even with four 8-digit line numbers in it
// (a file cannot have more than MAX_READ_BYTES + 1 lines, so 8 digits is the
// ceiling); 512 is that with room to spare, and it is 0.05% of the budget,
// so nothing is lost by being generous. Reserving is deliberate rather than
// measuring-then-dropping-a-line: dropping content to make room for the note
// that describes what was dropped is a loop with no natural bottom.
const PAGING_NOTE_RESERVE = 512;

/**
 * Read exactly `length` bytes of `filePath` starting at `byteOffset`, with a
 * positional read rather than fs.readFileSync.
 *
 * This is what makes `encoding: "base64"`'s byte windowing real instead of
 * cosmetic: fs.readFileSync would allocate the whole file and then slice it,
 * so a window into a 400 MB file would still be a 400 MB synchronous
 * allocation in the one process every other caller is waiting on -- exactly
 * the failure MAX_READ_BYTES exists to prevent, reintroduced by a feature
 * meant to avoid it. With pread the allocation is the window, full stop.
 *
 * The loop exists because readSync is allowed to return a short read; a
 * `n === 0` return means EOF (the file shrank between stat and read, or the
 * window ran past the end), and the caller sees a shorter Buffer, which it
 * reports honestly as `_meta.bytes` rather than padding.
 */
function readWindow(filePath: string, byteOffset: number, length: number): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buf, read, length - read, byteOffset + read);
      if (n === 0) break;
      read += n;
    }
    return read === length ? buf : buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read an optional non-negative integer argument, refusing anything that is
 * present but not one, rather than letting `as number` lie about it the way
 * text mode's `offset`/`limit` still do (a string or a float there is cast
 * unchecked and reaches Array.prototype.slice, producing a silently different
 * window than the caller asked for -- a real wart, left alone here because it
 * predates this issue and fixing it would change text mode's behaviour under
 * the guise of a transport fix). The byte window is new surface, so it gets
 * this right from the start: `byte_offset` is about to be handed to a
 * positional read syscall, where a negative or fractional value is a much
 * worse thing to be casual about.
 *
 * Returns `undefined` when genuinely absent, a number when valid, and an
 * MCPCallResult refusal otherwise -- the same three-way shape
 * `requireStringArg` uses, so a caller distinguishes them with `typeof`.
 */
function optionalCountArg(args: Record<string, unknown>, name: string): number | undefined | MCPCallResult {
  const raw = args[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    return errorResult(`${name} must be a non-negative integer; received ${JSON.stringify(raw)}`);
  }
  return raw;
}

export function registerRead(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_read',
      description:
        'Read a file. encoding: "text" (default) decodes the file as UTF-8 and returns a ' +
        'line-numbered PAGE (cat -n format) -- lines over 2000 characters are truncated, and ' +
        '"offset"/"limit" select a line range. The page always reports whether more of the file ' +
        'remains: an inline "[fsmcp: showing lines A-B of C; pass offset: D ...]" note plus ' +
        '_meta.truncated, so a short page is never mistakable for a whole file. A page ends at ' +
        'whichever comes first: the line limit (default 2000 lines) or fs_read\'s 1MiB response ' +
        'limit. That view is NOT byte-faithful, even for a file that is clean UTF-8: it is ' +
        'decoded, truncated, and line-split before it reaches you. Text mode refuses a file whose ' +
        'bytes are not valid UTF-8 rather than guessing at a lossy decoding. ' +
        'encoding: "base64" is the byte-exact path: the returned text is ONLY the base64 payload ' +
        '(no header, no trailing newline, no line numbers, no truncation, and no line-based ' +
        'offset/limit -- those are rejected in base64 mode, not silently ignored); the byte count, ' +
        'window start and file size are in _meta.bytes / _meta.byte_offset / _meta.total_bytes. ' +
        'base64 returns at most 256KiB of file per call; use "byte_offset"/"byte_length" to read a ' +
        'larger file in pieces. A whole-file base64 payload (no byte_offset/byte_length, file ' +
        'within the ceiling) can be passed verbatim, unmodified, as fs_write\'s "content" with ' +
        'encoding: "base64" to round-trip the file\'s exact bytes; a WINDOWED payload is for ' +
        'reading only -- fs_write has no matching offset, so windows cannot be reassembled into a ' +
        'file through fsMCP. Text mode refuses a file over 10MB outright -- use fs_grep to search ' +
        'a larger one instead.',
      inputSchema: schema(
        {
          file_path: stringProp(virtualPathDescription()),
          offset: intProp('Line number to start reading from (1-based). Text mode only.'),
          limit: intProp('Maximum number of lines to read (default: 2000). Text mode only.'),
          byte_offset: intProp(
            'Byte offset to start reading from (0-based). encoding: "base64" only. Use with ' +
              'byte_length to read a file larger than the 256KiB per-call ceiling in pieces.'
          ),
          byte_length: intProp(
            'Number of bytes to read (default: the rest of the file, which is refused if it ' +
              'exceeds the 256KiB per-call ceiling). encoding: "base64" only.'
          ),
          encoding: enumProp(
            '"text" (default): decode as UTF-8, line-numbered page, refuses non-UTF-8 content. ' +
              '"base64": exact bytes on disk as a bare base64 string (byte count in _meta.bytes), ' +
              'no decoding, no view formatting, works on any file, safe to pass straight into ' +
              'fs_write\'s encoding: "base64" when the whole file was returned.',
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
      // only option that doesn't guess at what the caller meant -- and that
      // stays true now that base64 mode HAS a windowing mechanism: it is a
      // separate, differently-named pair of arguments precisely so "line 40"
      // and "byte 40" can never be confused for one another by a caller that
      // switched encodings and left its arguments alone.
      if (encoding === 'base64' && (args.offset !== undefined || args.limit !== undefined)) {
        return errorResult(
          'offset/limit are a line-based view and do not apply to encoding: "base64"; use ' +
            'byte_offset/byte_length to select a byte range instead.'
        );
      }

      // The same refusal in the other direction, for the same reason: a byte
      // window has no meaning against a decoded, line-numbered view, and
      // ignoring it would hand back a page that silently is not the range
      // the caller asked for.
      if (encoding === 'text' && (args.byte_offset !== undefined || args.byte_length !== undefined)) {
        return errorResult(
          'byte_offset/byte_length select a byte range and only apply to encoding: "base64"; ' +
            'text mode is a line-based view -- use offset/limit, or pass encoding: "base64".'
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

      if (encoding === 'base64') {
        // The byte-exact path: no extension check, no content sniffing --
        // any file's bytes, base64-encoded, unconditionally. This is what
        // makes a PNG (or any other non-UTF-8 file) readable at all now
        // that there is no extension-keyed auto-base64 special case; the
        // caller declares the encoding instead of fsMCP guessing it from a
        // filename.
        //
        // The payload text is ONLY the base64 -- no "[base64: N bytes]"
        // header, no trailing newline, nothing else in the content string.
        //
        // General rule: a mode that exists for fidelity must round-trip
        // through itself. fs_read(base64) piped straight into
        // fs_write(base64), with no editing step in between, has to be an
        // identity for the file's bytes -- the same guarantee text mode
        // explicitly does NOT make (it is a documented view: line-numbered,
        // truncated, and says so).
        //
        // An earlier version of this prefixed a human-readable
        // "[base64: N bytes]\n" header. That broke the rule: fs_read's own
        // reply was not valid input to fs_write's own base64 decoder (PR
        // #13 review) -- isValidBase64 correctly refused the header line,
        // so nothing was corrupted, but the obvious, undocumented
        // composition of the two calls simply did not work. A caller who
        // "fixed" that by stripping the header via a pattern nothing
        // specifies could just as easily strip it WRONG and silently
        // corrupt the bytes -- the exact failure this whole issue exists to
        // close, just moved one level up and disguised as a caller bug
        // instead of a design one. The byte count is still available, just
        // structurally, in `_meta.bytes` -- the same idea as
        // `_meta.truncated` below, for the same reason: something a caller
        // branches on, not prose it has to parse out of the payload it is
        // about to decode.
        //
        // That identity is unchanged for a WHOLE-FILE read, which is the
        // only shape it was ever claimed for, and the ceiling below is
        // enforced so that a whole-file read can never quietly become a
        // prefix: an over-ceiling file is REFUSED, never served as its
        // first 256 KiB. A base64 payload has no room for an inline "there
        // is more" marker without breaking the identity above, so a silent
        // prefix here would be undetectable from the content -- the worst
        // shape this codebase has. See the byte-window branch for what a
        // windowed payload does and does not promise.
        const totalBytes = stat.size;

        const byteOffsetArg = optionalCountArg(args, 'byte_offset');
        if (typeof byteOffsetArg === 'object') return byteOffsetArg;
        const byteLengthArg = optionalCountArg(args, 'byte_length');
        if (typeof byteLengthArg === 'object') return byteLengthArg;

        const byteOffset = byteOffsetArg ?? 0;
        if (byteOffset > totalBytes) {
          return translateResult(
            errorResult(
              `byte_offset ${byteOffset} is past the end of ${filePath}, which is ${totalBytes} bytes ` +
                `(_meta.total_bytes on any successful base64 read gives you this number)`
            ),
            [filePath],
            ctx.labels
          );
        }

        // min() with what is actually left, not a refusal: a caller looping
        // with a fixed byte_length has no way to make the last window land
        // exactly on EOF, and short-reading the tail is what every read(2)
        // in existence does. Nothing is hidden by it -- `_meta.bytes` says
        // how much came back and `_meta.total_bytes` says how much there
        // was, so "this was the tail" is derivable, not guessed.
        const windowed = byteOffsetArg !== undefined || byteLengthArg !== undefined;
        const remaining = totalBytes - byteOffset;
        const length = Math.min(byteLengthArg ?? remaining, remaining);

        if (length > MAX_BASE64_FILE_BYTES) {
          const encodedWouldBe = base64EncodedLength(length);
          const message = windowed
            ? `byte_length ${length} is over fs_read's ${MAX_BASE64_FILE_BYTES}-byte per-call ` +
              `base64 ceiling (it would encode to ${encodedWouldBe} bytes); ask for at most ` +
              `${MAX_BASE64_FILE_BYTES} bytes per call and advance byte_offset between calls`
            : `${filePath} is ${totalBytes} bytes, over fs_read's ${MAX_BASE64_FILE_BYTES}-byte ` +
              `per-call base64 ceiling -- base64 inflates by 4/3, so the whole file would be ` +
              `${encodedWouldBe} bytes of payload, which is both a transport risk and far more ` +
              `context than it is worth. Read it in pieces with byte_offset/byte_length ` +
              `(byte_offset: 0, byte_length: ${MAX_BASE64_FILE_BYTES}, then byte_offset: ` +
              `${MAX_BASE64_FILE_BYTES}, and so on; _meta.total_bytes tells you when to stop). ` +
              `Those pieces are for READING: fs_write has no matching byte offset, so they cannot ` +
              `be reassembled into a copy of the file through fsMCP.`;
          return translateResult(errorResult(message), [filePath], ctx.labels);
        }

        let slice: Buffer;
        try {
          slice = readWindow(filePath, byteOffset, length);
        } catch {
          return translateResult(errorResult(`file not found: ${filePath}`), [filePath], ctx.labels);
        }

        const payload = slice.toString('base64');

        // Transport backstop. It cannot fire at the default ceilings (256
        // KiB of file is 349,528 bytes of base64, a third of the response
        // budget) and it is still not dead code: issue #16 turns both
        // numbers into operator flags, and an operator who raises the base64
        // ceiling past floor(MAX_RESPONSE_BYTES * 3/4) needs the transport
        // bound to stop them here rather than in relay's scanner, where the
        // cost is every client's session, not this call.
        if (wireBytes(payload) > MAX_RESPONSE_BYTES) {
          return translateResult(
            errorResult(
              `the base64 encoding of ${length} bytes of ${filePath} is ${payload.length} bytes, over ` +
                `fs_read's ${MAX_RESPONSE_BYTES}-byte response limit; ask for a smaller byte_length`
            ),
            [filePath],
            ctx.labels
          );
        }

        // byte_offset/total_bytes ride alongside bytes for the same reason
        // bytes itself does (PR #13): a caller driving a windowed read needs
        // to know where it is and when to stop, and it must not have to
        // parse that out of a payload whose whole value is being byte-exact.
        return {
          content: [{ type: 'text', text: payload }],
          _meta: { bytes: slice.length, byte_offset: byteOffset, total_bytes: totalBytes },
        };
      }

      if (stat.size > MAX_READ_BYTES) {
        return translateResult(
          errorResult(
            `${filePath} is ${stat.size} bytes, over fs_read's ${MAX_READ_BYTES}-byte limit; ` +
              `narrow with offset/limit is not possible because the whole file must be loaded ` +
              `to find line boundaries -- use fs_grep to search it instead, or read the bytes ` +
              `in windows with encoding: "base64" and byte_offset/byte_length`
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

      // Issue #19: the page is bounded in BYTES ON THE WIRE as well as in
      // lines, and the byte bound is measured, not estimated.
      //
      // Estimating is what the old code did wrong at the file level, and
      // text mode is the harder case of the two: line numbering adds
      // numWidth + 1 bytes per line, the "... [truncated]" marker adds 15 to
      // an over-long one, and JSON escaping then multiplies what is left by
      // anything from 1x (ASCII) to 6x (a C0 control byte, which is valid
      // UTF-8 and appears in real files). The genuine worst case is not a
      // ratio worth quoting: a 10 MiB file that is nothing but newlines,
      // read with an explicit `limit`, formats to ~90 MiB of numbered blank
      // lines before escaping, and 2000 lines x 2000 chars of control bytes
      // -- inside every existing limit -- is ~24 MiB. Both are decided here,
      // by adding up what each line actually costs, and stopping.
      //
      // Stopping short is PAGINATION, not truncation, and that distinction
      // is the reason this is not a refusal. fs_read already had a bound
      // that ends a page early (DEFAULT_LIMIT), already had the vocabulary
      // to say so (the inline continuation note, `_meta.truncated`), and
      // already named the offset to resume from -- issue #16 calls that "a
      // complete contract" and asks for it to stay. A byte budget is the
      // same bound in a second dimension and reuses the same contract, so
      // nothing comes back looking complete when it is not. Refusing here
      // instead would break ordinary reads for no gain: a caller that never
      // set `limit` did not ask for 2000 lines, it asked for the file, and
      // answering "too big, guess a smaller number" would be a worse answer
      // than "here are the first N lines, continue at N+1".
      //
      // The accounting is exact rather than conservative: wireBytes is the
      // encoder main.ts will actually run, and JSON escaping is per-code-
      // unit, so a sum over lines split on "\n" (which cannot fall between
      // the halves of a surrogate pair) is the real byte count, not a bound
      // on it.
      const lineBudget = MAX_RESPONSE_BYTES - PAGING_NOTE_RESERVE;
      const formatted: string[] = [];
      let pageBytes = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = String(startIdx + i + 1).padStart(numWidth);
        let displayLine = line;
        let thisLineTruncated = false;
        if (line.length > MAX_LINE_LENGTH) {
          displayLine = line.substring(0, MAX_LINE_LENGTH) + '... [truncated]';
          thisLineTruncated = true;
        }
        const rendered = `${lineNum}\t${displayLine}`;
        const cost = wireBytes(rendered) + (i > 0 ? WIRE_NEWLINE_BYTES : 0);
        if (pageBytes + cost > lineBudget) break;
        pageBytes += cost;
        formatted.push(rendered);
        if (thisLineTruncated) truncatedAnyLine = true;
      }

      // Not reachable with MAX_LINE_LENGTH at 2000 -- the widest a single
      // rendered line can be is 2015 characters plus its number, which is
      // ~12 KB even if every character escapes to six bytes, against a 1 MiB
      // budget. It is here because issue #16 proposes making
      // --max-line-length an operator flag, and a raised one makes it
      // reachable. Refusing is right in this case and pagination is not:
      // there is no shorter page to return (a page of zero lines carries no
      // content and no usable continuation offset), so there is nothing to
      // be honest about except that this line does not fit.
      // ...but ONLY when there was a line to format and it did not fit.
      // `lines` is empty for two entirely ordinary requests -- an `offset`
      // past the end of the file, which is exactly what paging to the end
      // looks like, and `limit: 0` -- and issue #19's first version answered
      // both with the refusal below, telling a caller that line 5 of a
      // three-line file was too large to return. That is a regression this
      // branch caused, not a condition it exists for: nothing was too big,
      // there was simply nothing there. An empty page is the honest answer,
      // and it carries the same continuation contract every other page does.
      if (lines.length === 0) {
        const empty = textResult('');
        empty._meta = { truncated: false, lines: allLines.length };
        return empty;
      }
      if (formatted.length === 0) {
        return translateResult(
          errorResult(
            `line ${offset} of ${filePath} does not fit in fs_read's ${MAX_RESPONSE_BYTES}-byte ` +
              `response limit on its own, so there is no page to return; read the file's bytes ` +
              `with encoding: "base64" and byte_offset/byte_length instead`
          ),
          [filePath],
          ctx.labels
        );
      }

      // The OTHER way this view can be incomplete: DEFAULT_LIMIT (2000
      // lines) applies even when the caller never asked for a limit at all,
      // and a file with more lines than that used to come back looking
      // exactly like a complete read -- no inline marker, no _meta, nothing
      // -- with lines past it simply absent. That is the same silent-
      // truncation shape issue #11 fixed for an over-long LINE, just one
      // level up (over-long FILE instead), and it matters more here because
      // it needs no unusual input to trigger: reading past line 2000 without
      // ever setting `limit` reaches it on an entirely ordinary file. An
      // agent that reads a file this way, assumes it has seen everything (a
      // reasonable assumption -- nothing said otherwise), and writes the
      // whole thing back via fs_write silently truncates the file to
      // whatever it happened to see. Flagged the same way per-line
      // truncation is, structurally AND inline, rather than inventing a
      // second signal for what is the same underlying problem: this
      // response does not contain the whole of what it was asked to
      // represent. The byte budget above ends a page for a different reason
      // but produces the same situation, so it reuses this exact signal
      // rather than adding a third -- with one extra clause in the note, so
      // a caller that asked for 2000 lines and got 700 can see WHICH limit
      // it hit and does not read it as "the file ended here".
      const linesShown = formatted.length;
      const endedOnBytes = linesShown < lines.length;
      const moreLinesRemain = startIdx + linesShown < allLines.length;

      let resultText = formatted.join('\n');
      if (moreLinesRemain) {
        const shownThrough = startIdx + linesShown;
        const reason = endedOnBytes
          ? `; the page ended at fs_read's ${MAX_RESPONSE_BYTES}-byte response limit, before the ` +
            `line limit`
          : '';
        resultText +=
          `\n[fsmcp: showing lines ${offset}-${shownThrough} of ${allLines.length}${reason}; ` +
          `pass offset: ${shownThrough + 1} to continue reading]`;
      }

      const result = textResult(resultText);
      if (truncatedAnyLine || moreLinesRemain) {
        result._meta = { truncated: true };
      }
      return result;
    }
  );
}
