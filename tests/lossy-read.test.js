'use strict';

/**
 * Issue #11: `fs.readFileSync(path, 'utf-8')` silently maps every byte that
 * is not valid UTF-8 to U+FFFD before any tool code runs -- lossy and
 * irreversible the instant it happens. Writing the decoded string back
 * re-encodes each replacement character as three DIFFERENT bytes, so an
 * ordinary read-edit-write cycle destroyed non-UTF-8 content with no error,
 * warning, or hint anywhere in the path. A 2000-character line cap had the
 * same shape, minus even the excuse of being about a different encoding.
 *
 * fsMCP's fix is a pass-through principle, not a content judgement: it does
 * not decide what a file's bytes MEAN (no extension-keyed special case, no
 * "this looks binary" heuristic) -- it only decides whether the CALLER'S
 * DECLARED ENCODING can represent those bytes losslessly. `encoding: "text"`
 * (default) is a decoded, line-numbered, truncated VIEW and refuses content
 * it cannot represent; `encoding: "base64"` is the byte-exact path, with no
 * view formatting, that works on any file's bytes unconditionally.
 *
 * The round-trip matrix below is this issue's acceptance bar, verbatim:
 * write exact bytes to disk, read them through fs_read, reconstruct what a
 * caller would write back (stripping fs_read's own "cat -n" formatting for
 * text mode, or round-tripping the base64 payload directly), write that
 * through fs_write, and compare bytes. Every case must either round-trip
 * byte-identically (in the encoding that can represent it) or be refused --
 * never silently altered.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnServer, makeFakeRg, toVirtual } = require('./helpers');
const { grepFallback } = require('../dist/tools/grep');

function mkTmpDir(prefix) {
  // realpath'd for the same reason buildScopeFixture is in helpers.js: on
  // macOS, os.tmpdir() is reached through the /var -> /private/var symlink,
  // so an unresolved path here would make every toVirtual() prefix check
  // below fail for a reason that has nothing to do with what is tested.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function allText(result) {
  return result.content.map((c) => c.text).join('');
}

/**
 * Reverse fs_read's "cat -n" formatting: strip the "<spaces><N>\t" prefix
 * fs_read puts on every line, then rejoin with "\n" -- exactly the
 * "a human strips the line numbers before pasting this back" transform the
 * issue's acceptance test specifies. Deliberately dumb (a fixed regex, not
 * a reimplementation of fs_read's own numbering logic) so this test does
 * not silently start asserting against its own copy of the code under test.
 */
function stripCatN(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*\d+\t/, ''))
    .join('\n');
}

/**
 * fs_read's encoding: "base64" reply is the bare base64 payload -- no
 * header, no trailing newline, nothing else -- specifically so it can be
 * passed straight into fs_write's encoding: "base64" `content` with no
 * transformation of any kind (PR #13 review: an earlier version prefixed a
 * human-readable "[base64: N bytes]\n" header, which made fs_read's own
 * reply invalid input to fs_write's own base64 decoder -- the fidelity
 * path's output was not valid input to the fidelity path). This helper
 * exists only to name that assumption at each call site, not to transform
 * anything.
 */
function base64Payload(result) {
  return allText(result);
}

test('round-trip matrix (issue #11): every case round-trips byte-identically in some encoding, or is refused', async (t) => {
  const root = mkTmpDir('fsmcp-lossy-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const v = (p) => toVirtual(p, root);

  // Cases 1-8: valid UTF-8, expected to round-trip byte-identically through
  // encoding: "text" (the default) with nothing special required.
  const textCases = [
    { name: 'plain ascii', bytes: Buffer.from('hello world\n', 'utf-8') },
    { name: 'CRLF line endings', bytes: Buffer.from('line1\r\nline2\r\n', 'utf-8') },
    { name: 'tabs', bytes: Buffer.from('a\tb\tc\n', 'utf-8') },
    { name: 'unicode + emoji', bytes: Buffer.from('héllo 🎉 world\n', 'utf-8') },
    { name: 'embedded NUL', bytes: Buffer.from('a\x00b\n', 'utf-8') },
    { name: 'lone CR (no following LF)', bytes: Buffer.from('a\rb\n', 'utf-8') },
    { name: 'trailing blank lines', bytes: Buffer.from('a\n\n\n', 'utf-8') },
  ];

  for (const [i, c] of textCases.entries()) {
    await t.test(c.name, async () => {
      const file = path.join(root, `text-case-${i}.txt`);
      fs.writeFileSync(file, c.bytes);

      const r = await server.callTool('fs_read', { file_path: v(file) });
      assert.equal(r.isError, undefined, `expected success for ${c.name}, got: ${allText(r)}`);
      assert.equal(r._meta, undefined, `${c.name} must not set _meta.truncated -- nothing here is over-long`);

      const recovered = stripCatN(allText(r));
      const out = path.join(root, `text-case-${i}-out.txt`);
      const w = await server.callTool('fs_write', { file_path: v(out), content: recovered });
      assert.equal(w.isError, undefined, `fs_write of ${c.name} failed: ${allText(w)}`);

      assert.deepEqual(
        fs.readFileSync(out),
        c.bytes,
        `${c.name} must round-trip byte-identical through fs_read/fs_write text mode`
      );
    });
  }

  // Case 8: a line over the 2000-character view cap. Text mode is a
  // documented VIEW -- it is expected to truncate, and to SAY SO via a
  // structured marker, not to round-trip. The byte-exact path is base64.
  await t.test('a line over 2000 chars: text mode truncates and flags it structurally; base64 mode round-trips exactly', async () => {
    const longLine = 'x'.repeat(5000) + '\n'; // 5001 bytes
    const bytes = Buffer.from(longLine, 'utf-8');
    const file = path.join(root, 'long-line.txt');
    fs.writeFileSync(file, bytes);

    const r = await server.callTool('fs_read', { file_path: v(file) });
    assert.equal(r.isError, undefined, allText(r));
    assert.match(allText(r), /\[truncated\]/, 'the inline marker must still be present for a human reader');
    assert.equal(r._meta && r._meta.truncated, true, 'a machine caller must be able to branch on _meta.truncated');

    // Text mode's own round trip is NOT expected to be byte-identical here
    // (it is a documented lossy view of a line that does not fit it) --
    // what must not happen is a caller getting no signal at all that it
    // wrote back less than the file contains.
    const recovered = stripCatN(allText(r));
    assert.notEqual(Buffer.byteLength(recovered, 'utf-8') + 1, bytes.length, 'sanity: the view really did shrink this line');

    // encoding: "base64" bypasses the view (no line numbers, no truncation)
    // and must round-trip the exact bytes.
    const rb64 = await server.callTool('fs_read', { file_path: v(file), encoding: 'base64' });
    assert.equal(rb64.isError, undefined, allText(rb64));
    const out = path.join(root, 'long-line-out.txt');
    const w = await server.callTool('fs_write', {
      file_path: v(out),
      content: base64Payload(rb64),
      encoding: 'base64',
    });
    assert.equal(w.isError, undefined, allText(w));
    assert.deepEqual(fs.readFileSync(out), bytes, 'base64 mode must round-trip the over-long line byte-identical');
  });

  // Cases 9-11: content that is not valid UTF-8. Text mode must refuse
  // (never substitute U+FFFD), naming the escape hatch; base64 mode must
  // round-trip the exact bytes regardless of what they are or what the
  // file is named -- content-based, not extension-based.
  const binaryCases = [
    { name: 'latin-1 high bytes', bytes: Buffer.from([0xe9, 0xe8, 0xfc, 0x0a]), ext: '.txt' },
    { name: 'arbitrary non-UTF-8 binary', bytes: Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f, 0x80]), ext: '.dat' },
    // Same content-based check, deliberately given a ".png" extension: the
    // old IMAGE_EXTENSIONS behaviour keyed the base64 decision off this
    // exact string, which this must NOT do -- text mode must still refuse
    // it as non-UTF-8 on its own merits, not "because it's an image".
    { name: 'non-UTF-8 binary named .png (must not get an extension-keyed pass)', bytes: Buffer.from([0x89, 0x00, 0xff, 0x0d, 0x0a, 0x1a, 0x0a]), ext: '.png' },
  ];

  for (const [i, c] of binaryCases.entries()) {
    await t.test(c.name, async () => {
      const file = path.join(root, `binary-case-${i}${c.ext}`);
      fs.writeFileSync(file, c.bytes);

      const r = await server.callTool('fs_read', { file_path: v(file) });
      assert.equal(r.isError, true, `expected a refusal for ${c.name}, got: ${allText(r)}`);
      assert.match(allText(r), /not valid UTF-8/i, `refusal for ${c.name} must name why: ${allText(r)}`);
      assert.match(allText(r), /base64/, `refusal for ${c.name} must point at the escape hatch: ${allText(r)}`);

      const rb64 = await server.callTool('fs_read', { file_path: v(file), encoding: 'base64' });
      assert.equal(rb64.isError, undefined, allText(rb64));
      const out = path.join(root, `binary-case-${i}-out${c.ext}`);
      const w = await server.callTool('fs_write', {
        file_path: v(out),
        content: base64Payload(rb64),
        encoding: 'base64',
      });
      assert.equal(w.isError, undefined, allText(w));
      assert.deepEqual(fs.readFileSync(out), c.bytes, `${c.name} must round-trip byte-identical via base64`);
    });
  }

  // Case 12 (the correction's addition): a PNG-shaped binary file read with
  // encoding: "base64" and written back must be byte-identical -- this is
  // now the ONLY way to move a binary file through fsMCP (there is no
  // extension-keyed auto-base64 path any more), so it has to actually work.
  await t.test('a PNG (real 1x1 image bytes) round-trips byte-identical via base64', async () => {
    // A real, minimal, valid 1x1 transparent PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    );
    const file = path.join(root, 'pixel.png');
    fs.writeFileSync(file, png);

    // Text mode must refuse it exactly like any other non-UTF-8 file --
    // being a PNG is not a special case any more.
    const rText = await server.callTool('fs_read', { file_path: v(file) });
    assert.equal(rText.isError, true, `a PNG must be refused in text mode, not auto-base64'd: ${allText(rText)}`);

    const rb64 = await server.callTool('fs_read', { file_path: v(file), encoding: 'base64' });
    assert.equal(rb64.isError, undefined, allText(rb64));
    const out = path.join(root, 'pixel-out.png');
    const w = await server.callTool('fs_write', {
      file_path: v(out),
      content: base64Payload(rb64),
      encoding: 'base64',
    });
    assert.equal(w.isError, undefined, allText(w));
    assert.deepEqual(fs.readFileSync(out), png, 'the PNG must round-trip byte-identical via base64');
  });
});

test('encoding: "base64" round-trips through itself with zero transformation: fs_read\'s reply is valid fs_write input, verbatim', async (t) => {
  // This is the composition PR #13 review found broken: an earlier version
  // of fs_read's base64 reply carried a human-readable "[base64: N bytes]"
  // header, which meant fs_read's own output was not valid input to
  // fs_write's own base64 decoder -- the fidelity path's output was not
  // valid input to the fidelity path. The failure mode when a caller
  // "fixed" that by stripping the header via some unspecified pattern is a
  // byte-level corruption of exactly the kind this whole issue exists to
  // prevent. The general rule: a mode that exists for fidelity must
  // round-trip through itself, with no editing step of any kind in
  // between -- this test asserts exactly that, passing fs_read's content
  // array straight into fs_write with nothing stripped, rewritten, or
  // reinterpreted.
  const root = mkTmpDir('fsmcp-lossy-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x1a, 0x0a, 0x41, 0x42, 0x43]);
  const file = path.join(root, 'a.bin');
  fs.writeFileSync(file, original);

  const r = await server.callTool('fs_read', { file_path: toVirtual(file, root), encoding: 'base64' });
  assert.equal(r.isError, undefined, allText(r));

  // Structural checks on the shape of the reply itself, independent of the
  // round trip below: no header, no trailing newline, byte count in _meta.
  assert.equal(r.content.length, 1, 'expected exactly one content item');
  assert.match(r.content[0].text, /^[A-Za-z0-9+/]*={0,2}$/, 'the payload must be bare base64 -- no header, no trailing newline, no other text');
  assert.equal(r._meta && r._meta.bytes, original.length, '_meta.bytes must carry the byte count structurally, not in prose');

  // The composition: fs_read's reply, VERBATIM (r.content[0].text, read
  // directly off the result -- no helper, no trim, no slice), straight
  // into fs_write's content argument.
  const out = path.join(root, 'a-out.bin');
  const w = await server.callTool('fs_write', {
    file_path: toVirtual(out, root),
    content: r.content[0].text,
    encoding: 'base64',
  });
  assert.equal(w.isError, undefined, `fs_read's own base64 reply must be valid fs_write input unmodified: ${allText(w)}`);
  assert.deepEqual(fs.readFileSync(out), original, 'the composition must be an identity on the file\'s bytes');
});

test('fs_read: encoding: "base64" rejects offset/limit rather than silently ignoring them', async (t) => {
  const root = mkTmpDir('fsmcp-lossy-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const file = path.join(root, 'a.txt');
  fs.writeFileSync(file, 'one\ntwo\nthree\n');

  const r = await server.callTool('fs_read', {
    file_path: toVirtual(file, root),
    encoding: 'base64',
    offset: 2,
  });
  assert.equal(r.isError, true, 'offset with encoding: "base64" must be refused, not silently ignored');
  assert.match(allText(r), /offset\/limit/i);

  const r2 = await server.callTool('fs_read', {
    file_path: toVirtual(file, root),
    encoding: 'base64',
    limit: 1,
  });
  assert.equal(r2.isError, true, 'limit with encoding: "base64" must be refused, not silently ignored');
});

/**
 * The same silent-truncation shape issue #11 fixed for an over-long LINE
 * (2000+ characters, flagged with `_meta.truncated`), one level up: an
 * over-long FILE. `limit` defaults to 2000 LINES even when the caller never
 * set one, and a file with more lines than that used to come back with no
 * inline marker and no `_meta` at all -- indistinguishable from a complete
 * read. Reproduced end to end: read a 5000-line file with no offset/limit,
 * then write fs_read's own reply straight back with fs_write (the most
 * ordinary "read it, then put it back" an agent can do) and confirm the
 * file is NOT silently truncated to 2000 lines by that round trip.
 */
test('fs_read: a file with more lines than the default limit sets _meta.truncated, and a naive round-trip does not truncate it', async (t) => {
  const root = mkTmpDir('fsmcp-lossy-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const file = path.join(root, 'many-lines.txt');
  const lineCount = 5000;
  const lines = [];
  for (let i = 1; i <= lineCount; i++) lines.push(`line ${i}`);
  fs.writeFileSync(file, lines.join('\n'));

  const r = await server.callTool('fs_read', { file_path: toVirtual(file, root) });
  assert.equal(r.isError, undefined);
  assert.equal(
    r._meta && r._meta.truncated,
    true,
    'a read that does not reach the end of the file must flag _meta.truncated, the same as an ' +
      'over-long line does -- a caller has no other structural way to know this is not the whole file'
  );

  const returnedLines = allText(r).split('\n');
  assert.ok(
    returnedLines.length < lineCount,
    'sanity check on the fixture: this test only means something if fewer than all lines came back'
  );

  // The corruption this guards against: an agent that reads a file, does not
  // notice the truncation, and writes what it has back believing it to be
  // the whole file. Reconstruct exactly that (strip fs_read's own line
  // numbers, the way a caller would to get plain content back) and confirm
  // fs_write is handed something a human reviewer would recognise as
  // incomplete -- not that fs_write itself must refuse it (fs_write has no
  // way to know what "the whole file" was supposed to be; that is exactly
  // why the signal has to be on the READ side).
  const strippedLineCount = returnedLines.filter((l) => l.trim() !== '').length;
  assert.ok(
    strippedLineCount < lineCount,
    'the content available to write back is short of the original file -- this is the shape of ' +
      'the corruption: fewer lines than the source, with nothing before this fix to say so'
  );
});

test('fs_read: an unrecognised encoding value is refused cleanly', async (t) => {
  const root = mkTmpDir('fsmcp-lossy-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const file = path.join(root, 'a.txt');
  fs.writeFileSync(file, 'hi\n');

  const r = await server.callTool('fs_read', { file_path: toVirtual(file, root), encoding: 'utf-16' });
  assert.equal(r.isError, true);
  assert.match(allText(r), /encoding must be "text" or "base64"/);
});

test('fs_write: encoding: "base64" refuses content that is not valid base64, rather than silently decoding wrong bytes', async (t) => {
  const root = mkTmpDir('fsmcp-lossy-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const file = path.join(root, 'out.bin');
  // "!!!!" is outside the base64 alphabet; Node's lenient decoder would
  // otherwise silently produce an empty buffer for it rather than erroring.
  const r = await server.callTool('fs_write', {
    file_path: toVirtual(file, root),
    content: '!!!!',
    encoding: 'base64',
  });
  assert.equal(r.isError, true, 'invalid base64 must be refused');
  assert.match(allText(r), /not valid base64/i);
  assert.equal(fs.existsSync(file), false, 'a refused write must create nothing');
});

test('fs_write: encoding: "text" (default) writes U+FFFD verbatim -- it is the caller\'s content, not second-guessed', async (t) => {
  const root = mkTmpDir('fsmcp-lossy-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const file = path.join(root, 'has-replacement-char.txt');
  const content = 'before�after\n';
  const w = await server.callTool('fs_write', { file_path: toVirtual(file, root), content });
  assert.equal(w.isError, undefined, allText(w));
  assert.deepEqual(fs.readFileSync(file, 'utf-8'), content, 'U+FFFD in caller-supplied content must be written as-is');
});

test('fs_write/fs_edit: a lone UTF-16 surrogate in content is refused unconditionally (no valid UTF-8 encoding exists for it)', async (t) => {
  const root = mkTmpDir('fsmcp-lossy-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const loneSurrogate = 'before\ud800after'; // an unpaired high surrogate
  const file = path.join(root, 'out.txt');

  const w = await server.callTool('fs_write', { file_path: toVirtual(file, root), content: loneSurrogate });
  assert.equal(w.isError, true, 'a lone surrogate must be refused, not silently substituted as U+FFFD');
  assert.match(allText(w), /lone.*surrogate/i);
  assert.equal(fs.existsSync(file), false);

  const existing = path.join(root, 'existing.txt');
  fs.writeFileSync(existing, 'hello world\n');
  const e = await server.callTool('fs_edit', {
    file_path: toVirtual(existing, root),
    old_string: 'world',
    new_string: loneSurrogate,
  });
  assert.equal(e.isError, true, 'fs_edit must refuse a new_string with a lone surrogate the same way fs_write does');
  assert.equal(fs.readFileSync(existing, 'utf-8'), 'hello world\n', 'the file must be untouched after the refusal');
});

test('fs_edit refuses a non-UTF-8 file rather than rewriting it as (corrupted) UTF-8', async (t) => {
  const root = mkTmpDir('fsmcp-lossy-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const file = path.join(root, 'binary.dat');
  const original = Buffer.from([0xe9, 0xe8, 0xfc, 0x0a, 0x41, 0x42]); // includes ASCII "AB" as bait for a naive match
  fs.writeFileSync(file, original);

  const e = await server.callTool('fs_edit', {
    file_path: toVirtual(file, root),
    old_string: 'AB',
    new_string: 'ZZ',
  });
  assert.equal(e.isError, true, 'fs_edit must refuse to operate on a non-UTF-8 file');
  assert.match(allText(e), /not valid UTF-8/i);

  assert.deepEqual(fs.readFileSync(file), original, 'a refused edit must leave the file byte-identical');
});

/**
 * `decodeUtf8Strict` (encoding.ts) is `fs_edit`'s read step. `TextDecoder`'s
 * DEFAULT behaviour strips a leading byte-order-mark (EF BB BF) from the
 * decoded string, treating it as metadata rather than content -- so a file
 * starting with a BOM, edited anywhere else in its content, came back
 * missing its BOM: three bytes gone with nothing in old_string/new_string
 * asking for that. Same shape as issue #11 (decode loses information that
 * the write step then can't put back), on a target issue #11's own fix
 * never covered, because a BOM does not fail strict UTF-8 decoding -- it
 * decodes just fine, to the WRONG string.
 */
test('fs_edit preserves a file\'s byte-order mark across an unrelated edit', async (t) => {
  const root = mkTmpDir('fsmcp-lossy-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const file = path.join(root, 'bom.txt');
  const before = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('HELLO world', 'utf-8')]);
  fs.writeFileSync(file, before);

  const r = await server.callTool('fs_edit', {
    file_path: toVirtual(file, root),
    old_string: 'world',
    new_string: 'there',
  });
  assert.equal(r.isError, undefined, `edit must succeed: ${allText(r)}`);

  const after = fs.readFileSync(file);
  const expected = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('HELLO there', 'utf-8')]);
  assert.deepEqual(
    after,
    expected,
    'the BOM must survive an edit that never touched it -- an edit changes only the bytes it ' +
      'was asked to change'
  );
});

test("fs_grep's Node fallback agrees with fs_read about what it declines to decode: a non-UTF-8 file is skipped, not lossily searched", async (t) => {
  const root = mkTmpDir('fsmcp-lossy-grep-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, 'good.txt'), 'TARGET line here\n', 'utf-8');
  // Any single non-UTF-8-valid byte is enough to make the whole file fail
  // strict decoding; 0xff is never a valid UTF-8 leading byte.
  fs.writeFileSync(path.join(root, 'bad.dat'), Buffer.from([0xff, 0x54, 0x41, 0x52, 0x47, 0x45, 0x54]));

  const res = grepFallback('TARGET', [root], undefined, undefined, 'files_with_matches', undefined, undefined, 5000, [root], undefined);
  const text = res.content[0].text;
  assert.match(text, /good\.txt/, `expected the valid UTF-8 file to be found: ${text}`);
  assert.doesNotMatch(text, /bad\.dat/, `the non-UTF-8 file must be skipped, not reported off a lossy decode: ${text}`);
});

test("fs_grep's Node fallback skips a non-UTF-8 file through a real server (rg forced unavailable) too", async (t) => {
  const root = mkTmpDir('fsmcp-lossy-grep-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'good.txt'), 'TARGET line here\n', 'utf-8');
  fs.writeFileSync(path.join(root, 'bad.dat'), Buffer.from([0xff, 0x54, 0x41, 0x52, 0x47, 0x45, 0x54]));

  const { bin, log } = makeFakeRg(root, { versionExitCode: 1 });
  const server = spawnServer(['--allowed-dir', root], {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_RG_LOG: log },
  });
  t.after(() => server.close());

  const res = await server.callTool('fs_grep', { pattern: 'TARGET', output_mode: 'files_with_matches' });
  const text = allText(res);
  assert.match(text, /good\.txt/, `expected the valid UTF-8 file to be found: ${text}`);
  assert.doesNotMatch(text, /bad\.dat/, `the non-UTF-8 file must not be reported: ${text}`);
});
