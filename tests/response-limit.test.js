'use strict';

/**
 * Issue #19: fsMCP bounded the FILE ON DISK while the thing that actually
 * breaks is the MESSAGE ON THE WIRE.
 *
 * `fs_read` checked `stat.size > MAX_READ_BYTES` (10 MiB) and then wrote a
 * base64 payload up to 4/3 that size -- or, in text mode, a payload with line
 * numbers, tab separators, truncation markers and JSON escaping added on top
 * of the file's own bytes -- as ONE line on stdout. Relay reads a stdio MCP's
 * stdout with a `bufio.Scanner` capped at `bridge.MaxMessageSize` = 10 MiB
 * (relay/bridge/types.go:13) and treats an over-long token as fatal: the
 * scanner returns `bufio.ErrTooLong`, `readLoop` exits, `readerErr` is
 * latched, and nothing respawns the child. One 8 MB read on one grant took
 * down four unrelated enrolments on four unrelated access profiles at once,
 * and the only recovery was an operator relaunching Relay.app. fsMCP's own
 * 10 MiB refusal could never fire in that deployment, because the transport
 * died first.
 *
 * So the assertions here are deliberately made on BYTES OF STDOUT, not on
 * whether a refusal message reads nicely. A test that only checked for an
 * error string would pass against a build that still emitted a fatal frame
 * somewhere else; the invariant is "no line fsMCP writes is ever big enough
 * to kill the transport", and the only honest way to check that is to measure
 * the lines.
 *
 * The second half of the issue is that a bound is only honest if there is a
 * way to work within it. `encoding: "base64"` REFUSED `offset`/`limit`, so a
 * file over the ceiling was not readable in one call or in any number of
 * them. `byte_offset`/`byte_length` are the answer -- byte-based and
 * separately named, so a caller that switched encodings and left its
 * arguments alone cannot silently get a byte range where it meant a line
 * range -- and the reassembly test below is what makes them more than a
 * gesture.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { spawnServer, toVirtual } = require('./helpers');

const MAIN_JS = path.join(__dirname, '..', 'dist', 'main.js');

// The three numbers this issue is about, pinned as literals rather than
// imported from `dist/limits`: they are the CONTRACT, and a test that reads
// them out of the code under test would agree with that code no matter what
// it said. RELAY_MAX_MESSAGE_SIZE is not fsMCP's to choose -- it is
// `bridge.MaxMessageSize` in relay, reproduced here because it is the actual
// thing that breaks.
const RELAY_MAX_MESSAGE_SIZE = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
const MAX_BASE64_FILE_BYTES = 256 * 1024;

function mkTmpDir(prefix) {
  // realpath'd for the same reason helpers.js does it: on macOS os.tmpdir()
  // is reached through the /var -> /private/var symlink, so an unresolved
  // path would make every toVirtual() prefix check fail for a reason that has
  // nothing to do with what is being tested.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function allText(result) {
  return (result.content || []).map((c) => c.text).join('');
}

/**
 * Drive a real fsmcp over stdio and hand back the RAW stdout lines, measured
 * in bytes, alongside the parsed responses.
 *
 * `helpers.spawnServer` parses each line and throws the original away, which
 * is exactly the information this issue is about: the bug was never visible
 * in the parsed result (a 12 MB base64 payload parses perfectly), only in the
 * length of the line carrying it. Buffers are concatenated as a Buffer, not a
 * string, so `line.length` is the byte count relay's scanner would see rather
 * than a JS code-unit count.
 */
function driveRaw(args, requests, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN_JS, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : { ...process.env },
    });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', () => {
      const out = Buffer.concat(chunks);
      const lines = [];
      let start = 0;
      for (let i = 0; i < out.length; i++) {
        if (out[i] === 0x0a) {
          lines.push(out.subarray(start, i));
          start = i + 1;
        }
      }
      if (start < out.length) lines.push(out.subarray(start));
      resolve({
        lines,
        stderr,
        parsed: lines.map((l) => {
          try {
            return JSON.parse(l.toString('utf-8'));
          } catch {
            return null;
          }
        }),
      });
    });
    for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n');
    child.stdin.end();
  });
}

function callRequest(id, name, toolArgs) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: toolArgs } };
}

// ---------------------------------------------------------------------------
// 1. The repro from the issue, measured where it actually breaks.
// ---------------------------------------------------------------------------

test('issue #19: no fs_read response line is ever large enough to kill relay\'s scanner', async (t) => {
  const root = mkTmpDir('fsmcp-wire-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // The issue's own table: 1 MB survived, 8 MB did not. Both are ordinary
  // files -- "read this PDF", "read this log" -- and neither is anywhere near
  // fsMCP's old 10 MiB file limit, which is the whole point.
  // Written as ordinary 100-byte lines rather than one enormous line, so
  // text mode's answer is the interesting one (a bounded PAGE with a
  // continuation offset) rather than the pre-existing per-line truncation.
  const sizes = [1000000, 8000000];
  const files = sizes.map((n) => {
    const p = path.join(root, `blob-${n}.log`);
    const line = 'A'.repeat(99) + '\n';
    fs.writeFileSync(p, Buffer.from(line.repeat(n / 100), 'utf-8'));
    return { n, p };
  });

  const requests = [{ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }];
  let id = 1;
  const idFor = new Map();
  for (const f of files) {
    for (const encoding of ['base64', 'text']) {
      idFor.set(`${f.n}:${encoding}`, id);
      requests.push(
        callRequest(id++, 'fs_read', { file_path: toVirtual(f.p, root), encoding })
      );
    }
  }

  const { lines, parsed, stderr } = await driveRaw(['--allowed-dir', root], requests);
  assert.ok(parsed.length >= requests.length, `server did not answer every request (stderr: ${stderr})`);

  for (const line of lines) {
    assert.ok(
      line.length < RELAY_MAX_MESSAGE_SIZE,
      `fsmcp wrote a ${line.length}-byte line; relay's bufio.Scanner caps a token at ` +
        `${RELAY_MAX_MESSAGE_SIZE} bytes and treats an over-long one as fatal for the whole ` +
        `external MCP, for every client on every profile`
    );
    // The real bound, well under relay's, so this test fails on the fsMCP
    // defect rather than only on relay's exact number.
    assert.ok(
      line.length < MAX_RESPONSE_BYTES + 64 * 1024,
      `fsmcp wrote a ${line.length}-byte line, over its own ${MAX_RESPONSE_BYTES}-byte response ` +
        `budget plus envelope headroom`
    );
  }

  const byId = new Map(parsed.filter(Boolean).map((m) => [m.id, m]));

  // 8 MB in base64 is refused outright, and the refusal is actionable: it
  // names the ceiling and the mechanism for reading a bigger file.
  const bigB64 = byId.get(idFor.get('8000000:base64')).result;
  assert.equal(bigB64.isError, true, 'an over-ceiling base64 read must be refused, not emitted');
  assert.match(allText(bigB64), new RegExp(String(MAX_BASE64_FILE_BYTES)));
  assert.match(allText(bigB64), /byte_offset/);

  // 1 MB in base64 is over the 256 KiB context ceiling too -- refused for the
  // same reason and pointed at the same escape hatch.
  const midB64 = byId.get(idFor.get('1000000:base64')).result;
  assert.equal(midB64.isError, true, '1 MB is over the base64 per-call ceiling and must be refused');

  // Text mode is not refused -- it PAGES. Both files come back as a bounded
  // page that says so.
  for (const n of sizes) {
    const r = byId.get(idFor.get(`${n}:text`)).result;
    assert.equal(r.isError, undefined, `text mode must page a ${n}-byte file, not refuse it: ${allText(r)}`);
    assert.equal(r._meta && r._meta.truncated, true, 'a bounded page must flag itself');
    assert.match(allText(r), /pass offset: \d+ to continue reading/);
  }
});

test('issue #19: a text page stays inside the response budget even when every byte escapes to six', async (t) => {
  const root = mkTmpDir('fsmcp-wire-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // 2000 lines of 2000 C0 control bytes: inside MAX_LINE_LENGTH, inside the
  // 2000-line default limit, inside MAX_READ_BYTES -- and every one of those
  // bytes is valid UTF-8 that JSON.stringify escapes to six bytes (``),
  // so the old code's page was ~24 MB on the wire while every limit it
  // actually checked reported the read as small. This is the case that makes
  // "count the characters and multiply by something" wrong as a strategy.
  const file = path.join(root, 'control-bytes.txt');
  const line = '\x01'.repeat(2000);
  fs.writeFileSync(file, Buffer.from(new Array(2000).fill(line).join('\n'), 'utf-8'));

  const { lines, parsed } = await driveRaw(
    ['--allowed-dir', root],
    [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} },
      callRequest(1, 'fs_read', { file_path: toVirtual(file, root) }),
    ]
  );

  for (const l of lines) {
    assert.ok(
      l.length < MAX_RESPONSE_BYTES + 64 * 1024,
      `a page of escape-heavy content came back as a ${l.length}-byte line`
    );
  }

  const r = parsed.find((m) => m && m.id === 1).result;
  assert.equal(r.isError, undefined, `this file is readable, just not all at once: ${allText(r)}`);
  assert.equal(r._meta && r._meta.truncated, true);
  assert.match(
    allText(r),
    /the page ended at fs_read's \d+-byte response limit/,
    'a page cut short by BYTES rather than by the line limit must say which limit it hit, or a ' +
      'caller that asked for 2000 lines and got 80 has no way to tell this from end-of-file'
  );
});

// ---------------------------------------------------------------------------
// 2. Bounded, but not lossy: paging must reassemble exactly.
// ---------------------------------------------------------------------------

test('issue #19: byte-bounded text paging loses nothing -- successive pages reassemble the file exactly', async (t) => {
  const root = mkTmpDir('fsmcp-wire-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // 2000 lines x 1500 chars = ~3 MB. Every line is well inside
  // MAX_LINE_LENGTH so nothing is truncated INSIDE a line; the only thing
  // ending a page here is the byte budget, which is the case under test.
  const file = path.join(root, 'wide.txt');
  const contentLines = [];
  for (let i = 1; i <= 2000; i++) contentLines.push(`${i}:`.padEnd(1500, 'abcdefghij'));
  const original = contentLines.join('\n');
  fs.writeFileSync(file, original, 'utf-8');

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());
  const v = toVirtual(file, root);

  const gathered = [];
  let offset = 1;
  let pages = 0;
  for (;;) {
    const r = await server.callTool('fs_read', { file_path: v, offset });
    assert.equal(r.isError, undefined, `page at offset ${offset} failed: ${allText(r)}`);
    pages++;
    assert.ok(pages < 20, 'runaway paging loop -- the continuation offset is not advancing');

    const text = allText(r);
    const noteMatch = text.match(/\n\[fsmcp: showing lines (\d+)-(\d+) of (\d+)[^\]]*\]$/);
    const body = noteMatch ? text.slice(0, text.length - noteMatch[0].length) : text;
    const bodyLines = body.split('\n').map((l) => l.replace(/^\s*\d+\t/, ''));
    gathered.push(...bodyLines);

    if (!noteMatch) {
      assert.equal(r._meta, undefined, 'the final page of a file must not claim to be truncated');
      break;
    }
    assert.equal(r._meta && r._meta.truncated, true, 'a page with more to come must flag itself');
    assert.equal(Number(noteMatch[1]), offset, 'the note must name the offset it actually started at');
    assert.equal(
      Number(noteMatch[2]),
      offset + bodyLines.length - 1,
      'the note must name the last line it actually returned'
    );
    assert.equal(Number(noteMatch[3]), 2000, 'the note must name the true total line count');
    offset = Number(noteMatch[2]) + 1;
  }

  assert.ok(pages > 1, 'sanity: this fixture only means something if the byte budget split it');
  assert.equal(
    gathered.join('\n'),
    original,
    'paging must be lossless: the concatenation of every page is the file, with no line dropped ' +
      'at a page boundary and none repeated'
  );
});

// ---------------------------------------------------------------------------
// 3. base64 byte windowing: the escape hatch that makes the ceiling honest.
// ---------------------------------------------------------------------------

test('issue #19: a file over the base64 ceiling is refused whole and readable in byte windows', async (t) => {
  const root = mkTmpDir('fsmcp-wire-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Deliberately non-UTF-8 so text mode is not an alternative: this is the
  // "read this PDF / this image / this zip" case, where base64 is the ONLY
  // path and a ceiling with no windowing would mean the file is unreadable
  // rather than merely awkward.
  const size = 700 * 1024;
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 37 + (i >> 8) * 11) & 0xff;
  const file = path.join(root, 'big.bin');
  fs.writeFileSync(file, bytes);

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());
  const v = toVirtual(file, root);

  // Whole-file: REFUSED, never served as a silent prefix. A base64 payload
  // has no room for an inline "there is more" marker without breaking the
  // fs_read -> fs_write identity PR #13 established, so a prefix here would
  // be undetectable from the content itself.
  const whole = await server.callTool('fs_read', { file_path: v, encoding: 'base64' });
  assert.equal(whole.isError, true, 'an over-ceiling whole-file base64 read must be refused');
  assert.match(allText(whole), /byte_offset/, 'the refusal must name the way to read it anyway');

  // Windowed: exact bytes, reassembled byte-for-byte from _meta alone.
  const pieces = [];
  let byteOffset = 0;
  let total = null;
  for (;;) {
    const r = await server.callTool('fs_read', {
      file_path: v,
      encoding: 'base64',
      byte_offset: byteOffset,
      byte_length: MAX_BASE64_FILE_BYTES,
    });
    assert.equal(r.isError, undefined, `window at ${byteOffset} failed: ${allText(r)}`);
    assert.match(
      allText(r),
      /^[A-Za-z0-9+/]*={0,2}$/,
      'a windowed payload must still be BARE base64 -- no header, no marker, nothing to strip'
    );
    assert.equal(r._meta.byte_offset, byteOffset, '_meta must say where this window starts');
    assert.equal(r._meta.total_bytes, size, '_meta must say how big the whole file is');
    total = r._meta.total_bytes;

    const buf = Buffer.from(allText(r), 'base64');
    assert.equal(buf.length, r._meta.bytes, '_meta.bytes must match the payload it describes');
    pieces.push(buf);
    byteOffset += buf.length;
    if (byteOffset >= total) break;
    assert.ok(pieces.length < 10, 'runaway windowing loop');
  }

  assert.ok(pieces.length > 1, 'sanity: this fixture only means something if it took several windows');
  assert.deepEqual(
    Buffer.concat(pieces),
    bytes,
    'the windows must reassemble to the file byte-for-byte -- a windowing scheme that loses or ' +
      'duplicates a byte at a boundary is worse than no windowing at all'
  );

  // A window over the ceiling is refused rather than quietly shortened: the
  // caller asked for a specific range and must not be handed a different one.
  const tooWide = await server.callTool('fs_read', {
    file_path: v,
    encoding: 'base64',
    byte_offset: 0,
    byte_length: MAX_BASE64_FILE_BYTES + 1,
  });
  assert.equal(tooWide.isError, true, 'an over-ceiling byte_length must be refused, not clamped');

  // The tail short-reads to EOF, which is read(2) behaviour and is fully
  // described by _meta, not hidden.
  const tail = await server.callTool('fs_read', {
    file_path: v,
    encoding: 'base64',
    byte_offset: size - 10,
    byte_length: MAX_BASE64_FILE_BYTES,
  });
  assert.equal(tail.isError, undefined, allText(tail));
  assert.equal(tail._meta.bytes, 10);
  assert.deepEqual(Buffer.from(allText(tail), 'base64'), bytes.subarray(size - 10));
});

test('issue #19: base64 byte windowing reaches into a file larger than fs_read\'s allocation limit', async (t) => {
  const root = mkTmpDir('fsmcp-wire-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Over MAX_READ_BYTES (10 MiB), which text mode still refuses outright.
  // base64 mode no longer needs that bound, because a positional read
  // allocates the window and not the file -- if it ever goes back to
  // readFileSync, this test is the thing that notices.
  const size = 11 * 1024 * 1024;
  const file = path.join(root, 'huge.bin');
  const fd = fs.openSync(file, 'w');
  const chunk = Buffer.alloc(1024 * 1024, 0x5a);
  for (let i = 0; i < 11; i++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  // A recognisable needle deep inside, past every old limit.
  const needle = Buffer.from('NEEDLE-19-a41f', 'utf-8');
  const needleAt = 10 * 1024 * 1024 + 4242;
  const wfd = fs.openSync(file, 'r+');
  fs.writeSync(wfd, needle, 0, needle.length, needleAt);
  fs.closeSync(wfd);

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());
  const v = toVirtual(file, root);

  const textRead = await server.callTool('fs_read', { file_path: v });
  assert.equal(textRead.isError, true, 'text mode still refuses a file over its allocation limit');

  const r = await server.callTool('fs_read', {
    file_path: v,
    encoding: 'base64',
    byte_offset: needleAt,
    byte_length: needle.length,
  });
  assert.equal(r.isError, undefined, allText(r));
  assert.equal(r._meta.total_bytes, size);
  assert.deepEqual(Buffer.from(allText(r), 'base64'), needle);
});

test('issue #19: a whole-file base64 read inside the ceiling still round-trips through fs_write verbatim', async (t) => {
  const root = mkTmpDir('fsmcp-wire-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // PR #13's rule ("a mode that exists for fidelity must round-trip through
  // itself") is scoped to a WHOLE-FILE base64 read, and the ceiling above
  // must not have quietly narrowed it to nothing. A file just inside the
  // ceiling still pipes straight into fs_write with no transformation.
  const size = MAX_BASE64_FILE_BYTES - 3;
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 251) & 0xff;
  const file = path.join(root, 'at-ceiling.bin');
  fs.writeFileSync(file, bytes);

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const r = await server.callTool('fs_read', { file_path: toVirtual(file, root), encoding: 'base64' });
  assert.equal(r.isError, undefined, allText(r));
  assert.equal(r._meta.bytes, size);
  assert.equal(r._meta.byte_offset, 0);
  assert.equal(r._meta.total_bytes, size);

  const out = path.join(root, 'copy.bin');
  const w = await server.callTool('fs_write', {
    file_path: toVirtual(out, root),
    content: allText(r),
    encoding: 'base64',
  });
  assert.equal(w.isError, undefined, allText(w));
  assert.deepEqual(fs.readFileSync(out), bytes, 'the identity must survive the new ceiling');
});

// ---------------------------------------------------------------------------
// 4. The two windowing vocabularies must never be confused for each other.
// ---------------------------------------------------------------------------

test('issue #19: line windowing and byte windowing are refused in each other\'s mode, never ignored', async (t) => {
  const root = mkTmpDir('fsmcp-wire-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'small.txt');
  fs.writeFileSync(file, 'alpha\nbravo\ncharlie\ndelta\n');

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());
  const v = toVirtual(file, root);

  // A caller that switched to base64 and left offset/limit behind must be
  // told, not quietly handed the whole file (the pre-existing rule, kept).
  const lineInB64 = await server.callTool('fs_read', { file_path: v, encoding: 'base64', offset: 2 });
  assert.equal(lineInB64.isError, true);
  assert.match(allText(lineInB64), /byte_offset\/byte_length/, 'point the caller at the right pair');

  // And the new direction: a byte window against a line-based view would
  // return a page that silently is not the range asked for.
  for (const argName of ['byte_offset', 'byte_length']) {
    const r = await server.callTool('fs_read', { file_path: v, [argName]: 2 });
    assert.equal(r.isError, true, `${argName} in text mode must be refused, not ignored`);
    assert.match(allText(r), /only apply to encoding: "base64"/);
  }

  // A byte window that is not a byte count at all is refused before it can
  // reach a positional read syscall.
  for (const bad of [-1, 1.5, '10']) {
    const r = await server.callTool('fs_read', { file_path: v, encoding: 'base64', byte_offset: bad });
    assert.equal(r.isError, true, `byte_offset: ${JSON.stringify(bad)} must be refused`);
    assert.match(allText(r), /non-negative integer/);
  }

  // Past EOF is an error, not an empty success that a loop would read as
  // "done" for the wrong reason.
  const past = await server.callTool('fs_read', { file_path: v, encoding: 'base64', byte_offset: 9999 });
  assert.equal(past.isError, true);
  assert.match(allText(past), /past the end/);
});

// ---------------------------------------------------------------------------
// 5. The inbound half: fs_write had the identical defect pointing the other way.
// ---------------------------------------------------------------------------

test('issue #19: fs_write bounds the request it accepts, not just the bytes that land on disk', async (t) => {
  const root = mkTmpDir('fsmcp-wire-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  // Text: 1.5 MB of `content` is a >1.5 MB request line. Under the old 10 MiB
  // rule this was accepted, and a caller composing it against a relay-hosted
  // fsmcp would have had the request dropped by the transport instead.
  const textTarget = path.join(root, 'text-too-big.txt');
  const rText = await server.callTool('fs_write', {
    file_path: toVirtual(textTarget, root),
    content: 'x'.repeat(1500000),
  });
  assert.equal(rText.isError, true, 'an over-limit text content must be refused');
  assert.match(allText(rText), /message byte limit/i);
  assert.equal(fs.existsSync(textTarget), false, 'a refusal must create nothing, not even a partial file');

  // base64: the ceiling that matters is on the REQUEST, so it is 4/3 tighter
  // in file terms. 900 KiB of file is a 1.2 MB request line.
  const binTarget = path.join(root, 'bin-too-big.bin');
  const rB64 = await server.callTool('fs_write', {
    file_path: toVirtual(binTarget, root),
    content: Buffer.alloc(900 * 1024, 0x33).toString('base64'),
    encoding: 'base64',
  });
  assert.equal(rB64.isError, true, 'an over-limit base64 content must be refused');
  assert.match(allText(rB64), new RegExp(String(Math.floor((MAX_RESPONSE_BYTES * 3) / 4))));
  assert.equal(fs.existsSync(binTarget), false);

  // And the refusal is honest about there being no piecewise base64 write:
  // fs_write has no offset or append mode, so a bigger binary genuinely
  // cannot be assembled through fsMCP, and saying "write it in pieces" would
  // be advice that does not work.
  assert.match(allText(rB64), /no offset or append mode/);

  // Just inside the limit still writes, so the bound is a bound and not a ban.
  const okTarget = path.join(root, 'fits.txt');
  const ok = await server.callTool('fs_write', {
    file_path: toVirtual(okTarget, root),
    content: 'y'.repeat(1000000),
  });
  assert.equal(ok.isError, undefined, allText(ok));
  assert.equal(fs.statSync(okTarget).size, 1000000);
});

test('issue #19: fs_write measures the wire form of content, not its character count', async (t) => {
  const root = mkTmpDir('fsmcp-wire-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  // 300,000 C0 control characters: 300 KB of UTF-8, 300 KB of JS string
  // length -- and 1.8 MB inside the JSON request line, because each one
  // escapes to ``. A check against `content.length`, or against the
  // decoded byte count, passes this happily and puts a 1.8 MB line on the
  // wire. This is the write-side twin of the control-byte read test above.
  const target = path.join(root, 'escapes.txt');
  const r = await server.callTool('fs_write', {
    file_path: toVirtual(target, root),
    content: '\x01'.repeat(300000),
  });
  assert.equal(
    r.isError,
    true,
    'content whose JSON escaping is 6x its byte count must be measured as it appears on the wire'
  );
  assert.match(allText(r), /1800\d{3} bytes on the wire/);
  assert.equal(fs.existsSync(target), false);
});

// ---------------------------------------------------------------------------
// 6. The second repro on the issue: fs_grep content mode bounded nothing.
// ---------------------------------------------------------------------------

/**
 * A grant with a lot of matching text in it. Nothing exotic -- this is what a
 * granted source repository looks like to a grep for a common word.
 */
function buildGrepFixture(root, { files, linesPerFile, lineLength }) {
  const line = `NEEDLEX ${'z'.repeat(lineLength)}`;
  const body = new Array(linesPerFile).fill(line).join('\n');
  for (let i = 0; i < files; i++) {
    fs.writeFileSync(path.join(root, `src-${i}.txt`), body, 'utf-8');
  }
  return files * linesPerFile;
}

for (const backend of ['ripgrep', 'node-fallback']) {
  test(`issue #19: fs_grep content mode is bounded and says so (${backend})`, async (t) => {
    const root = mkTmpDir('fsmcp-grep-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    // 20 files x 1500 lines x ~520 bytes ~= 15 MB of matching lines. Before
    // this change fs_grep in content mode capped NOTHING -- not lines, not
    // bytes -- so all of it went out as a single stdout line and relay's
    // scanner returned bufio.ErrTooLong, killing the MCP for every grant on
    // the host. fsmcp itself stayed alive, which is what made this a second,
    // independent path to the same permanent outage.
    const totalLines = buildGrepFixture(root, { files: 20, linesPerFile: 1500, lineLength: 500 });
    assert.ok(totalLines * 520 > 10 * 1024 * 1024, 'sanity: the fixture must exceed relay\'s frame cap');

    // makeFakeRg with a failing --version probe forces the pure-Node
    // fallback, which is the path every host without ripgrep takes; the
    // ripgrep path is exercised by the same test with the real binary. Both
    // build their own result strings, so a cap on one is not a cap on the
    // other.
    let env;
    if (backend === 'node-fallback') {
      const { makeFakeRg } = require('./helpers');
      const { bin, log } = makeFakeRg(root, { versionExitCode: 1 });
      env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_RG_LOG: log };
    }

    const { lines, parsed, stderr } = await driveRaw(
      ['--allowed-dir', root],
      [
        { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} },
        callRequest(1, 'fs_grep', { pattern: 'NEEDLEX', output_mode: 'content' }),
        // An ordinary call after the big one: under the old behaviour the
        // transport was already dead by this point for every client, so this
        // is the "survives?" column from the issue's own repro table.
        callRequest(2, 'fs_list', {}),
      ],
      env
    );

    for (const l of lines) {
      assert.ok(
        l.length < RELAY_MAX_MESSAGE_SIZE,
        `fs_grep wrote a ${l.length}-byte line; relay's scanner treats anything over ` +
          `${RELAY_MAX_MESSAGE_SIZE} as fatal for the whole external MCP`
      );
      assert.ok(
        l.length < MAX_RESPONSE_BYTES + 128 * 1024,
        `fs_grep wrote a ${l.length}-byte line, over its own response budget`
      );
    }

    const r = (parsed.find((m) => m && m.id === 1) || {}).result;
    assert.ok(r, `fs_grep did not answer (stderr: ${stderr})`);
    assert.equal(r.isError, undefined, `a search that found too much has still done useful work: ${allText(r)}`);

    // Refusing is the WRONG answer for a search, and truncating silently is
    // the wrong answer for anything. The right one is the vocabulary this
    // codebase already had: bounded, and saying so both ways.
    assert.match(
      allText(r),
      /\(showing \d+ of \d+ result lines/,
      'a bounded search result must say so inline, the way fs_glob already does'
    );
    assert.equal(
      r._meta && r._meta.truncated,
      true,
      'a caller must be able to tell a complete result from a bounded one programmatically, ' +
        'not by pattern-matching English out of the payload'
    );

    const shown = Number(allText(r).match(/\(showing (\d+) of (\d+) result lines/)[1]);
    const claimedTotal = Number(allText(r).match(/\(showing (\d+) of (\d+) result lines/)[2]);
    assert.ok(shown <= 1000, `the line cap must hold: ${shown} lines came back`);
    // At least every matching line, and no more than that plus ripgrep's own
    // "--" group breaks (one per file boundary in content mode; the Node
    // fallback does not emit them, which is a pre-existing divergence between
    // the two backends and not this issue's). The point of the assertion is
    // that the "of N" is the REAL total, not the size of the array that
    // survived the cap -- 1000 would mean the tool was reporting its own cap
    // back to the caller as if it were the answer.
    assert.ok(
      claimedTotal >= totalLines && claimedTotal <= totalLines + 100,
      `the "of N" must be the real result-line count (expected ~${totalLines}), got ${claimedTotal}`
    );

    // Real matched content, not just a note.
    assert.match(allText(r), /NEEDLEX/);

    // And the connection is still usable, which is the whole point.
    const after = (parsed.find((m) => m && m.id === 2) || {}).result;
    assert.ok(after, 'the call after the big grep must still be answered');
    assert.equal(after.isError, undefined, allText(after));
  });
}

test('issue #19: a complete fs_grep result is still reported as complete', async (t) => {
  const root = mkTmpDir('fsmcp-grep-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'a.txt'), 'one NEEDLEX\ntwo\nthree NEEDLEX\n');

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const r = await server.callTool('fs_grep', { pattern: 'NEEDLEX', output_mode: 'content' });
  assert.equal(r.isError, undefined, allText(r));
  assert.doesNotMatch(allText(r), /showing \d+ of/, 'a complete result must not claim to be bounded');
  assert.equal(r._meta, undefined, 'a complete result must not set _meta.truncated');
  assert.match(allText(r), /one NEEDLEX/);
});

// ---------------------------------------------------------------------------
// 7. The bound is a property of every result, not a check inside one tool.
// ---------------------------------------------------------------------------

test('issue #19: the response bound is enforced for every tool at the point a result is serialised', async (t) => {
  // Required lazily so the rest of this file still runs (and still fails on
  // its own assertions) against a build that has no limits module at all.
  const { boundResultBytes, capLines, MAX_RESULT_BYTES, MAX_FRAME_BYTES } = require('../dist/limits');

  // The backstop is an alarm, not the mechanism: it replaces an oversized
  // result outright rather than shortening it, because at that layer there is
  // no structure left to shorten honestly.
  const oversized = { content: [{ type: 'text', text: 'x'.repeat(MAX_RESULT_BYTES + 1) }] };
  const bounded = boundResultBytes(oversized, 'fs_hypothetical');
  assert.equal(bounded.isError, true);
  assert.match(bounded.content[0].text, /fs_hypothetical/);
  assert.match(bounded.content[0].text, /bug in fsmcp/i);
  assert.ok(
    Buffer.byteLength(JSON.stringify(bounded)) < MAX_RESULT_BYTES,
    'the replacement for an oversized result must not itself be oversized'
  );
  assert.ok(MAX_FRAME_BYTES < 10 * 1024 * 1024, 'every frame must stay under relay\'s cap');

  // A result already inside the bound is returned untouched -- object
  // identity, so nothing is being rebuilt or rewritten on the common path.
  const fine = { content: [{ type: 'text', text: 'ok' }] };
  assert.equal(boundResultBytes(fine, 'fs_hypothetical'), fine);

  // capLines bounds by BOTH count and bytes, and reports which one bit.
  const many = new Array(50).fill('short');
  assert.deepEqual(
    { ...capLines(many, 10), text: undefined },
    { text: undefined, shown: 10, total: 50, capped: true, reason: 'lines' }
  );
  const wide = new Array(50).fill('w'.repeat(1000));
  const byBytes = capLines(wide, 1000, 50, 5000);
  assert.equal(byBytes.reason, 'bytes');
  assert.ok(byBytes.shown < 50 && byBytes.shown > 0);
  assert.equal(capLines(['a', 'b'], 10).capped, false, 'a complete list must not report itself bounded');

  // The byte accounting is on the WIRE form, not the character count: 1000
  // C0 control characters are 1000 chars and 6000 bytes of JSON.
  const escaping = capLines([`\x01`.repeat(1000)], 1000, 1, 3000);
  assert.equal(escaping.shown, 0, 'a line whose JSON escaping is 6x its length must be measured as 6x');
});
