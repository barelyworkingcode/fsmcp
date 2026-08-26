// Shared byte/text representability checks for fs_read, fs_write, fs_edit and
// fs_grep's Node fallback (issue #11).
//
// fsMCP is a pass-through: it does not decide what a file's bytes MEAN
// (there is no "this looks like a binary file" judgement anywhere in this
// module), it only decides whether those bytes can be represented
// losslessly in the encoding a caller asked for. If they can, they are
// delivered exactly; if they cannot, the call is refused and the caller is
// told which encoding does work. Content-based, not extension-based: two
// files with identical bytes and different names must be treated
// identically, which is exactly what an `IMAGE_EXTENSIONS`-style check
// (fsMCP used to have one, keyed on `.png`/`.jpg`/etc.) cannot guarantee.
//
// Centralized here so fs_read, fs_edit and fs_grep's fallback all make this
// call the same way, from the same bytes, rather than three near-identical
// hand-rolled checks drifting apart over time.

/**
 * Decode `buf` as UTF-8, throwing if any byte sequence in it is not valid
 * UTF-8, instead of silently substituting U+FFFD.
 *
 * `TextDecoder('utf-8', { fatal: true })` is used deliberately in place of
 * `buf.toString('utf-8')` (or `fs.readFileSync(path, 'utf-8')`, the actual
 * call that caused issue #11): Node's `Buffer#toString` has no strict mode
 * at all -- it always substitutes U+FFFD for an invalid sequence, and that
 * mapping is lossy and irreversible the instant it happens, before any of
 * this codebase's own logic runs. `TextDecoder`'s `fatal` option is a
 * documented, standard (WHATWG Encoding spec) way to ask for the opposite:
 * throw on the first invalid sequence rather than substitute one in. This
 * is a representability question -- "can these exact bytes round-trip
 * through UTF-8 text?" -- not a detection heuristic, and hand-rolling a
 * byte-by-byte UTF-8 validator instead would duplicate logic the platform
 * already implements correctly, with real ways to get it subtly wrong (an
 * off-by-one on a continuation byte, an overlong encoding accepted, a
 * surrogate half accepted) that this issue does not need more of.
 */
export function decodeUtf8Strict(buf: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(buf);
}

/**
 * True if `buf`'s bytes are exactly representable as UTF-8 text -- i.e.
 * `decodeUtf8Strict` would not throw. A thin, named wrapper around that
 * throw/no-throw so a call site that only needs the boolean (fs_grep's
 * fallback, which skips a file's content entirely rather than using a
 * decoded string) doesn't repeat its own try/catch.
 */
export function isValidUtf8(buf: Buffer): boolean {
  try {
    decodeUtf8Strict(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * A lone (unpaired) UTF-16 surrogate code unit inside a JS string.
 *
 * This is a different failure from the rest of this file: it cannot occur
 * in a string this codebase decoded from disk itself (decodeUtf8Strict
 * already refuses anything that would produce one -- a lone surrogate is
 * not a valid Unicode scalar value, so it is not valid UTF-8 either), only
 * in a string that arrived some other way, e.g. `content`/`new_string`
 * over JSON-RPC. JSON has no way to *forbid* one: `JSON.parse("\"\\ud800\"")`
 * happily returns a one-code-unit JS string, because JS strings are
 * sequences of UTF-16 code units, not Unicode scalar values, and JSON.parse
 * does not validate surrogate pairing. Node's own UTF-8 encoder then
 * silently substitutes U+FFFD for it on write (`Buffer.from`/
 * `fs.writeFileSync(..., 'utf-8')`) -- the same lossy substitution this
 * whole issue is about, just introduced at the JSON-RPC boundary instead of
 * by a disk read.
 *
 * Refused unconditionally, with no acknowledgement flag, unlike anything
 * else in this file: representing it correctly is not merely undesirable,
 * it is impossible -- UTF-8 has no valid byte sequence for a surrogate code
 * point, so there is no "yes, really write this" a caller could opt into.
 * Refusing is also cheap to justify as never a false positive: nothing this
 * server itself ever decodes from disk can produce one (see above), so the
 * only way `content` or `new_string` carries one is a caller, or something
 * upstream of the caller, already having lost information before the call
 * reached fsMCP.
 */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function hasLoneSurrogate(s: string): boolean {
  return LONE_SURROGATE.test(s);
}

/**
 * True if `s` is valid base64 (RFC 4648, standard alphabet, optional `=`
 * padding, no whitespace or line breaks) -- checked before `Buffer.from(s,
 * 'base64')` is trusted to mean what it says.
 *
 * Node's base64 decoder is lenient by design: it skips characters outside
 * the base64 alphabet rather than throwing, so `Buffer.from('!!!!', 'base64')`
 * silently returns an empty buffer instead of an error, and a caller's
 * typo, truncated copy-paste, or wrong-encoding mistake would decode to the
 * WRONG bytes with no signal that anything was dropped -- fs_write would
 * then report success having written something other than what the caller
 * meant, which is exactly the silent-corruption shape issue #11 exists to
 * close on the read side; this closes the same shape on the write side's
 * base64 escape hatch. Length must also be a multiple of 4 (with the
 * decoded byte count implied by `=` padding): valid base64 is always
 * block-aligned, and Node's lenient decoder will still produce SOME bytes
 * from a non-aligned string rather than erroring, which is exactly the
 * silent-wrong-bytes case this exists to catch.
 */
export function isValidBase64(s: string): boolean {
  if (s.length === 0) return true;
  if (s.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(s);
}
