// How this server's line-oriented text results are SHAPED: the escaping that
// keeps "one result per line" true whatever is on disk, the sentences that
// tell a caller how to parse it, and the rule about where a result stops and
// fsmcp's own commentary starts.
//
// This file exists because the property is shared and the bug was not.
// Issue #31 fixed `fs_list`'s record and left the escaping in list.ts, where
// it read as a fact about that one tool; issue #37 is the same defect
// surviving in `fs_glob`, `fs_find` and `fs_grep`, which all join a list of
// paths with "\n" and escape nothing. A scheme that lives inside the tool it
// was first needed in is a scheme the next tool will not adopt, so it lives
// here, with the four call sites importing it rather than each spelling out
// four `String.replace` calls and hoping they agree.
//
// The one thing this file is NOT allowed to touch is a file's own CONTENT.
// `fs_grep`'s content mode puts a matched line next to a path on the same
// line, and only the path is escaped -- see `escapePathField`'s doc.

/**
 * Make a path safe to put in a line-oriented record (issues #31, #37).
 *
 * A caller has nothing to parse these tools' output with except a split on
 * "\n" and then on whatever separates the fields. A newline in a FILENAME --
 * legal on every POSIX filesystem including APFS, and creatable through
 * fsMCP's own `fs_write` and `fs_move` -- was emitted raw, so one entry
 * became two lines: a phantom record with no type and no size, and a real
 * record whose path stopped at the newline. The format did not fail; it
 * silently stopped being the format, in the caller's parser rather than
 * here.
 *
 * Escaping rather than skipping the entry (the other candidate in #31):
 * refusing to list a file whose name contains a separator makes a real,
 * reachable file invisible to the tools whose job is to say what is there,
 * and every other tool would still happily operate on it by name. A parsing
 * problem is not worth trading for a file that cannot be found. Structured
 * content instead of a text table is the clean answer and a much larger
 * change, worth it only if these tools are reworked as a group.
 *
 * The scheme is C-style and deliberately minimal: a literal backslash
 * becomes `\\`, and the three characters that carry structure in a
 * line-and-tab format -- newline, carriage return, tab -- become `\n`, `\r`,
 * `\t`. Nothing else is touched by default. The backslash pass must come
 * FIRST and must be unconditional, or the scheme is not decodable: a real
 * file named `a\nb` (backslash, n) would otherwise emit the identical bytes
 * as a file whose name contains an actual newline, and a caller unescaping
 * would conjure a newline into a name that never had one. That unconditional
 * pass is the one behaviour change for ordinary paths -- a path containing a
 * backslash now emits it doubled -- and it is the price of the format being
 * reversible at all.
 *
 * `separators` extends the set with the characters that carry structure in
 * ONE tool's format rather than in all of them: `fs_grep` passes ":", because
 * its `path:line:content` record is delimited by a colon and a path
 * containing one broke that record independently of newlines, and always
 * had. That pass runs LAST, after the backslash doubling, which is safe
 * only because the four escapes above emit nothing but a backslash and the
 * letters n/r/t -- so a separator must never be one of `\`, `n`, `r` or `t`.
 * Callers pass a literal, and there is exactly one caller.
 *
 * Applied to the already-translated virtual path (or the redaction
 * placeholder), never to the host path: what goes on the wire is what has to
 * be parseable, and escaping before translation would change the string
 * `hostToVirtualOrRedact` matches its prefix against.
 *
 * NEVER applied to a file's own bytes. `fs_grep` content mode emits
 * `path:line:content`, and `content` is the file's own matched text, which
 * must reach the caller byte for byte -- the same rule `formatRgJson`'s
 * `lines.text` and `fs_read`'s payload already follow, and the rule PR #10
 * exists to enforce after a whole-result rewrite silently corrupted a file
 * whose bytes happened to contain the sandbox path. Escaping content would
 * be that mistake wearing a new coat: it would make `fs_grep`'s output
 * disagree with `fs_read`'s about what is in the file, and a caller could
 * not tell which one to believe. The asymmetry is what the tool descriptions
 * have to state, and do.
 *
 * Every tool that uses this states the rules in its own description, because
 * a caller cannot parse a format whose escaping is unstated -- an escaping
 * scheme nobody is told about turns one silent corruption into a different
 * one. `pathFieldEscapingRules` below is that sentence, shared for the same
 * reason the function is.
 */
export function escapePathField(p: string, separators: string = ''): string {
  let out = p
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  for (const sep of separators) {
    out = out.split(sep).join(`\\${sep}`);
  }
  return out;
}

/**
 * The sentence a tool's description carries so `escapePathField`'s output is
 * parseable without guessing.
 *
 * `unit` is what one line of this tool's output IS ("entry", "result",
 * "result line"), so the promise reads as a statement about that tool's own
 * record. `separators` names any extra characters this tool escapes beyond
 * the universal four, in the same order they are passed to
 * `escapePathField`.
 *
 * Shared rather than copied because the rules are the same rules: four
 * descriptions that drift apart describe four schemes, and there is only
 * one.
 */
export function pathFieldEscapingRules(unit: string, separators: string = ''): string {
  const extra =
    separators === ''
      ? ''
      : `; this tool also escapes ${[...separators]
          .map((c) => `"${c}" as "\\${c}"`)
          .join(' and ')}, because ${
          separators.length > 1 ? 'those characters separate' : 'that character separates'
        } its fields, so the path field never contains an unescaped separator`;
  return (
    `The path field is backslash-escaped so that one ${unit} is always exactly one line, whatever ` +
    `the filename: a literal backslash is written "\\\\", a newline "\\n", a carriage return "\\r" ` +
    `and a tab "\\t"${extra}. No other character is escaped, and no field other than the path is ` +
    `escaped. Unescape by scanning left to right and consuming a backslash together with the ` +
    `character after it -- do not run the replacements independently, or "\\\\n" (an escaped ` +
    `backslash followed by the letter n) decodes to a newline that is not in the name.`
  );
}

/**
 * The other half of "one line per result", and the half issue #37 raised
 * second: every one of these tools may append a trailer -- the
 * `(showing X of Y ...)` cap note, an `[fsmcp: ...]` advisory about a walk
 * that was cut short -- and a caller splitting the payload on "\n" reads
 * those trailer lines as two more results.
 *
 * Documented rather than removed, and deliberately. The trailer is not
 * decoration: issue #11's rule is that a bounded or incomplete answer says
 * so BOTH structurally (`_meta.truncated`) and inline for a human, never one
 * or the other, and dropping the inline half to make the payload uniform
 * would trade a stated parse rule for a silently-short answer -- the exact
 * failure the whole limits story exists to prevent.
 *
 * A reply with NO results is the one shape this rule does not cover on its
 * own -- it is a sentence ("No matches found.", "(empty)"), which a caller
 * splitting on "\n" would otherwise read as one result -- so the rule says
 * so out loud rather than leaving a caller to discover it. Emitting an empty
 * payload instead was considered and rejected for the reason issue #21
 * records: "nothing matched" and "the search could not finish" are different
 * facts, and an empty string is the one output that cannot tell them apart.
 *
 * What makes the trailer itself parseable is the blank line these tools
 * already emit before it: no result line is ever empty (`fs_list` always has
 * four fields, `fs_glob`/`fs_find` always have a non-empty path, `fs_grep`
 * always has a path and a separator), so the first empty line is an
 * unambiguous end-of-results marker. That was already true; it was just never written down.
 */
export const RESULT_TRAILER_RULE =
  'Results run to the first blank line: any trailer -- a "(showing X of Y ...)" cap note, or an ' +
  '"[fsmcp: ...]" advisory about a search that was cut short -- follows one blank line after the ' +
  'last result, and no result line is ever empty, so a caller splitting on newline can take ' +
  "everything before the first empty line as results and everything after it as fsmcp's own " +
  'commentary. A reply with no results at all is a sentence saying so, never an empty payload, ' +
  'so check for that before splitting.';
