'use strict';

/**
 * Issue #30: fs_edit's two degenerate string arguments.
 *
 * fs_edit matches literally, with `content.split(old).join(new)`. That is
 * exact and cheap for a real search string and silently meaningless for two
 * inputs a caller can reach without trying:
 *
 *   - `old_string: ""`. `"hello".split("")` splits into CHARACTERS, so the
 *     occurrence count is `length - 1` and the join interleaves new_string
 *     between every character: "hello" with new_string "X" was written to
 *     disk as "hXeXlXlXoX" and reported as `Replaced 5 occurrence(s)` on a
 *     success result. Relay's audit recorded `ok`. The un-flagged path was
 *     worse than it looks: `old_string found 5 times. Use replace_all or
 *     provide more context to make it unique` is a refusal whose own
 *     suggested remedy is the flag that destroys the file.
 *   - `old_string === new_string`. A "replacement" with nothing to show for
 *     it, reported as `Replaced N occurrence(s)`, which reads as a change
 *     that happened. And not even a true no-op on disk: fs_edit rewrites
 *     through writeFileAtomic's temp-file rename, so the file is replaced
 *     (new inode, new mtime, any hard link broken) with identical bytes.
 *
 * Neither is a contrived input. Both are what an agent produces when a
 * string it meant to search for came from a variable that resolved empty,
 * or when two template variables resolved to the same value. The agent
 * believes it made a targeted edit either way.
 *
 * These pin the refusals, that they happen BEFORE the file is read, that
 * the file is untouched, and that the one legitimate degenerate case --
 * an empty new_string, i.e. a deletion -- still works.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnServer } = require('./helpers');

function mkFixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-edit-')));
  return dir;
}

function allText(result) {
  return (result.content || []).map((c) => c.text).join('\n');
}

test('fs_edit refuses an empty old_string instead of interleaving new_string between every character', async (t) => {
  const dir = mkFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = spawnServer([]);
  t.after(() => server.close());

  const meta = { allowed_dirs: [dir] };
  const file = path.join(dir, 'empt.txt');

  await t.test('without replace_all: refused on the emptiness, not on the match count', async () => {
    fs.writeFileSync(file, 'hello\n');
    const r = await server.callTool(
      'fs_edit',
      { file_path: '/d0/empt.txt', old_string: '', new_string: 'X' },
      meta
    );
    assert.equal(r.isError, true, allText(r));
    assert.match(allText(r), /old_string must not be empty/i);
    // The refusal must NOT be the uniqueness one. That message names
    // replace_all as the remedy, and following it is what corrupted the
    // file -- a refusal that hands the caller the instruction for the
    // damage is worse than no refusal at the same place.
    assert.doesNotMatch(allText(r), /use replace_all/i);
    assert.equal(fs.readFileSync(file, 'utf-8'), 'hello\n');
  });

  await t.test('with replace_all: still refused, and the file is byte-identical', async () => {
    fs.writeFileSync(file, 'hello\n');
    const before = fs.readFileSync(file);
    const r = await server.callTool(
      'fs_edit',
      { file_path: '/d0/empt.txt', old_string: '', new_string: 'X', replace_all: true },
      meta
    );
    assert.equal(r.isError, true, allText(r));
    assert.match(allText(r), /old_string must not be empty/i);
    // The exact corruption from the issue, stated as bytes rather than as
    // a message: "hello\n" must not have become "hXeXlXlXoX\n".
    assert.deepEqual(fs.readFileSync(file), before);
    assert.doesNotMatch(allText(r), /Replaced/i);
  });

  await t.test('refused before the file is read at all', async () => {
    // A path in scope that does not exist. If the emptiness check ran after
    // the read, this would come back "file not found" -- a message about
    // the file rather than about the argument, and proof the file had
    // already been opened by the time anything looked at old_string. The
    // issue asks for the refusal to come first, and this is what "first"
    // means observably from the wire.
    const r = await server.callTool(
      'fs_edit',
      { file_path: '/d0/does-not-exist.txt', old_string: '', new_string: 'X' },
      meta
    );
    assert.equal(r.isError, true, allText(r));
    assert.match(allText(r), /old_string must not be empty/i);
    assert.doesNotMatch(allText(r), /file not found/i);
  });

  await t.test('an out-of-scope path is still a scope refusal, not an argument one', async () => {
    // Ordering in the other direction: the emptiness check sits after
    // checkPathV, so a caller cannot use a degenerate argument to learn
    // that its path would otherwise have been accepted. A scope violation
    // stays a scope violation, and keeps carrying _meta.scope_violation for
    // relay's audit.
    const r = await server.callTool(
      'fs_edit',
      { file_path: '/d0/../../etc/passwd', old_string: '', new_string: 'X' },
      meta
    );
    assert.equal(r.isError, true, allText(r));
    assert.doesNotMatch(allText(r), /old_string must not be empty/i);
  });

  await t.test('an empty new_string is a deletion and still works', async () => {
    fs.writeFileSync(file, 'hello world\n');
    const r = await server.callTool(
      'fs_edit',
      { file_path: '/d0/empt.txt', old_string: ' world', new_string: '' },
      meta
    );
    assert.equal(r.isError, undefined, allText(r));
    assert.equal(fs.readFileSync(file, 'utf-8'), 'hello\n');
  });
});

test('fs_edit publishes minLength: 1 on old_string, so a caller sees the constraint before calling', async (t) => {
  const server = spawnServer([]);
  t.after(() => server.close());

  const res = await server.request('tools/list', {});
  const edit = res.result.tools.find((tool) => tool.name === 'fs_edit');
  assert.ok(edit, 'fs_edit must be published');

  // The handler's refusal is the enforcement; this is the half a caller can
  // read ahead of time. Without it the only way to learn the constraint is
  // to make the call that used to corrupt the file.
  assert.equal(edit.inputSchema.properties.old_string.minLength, 1);
  // new_string must NOT pick up the same floor: an empty new_string is a
  // legitimate deletion.
  assert.equal(edit.inputSchema.properties.new_string.minLength, undefined);
});

test('fs_edit refuses old_string === new_string rather than reporting a replacement that changed nothing', async (t) => {
  const dir = mkFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = spawnServer([]);
  t.after(() => server.close());

  const meta = { allowed_dirs: [dir] };
  const file = path.join(dir, 'noop.txt');
  fs.writeFileSync(file, 'hello hello\n');
  const before = fs.statSync(file);

  const r = await server.callTool(
    'fs_edit',
    { file_path: '/d0/noop.txt', old_string: 'hello', new_string: 'hello', replace_all: true },
    meta
  );
  assert.equal(r.isError, true, allText(r));
  assert.match(allText(r), /identical/i);
  assert.doesNotMatch(allText(r), /Replaced/i);

  const after = fs.statSync(file);
  assert.equal(fs.readFileSync(file, 'utf-8'), 'hello hello\n');
  // The point of refusing rather than letting it through and calling it a
  // no-op: writeFileAtomic renames a fresh temp file over the target, so
  // "nothing changed" would still have replaced the inode and bumped mtime.
  assert.equal(after.ino, before.ino, 'the file must not have been rewritten onto a new inode');
  assert.equal(after.mtimeMs, before.mtimeMs, 'mtime must not have moved');
});
