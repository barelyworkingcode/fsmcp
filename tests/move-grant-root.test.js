'use strict';

/**
 * Issue #34 -- `fs_move` could rename a grant root away, destroying the
 * sandbox root that `fs_delete` explicitly refuses to remove.
 *
 * `fs_delete` refuses to remove an `allowed_dir` root on the principle that
 * the sandbox must survive its occupant: an agent may do as it likes INSIDE
 * the granted folder, but the folder itself is the operator's boundary
 * object, not the agent's to remove. `rename(2)` reaches the same outcome by
 * a different syscall. Measured on the build before this fix, with a two-root
 * grant:
 *
 *   fs_move { source: "/d0", destination: "/d1/moved-root" }
 *   -> "Moved /d0 to /d1/moved-root"        (relay audit: ok)
 *   -> the /d0 directory is gone; its whole tree now lives under /d1
 *
 * Nothing leaves the grant, so this is NOT a containment escape -- which is
 * exactly why neither `checkPathV` nor issue #24's DESTINATION guard sees it.
 * #24 closed the root as a destination; this is the root as a SOURCE.
 *
 * Classification is deliberately `fs_delete`'s and not #24's: a plain
 * `errorResult`, with NO `_meta.scope_violation`. The client addressed
 * something inside its own scope. `scope_violation` has to keep meaning "the
 * client addressed something outside it", or the one field an operator alerts
 * on stops distinguishing anything.
 *
 * Every case asserts on WHAT IS ON DISK, not only on the reply -- the reply
 * was the least alarming part of the bug, since it said "Moved".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnServer } = require('./helpers');

/** Two granted roots, `A` holding a file worth losing. */
function buildTwoRootFixture() {
  const R = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-move-root-')));
  const A = path.join(R, 'A');
  const B = path.join(R, 'B');
  fs.mkdirSync(path.join(A, 'data'), { recursive: true });
  fs.mkdirSync(B, { recursive: true });
  fs.writeFileSync(path.join(A, 'data', 'keep.txt'), 'important\n');
  return { R, A, B };
}

const text = (r) => (r.content || []).map((c) => c.text).join('\n');

/**
 * Every spelling that resolves to the root. The refusal is on the RESOLVED
 * path, so these are one case rather than four -- and a fix that string-matched
 * the label would pass the first and fail the rest.
 */
const ROOT_SPELLINGS = ['/d0', '/d0/', '/d0/.', '/d0/data/..'];

for (const spelling of ROOT_SPELLINGS) {
  test(`issue #34: fs_move refuses a grant root as source, spelled "${spelling}"`, async (t) => {
    const fx = buildTwoRootFixture();
    t.after(() => fs.rmSync(fx.R, { recursive: true, force: true }));
    const server = spawnServer(['--allowed-dir', fx.A, '--allowed-dir', fx.B]);
    t.after(() => server.close());

    const r = await server.callTool('fs_move', {
      source: spelling,
      destination: '/d1/moved-root',
    });

    assert.equal(r.isError, true, `expected a refusal, got: ${text(r)}`);
    assert.match(text(r), /allowed_dir root/, text(r));

    // fs_delete's classification, not fs_write's. See the header.
    assert.equal(
      (r._meta || {}).scope_violation,
      undefined,
      'moving the root is not a SCOPE violation -- the client stayed inside its own grant'
    );

    // The assertion that matters: on the unfixed build A is gone entirely.
    assert.ok(fs.existsSync(fx.A), 'the grant root must still exist');
    assert.equal(
      fs.readFileSync(path.join(fx.A, 'data', 'keep.txt'), 'utf8'),
      'important\n',
      'the tree under the grant root must be untouched'
    );
    assert.deepEqual(fs.readdirSync(fx.B), [], 'nothing may have been relocated into the other root');
  });
}

test('issue #34: a legitimate cross-root move still works', async (t) => {
  const fx = buildTwoRootFixture();
  t.after(() => fs.rmSync(fx.R, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', fx.A, '--allowed-dir', fx.B]);
  t.after(() => server.close());

  const r = await server.callTool('fs_move', {
    source: '/d0/data/keep.txt',
    destination: '/d1/keep.txt',
  });

  assert.equal(r.isError, undefined, text(r));
  assert.equal(fs.readFileSync(path.join(fx.B, 'keep.txt'), 'utf8'), 'important\n');
  assert.ok(!fs.existsSync(path.join(fx.A, 'data', 'keep.txt')));
  assert.ok(fs.existsSync(fx.A), 'the source grant root itself is untouched by an ordinary move');
});

test('issue #34: a directory INSIDE the grant is still movable', async (t) => {
  const fx = buildTwoRootFixture();
  t.after(() => fs.rmSync(fx.R, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', fx.A, '--allowed-dir', fx.B]);
  t.after(() => server.close());

  // The guard must refuse the root and nothing else -- a fix that refused any
  // directory, or anything at depth 1, would pass every test above.
  const r = await server.callTool('fs_move', {
    source: '/d0/data',
    destination: '/d1/data',
  });

  assert.equal(r.isError, undefined, text(r));
  assert.equal(fs.readFileSync(path.join(fx.B, 'data', 'keep.txt'), 'utf8'), 'important\n');
});
