'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { spawnServer, buildScopeFixture, removeFixture, toVirtual } = require('./helpers');

/**
 * fs_write and fs_edit both used to write a file by calling
 * fs.writeFileSync(filePath, ...) directly. That call opens the target with
 * O_TRUNC before a single byte of the new content is written, so a write
 * that fails partway through -- ENOSPC, the process being killed, the
 * machine losing power -- leaves the file truncated (usually to 0 bytes),
 * never in its old state and never in its new one. Confirmed for real
 * against a deliberately undersized filesystem (a 1MB HFS+ volume created
 * with `hdiutil create -size 1m -fs HFS+`): a 512000-byte file overwritten
 * with 2MB of new content hit ENOSPC and was left at 0 bytes, with fs_write
 * correctly REPORTING the failure -- the report was honest, the file was
 * still gone.
 *
 * hdiutil is macOS-only and slow (it shells out to diskimage tooling and
 * mounts a real volume), which is fine for a one-off manual repro but wrong
 * for a suite that has to run everywhere and run fast. This test reproduces
 * the same failure MODE portably, at the point fs.writeFileSync is called
 * with the NEW content (identified by a marker string in the bytes, not by
 * which path is being written to -- so this is agnostic to *how* a handler
 * gets the new content onto disk, whether that is one direct write to the
 * target, as fs_write/fs_edit used to do, or a write to a temp file
 * followed by a rename, as they do now):
 *
 *   1. it truncates whatever path was actually passed to empty, exactly as
 *      the real fs.writeFileSync(path, 'w'-flag) open() call already does
 *      before writing a single byte of `data` -- confirmed for real above;
 *   2. it then throws ENOSPC instead of performing the write, exactly as a
 *      real write(2) that runs out of room fails AFTER that truncating
 *      open() already succeeded.
 *
 * A naive mock that only throws (never truncating first) would not
 * reproduce the bug at all: it would make the call fail before touching
 * disk, which is trivially safe for old and new code alike and proves
 * nothing about which one actually corrupts a file. The fixture's OWN setup
 * write, a few lines below, carries the OLD content and is never matched.
 * Injected into the real server process via a `--require` preload -- not by
 * mocking fs in this test process, which would never affect dist/main.js
 * running as a child. Every other syscall the server makes runs unmodified;
 * only the one write this test cares about is forced to fail, the same way
 * a real disk running out of room would fail it.
 */
function writeFailureInjector(matchInData) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-inject-'));
  const file = path.join(dir, 'inject.js');
  fs.writeFileSync(
    file,
    [
      "const fs = require('fs');",
      'const original = fs.writeFileSync;',
      'let failed = false;',
      'fs.writeFileSync = function (p, data, ...rest) {',
      "  const s = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);",
      `  if (!failed && s.includes(${JSON.stringify(matchInData)})) {`,
      '    failed = true;',
      '    original.call(fs, p, Buffer.alloc(0));',
      "    const err = new Error('ENOSPC: no space left on device, write');",
      "    err.code = 'ENOSPC';",
      '    err.path = p;',
      '    throw err;',
      '  }',
      '  return original.apply(fs, [p, data, ...rest]);',
      '};',
    ].join('\n')
  );
  return file;
}

function allText(result) {
  return (result.content || []).map((c) => c.text).join('');
}

test('fs_write: a write that fails partway does not destroy the original file', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));

  const target = path.join(fx.root, 'important.txt');
  const before = 'ORIGINAL CONTENT THAT MUST SURVIVE\n'.repeat(200);
  fs.writeFileSync(target, before);
  const entriesBefore = new Set(fs.readdirSync(fx.root));

  const injector = writeFailureInjector('REPLACEMENT-MARKER');
  const server = spawnServer(['--allowed-dir', fx.root], {
    env: { NODE_OPTIONS: `--require ${injector}` },
  });
  t.after(() => server.close());

  const v = (p) => toVirtual(p, fx.root);
  const r = await server.callTool('fs_write', {
    file_path: v(target),
    content: 'REPLACEMENT-MARKER\n'.repeat(500),
  });

  assert.equal(r.isError, true, 'the injected write failure must be reported, not swallowed');
  assert.match(allText(r), /ENOSPC/, 'the real error must reach the caller, not a cleanup-step error masking it');

  const after = fs.readFileSync(target, 'utf-8');
  assert.equal(
    after,
    before,
    'a write that fails partway must leave the original file byte-for-byte untouched, ' +
      'not truncated -- the file must be in exactly one of its two legitimate states, ' +
      'never a third "truncated garbage" state'
  );

  // Nothing NEW left behind in the directory either -- whether that is
  // atomicWrite's own temp file (its cleanup step runs even when the write
  // itself is what failed, since there is nothing to rename in that case,
  // only something to unlink) or, on pre-fix code, nothing at all: pre-fix
  // writes straight to `target`, so there was never a second file to leave
  // behind. Compared against the directory's OWN pre-existing entries
  // (buildScopeFixture seeds several) rather than a hardcoded list, so this
  // assertion is about what THIS call added, not about the fixture's shape.
  const leftover = fs.readdirSync(fx.root).filter((n) => !entriesBefore.has(n));
  assert.deepStrictEqual(leftover, [], 'a failed write must not leave a stray temp file behind');
});

test('fs_edit: a write that fails partway does not destroy the original file', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));

  const target = path.join(fx.root, 'important.txt');
  const before = 'A'.repeat(50000) + 'MARKER' + 'A'.repeat(50000);
  fs.writeFileSync(target, before);

  const injector = writeFailureInjector('REPLACEMENT-MARKER');
  const server = spawnServer(['--allowed-dir', fx.root], {
    env: { NODE_OPTIONS: `--require ${injector}` },
  });
  t.after(() => server.close());

  const v = (p) => toVirtual(p, fx.root);
  const r = await server.callTool('fs_edit', {
    file_path: v(target),
    old_string: 'MARKER',
    new_string: 'REPLACEMENT-MARKER'.repeat(2000),
  });

  assert.equal(r.isError, true, 'the injected write failure must be reported, not swallowed');
  assert.match(allText(r), /ENOSPC/, 'the real error must reach the caller, not a cleanup-step error masking it');

  const after = fs.readFileSync(target, 'utf-8');
  assert.equal(
    after,
    before,
    'a write that fails partway must leave the original file byte-for-byte untouched -- ' +
      'fs_edit reads the whole file into memory before writing any of it back, so a correct ' +
      'edit followed by a failed write must still be recoverable from the file itself'
  );
});

/**
 * atomicWrite replaces a file by renaming a freshly-created temp file over
 * it, and a freshly-created inode gets the process's default permissions
 * unless told otherwise -- a naive version of the fix above would silently
 * turn every fs_edit/fs_write on an executable file into a non-executable
 * one. Exercised without fault injection: this is about the ordinary
 * successful path, not the failure path the tests above cover.
 */
test('fs_edit and fs_write preserve an existing file\'s permission bits across the replace', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));

  const target = path.join(fx.root, 'script.sh');
  fs.writeFileSync(target, '#!/bin/sh\necho MARKER\n');
  fs.chmodSync(target, 0o741);
  const expected = fs.statSync(target).mode & 0o777;

  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());
  const v = (p) => toVirtual(p, fx.root);

  const editResult = await server.callTool('fs_edit', {
    file_path: v(target),
    old_string: 'MARKER',
    new_string: 'CHANGED',
  });
  assert.equal(editResult.isError, undefined, 'the edit itself must succeed');
  assert.equal(
    fs.statSync(target).mode & 0o777,
    expected,
    'fs_edit must not reset permission bits to a default when it replaces the file'
  );

  const writeResult = await server.callTool('fs_write', {
    file_path: v(target),
    content: '#!/bin/sh\necho REWRITTEN\n',
  });
  assert.equal(writeResult.isError, undefined, 'the write itself must succeed');
  assert.equal(
    fs.statSync(target).mode & 0o777,
    expected,
    'fs_write must not reset permission bits to a default when it replaces an existing file'
  );
});

/**
 * rename(2) -- the second half of writeFileAtomic's replace -- never follows
 * a symlink at its DESTINATION; it replaces that directory entry outright.
 * A direct fs.writeFileSync(filePath, ...) (what fs_write/fs_edit used to
 * call) DOES follow a symlink there, like any ordinary open(). So an
 * unqualified switch to "write a temp file, then rename it over filePath"
 * silently changes what "write to this path" means for a symlinked target:
 * instead of updating the file the link points to (leaving the link itself
 * alone), it severs the link and drops a new plain file in its place, and
 * the link's real target is left holding stale content forever -- with the
 * call still reporting success. Caught in review by resolving `filePath`
 * through canonicalizePath (the same resolution checkPathV already uses to
 * decide the call is in scope) before handing a path to writeFileAtomic.
 * This pins that resolution so a future change to write.ts/edit.ts can't
 * drop it silently.
 */
test('fs_write and fs_edit through an in-scope symlink update the symlink\'s target, not the symlink itself', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));

  const real = path.join(fx.root, 'real.txt');
  fs.writeFileSync(real, 'ORIGINAL-marker-END');
  const link = path.join(fx.root, 'link.txt');
  fs.symlinkSync(real, link);

  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());
  const v = (p) => toVirtual(p, fx.root);

  const w = await server.callTool('fs_write', { file_path: v(link), content: 'REWRITTEN-BY-FS-WRITE' });
  assert.equal(w.isError, undefined, `fs_write through the symlink must succeed: ${allText(w)}`);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'fs_write must not sever the symlink it wrote through');
  assert.equal(
    fs.readFileSync(real, 'utf-8'),
    'REWRITTEN-BY-FS-WRITE',
    "fs_write's new content must land on the symlink's target, not on a new file replacing the link"
  );

  fs.writeFileSync(real, 'EDIT-ME-marker-END');
  const e = await server.callTool('fs_edit', { file_path: v(link), old_string: 'marker', new_string: 'CHANGED' });
  assert.equal(e.isError, undefined, `fs_edit through the symlink must succeed: ${allText(e)}`);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'fs_edit must not sever the symlink it wrote through');
  assert.equal(
    fs.readFileSync(real, 'utf-8'),
    'EDIT-ME-CHANGED-END',
    "fs_edit's edited content must land on the symlink's target, not on a new file replacing the link"
  );
});

/**
 * Write-to-temp-then-rename needs the OLD file and the NEW content resident
 * on disk simultaneously (see atomicWrite.ts's own doc comment), unlike the
 * truncate-then-write it replaced, which never needed more than the larger
 * of the two. That is the accepted cost of the fix above -- losing the
 * original on a failed write is worse than failing the write -- but it is a
 * real behavioural change: a write that used to fit a nearly-full volume
 * can now fail with a plain ENOSPC that gives no hint the atomic strategy is
 * why. This test exists to make that trade a decision a future change has to
 * notice breaking, not an accident: a payload sized to fit the free volume
 * on its own, written over an existing file that leaves too little headroom
 * for both copies at once, must fail -- and the ORIGINAL file must still be
 * there afterwards, byte-identical, which is the whole point of the fix
 * this same scenario stresses.
 *
 * Needs a real free-space boundary, not the marker-based fault injection
 * the tests above use: this property is about actual bytes-remaining
 * arithmetic on a real filesystem, which nothing at the JS level can stand
 * in for without re-implementing (and therefore risking bugs in) the very
 * space accounting this test is trying to pin. hdiutil (disk image
 * creation) is macOS-only, so this test skips itself cleanly elsewhere
 * rather than fake the result it exists to make real -- consistent with the
 * rest of this suite, which already assumes a POSIX filesystem throughout
 * (symlinks, permission bits) and has no Windows CI leg to protect.
 */
function hdiutilAvailable() {
  try {
    execFileSync('hdiutil', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function makeSmallVolume(sizeMiB) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-vol-'));
  const image = path.join(dir, 'vol.dmg');
  const mountPoint = path.join(dir, 'mnt');
  fs.mkdirSync(mountPoint);
  execFileSync('hdiutil', ['create', '-size', `${sizeMiB}m`, '-fs', 'HFS+', '-volname', 'fsmcptest', image], {
    stdio: 'ignore',
  });
  execFileSync('hdiutil', ['attach', image, '-mountpoint', mountPoint], { stdio: 'ignore' });
  return {
    root: mountPoint,
    cleanup() {
      try {
        execFileSync('hdiutil', ['detach', mountPoint, '-force'], { stdio: 'ignore' });
      } catch {
        // Best-effort: a leaked mount in a tmpdir is a cleanup nuisance, not
        // a reason to fail a test that has already made its assertions.
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test(
  'fs_write: a payload that fits the free volume alone fails once an existing file leaves no room ' +
    'for both copies at once, and the original survives (peak-disk-usage tradeoff, pinned deliberately)',
  async (t) => {
    if (!hdiutilAvailable()) {
      t.skip('hdiutil not available on this platform');
      return;
    }

    const vol = makeSmallVolume(2);
    t.after(() => vol.cleanup());

    // Sized against fs_write's message limit (issue #19), not against the
    // volume: `content` is plain ASCII here, so its wire size is its length,
    // and anything over MAX_RESPONSE_BYTES is refused for being an
    // un-carryable request line rather than reaching the disk at all. That
    // refusal is a different assertion from this test's, so the payload is
    // kept comfortably inside it and the EXISTING file is made big enough to
    // fill the volume instead -- the pin is "the two copies do not fit at
    // once", and which of the two is the large one was never the point.
    //
    // Since #20 the temp file is SEEDED from the target before the new bytes
    // are written over it, so on a full volume the seed is what fails. Either
    // way the original must survive and the caller must be told ENOSPC.
    const payloadSize = 50 * 1024;
    const existingSize = 1900000;

    // Sanity half of the pin, run on the volume BEFORE `existing.txt` below
    // claims any of its space: this exact payload size fits when nothing
    // else is competing for room, so the failure asserted further down is
    // specifically about needing space for TWO copies at once, not about
    // the payload being too large for the volume outright.
    const probe = path.join(vol.root, '.sanity-probe');
    fs.writeFileSync(probe, Buffer.alloc(payloadSize, 'y'));
    fs.unlinkSync(probe);

    const target = path.join(vol.root, 'existing.txt');
    const before = Buffer.alloc(existingSize, 'A');
    fs.writeFileSync(target, before);

    const server = spawnServer(['--allowed-dir', vol.root]);
    t.after(() => server.close());
    const v = (p) => toVirtual(p, vol.root);

    const r = await server.callTool('fs_write', {
      file_path: v(target),
      content: 'y'.repeat(payloadSize),
    });

    assert.equal(
      r.isError,
      true,
      'writing a payload that fits the volume alone must still fail when the existing file leaves ' +
        'no room for both the old and new copies at once'
    );
    assert.match((r.content || []).map((c) => c.text).join(''), /ENOSPC/);

    const after = fs.readFileSync(target);
    assert.ok(
      before.equals(after),
      'the original file must survive byte-identical -- this is the entire point of paying the ' +
        'peak-disk-usage cost: a failed write must never destroy what was already there'
    );

    const leftover = fs.readdirSync(vol.root).filter((n) => n.includes('.fsmcp-tmp-'));
    assert.deepStrictEqual(leftover, [], 'a failed write must not leave its temp file behind');
  }
);
