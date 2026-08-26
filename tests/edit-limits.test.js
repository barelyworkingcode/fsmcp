'use strict';

/**
 * Issue #38: `fs_edit` was the one mutating tool with no bound on what it
 * accepts off the wire, and the one file-loading path with no bound on what
 * it allocates.
 *
 * #19 bounded what crosses the stdio transport and bounded it for `fs_write`
 * only. Measured by an independent verifier: a 3 MB `new_string` landed on
 * disk through `fs_edit` while the byte-identical `fs_write` refused at
 * 1,048,576 bytes -- so the limit fsMCP publishes was untrue for half its own
 * write surface. `old_string` is the same shape: equally caller-supplied,
 * equally unbounded, and equally a whole file's worth of text in the way this
 * tool is actually used.
 *
 * The read cap is the other half and a different hazard: `fs_edit` loaded its
 * target with a bare `fs.readFileSync` and no size check at all, which in a
 * single synchronous process is an unbounded allocation that blocks every
 * other caller -- exactly what `MAX_READ_BYTES` exists to prevent in
 * `fs_read`, reached through a different door.
 *
 * The third assertion here is about the WORDS, and it is not decoration.
 * `fs_write`'s over-size message can honestly suggest writing the file in
 * pieces; `fs_edit` has no offset, append or windowed mode, so the same
 * sentence would be false advice -- and false advice in a refusal is how
 * issue #23 destroyed files ("pass overwrite: true to replace it"). The
 * refusals therefore say what a caller can actually do: split the
 * REPLACEMENT into several smaller anchored edits, and, for a file over the
 * read cap, that it cannot be edited through fsMCP at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnServer } = require('./helpers');

const MAX_STRING_WIRE_BYTES = 64 * 1024;
const MAX_EDIT_READ_BYTES = 10 * 1024 * 1024;

function allText(result) {
  return (result.content || []).map((c) => c.text).join('\n');
}

function mkRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-editlimits-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('fs_edit refuses an over-size new_string, and writes nothing', async (t) => {
  const root = mkRoot(t);
  const file = path.join(root, 'f.txt');
  fs.writeFileSync(file, 'AAA\n');

  const server = spawnServer([]);
  t.after(() => server.close());

  // 3 MB, the size the issue measured landing on disk.
  const big = 'x'.repeat(3 * 1024 * 1024);
  const result = await server.callTool(
    'fs_edit',
    { file_path: '/d0/f.txt', old_string: 'AAA', new_string: big },
    { allowed_dirs: [root] }
  );

  assert.equal(result.isError, true, allText(result));
  const text = allText(result);
  assert.match(text, /new_string is 3145728 bytes on the wire/, text);
  assert.match(text, new RegExp(`over fs_edit's ${MAX_STRING_WIRE_BYTES}-byte message byte limit`), text);
  // The file is untouched: the refusal happens before anything is opened,
  // which is what makes "nothing was written" a property rather than a
  // hope.
  assert.equal(fs.readFileSync(file, 'utf-8'), 'AAA\n');
});

test('fs_edit refuses an over-size old_string too, not just the half that reaches disk', async (t) => {
  const root = mkRoot(t);
  const file = path.join(root, 'f.txt');
  fs.writeFileSync(file, 'AAA\n');

  const server = spawnServer([]);
  t.after(() => server.close());

  const big = 'y'.repeat(2 * 1024 * 1024);
  const result = await server.callTool(
    'fs_edit',
    { file_path: '/d0/f.txt', old_string: big, new_string: 'B' },
    { allowed_dirs: [root] }
  );

  // Without this bound the call is refused eventually anyway ("old_string
  // not found in file"), which is the wrong refusal for the wrong reason:
  // it is a statement about the file's contents, made after a request the
  // server should not have accepted was fully processed. The message has to
  // name the size.
  assert.equal(result.isError, true, allText(result));
  assert.match(allText(result), /^old_string is 2097152 bytes on the wire/, allText(result));
  assert.equal(fs.readFileSync(file, 'utf-8'), 'AAA\n');
});

test('the wire bound is measured on the JSON-escaped form, not on .length', async (t) => {
  const root = mkRoot(t);
  fs.writeFileSync(path.join(root, 'f.txt'), 'AAA\n');

  const server = spawnServer([]);
  t.after(() => server.close());

  // 300,000 C0 control characters: 300,000 UTF-16 code units, and 1,800,000
  // bytes once JSON.stringify turns each into the six-character "\u0001". A bound keyed on
  // .length would let this straight through at less than a third of the
  // limit; the wire is what has to fit, so the wire is what is measured.
  // This is #19's trap, restated for the tool that did not get #19's fix.
  const controls = '\u0001'.repeat(300000);
  const result = await server.callTool(
    'fs_edit',
    { file_path: '/d0/f.txt', old_string: 'AAA', new_string: controls },
    { allowed_dirs: [root] }
  );

  assert.equal(result.isError, true, allText(result));
  assert.match(allText(result), /new_string is 1800000 bytes on the wire/, allText(result));
});

test('fs_edit refuses a file over its read cap instead of allocating it', async (t) => {
  const root = mkRoot(t);
  const big = path.join(root, 'big.bin');
  // Sparse: 12 MiB of address space, a few bytes of disk. The point is the
  // ALLOCATION fs_edit would have made, not the storage.
  const fd = fs.openSync(big, 'w');
  fs.writeSync(fd, 'AAA', 0);
  fs.ftruncateSync(fd, 12 * 1024 * 1024);
  fs.closeSync(fd);

  const server = spawnServer([]);
  t.after(() => server.close());

  const result = await server.callTool(
    'fs_edit',
    { file_path: '/d0/big.bin', old_string: 'AAA', new_string: 'BBB' },
    { allowed_dirs: [root] }
  );

  assert.equal(result.isError, true, allText(result));
  const text = allText(result);
  assert.match(text, new RegExp(`over fs_edit's ${MAX_EDIT_READ_BYTES}-byte read limit`), text);
  // Names the virtual path, never the host one -- the same rule every other
  // refusal in this server follows.
  assert.match(text, /^\/d0\/big\.bin is 12582912 bytes/, text);
  assert.ok(!text.includes(root), `refusal leaked the host path: ${text}`);
});

test('the refusals give advice fs_edit can actually honour', async (t) => {
  const root = mkRoot(t);
  fs.writeFileSync(path.join(root, 'f.txt'), 'AAA\n');
  const big = path.join(root, 'big.bin');
  const fd = fs.openSync(big, 'w');
  fs.writeSync(fd, 'AAA', 0);
  fs.ftruncateSync(fd, 12 * 1024 * 1024);
  fs.closeSync(fd);

  const server = spawnServer([]);
  t.after(() => server.close());

  const overSize = allText(
    await server.callTool(
      'fs_edit',
      { file_path: '/d0/f.txt', old_string: 'AAA', new_string: 'x'.repeat(2 * 1024 * 1024) },
      { allowed_dirs: [root] }
    )
  );
  // fs_write's message can say "write it in smaller pieces". fs_edit has no
  // offset mode, so it must say so out loud and then name the thing that
  // does work -- several smaller edits, each anchored on surrounding text.
  assert.match(overSize, /no offset, append or streaming mode/, overSize);
  assert.match(overSize, /anchor/, overSize);

  const overRead = allText(
    await server.callTool(
      'fs_edit',
      { file_path: '/d0/big.bin', old_string: 'AAA', new_string: 'BBB' },
      { allowed_dirs: [root] }
    )
  );
  // For a file over the read cap there is no smaller edit that helps: the
  // whole file has to be loaded to find old_string at all. Saying so is the
  // honest answer; pointing at fs_read is what the caller can still do.
  assert.match(overRead, /cannot be edited in place through fsMCP at all/, overRead);
  assert.match(overRead, /fs_read/, overRead);
});

test('an ordinary edit is unaffected by either bound', async (t) => {
  const root = mkRoot(t);
  const file = path.join(root, 'f.txt');
  fs.writeFileSync(file, 'hello AAA world\n');

  const server = spawnServer([]);
  t.after(() => server.close());

  // Comfortably inside both bounds, including a non-ASCII character, so the
  // wire measurement being larger than .length cannot make an ordinary edit
  // fail.
  const result = await server.callTool(
    'fs_edit',
    { file_path: '/d0/f.txt', old_string: 'AAA', new_string: 'BBB é' },
    { allowed_dirs: [root] }
  );
  assert.equal(result.isError, undefined, allText(result));
  assert.equal(fs.readFileSync(file, 'utf-8'), 'hello BBB é world\n');
});

test("fs_edit's published description states both limits", async (t) => {
  const server = spawnServer([]);
  t.after(() => server.close());

  const res = await server.request('tools/list', {});
  const edit = res.result.tools.find((tool) => tool.name === 'fs_edit');
  const d = edit.description;
  // Same argument as fs_write's (see write.ts): the refusal is not the
  // primary fix, because a request too long to carry never arrives to be
  // refused. What the check buys is that the published limit and the
  // enforced limit are the same number.
  assert.match(d, /1MiB/, d);
  assert.match(d, /10MiB/, d);
  assert.match(d, /no offset, append or windowed mode/i, d);
});
