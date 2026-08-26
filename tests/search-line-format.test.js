'use strict';

/**
 * Issue #37: `fs_glob`, `fs_find` and `fs_grep` emit one line per result,
 * whatever is in the filename -- and `fs_grep` says exactly how to parse a
 * line that carries a path AND a file's own bytes.
 *
 * #31 fixed `fs_list`'s record and left the escaping inside that one tool,
 * where it read as a fact about `fs_list` rather than about this server's
 * line-oriented output. The other three joined their paths with "\n" and
 * escaped nothing, so a filename containing a newline -- legal on every
 * POSIX filesystem including APFS, and creatable through fsMCP's own
 * `fs_write`/`fs_move` -- turned one result into two lines: a phantom
 * result, and a truncated path a caller would then hand to the next tool.
 *
 * `fs_grep` is not a pure copy of the `fs_list` scheme and the two things
 * that make it different are what most of this file is about:
 *
 *   1. Its content mode is `path:line:content`, and a path containing ":"
 *      broke that record independently of newlines. The path field escapes
 *      ":" as well as the universal four, so the first UNESCAPED colon on a
 *      line is where the path ends.
 *   2. The CONTENT field is the file's own bytes and is never escaped,
 *      never translated, never touched. That is PR #10's rule -- a
 *      whole-result rewrite once silently corrupted a file whose bytes
 *      contained the sandbox path -- and escaping content would be the same
 *      mistake in new clothes. So this file greps a file whose content
 *      contains a colon, a backslash and the sandbox's own host path, and
 *      asserts the content field comes back byte for byte.
 *
 * The `--null` assertion below is the same defect pointing INWARD, found
 * while fixing this one: `fs_find`'s ripgrep backend split `rg --files`
 * output on "\n", so a newline-named file arrived as two non-paths and was
 * dropped -- invisible to `fs_find` on every host with ripgrep installed.
 * Escaping the output would have been a promise about a name fs_find never
 * had.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnServer } = require('./helpers');

function allText(result) {
  return (result.content || []).map((c) => c.text).join('\n');
}

/**
 * Decode an escaped path field the way every one of these tools' descriptions
 * tells a caller to: left to right, consuming a backslash together with
 * whatever follows it. Written as a scanner rather than as independent
 * String.replace calls precisely because the descriptions warn against the
 * latter -- run independently, "\\n" (an escaped backslash then the letter n)
 * becomes a newline that was never in the name.
 */
function unescapePathField(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') {
      out += s[i];
      continue;
    }
    const next = s[++i];
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else out += next; // "\\" and fs_grep's "\:"
  }
  return out;
}

/**
 * Split one `fs_grep` content-mode line into (path, lineNumber, content) by
 * the exact rule the tool description states: scan left to right through
 * escape pairs, stop at the first UNESCAPED ":", then take the digits up to
 * the next ":", and treat everything after that as verbatim content --
 * including any further colons, which belong to the file, not to the format.
 */
function splitEscapedPath(line) {
  let i = 0;
  let escapedPath = '';
  for (; i < line.length; i++) {
    if (line[i] === '\\') {
      escapedPath += line[i] + line[i + 1];
      i++;
      continue;
    }
    if (line[i] === ':') break;
    escapedPath += line[i];
  }
  assert.equal(line[i], ':', `no unescaped ":" in ${JSON.stringify(line)}`);
  return { path: unescapePathField(escapedPath), rest: line.slice(i + 1) };
}

function splitGrepContentLine(line) {
  const { path: p, rest } = splitEscapedPath(line);
  const sep = rest.indexOf(':');
  assert.ok(sep > 0, `no line-number field in ${JSON.stringify(line)}`);
  return { path: p, lineNumber: Number(rest.slice(0, sep)), content: rest.slice(sep + 1) };
}

// Every one of these is legal on APFS and creatable through fsMCP itself.
const HOSTILE_NAMES = [
  // The issue's own case: one result becomes two lines.
  'we\nird.txt',
  // Harmless alone, but a caller trimming lines or splitting on os.EOL sees
  // a different name than the one on disk.
  'car\rriage.txt',
  // A tab is fs_list's field separator; it is escaped here too so one
  // unescaper works across all four tools.
  'ta\tbbed.txt',
  // A literal backslash: what makes the scheme have to be REVERSIBLE rather
  // than merely line-safe.
  'back\\slash.txt',
  // The adversarial pair for the backslash pass: decoded with independent
  // replacements this reads as a newline, decoded left to right it reads as
  // what it is.
  'a\\nb.txt',
  // fs_grep's own delimiter. This breaks "path:line:content" with no
  // newline anywhere in sight, and always did.
  'co:lon.txt',
  // The 99% case, so the test also proves ordinary names are not mangled.
  'plain.txt',
];

const NEEDLE = 'NEEDLEWORD';

function mkFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-searchfmt-')));
  for (const name of HOSTILE_NAMES) {
    fs.writeFileSync(path.join(root, name), `${NEEDLE} here\n`);
  }
  return root;
}

/** The result lines, i.e. everything before the first blank line. */
function resultLines(result) {
  const text = allText(result);
  const blank = text.indexOf('\n\n');
  return (blank === -1 ? text : text.slice(0, blank)).split('\n');
}

test('fs_glob emits exactly one parseable line per match, whatever the filename contains', async (t) => {
  const root = mkFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = spawnServer([]);
  t.after(() => server.close());

  const result = await server.callTool('fs_glob', { pattern: '*.txt' }, { allowed_dirs: [root] });
  assert.equal(result.isError, undefined, allText(result));

  const lines = resultLines(result);
  assert.equal(
    lines.length,
    HOSTILE_NAMES.length,
    `expected one line per match; got ${lines.length}:\n${allText(result)}`
  );

  const seen = lines.map((line) => {
    const decoded = unescapePathField(line);
    assert.ok(decoded.startsWith('/d0/'), `not a virtual address: ${JSON.stringify(decoded)}`);
    return decoded.slice('/d0/'.length);
  });
  // Round trip: every name on disk is recoverable from the output and
  // nothing else is. Line count alone would pass for a tool that silently
  // dropped the awkward names.
  assert.deepEqual(seen.sort(), [...HOSTILE_NAMES].sort());
});

test('fs_find emits exactly one parseable line per match, and can SEE a newline-named file', async (t) => {
  const root = mkFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = spawnServer([]);
  t.after(() => server.close());

  // "txt" is a subsequence of every name in the fixture.
  const result = await server.callTool('fs_find', { pattern: 'txt' }, { allowed_dirs: [root] });
  assert.equal(result.isError, undefined, allText(result));

  const lines = resultLines(result);
  const seen = lines.map((line) => {
    const decoded = unescapePathField(line);
    assert.ok(decoded.startsWith('/d0/'), `not a virtual address: ${JSON.stringify(decoded)}`);
    return decoded.slice('/d0/'.length);
  });

  // Both halves in one assertion, deliberately. The line COUNT is issue
  // #37's outbound defect (one match must not become two lines); the
  // membership of "we\nird.txt" is the inbound one found with it, where
  // `rg --files` output was split on "\n" and this file arrived as the two
  // non-paths "./we" and "ird.txt", both dropped by the re-validation. On a
  // host with ripgrep installed the file was invisible to fs_find entirely;
  // on a host without it, the Node walker listed it fine -- so this
  // assertion is also what keeps the two backends agreeing.
  assert.deepEqual(seen.sort(), [...HOSTILE_NAMES].sort());
});

test('fs_grep escapes the path field in every output mode, including its own ":" delimiter', async (t) => {
  const root = mkFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = spawnServer([]);
  t.after(() => server.close());

  for (const mode of ['files_with_matches', 'count', 'content']) {
    const result = await server.callTool(
      'fs_grep',
      { pattern: NEEDLE, output_mode: mode },
      { allowed_dirs: [root] }
    );
    assert.equal(result.isError, undefined, allText(result));

    const lines = resultLines(result).filter((l) => l !== '--');
    assert.equal(
      lines.length,
      HOSTILE_NAMES.length,
      `${mode}: expected one line per result; got ${lines.length}:\n${allText(result)}`
    );

    const seen = lines.map((line) => {
      let decoded;
      if (mode === 'files_with_matches') {
        decoded = unescapePathField(line);
      } else if (mode === 'count') {
        // Same rule as content mode's first field: the path ends at the
        // first unescaped colon. A path containing ":" made this ambiguous
        // before, which is why the colon is escaped in every mode rather
        // than only in the ones where it separates something -- without it,
        // "co:lon.txt:1" parses as a file called "/d0/co" with a count of
        // "lon.txt".
        const { path: p, rest } = splitEscapedPath(line);
        assert.equal(rest, '1', line);
        decoded = p;
      } else {
        const parsed = splitGrepContentLine(line);
        assert.equal(parsed.lineNumber, 1, line);
        // The content field is the file's own line, verbatim.
        assert.equal(parsed.content, `${NEEDLE} here`, line);
        decoded = parsed.path;
      }
      assert.ok(decoded.startsWith('/d0/'), `${mode}: not a virtual address: ${JSON.stringify(decoded)}`);
      return decoded.slice('/d0/'.length);
    });
    assert.deepEqual(seen.sort(), [...HOSTILE_NAMES].sort(), mode);
  }
});

test("fs_grep's matched CONTENT is byte-for-byte the file's own line, never escaped", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-grepverbatim-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Everything that would be touched if content were run through the path
  // escaper, plus the sandbox's own host path -- PR #10's exact repro, where
  // a whole-result rewrite silently corrupted a file whose bytes contained
  // the granted directory. A tool that "helpfully" escaped its output would
  // hand back a line that fs_read disagrees with, and the caller would have
  // no way to know which to believe.
  const line = `NEEDLEWORD C:\\Users\\x\ttabbed :: ${root} :end`;
  fs.writeFileSync(path.join(root, 'f.txt'), `first\n${line}\nlast\n`);

  const server = spawnServer([]);
  t.after(() => server.close());

  const result = await server.callTool(
    'fs_grep',
    { pattern: 'NEEDLEWORD', output_mode: 'content' },
    { allowed_dirs: [root] }
  );
  assert.equal(result.isError, undefined, allText(result));

  const lines = resultLines(result);
  assert.equal(lines.length, 1, allText(result));
  const parsed = splitGrepContentLine(lines[0]);
  assert.equal(parsed.path, '/d0/f.txt');
  assert.equal(parsed.lineNumber, 2);
  assert.equal(
    parsed.content,
    line,
    'the matched line must arrive exactly as it sits on disk, escaping and host path included'
  );
});

test('fs_glob, fs_find and fs_grep state their escaping rules, so the format is parseable without guessing', async (t) => {
  const server = spawnServer([]);
  t.after(() => server.close());

  const res = await server.request('tools/list', {});
  const byName = new Map(res.result.tools.map((tool) => [tool.name, tool]));

  // An escaping scheme nobody is told about replaces one silent parsing
  // failure with a different one, so the description carrying the rules is
  // part of the fix rather than documentation of it. Each pattern is written
  // against the LITERAL two-character sequence the description must contain
  // -- a backslash followed by n, r or t -- which is why each is one escaped
  // backslash in the regex and not two.
  for (const name of ['fs_list', 'fs_glob', 'fs_find', 'fs_grep']) {
    const d = byName.get(name).description;
    assert.match(d, /escap/i, `${name}: no mention of escaping: ${d}`);
    assert.match(d, /"\\n"/, `${name}: the newline escape is not named: ${d}`);
    assert.match(d, /"\\r"/, `${name}: the carriage-return escape is not named: ${d}`);
    assert.match(d, /"\\t"/, `${name}: the tab escape is not named: ${d}`);
    assert.match(d, /"\\\\"/, `${name}: the backslash escape is not named: ${d}`);
    assert.match(d, /left to right/i, `${name}: the decoding order is not stated: ${d}`);
    // The trailer rule (#37's second half): a "(showing X of Y)" note breaks
    // "one line per result" for a caller splitting on "\n" unless it is told
    // where the results stop.
    assert.match(d, /blank line/i, `${name}: the trailer's blank-line rule is not stated: ${d}`);
  }

  // fs_grep alone has to say two more things, because it is the only one
  // whose line carries a field that is NOT fsmcp's to rewrite.
  const grep = byName.get('fs_grep').description;
  assert.match(grep, /":" as "\\:"/, `fs_grep does not name its colon escape: ${grep}`);
  assert.match(grep, /NEVER escaped/, `fs_grep does not say content is verbatim: ${grep}`);
});

test('the "(showing X of Y)" trailer is separated from the results by a blank line', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-trailer-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // fs_find's cap is the tightest of the four (200), so this is the cheapest
  // way to observe a real capped result rather than a simulated one.
  for (let i = 0; i < 250; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x');

  const server = spawnServer([]);
  t.after(() => server.close());

  const result = await server.callTool('fs_find', { pattern: 'txt' }, { allowed_dirs: [root] });
  assert.equal(result.isError, undefined, allText(result));
  assert.equal(result._meta && result._meta.truncated, true, 'a capped result must say so structurally');

  const lines = allText(result).split('\n');
  const firstBlank = lines.indexOf('');
  assert.ok(firstBlank > 0, `no blank line before the trailer:\n${allText(result)}`);
  // Everything before the blank line is a result; everything after it is
  // fsmcp's own commentary. That is the promise the descriptions now make,
  // and it is what lets a caller split on "\n" without counting the trailer
  // as two more filenames.
  for (const line of lines.slice(0, firstBlank)) {
    assert.ok(line.startsWith('/d0/'), `not a result line: ${JSON.stringify(line)}`);
  }
  assert.match(lines[firstBlank + 1], /^\(showing \d+ of \d+ matches/);
});
