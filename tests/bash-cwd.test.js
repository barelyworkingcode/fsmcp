'use strict';

/**
 * fs_bash carries its working directory between calls. It validated that
 * directory on the way IN but stored the post-`cd` value on the way OUT
 * without validating it, so a single `cd` out of the allowed directories
 * wedged the tool permanently: every later call was refused by the entry
 * check, and that included the `cd` back, because the refusal happens before
 * the command runs. Nothing short of restarting the server recovered it.
 *
 * The escape is not the bug -- fs_bash is an arbitrary shell and allowed_dirs
 * was never a boundary for it (relay filters it out of every project for
 * exactly that reason). The denial of service is.
 *
 * These tests assert what actually happened on disk -- a file the command was
 * asked to create, and the directory a later command really ran in -- rather
 * than the tool's reply, because a reply is what a broken build can still get
 * right.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnServer } = require('./helpers');

function mkTmpDir() {
  // realpath: /var/folders/... on macOS is a symlink to /private/var/...,
  // and `pwd` inside the shell reports the resolved form.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-bash-')));
}

test('a cd out of the allowed dirs does not disable fs_bash for every later call', async () => {
  const dir = mkTmpDir();
  const server = spawnServer(['--allowed-dir', dir]);
  try {
    await server.callTool('fs_bash', { command: 'cd /etc' });

    // The proof is on disk: the next command has to actually run.
    const marker = path.join(dir, 'still-working.txt');
    await server.callTool('fs_bash', { command: `touch ${marker}` });
    assert.equal(
      fs.existsSync(marker),
      true,
      'fs_bash was still refusing after a stray cd -- the tool is wedged'
    );
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an out-of-scope cwd is not carried over; the next call runs in the last good one', async () => {
  const dir = mkTmpDir();
  const server = spawnServer(['--allowed-dir', dir]);
  try {
    await server.callTool('fs_bash', { command: 'cd /etc' });

    const where = path.join(dir, 'where.txt');
    await server.callTool('fs_bash', { command: `pwd > ${where}` });
    assert.equal(
      fs.readFileSync(where, 'utf-8').trim(),
      dir,
      'the next call inherited the out-of-scope directory'
    );
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the cd back in is not needed, but it still works after a stray cd', async () => {
  const dir = mkTmpDir();
  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub);
  const server = spawnServer(['--allowed-dir', dir]);
  try {
    await server.callTool('fs_bash', { command: 'cd /etc' });
    await server.callTool('fs_bash', { command: `cd ${sub}` });
    await server.callTool('fs_bash', { command: 'touch recovered.txt' });
    assert.equal(
      fs.existsSync(path.join(sub, 'recovered.txt')),
      true,
      'the cd back was itself refused -- the one-way door is still there'
    );
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a cd that stays inside the allowed dirs still persists between calls', async () => {
  const dir = mkTmpDir();
  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub);
  const server = spawnServer(['--allowed-dir', dir]);
  try {
    await server.callTool('fs_bash', { command: `cd ${sub}` });
    await server.callTool('fs_bash', { command: 'touch persisted.txt' });
    assert.equal(
      fs.existsSync(path.join(sub, 'persisted.txt')),
      true,
      'an in-scope cd stopped persisting -- the fix over-corrected'
    );
    assert.equal(fs.existsSync(path.join(dir, 'persisted.txt')), false);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fs_bash works when the server was started outside the allowed dirs', async () => {
  // spawnServer inherits this repo as its cwd, which is outside `dir`. Before
  // the fix that made fs_bash dead on arrival: the very first call, and every
  // one after it, was refused.
  const dir = mkTmpDir();
  const server = spawnServer(['--allowed-dir', dir]);
  try {
    const marker = path.join(dir, 'first-call.txt');
    await server.callTool('fs_bash', { command: `touch ${marker}` });
    assert.equal(
      fs.existsSync(marker),
      true,
      'the first call was refused because the launch cwd was out of scope'
    );

    const where = path.join(dir, 'where.txt');
    await server.callTool('fs_bash', { command: `pwd > ${where}` });
    assert.equal(
      fs.readFileSync(where, 'utf-8').trim(),
      dir,
      'the cwd should have been reset to an allowed directory'
    );
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with no usable allowed directory fs_bash refuses rather than running anywhere', async () => {
  const dir = mkTmpDir();
  const missing = path.join(dir, 'does-not-exist');
  const server = spawnServer(['--allowed-dir', missing]);
  try {
    const marker = path.join(dir, 'should-not-exist.txt');
    const res = await server.callTool('fs_bash', { command: `touch ${marker}` });
    assert.equal(res.isError, true, 'recovery must not become a way to run with no scope');
    assert.match(res.content[0].text, /no allowed directory|outside allowed directories/i);
    assert.equal(fs.existsSync(marker), false, 'the command ran despite there being no usable scope');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
