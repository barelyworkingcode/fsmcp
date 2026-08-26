import { MCPCallResult, errorResult } from './types';

// Transport and context limits for what fsMCP puts on -- and accepts off --
// the stdio wire (issue #19).
//
// The defect this file exists for is NOT "fs_read's file limit is wrong". It
// is "fsMCP does not bound its responses". fs_read was the first way found to
// emit a fatal frame; fs_grep in `output_mode: "content"` was the second, and
// it capped nothing at all -- not lines, not bytes -- so an ordinary grep for
// a common word over a large granted repository crossed relay's frame cap on
// its own. The two failures do not even look alike from the outside (fs_read
// killed fsmcp; the grep case left fsmcp alive and killed relay's stdout
// reader instead) and they produce the identical permanent outage for every
// grant on the host. A bound that lives in one tool leaves the next tool to
// reopen this, so the bound here is a property of EVERY result, applied where
// results are built and enforced again where they are serialised.
//
// These are NOT the same thing as fs_read's MAX_READ_BYTES / fs_write's
// MAX_WRITE_BYTES, and the difference is the whole point of this file. Those
// two are PROCESS protection: fsmcp is one synchronous loop, and a
// multi-hundred-megabyte `fs.readFileSync` blocks (and can kill) the one
// process every other caller is waiting on, so they bound the ALLOCATION.
// The constants here are TRANSPORT and CONTEXT protection: they bound the
// MESSAGE, which is a different quantity with a different worst case and a
// different consumer. Issue #16 argues MAX_READ_BYTES "earns its place", and
// it does -- it is not made redundant by anything below, and nothing below is
// made redundant by it. Deleting either family because the other exists is
// the specific mistake this comment is here to prevent.
//
// ---------------------------------------------------------------------------
// Why a message bound exists at all (issue #19)
// ---------------------------------------------------------------------------
//
// fsMCP's own limits used to describe the FILE ON DISK while the thing that
// actually breaks is the RESPONSE LINE. `stat.size > MAX_READ_BYTES` passed a
// 9 MB file, and fs_read then wrote ~12 MB of base64 as a single line to
// stdout. Relay reads a stdio MCP's stdout with a `bufio.Scanner` capped at
// `bridge.MaxMessageSize` = 10 * 1024 * 1024 (relay/bridge/types.go:13, used
// at external_mcp.go:844) and treats an over-long token as FATAL: the scanner
// returns bufio.ErrTooLong, readLoop exits, readerErr is latched, and nothing
// respawns the child. Every later call -- on every profile, from every
// enrolled client, not just the one that made the big read -- then fails until
// an operator restarts Relay.app by hand. So fsMCP's 10 MiB refusal could
// never actually fire in a relay deployment: the transport died first, and it
// died globally. Measured: 6 MB file -> 8,000,065 bytes returned, survives;
// 8 MB file -> "bufio.Scanner: token too long", server dead for everyone.
//
// A limit on the file is therefore not a limit at all. What crosses the wire
// is what has to be bounded, in both encodings and in both directions.
//
// ---------------------------------------------------------------------------
// Why fsMCP does not read relay's number
// ---------------------------------------------------------------------------
//
// It cannot, and pretending otherwise would be worse than a constant. Relay
// does not advertise MaxMessageSize in the handshake, fsMCP has no import path
// into a Go package, and fsMCP is not relay-only -- it is a plain stdio MCP
// that also runs under bare `node dist/main.js` and under any other host, each
// with its own framing rules (or none). The honest arrangement is a default
// chosen with a stated margin under the smallest cap fsMCP is known to run
// behind, with the relationship written down here so a future reader can check
// it against relay rather than rediscover it from a dead deployment. Per issue
// #16 these become operator flags; see "Configurability" at the bottom.

/**
 * The largest single payload fsMCP will put into one JSON-RPC message, or
 * accept out of one, measured in BYTES ON THE WIRE after JSON escaping.
 *
 * 1 MiB, ~10x under relay's 10 MiB `bridge.MaxMessageSize`. The margin is
 * deliberately generous rather than tight-but-provable, for three reasons:
 *
 *  1. This bounds the one LARGE field (fs_read's payload, fs_write's
 *     `content`), not the whole line. The JSON-RPC envelope, `_meta`, and the
 *     advisory content blocks main.ts appends for dropped/malformed
 *     `_meta.allowed_dirs` entries all ride along outside this number. They
 *     are small -- hundreds of bytes -- but they are not zero, and "provably
 *     exactly at the cap" is a bad place for a bound whose failure mode is a
 *     dead server for every client.
 *  2. fsMCP does not know what else is in the chain. Relay is one host; a
 *     future one may frame or re-encode, and a 10x margin survives a
 *     constant-factor surprise that a 1.02x margin does not.
 *  3. Nothing legitimate needs the other 9 MiB. A 1 MiB response is already
 *     ~350K tokens of text at 3 chars/token -- past a standard 200K context
 *     window on its own. See MAX_BASE64_FILE_BYTES.
 *
 * Enforced on the ENCODED response for both encodings, not on the file: for
 * base64 the encoded form is 4/3 the file's bytes, and for text mode line
 * numbering, the tab separator, the truncation markers and JSON escaping all
 * add bytes on top of the file's own (see wireBytes below).
 */
export const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;

/**
 * The largest FILE, in its own bytes on disk, that `fs_read` will return
 * through `encoding: "base64"` in a single call.
 *
 * 256 KiB. This is a CONTEXT limit, not a transport one, and it is
 * deliberately far below what MAX_RESPONSE_BYTES would allow (which is
 * floor(1 MiB * 3/4) = 786,432 bytes): base64 tokenizes at roughly 3
 * characters per token, so a 1 MiB file becomes ~1.4M base64 characters
 * ~= 460K tokens -- more than twice a standard 200K model context window.
 * The response would cross the wire intact and then destroy the context of
 * the agent that asked for it, which is a failure fsMCP can see coming and
 * the agent cannot. 256 KiB lands around 115K tokens: still half a window,
 * still enough for an icon, a config blob, a certificate or a small PDF, and
 * not enough to be absurd.
 *
 * Not applied to fs_write's inbound base64 (which is bounded by
 * MAX_RESPONSE_BYTES alone). The asymmetry is intentional: nothing is being
 * loaded into anyone's context on a write, so the reason for this number does
 * not apply in that direction. The round-trip promise still holds in the
 * direction that matters -- every payload fs_read(base64) can produce is
 * comfortably inside what fs_write(base64) accepts.
 *
 * MAX_RESPONSE_BYTES is still enforced on base64 responses as a backstop even
 * though it cannot fire at these defaults (256 KiB encodes to 349,528 bytes,
 * a third of the response cap). That check is not dead code waiting to be
 * deleted: issue #16 makes both numbers operator flags, and an operator who
 * raises the base64 ceiling past 768 KiB needs the transport bound to be the
 * thing that stops them, not a comment.
 */
export const MAX_BASE64_FILE_BYTES = 256 * 1024;

/**
 * The largest file `encoding: "base64"` could return if only the transport
 * bound applied -- floor(MAX_RESPONSE_BYTES * 3 / 4), because base64 inflates
 * by exactly 4/3. Used for fs_write's inbound base64 ceiling (where the
 * context argument above does not apply) and named here rather than open-coded
 * so the 4/3 relationship lives in one place.
 */
export function base64SourceCeiling(responseBytes: number = MAX_RESPONSE_BYTES): number {
  return Math.floor((responseBytes * 3) / 4);
}

/** Exact encoded length of `n` bytes of base64, padding included. */
export function base64EncodedLength(n: number): number {
  return 4 * Math.ceil(n / 3);
}

/**
 * Exactly how many bytes `s` occupies inside a JSON string on the wire, NOT
 * counting the two surrounding quote characters.
 *
 * This is the only honest way to answer "how big is this going to be", and
 * estimating it was the trap issue #19 is about. A JS string's `.length` is
 * UTF-16 code units, which is a floor on the bytes it serialises to and
 * nothing like a ceiling:
 *
 *   - `"` and `\` cost 2 bytes each (`\"`, `\\`).
 *   - A C0 control byte costs SIX (`\u0001`) -- and a plain text file full of
 *     them is perfectly valid UTF-8, so this is not a hypothetical.
 *   - A non-ASCII scalar costs its UTF-8 length (2-4 bytes) for 1-2 code
 *     units, since JSON.stringify emits it raw rather than escaped.
 *
 * So the real worst case for text mode is ~6x the character count, on top of
 * the view formatting fs_read has already added. `JSON.stringify` is used
 * rather than a hand-rolled escape table for the same reason encoding.ts uses
 * `TextDecoder` rather than a hand-rolled UTF-8 validator: this must agree
 * with the encoder that will actually run in main.ts, byte for byte, and the
 * cheapest way to guarantee that is to call it.
 *
 * Additive across concatenation, which is what lets fs_read accumulate a page
 * line by line and stop the moment the budget is gone: JSON escaping is a
 * per-code-unit function, and fs_read only ever splits on "\n", which cannot
 * fall between the halves of a surrogate pair.
 */
export function wireBytes(s: string): number {
  return Buffer.byteLength(JSON.stringify(s)) - 2;
}

/** Wire cost of one "\n" inside a JSON string: it is escaped to `\n`. */
export const WIRE_NEWLINE_BYTES = 2;

/**
 * Held back from MAX_RESPONSE_BYTES for the "(showing X of Y ...)" suffix and
 * any other note a tool appends after its lines have been measured. 4 KiB is
 * ~20x the longest note any tool in this codebase writes, and 0.4% of the
 * budget, so being generous costs nothing.
 */
const RESULT_NOTE_RESERVE = 4 * 1024;

/** What `capLines` produced, and whether it is the whole answer. */
export interface CappedLines {
  /** The kept lines, joined with "\n". */
  text: string;
  /** How many lines are in `text`. */
  shown: number;
  /** How many there would have been with no cap at all. */
  total: number;
  /** `shown < total`. */
  capped: boolean;
  /** Which bound stopped it, for a caller that wants to say so. */
  reason: 'lines' | 'bytes' | null;
}

/**
 * Cap a list of result lines by COUNT and by WIRE BYTES, and report exactly
 * what was left out.
 *
 * Both bounds, not one. A byte cap alone cuts at an unpredictable point in
 * the middle of a result and gives a caller a number ("1048576 bytes") it has
 * no way to reason about; a line cap alone is what fs_glob/fs_list/fs_find
 * already had, and it does not bound anything at all when a line can be a
 * kilobyte of path or of matched source (fs_list's 5000 entries at PATH_MAX
 * is 5 MB; fs_grep content mode had no line cap either). A line is the unit a
 * caller reasons about, so it goes first and does the work in the ordinary
 * case; the byte budget is what makes the guarantee true in the bad case.
 *
 * `total` may be larger than `lines.length` for a caller that stopped
 * collecting early but kept counting -- the "of N" must be the real N, not
 * the size of the array that survived.
 *
 * This deliberately does NOT decide how to report the cap. fs_glob says
 * "(showing 1000 of N matches)", fs_read sets `_meta.truncated` and names a
 * continuation offset; the vocabulary belongs to the tool, the arithmetic
 * belongs here.
 */
export function capLines(
  lines: string[],
  maxLines: number,
  total: number = lines.length,
  budgetBytes: number = MAX_RESPONSE_BYTES - RESULT_NOTE_RESERVE
): CappedLines {
  const kept: string[] = [];
  let bytes = 0;
  let reason: 'lines' | 'bytes' | null = null;

  for (let i = 0; i < lines.length; i++) {
    if (kept.length >= maxLines) {
      reason = 'lines';
      break;
    }
    const cost = wireBytes(lines[i]) + (i > 0 ? WIRE_NEWLINE_BYTES : 0);
    if (bytes + cost > budgetBytes) {
      reason = 'bytes';
      break;
    }
    bytes += cost;
    kept.push(lines[i]);
  }

  // The caller pre-capped its own collection (grepFallback stops pushing once
  // it is far past the cap, so the array it hands over is already short).
  // That is still a line cap, and it still has to be reported.
  if (reason === null && kept.length < total) reason = 'lines';

  return { text: kept.join('\n'), shown: kept.length, total, capped: kept.length < total, reason };
}

/**
 * The largest a whole tool RESULT may be, serialised: the payload budget plus
 * room for the object around it (`content`, `type`, `_meta`, a
 * "(showing X of Y)" note, an appended advisory block).
 */
export const MAX_RESULT_BYTES = MAX_RESPONSE_BYTES + 64 * 1024;

/**
 * The largest LINE fsMCP will ever write to stdout: a whole JSON-RPC message,
 * envelope included. Still ~8.7x under relay's 10 MiB.
 */
export const MAX_FRAME_BYTES = MAX_RESULT_BYTES + 64 * 1024;

/**
 * The universal backstop: no tool result crosses the wire over
 * MAX_RESULT_BYTES, whatever the tool did or forgot to do.
 *
 * This is an ALARM, not the mechanism -- the same standing as
 * `redactLeakedHostPaths` in registry.ts, which it sits next to for the same
 * reason. Every tool that can produce a large result is expected to bound and
 * report its own (fs_read pages, fs_grep/fs_glob/fs_list/fs_find cap and say
 * "showing X of Y"), because only the tool knows how to give a USEFUL bounded
 * answer. What this catches is the tool that does not: the one added next
 * year by someone who did not read this file, or an existing one meeting an
 * input nobody modelled. It replaces the result outright rather than
 * shortening it, because at this layer there is no structure left to shorten
 * honestly -- the alternative is emitting a prefix of somebody's content with
 * no idea what it was a prefix of, which is the failure mode this whole issue
 * exists to prevent.
 *
 * The message says "bug in fsmcp" because that is what reaching it means.
 */
export function boundResultBytes(result: MCPCallResult, toolName: string): MCPCallResult {
  const size = Buffer.byteLength(JSON.stringify(result));
  if (size <= MAX_RESULT_BYTES) return result;
  return errorResult(
    `${toolName} produced a ${size}-byte result, over fsMCP's ${MAX_RESULT_BYTES}-byte response ` +
      `limit, and it was withheld rather than truncated (a shortened result that looks complete ` +
      `is worse than none). This is a bug in fsmcp: every tool is supposed to bound and report ` +
      `its own result. Narrow the request -- fewer entries, a smaller path, a more specific ` +
      `pattern -- and please report it.`
  );
}

// ---------------------------------------------------------------------------
// Configurability (issue #16)
// ---------------------------------------------------------------------------
//
// Both constants above are DEFAULTS, not facts, and both are the right shape
// for the `--max-read-bytes` / `--max-line-length` / `--max-lines` treatment
// issue #16 proposes: operator-side flags, defaulting to today's value,
// deliberately NOT plumbed through `_meta`. A caller must not be able to raise
// its own ceiling -- the ceiling exists partly to protect the transport shared
// by every other enrolment on the same relay, which is precisely not the
// calling client's to spend.
//
// No flag is added here. #16 is the issue that owns the flag surface for this
// server's limits, it is still open, and adding `--max-response-bytes` from
// #19 would either pre-empt its design or leave two half-built flag systems to
// reconcile. The two names that fit its table when someone implements it are
// `--max-response-bytes` (default 1 MiB) and `--max-base64-bytes` (default
// 256 KiB), added ALONGSIDE `--max-read-bytes`, never instead of it.
