'use strict';

/**
 * fs_list's output record: two things it used to get wrong about a single
 * line.
 *
 * Issue #31 -- the format. fs_list documents "one line per entry,
 * type\tsize\tmtime\tpath", and the only thing that description invites a
 * caller to do is split on \n and then on \t. A filename containing a
 * newline (legal on every POSIX filesystem including APFS, and creatable
 * through fsMCP's own fs_write and fs_move) was emitted raw, so one entry
 * became two lines: a phantom record with no type and no size, and a real
 * record truncated at the newline. Nothing errored. The failure landed in
 * the caller's parser. A path is now backslash-escaped, and the tool
 * description states the rules -- a caller cannot parse a format whose
 * escaping is unstated.
 *
 * Issue #28 -- the size column. listOneDir uses lstat (correct: it must not
 * follow the link) and printed st.size, and for a symlink st_size IS THE
 * BYTE LENGTH OF THE TARGET PATH STRING. So the column was an exact
 * measurement of a path the client is not allowed to know exists -- while
 * every other surface refuses to say anything at all about that link. It is
 * reported as 0 now.
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
 * Decode fs_list's escaping the way the tool description tells a caller to:
 * left to right, consuming a backslash together with whatever follows it.
 * Written as a scanner rather than four independent String.replace calls
 * precisely because the description warns against the latter -- running
 * them independently turns "\\n" (an escaped backslash then the letter n)
 * into a newline that was never in the name, which is the whole reason the
 * backslash pass has to come first on the way out.
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
    else if (next === '\\') out += '\\';
    else throw new Error(`unknown escape \\${next} in ${JSON.stringify(s)}`);
  }
  return out;
}

const HOSTILE_NAMES = [
  // The issue's own case. Two lines out of one entry.
  'we\nird.txt',
  // \r alone: harmless on its own, but a caller splitting on os.EOL or
  // trimming lines sees a different name than the one on disk.
  'car\rriage.txt',
  // A tab splits the record into five fields instead of four, and lands the
  // tail of the name in a column a caller reads as something else.
  'ta\tbbed.txt',
  // A literal backslash, which is what makes the escaping have to be
  // reversible rather than merely line-safe: without an unconditional
  // backslash pass this name and the "we\nird.txt" one above would emit
  // identical bytes.
  'back\\slash.txt',
  // The adversarial one: the bytes an escaped backslash produces, next to
  // an n. Decoded with four independent replacements this reads as a
  // newline; decoded left to right it reads as what it is.
  'a\\nb.txt',
  // An ordinary name, so the test also proves the escaping does not mangle
  // the 99% case.
  'plain.txt',
];

function mkFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-list-')));
  for (const name of HOSTILE_NAMES) {
    fs.writeFileSync(path.join(root, name), 'x');
  }
  return root;
}

test('fs_list emits exactly one parseable line per entry, whatever the filename contains', async (t) => {
  const root = mkFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = spawnServer([]);
  t.after(() => server.close());

  const result = await server.callTool('fs_list', { path: '/d0' }, { allowed_dirs: [root] });
  assert.equal(result.isError, undefined, allText(result));

  const lines = allText(result).split('\n');
  assert.equal(
    lines.length,
    HOSTILE_NAMES.length,
    `expected one line per entry; got ${lines.length} lines for ${HOSTILE_NAMES.length} entries:\n${allText(result)}`
  );

  const seen = new Set();
  for (const line of lines) {
    const fields = line.split('\t');
    assert.equal(fields.length, 4, `expected 4 tab-separated fields, got ${fields.length}: ${JSON.stringify(line)}`);
    const [type, size, mtime, escapedPath] = fields;
    assert.equal(type, 'file');
    assert.equal(size, '1');
    assert.match(mtime, /^\d{4}-\d\d-\d\dT/);

    // The path field decodes back to the real name, addressed in this
    // call's virtual space (one root, so d0).
    const decoded = unescapePathField(escapedPath);
    assert.ok(decoded.startsWith('/d0/'), `not a virtual address: ${JSON.stringify(decoded)}`);
    seen.add(decoded.slice('/d0/'.length));
  }

  // Round trip: every name on disk is recoverable from the output, and
  // nothing else is. This is what "the format stays true" means -- not just
  // that the line count is right, but that a caller reversing the documented
  // escaping lands back on the exact bytes readdir produced.
  assert.deepEqual([...seen].sort(), [...HOSTILE_NAMES].sort());
});

test("fs_list's description states its escaping rules, so the format is parseable without guessing", async (t) => {
  const server = spawnServer([]);
  t.after(() => server.close());

  const res = await server.request('tools/list', {});
  const list = res.result.tools.find((tool) => tool.name === 'fs_list');
  assert.ok(list, 'fs_list must be published');

  // An escaping scheme nobody is told about replaces one silent parsing
  // failure with a different one, so the description carrying the rules is
  // part of the fix rather than documentation of it. Each escape is named,
  // and so is the left-to-right decoding order that makes them reversible.
  const d = list.description;
  assert.match(d, /escap/i, `fs_list's description does not mention escaping: ${d}`);
  // Each pattern below is written against the LITERAL two-character
  // sequence the description has to contain -- a backslash followed by n,
  // r or t -- which is why each is one escaped backslash in the regex and
  // not two.
  assert.match(d, /"\\n"/, `the newline escape is not named: ${d}`);
  assert.match(d, /"\\r"/, `the carriage-return escape is not named: ${d}`);
  assert.match(d, /"\\t"/, `the tab escape is not named: ${d}`);
  assert.match(d, /"\\\\"/, `the backslash escape is not named: ${d}`);
  assert.match(d, /left to right/i, `the decoding order is not stated: ${d}`);
});

test("fs_list reports a symlink's size as 0, not the byte length of its target path", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-symsize-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Three targets of three distinct, known lengths, all outside the grant
  // and one of them not existing at all. Distinct lengths are the point: a
  // single link could pass by coincidence if the code reported some other
  // constant, and equal lengths could not tell "reports 0" apart from
  // "reports one fixed number".
  const targets = {
    short_link: '/nope',
    medium_link: '/nonexistent/nowhere/at/all',
    long_link: '/Users/someone/a/deliberately/long/target/path/that/reveals/layout',
  };
  for (const [name, target] of Object.entries(targets)) {
    fs.symlinkSync(target, path.join(root, name));
  }

  const server = spawnServer([]);
  t.after(() => server.close());

  const result = await server.callTool('fs_list', { path: '/d0' }, { allowed_dirs: [root] });
  assert.equal(result.isError, undefined, allText(result));

  const lines = allText(result).split('\n');
  assert.equal(lines.length, 3);
  for (const line of lines) {
    const [type, size, , p] = line.split('\t');
    assert.equal(type, 'symlink', line);
    assert.equal(size, '0', `a symlink's size must be 0, not its target's length: ${line}`);
    // Stated the other way round as well, so a future "report some other
    // number" does not pass by accident: whatever the size column says, it
    // must not be this particular link's target length. Checked against the
    // size field alone rather than the whole line -- the mtime is a
    // timestamp and will contain almost any short digit string sooner or
    // later, which would make a whole-line check flaky rather than strict.
    const target = targets[p.slice('/d0/'.length)];
    assert.ok(target, `unexpected entry: ${line}`);
    assert.notEqual(
      size,
      String(target.length),
      `the size column is still the target path's length: ${line}`
    );
  }

  // Nothing about the target itself, either -- the property the doc comment
  // above listOneDir now actually describes.
  assert.ok(!allText(result).includes('nonexistent'), allText(result));
  assert.ok(!allText(result).includes('deliberately'), allText(result));
});
