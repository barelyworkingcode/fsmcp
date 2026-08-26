'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { spawnServer, buildScopeFixture, removeFixture, toVirtual } = require('./helpers');

/**
 * Issue #20. writeFileAtomic replaces a file by renaming a freshly-created
 * temp file over it, so the file that comes out the other side is a NEW
 * INODE and carries only what fsmcp deliberately put on it. The first
 * version of that fix put the permission bits there and stopped, which left
 * two ways for an fs_edit or an fs_write to destroy metadata while
 * reporting `ok`:
 *
 *   1. extended attributes and the ACL were never copied at all -- Finder
 *      tags, Finder comments, Spotlight metadata, com.apple.quarantine and
 *      any application state hung off the file all vanished on the first
 *      edit;
 *   2. the permission bits were not actually preserved either. They were
 *      handed to fs.writeFileSync's `mode` option, which is open(2)'s mode,
 *      which the process umask masks. Under the macOS default `umask 022`,
 *      0664 came back 0644 and 0777 came back 0755.
 *
 * (2) is the more ordinary loss of the two: a group-writable file in a
 * shared folder stops being group-writable the first time the agent edits
 * it, on a default-configured Mac, with a success result.
 *
 * These tests go through the real server over stdio rather than calling
 * writeFileAtomic directly, because the umask half only exists in a
 * process's umask and the xattr half only exists on the real filesystem --
 * neither is observable from a unit test that stubs either one out.
 */

/**
 * The server child inherits the umask of whoever spawned it, and the test
 * runner's umask is whatever the developer's shell happens to have. Pinning
 * it in the SERVER process (via the same `--require` preload trick
 * atomic-write.test.js uses for fault injection) rather than in this
 * process makes the test deterministic and keeps it from leaking into the
 * other tests in this file. 0o077 is used rather than the macOS default
 * 0o022 so the failure is unmistakable: on the pre-fix code every
 * group/other bit disappears, not just the write bits.
 */
function umaskPreload(umask) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-umask-'));
  const file = path.join(dir, 'umask.js');
  fs.writeFileSync(file, `process.umask(${umask});\n`);
  return file;
}

function allText(result) {
  return (result.content || []).map((c) => c.text).join('');
}

const isDarwin = process.platform === 'darwin';

function xattrNames(file) {
  return execFileSync('/usr/bin/xattr', ['--', file], { encoding: 'utf-8' })
    .split('\n')
    .filter(Boolean)
    .sort();
}

function xattrValue(file, name) {
  return execFileSync('/usr/bin/xattr', ['-p', '-x', '--', name, file], { encoding: 'utf-8' })
    .replace(/\s+/g, '');
}

/** The ACE lines `ls -le` prints under the mode line, if there are any. */
function aclLines(file) {
  return execFileSync('/bin/ls', ['-lde', '--', file], { encoding: 'utf-8' })
    .split('\n')
    .slice(1)
    .filter((l) => l.trim())
    .map((l) => l.trim());
}

test('fs_edit and fs_write preserve the EXACT permission bits, not the umask-masked ones', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));

  // 0o664 is the case from the issue: an ordinary group-writable file in a
  // shared folder. 0o777 is the case where a default umask eats two bits
  // rather than one.
  const targets = [
    { name: 'group-writable.txt', mode: 0o664 },
    { name: 'wide-open.txt', mode: 0o777 },
  ];
  for (const { name, mode } of targets) {
    fs.writeFileSync(path.join(fx.root, name), 'marker here\n');
    fs.chmodSync(path.join(fx.root, name), mode);
  }

  const server = spawnServer(['--allowed-dir', fx.root], {
    env: { NODE_OPTIONS: `--require ${umaskPreload('0o077')}` },
  });
  t.after(() => server.close());
  const v = (p) => toVirtual(p, fx.root);

  for (const { name, mode } of targets) {
    const target = path.join(fx.root, name);

    const e = await server.callTool('fs_edit', {
      file_path: v(target),
      old_string: 'marker',
      new_string: 'EDITED',
    });
    assert.equal(e.isError, undefined, `fs_edit must succeed: ${allText(e)}`);
    assert.equal(
      (fs.statSync(target).mode & 0o777).toString(8),
      mode.toString(8),
      `fs_edit must leave ${name} at exactly ${mode.toString(8)}. writeFileSync's own \`mode\` ` +
        `option is open(2)'s, and open(2)'s mode is masked by the umask -- preserving a mode ` +
        `through it silently drops every bit the umask clears, which for a group-writable file ` +
        `under the default umask 022 means it stops being group-writable on the first edit.`
    );

    const w = await server.callTool('fs_write', { file_path: v(target), content: 'rewritten\n' });
    assert.equal(w.isError, undefined, `fs_write must succeed: ${allText(w)}`);
    assert.equal(
      (fs.statSync(target).mode & 0o777).toString(8),
      mode.toString(8),
      `fs_write must leave ${name} at exactly ${mode.toString(8)} for the same reason`
    );
  }
});

test('fs_edit and fs_write preserve extended attributes across the replace', async (t) => {
  if (!isDarwin) {
    t.skip('extended attribute preservation is implemented for macOS only -- see atomicWrite.ts');
    return;
  }
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));

  const target = path.join(fx.root, 'tagged.txt');
  fs.writeFileSync(target, 'original content\nline two\n');
  // The two from the issue's repro: one in the com.apple.metadata namespace
  // (this is where Finder tags and Spotlight state live) and one arbitrary
  // application attribute.
  execFileSync('/usr/bin/xattr', ['-w', 'com.apple.metadata:_kMDItemUserTags', 'bplist-tag', target]);
  execFileSync('/usr/bin/xattr', ['-w', 'user.custom', 'important-xattr-value', target]);
  fs.chmodSync(target, 0o754);

  const before = xattrNames(target);
  assert.deepStrictEqual(before, ['com.apple.metadata:_kMDItemUserTags', 'user.custom']);
  const beforeValues = before.map((n) => xattrValue(target, n));

  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());
  const v = (p) => toVirtual(p, fx.root);

  const e = await server.callTool('fs_edit', {
    file_path: v(target),
    old_string: 'original content',
    new_string: 'edited content',
  });
  assert.equal(e.isError, undefined, `fs_edit must succeed: ${allText(e)}`);
  assert.match(fs.readFileSync(target, 'utf-8'), /edited content/, 'the edit itself must land');
  assert.deepStrictEqual(
    xattrNames(target),
    before,
    'fs_edit replaces the file by renaming a new inode over it; every extended attribute the ' +
      'old inode carried is destroyed unless it is copied across first. On macOS this is not ' +
      'exotic metadata -- it is Finder tags, Finder comments, Spotlight state and the ' +
      'quarantine flag.'
  );
  assert.deepStrictEqual(
    before.map((n) => xattrValue(target, n)),
    beforeValues,
    'the attribute VALUES must survive byte-for-byte, not just the names'
  );
  assert.equal(fs.statSync(target).mode & 0o777, 0o754, 'and the mode still comes along');

  const w = await server.callTool('fs_write', { file_path: v(target), content: 'rewritten\n' });
  assert.equal(w.isError, undefined, `fs_write must succeed: ${allText(w)}`);
  assert.deepStrictEqual(xattrNames(target), before, 'fs_write must preserve them too');
  assert.deepStrictEqual(before.map((n) => xattrValue(target, n)), beforeValues);
});

test('fs_edit preserves an ACL across the replace', async (t) => {
  if (!isDarwin) {
    t.skip('ACL preservation is implemented for macOS only -- see atomicWrite.ts');
    return;
  }
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));

  const target = path.join(fx.root, 'acl.txt');
  fs.writeFileSync(target, 'acl file\n');
  execFileSync('/bin/chmod', ['+a', 'staff allow read,write', target]);
  const before = aclLines(target);
  assert.equal(before.length, 1, 'fixture setup: the file must actually carry an ACE');

  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());
  const v = (p) => toVirtual(p, fx.root);

  const e = await server.callTool('fs_edit', {
    file_path: v(target),
    old_string: 'acl file',
    new_string: 'acl edited',
  });
  assert.equal(e.isError, undefined, `fs_edit must succeed: ${allText(e)}`);
  assert.deepStrictEqual(
    aclLines(target),
    before,
    'the ACL is a property of the inode, and rename(2) installs a different inode. An ' +
      'organisation that sets ACLs on a shared folder loses them on every edit the agent ' +
      'makes unless they are copied onto the replacement first.'
  );
});

/**
 * The mechanism that carries the xattrs and the ACL across is `cp -p`, and
 * `cp -p` copies the setuid bit too. atomicWrite masks the mode it applies
 * with 0o777 for exactly this reason -- the same mask, and the same stated
 * reason, as before the fix: nothing about "preserve the execute bit across
 * an edit" implies "preserve setuid across a rewrite to a fresh inode."
 * This pins it, because the mask is load-bearing in a way it was not when
 * the temp file was always created from scratch.
 */
test('a setuid target does not produce a setuid replacement', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));

  const target = path.join(fx.root, 'suid.sh');
  fs.writeFileSync(target, '#!/bin/sh\necho MARKER\n');
  fs.chmodSync(target, 0o4755);
  if ((fs.statSync(target).mode & 0o4000) === 0) {
    t.skip('this filesystem does not keep the setuid bit');
    return;
  }

  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());
  const v = (p) => toVirtual(p, fx.root);

  const e = await server.callTool('fs_edit', {
    file_path: v(target),
    old_string: 'MARKER',
    new_string: 'CHANGED',
  });
  assert.equal(e.isError, undefined, `fs_edit must succeed: ${allText(e)}`);
  assert.equal(
    fs.statSync(target).mode & 0o7000,
    0,
    'fsmcp must never produce a setuid, setgid or sticky file -- the cp -p that carries the ' +
      'xattrs across brings setuid with it, and the 0o777 mask on the chmod is what takes it ' +
      'back off'
  );
  assert.equal(fs.statSync(target).mode & 0o777, 0o755, 'the ordinary permission bits still survive');
});

/**
 * The other half of issue #20's "state what the replace does NOT preserve":
 * a hard link to the target is broken by the replace, and that is correct
 * behaviour, not a defect. rename(2) swings the directory entry `file_path`
 * names at a new inode; a second name for the old inode still points at the
 * old inode, holding the old content.
 *
 * This is asserted rather than merely documented so that nobody "fixes" it
 * later: keeping the link would mean writing through the existing inode,
 * which is the truncate-then-write that atomicWrite.ts exists to replace,
 * and would trade a visible local surprise for the silent, unrecoverable
 * one (file truncated to zero, old content gone) that this whole mechanism
 * was built to prevent.
 */
test('a hard link to the target is broken by the replace, deliberately', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));

  const target = path.join(fx.root, 'linked.txt');
  const sibling = path.join(fx.root, 'sibling.txt');
  fs.writeFileSync(target, 'shared MARKER content\n');
  fs.linkSync(target, sibling);
  const inodeBefore = fs.statSync(target).ino;
  assert.equal(fs.statSync(target).nlink, 2, 'fixture setup: the two names must share an inode');

  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());
  const v = (p) => toVirtual(p, fx.root);

  const e = await server.callTool('fs_edit', {
    file_path: v(target),
    old_string: 'MARKER',
    new_string: 'CHANGED',
  });
  assert.equal(e.isError, undefined, `fs_edit must succeed: ${allText(e)}`);

  assert.match(fs.readFileSync(target, 'utf-8'), /CHANGED/, 'the edit lands on the named path');
  assert.notEqual(fs.statSync(target).ino, inodeBefore, 'the replace installs a new inode');
  assert.equal(fs.statSync(target).nlink, 1, 'and the new inode has exactly one name');
  assert.equal(
    fs.readFileSync(sibling, 'utf-8'),
    'shared MARKER content\n',
    'the sibling hard link keeps the OLD inode and the OLD content. This is the documented ' +
      'trade for atomic replace (README, "what the replace preserves"), not a bug to fix -- ' +
      'the alternative is writing through the shared inode, which is exactly the ' +
      'truncate-then-write that loses the file when it fails partway.'
  );
  assert.equal(fs.statSync(sibling).ino, inodeBefore, 'the sibling still points at the old inode');
});
