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
 * 64 KiB. The binding constraint is NOT the transport -- it is the context
 * window of the model on the other end, which is a much smaller number and
 * the one that actually gets destroyed.
 *
 * This started at 1 MiB, chosen as ~10x under relay's 10 MiB
 * `bridge.MaxMessageSize`, and that was the wrong question to ask. 1 MiB of
 * text is ~350K tokens at 3 chars/token: it crosses the wire perfectly and
 * then blows out a 200K context window on arrival, which is a failure fsMCP
 * can see coming and the agent cannot. 64 KiB is ~20K tokens -- a real
 * fraction of a working context, not all of it -- and it is ~160x under
 * relay's cap, so the transport argument is satisfied for free rather than
 * being the thing that decides.
 *
 * Two properties keep this from being merely small:
 *
 *  1. **It bounds one payload, not the message.** The JSON-RPC envelope,
 *     `_meta`, and the advisory blocks main.ts appends for dropped
 *     `_meta.allowed_dirs` entries ride along outside this number. They are
 *     small but not zero, and MAX_RESULT_BYTES below leaves room for them.
 *  2. **Nothing becomes unreachable.** fs_read pages by line and windows by
 *     byte, and the search tools cap and report "showing X of Y", so a
 *     smaller default costs a caller more calls and never an answer. That is
 *     the trade being made deliberately: paging is cheap, a destroyed context
 *     is not.
 *
 * Enforced on the ENCODED response for both encodings, not on the file: for
 * base64 the encoded form is 4/3 the file's bytes, and for text mode line
 * numbering, the tab separator, the truncation markers and JSON escaping all
 * add bytes on top of the file's own (see wireBytes below).
 */
export const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * The largest FILE, in its own bytes on disk, that `fs_read` will return
 * through `encoding: "base64"` in a single call.
 *
 * 32 KiB. This is a CONTEXT limit, not a transport one, and it has to stay
 * meaningfully below what MAX_RESPONSE_BYTES allows or it stops meaning
 * anything: base64 inflates by exactly 4/3, so the transport bound alone
 * would permit floor(64 KiB * 3/4) = 49,152 file bytes. At 32 KiB the encoded
 * payload is 43,692 bytes, comfortably inside the response cap, and lands
 * around 14K tokens at base64's ~3 chars/token.
 *
 * **This number is not independent of MAX_RESPONSE_BYTES and must not be
 * raised without checking it.** It was 256 KiB when the response cap was
 * 1 MiB. When the cap came down to 64 KiB this became 5.3x the cap -- so the
 * ceiling could never fire, and every base64 read between 48 KiB and 256 KiB
 * would have been refused by the transport check while the tool description
 * still advertised a 256 KiB limit. A limit a caller is told about and which
 * cannot be reached is worse than no limit: it sends them to the wrong
 * remedy. The two numbers move together until issue #16 makes both flags.
 *
 * Not applied to fs_write's inbound base64 (which is bounded by
 * MAX_RESPONSE_BYTES alone). The asymmetry is intentional: nothing is being
 * loaded into anyone's context on a write, so the reason for this number does
 * not apply in that direction.
 *
 * A file larger than this is still fully readable, byte for byte, through
 * `byte_offset`/`byte_length` -- the windowing exists precisely so that a
 * conservative whole-file ceiling costs calls rather than access.
 */
export const MAX_BASE64_FILE_BYTES = 32 * 1024;

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
 * Held back from a listing budget for the "(showing X of Y ...)" suffix and
 * any other note a tool appends after its lines have been measured.
 *
 * 1 KiB, ~5x the longest note any tool in this codebase writes. It was 4 KiB
 * when the budget it came out of was 1 MiB, where being generous cost 0.4%.
 * Against MAX_SEARCH_RESULT_BYTES it would cost 25%, which is no longer
 * "generous costs nothing" -- it is a quarter of the caller's answer spent on
 * a sentence. Sized to the note it actually reserves for.
 */
const RESULT_NOTE_RESERVE = 1 * 1024;

/**
 * The largest LISTING a search tool will return: `fs_glob`, `fs_find`,
 * `fs_grep` and `fs_list`.
 *
 * 16 KiB, a quarter of MAX_RESPONSE_BYTES, and deliberately its own number
 * rather than a share of that one. The two bound different shapes of answer
 * and deserve to move independently:
 *
 *  - MAX_RESPONSE_BYTES bounds ONE payload a caller asked for by name -- a
 *    file it chose to read. Spending context on it is the caller's decision.
 *  - This bounds a list the caller did NOT enumerate: every path matching a
 *    pattern, every entry in a directory, every line matching a regex. The
 *    caller cannot know the size before asking, and a broad pattern over a
 *    real repository produces thousands of lines from a single call. That is
 *    the shape most likely to fill a context by accident.
 *
 * Every tool this bounds already reports a bounded answer as bounded --
 * "(showing X of Y matches, cut at ...)" plus `_meta.truncated` -- so a
 * caller can always tell a floor from a complete answer and narrow its
 * pattern. What it CANNOT do for a directory listing is page: `fs_list`,
 * `fs_glob` and `fs_find` take no offset. So a large directory is reported
 * truncated with no way to walk the remainder, and the answer is to narrow
 * the pattern or list a subdirectory. Worth knowing before raising or
 * lowering this; per issue #16 it becomes an operator flag.
 */
export const MAX_SEARCH_RESULT_BYTES = 16 * 1024;

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
  budgetBytes: number = MAX_SEARCH_RESULT_BYTES - RESULT_NOTE_RESERVE
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
 *
 * The allowance is 16 KiB, not the 64 KiB it was: an envelope allowance has
 * to stay SMALLER than the payload it wraps or the backstop stops bounding
 * anything recognisable, and at a 64 KiB payload budget a 64 KiB allowance
 * meant a result could be double its own limit and still pass. 16 KiB is
 * still ~80x the largest envelope this codebase produces.
 *
 * **This must stay ABOVE MAX_RESPONSE_BYTES, and it is derived so it cannot
 * drift below it.** It is the alarm for a tool that did not bound itself; if
 * it were the smaller of the two, it would fire on ordinary correctly-bounded
 * results instead, and an alarm that goes off in normal use is one everybody
 * learns to ignore.
 */
export const MAX_RESULT_BYTES = MAX_RESPONSE_BYTES + 16 * 1024;

/**
 * The largest LINE fsMCP will ever write to stdout: a whole JSON-RPC message,
 * envelope included. Still ~8.7x under relay's 10 MiB.
 */
export const MAX_FRAME_BYTES = MAX_RESULT_BYTES + 16 * 1024;

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
