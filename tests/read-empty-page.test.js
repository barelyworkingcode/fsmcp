'use strict';

/**
 * Regression from issue #19's response-byte bound.
 *
 * #19 added a branch for a genuine condition: a single line so wide that it
 * cannot fit the response budget on its own, where pagination has nothing
 * shorter to offer and refusing is the honest answer. The branch was keyed on
 * `formatted.length === 0`, which is also true for two entirely ORDINARY
 * requests that have nothing to do with size:
 *
 *   - `offset` past the last line -- exactly what paging to the end looks
 *     like, and the natural way a caller discovers it has finished;
 *   - `limit: 0`.
 *
 * Both were answered with "line 5 of /d0/short.txt does not fit in fs_read's
 * 1048576-byte response limit on its own", which is false about a three-line
 * file and sends the caller to base64 windowing for a file it had already
 * finished reading. Found by independent verification of the #19 repair, and
 * confirmed new by building the commit before it.
 *
 * An empty page is the honest answer: nothing was too big, there was simply
 * nothing there.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnServer } = require('./helpers');

function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-emptypage-')));
  fs.writeFileSync(path.join(dir, 'short.txt'), 'line one\nline two\nline three\n');
  return dir;
}

const text = (r) => (r.content || []).map((c) => c.text).join('');

test('fs_read: an offset past the last line is an empty page, not a size refusal', async (t) => {
  const dir = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', dir]);
  t.after(() => server.close());

  const r = await server.callTool('fs_read', { file_path: '/d0/short.txt', offset: 5 });

  assert.equal(r.isError, undefined, text(r));
  assert.equal(text(r), '', 'an empty page carries no content');
  assert.doesNotMatch(text(r), /does not fit/, 'nothing here is about size');
});

test('fs_read: limit 0 is an empty page, not a size refusal', async (t) => {
  const dir = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', dir]);
  t.after(() => server.close());

  const r = await server.callTool('fs_read', { file_path: '/d0/short.txt', limit: 0 });

  assert.equal(r.isError, undefined, text(r));
  assert.equal(text(r), '');
  assert.doesNotMatch(text(r), /does not fit/);
});

test('fs_read: an ordinary offset inside the file is unaffected', async (t) => {
  // The control. A fix that answered every request with an empty page would
  // pass both tests above.
  const dir = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', dir]);
  t.after(() => server.close());

  const r = await server.callTool('fs_read', { file_path: '/d0/short.txt', offset: 2 });

  assert.equal(r.isError, undefined, text(r));
  assert.match(text(r), /line two/);
  assert.match(text(r), /line three/);
  assert.doesNotMatch(text(r), /line one/);
});

test('fs_read: a very wide line is truncated and flagged, not refused', async (t) => {
  // The control on the OTHER side. #19's "does not fit in the response limit"
  // branch is unreachable at the shipped defaults, and this test says so
  // rather than pretending otherwise: MAX_LINE_LENGTH (2000 chars) truncates
  // a wide line long before MAX_RESPONSE_BYTES (1 MiB) could reject it, so a
  // single line cannot exceed the byte budget. The branch exists for a raised
  // --max-line-length (issue #16), which is why the fix above had to be keyed
  // on `lines.length === 0` rather than on `formatted.length === 0` -- the
  // only way the latter fires TODAY is the ordinary empty-page case.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-widen-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'wide.txt'), 'x'.repeat(3 * 1024 * 1024) + '\n');
  const server = spawnServer(['--allowed-dir', dir]);
  t.after(() => server.close());

  const r = await server.callTool('fs_read', { file_path: '/d0/wide.txt' });

  assert.equal(r.isError, undefined, text(r));
  assert.match(text(r), /truncated/, 'a shortened line must say so inline');
  assert.equal(r._meta && r._meta.truncated, true, 'and structurally, for a caller that branches');
  assert.ok(text(r).length < 1024 * 1024, 'and the result must be inside the response budget');
});
