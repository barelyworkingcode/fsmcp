'use strict';

/**
 * Issue #33 -- fsMCP created directories OUTSIDE the granted folder when the
 * grant root did not exist.
 *
 * `fs_write` runs `fs.mkdirSync(path.dirname(resolvedPath), { recursive:
 * true })` before writing and `fs_mkdir` runs `fs.mkdirSync(dirPath, {
 * recursive: true })`. `recursive: true` walks UP until it finds a directory
 * that already exists, and nothing in it knows where the grant is: when the
 * grant root is missing too, the root is just another component on the way
 * and every ancestor above it is created as well. Measured on `main`, with a
 * grant at `<R>/level1/level2/level3/grant` where only `<R>` existed:
 *
 *   fs_write { file_path: "/d0/sub/file.txt", content: <31 bytes> }
 *   -> "Wrote 31 bytes to /d0/sub/file.txt"
 *   -> <R>/level1, <R>/level1/level2, <R>/level1/level2/level3 now exist
 *
 * Three directories above the boundary, from one call to a path that is
 * entirely legitimate, reported as success. `fs_mkdir { path: "/d0/sub" }`
 * did the same and answered "Created directory: /d0/sub".
 *
 * This is #24's family, one step wider. #24 closed the grant root ADDRESSED
 * AS THE TARGET; that refusal never fires here, because the target is an
 * ordinary path inside the grant.
 *
 * Every case below asserts on WHAT EXISTS ON DISK afterwards, not only on
 * the reply. The reply was the least alarming part of the bug -- it said
 * "Wrote 31 bytes", and `relay audit` said `ok`.
 *
 * Fixture is the issue's exact one, built fresh per test in a mkdtemp'd
 * directory:
 *
 *   <R>/                                  <- exists; the ONLY thing that does
 *   <R>/level1/level2/level3/grant        <- the allowed_dir, entirely absent
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnServer } = require('./helpers');

/**
 * The issue's fixture: a grant three missing levels below the deepest
 * directory that exists. Three, not one, because one missing level cannot
 * tell "bounded at the grant root" apart from "bounded one level above it"
 * -- a fix that created only the root and stopped would still pass a
 * single-level fixture's disk assertions.
 *
 * `existing: true` creates the grant root (and nothing above it that was not
 * already there), for the negative control: auto-creating intermediate
 * directories INSIDE a grant that really exists is documented behaviour and
 * must not regress.
 */
function buildMissingRootFixture(existing = false) {
  const R = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-missing-root-')));
  const grant = path.join(R, 'level1', 'level2', 'level3', 'grant');
  if (existing) fs.mkdirSync(grant, { recursive: true });
  return { R, grant, level1: path.join(R, 'level1') };
}

function allText(result) {
  return result.content.map((c) => c.text).join('\n');
}

/** Every path under `R`, relative to it, sorted -- the `find <R>` of the issue. */
function treeUnder(R) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      out.push(path.relative(R, full));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(R);
  return out.sort();
}

/**
 * The refusal has to be about the GRANT and has to tell the caller that
 * retrying is pointless. An agent handed "no such file or directory" for
 * `/d0/sub/file.txt` concludes it got the path wrong and tries again --
 * possibly forever, since nothing it can do from the client side will ever
 * make the operator's grant exist. Asserted on every case rather than once,
 * because the message is the entire difference between a client that stops
 * and a client that loops.
 */
function assertRefusedAboutTheGrant(r, where) {
  assert.equal(r.isError, true, `${where}: expected a refusal, got ${allText(r)}`);
  const text = allText(r);
  assert.match(text, /granted directory \/d0 does not exist on the host/i, where);
  assert.match(text, /configuration/i, `${where}: must name this as a configuration problem`);
  assert.match(text, /retrying/i, `${where}: must tell the caller a retry will not help`);
  // The errno the caller would have received if this were left to the
  // syscall, and the shape that makes an agent retry. Named explicitly so a
  // future change that goes back to letting mkdir answer fails here.
  assert.doesNotMatch(text, /ENOENT|no such file or directory/i, where);
  // Issue #33's classification decision, pinned so it cannot drift back:
  // the client addressed something INSIDE its scope. `_meta.scope_violation`
  // has to keep meaning "the client addressed something outside its scope",
  // or an operator reading `relay audit` cannot tell a containment event
  // apart from a mistyped grant.
  assert.ok(
    !r._meta || r._meta.scope_violation !== true,
    `${where}: an operator's grant pointing at nothing is a configuration error, not a caller scope violation`
  );
}

test('issue #33: fs_write into a grant whose root does not exist creates nothing above the grant', async (t) => {
  const fx = buildMissingRootFixture();
  t.after(() => fs.rmSync(fx.R, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', fx.grant]);
  t.after(() => server.close());

  assert.deepEqual(treeUnder(fx.R), [], 'sanity: the issue\'s starting state -- only <R> exists');

  // The issue's exact call.
  const r = await server.callTool('fs_write', {
    file_path: '/d0/sub/file.txt',
    content: 'created via a nonexistent grant',
  });

  assertRefusedAboutTheGrant(r, 'fs_write /d0/sub/file.txt');

  // The assertion that matters. On main this is
  // ['level1', 'level1/level2', 'level1/level2/level3',
  //  'level1/level2/level3/grant', '.../grant/sub', '.../grant/sub/file.txt'].
  assert.deepEqual(
    treeUnder(fx.R),
    [],
    'a write into a grant that does not exist must create NOTHING -- not the grant, and above all not its ancestors'
  );
  assert.equal(fs.existsSync(fx.level1), false, 'the first directory above the boundary must not exist');
});

test('issue #33: fs_mkdir inside a grant whose root does not exist creates nothing above the grant', async (t) => {
  const fx = buildMissingRootFixture();
  t.after(() => fs.rmSync(fx.R, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', fx.grant]);
  t.after(() => server.close());

  const r = await server.callTool('fs_mkdir', { path: '/d0/sub' });
  assertRefusedAboutTheGrant(r, 'fs_mkdir /d0/sub');
  assert.deepEqual(treeUnder(fx.R), [], 'fs_mkdir must not create the grant or its ancestors either');

  // `recursive: false` would have failed ENOENT at the syscall and created
  // nothing even on main, so this case is not about what lands on disk --
  // it is about the ANSWER. "no such file or directory" is what makes a
  // client retry; the refusal has to say the grant is the problem
  // regardless of which flag the caller passed.
  const nonRecursive = await server.callTool('fs_mkdir', { path: '/d0/sub', recursive: false });
  assertRefusedAboutTheGrant(nonRecursive, 'fs_mkdir /d0/sub recursive:false');
  assert.deepEqual(treeUnder(fx.R), []);
});

test('issue #33: the grant root itself is never manufactured, even addressed directly', async (t) => {
  const fx = buildMissingRootFixture();
  t.after(() => fs.rmSync(fx.R, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', fx.grant]);
  t.after(() => server.close());

  // #24's rule (a root is not a write target) answers this one, and it
  // answers it as a scope violation. Pinned here so that the two rules'
  // division of labour is visible in one place: #24 owns "the target IS the
  // root", #33 owns "the target is inside a root that is not there", and
  // neither refusal creates anything.
  const r = await server.callTool('fs_mkdir', { path: '/d0' });
  assert.equal(r.isError, true, allText(r));
  assert.deepEqual(treeUnder(fx.R), [], 'the grant root must not be manufactured');
});

test('issue #33 (negative): a grant root that DOES exist still auto-creates intermediate directories inside it', async (t) => {
  const fx = buildMissingRootFixture(true);
  t.after(() => fs.rmSync(fx.R, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', fx.grant]);
  t.after(() => server.close());

  // The behaviour the fix must NOT take away. fs_write is documented as
  // creating parent directories, fs_mkdir as creating missing parents, and
  // both are bounded correctly the moment the grant root exists: every
  // directory `recursive: true` can create from a path already inside the
  // grant is a strict descendant of a root the walk stops at. A fix that
  // refused whenever any intermediate directory was missing would pass every
  // test above and break the tool.
  const w = await server.callTool('fs_write', {
    file_path: '/d0/a/b/c/file.txt',
    content: 'three levels of parents, all inside the grant',
  });
  assert.equal(w.isError, undefined, allText(w));
  assert.equal(
    fs.readFileSync(path.join(fx.grant, 'a', 'b', 'c', 'file.txt'), 'utf-8'),
    'three levels of parents, all inside the grant'
  );

  const m = await server.callTool('fs_mkdir', { path: '/d0/x/y/z' });
  assert.equal(m.isError, undefined, allText(m));
  assert.ok(fs.statSync(path.join(fx.grant, 'x', 'y', 'z')).isDirectory());

  // And nothing was created above the grant on the way: `level1/level2/
  // level3` were built by the fixture, `grant` is the boundary, and every
  // path the two calls above produced is under it.
  assert.deepEqual(
    treeUnder(fx.R).filter((p) => !p.startsWith(path.join('level1', 'level2', 'level3'))),
    ['level1', path.join('level1', 'level2')]
  );
});

test('issue #33: a grant that resolves to a file, or to a dangling symlink, is refused the same way', async (t) => {
  const R = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-bad-root-')));
  t.after(() => fs.rmSync(R, { recursive: true, force: true }));

  // A grant pointing at a regular file: the same operator mistake, and
  // `mkdirSync` would answer ENOTDIR from three frames down.
  const asFile = path.join(R, 'not-a-dir');
  fs.writeFileSync(asFile, 'this is a file, not a directory\n');

  // A dangling symlink is the unmounted-volume shape in miniature: a name
  // that exists as an entry and resolves to nothing. `fs.statSync` follows
  // it (unlike lstat), which is exactly what tells it apart from a grant
  // that is a symlink to a real directory -- the ordinary case, covered by
  // the escape matrix.
  const dangling = path.join(R, 'dangling-grant');
  fs.symlinkSync(path.join(R, 'never-created'), dangling);

  for (const [name, grant, expected] of [
    ['file', asFile, /is not a directory/i],
    ['dangling symlink', dangling, /does not exist on the host/i],
  ]) {
    await t.test(`a grant that is a ${name}`, async () => {
      const server = spawnServer(['--allowed-dir', grant]);
      t.after(() => server.close());
      const r = await server.callTool('fs_write', { file_path: '/d0/sub/file.txt', content: 'x' });
      assert.equal(r.isError, true, allText(r));
      assert.match(allText(r), /granted directory/i);
      assert.match(allText(r), expected);
      assert.equal(fs.existsSync(path.join(R, 'never-created')), false);
      assert.ok(fs.statSync(asFile).isFile(), 'the grant-as-a-file must not have been replaced by a directory');
    });
  }
});

test('issue #33: with two grants, an existing one still bounds a write that the missing one also contains', async (t) => {
  const R = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-two-grants-')));
  t.after(() => fs.rmSync(R, { recursive: true, force: true }));

  // outer exists, inner does not, and inner is inside outer. A write to
  // `<inner>/sub/f.txt` is inside BOTH. Creating `inner` and `inner/sub` is
  // then entirely legitimate -- they are descendants of `outer`, which the
  // operator granted and which exists -- so the refusal must not fire. This
  // is the case a naive "the most specific grant must exist" rule gets
  // wrong, and it is why the check asks whether ANY containing grant is
  // usable rather than only the closest one.
  const outer = path.join(R, 'outer');
  const inner = path.join(outer, 'a', 'b', 'inner');
  fs.mkdirSync(outer, { recursive: true });

  const server = spawnServer(['--allowed-dir', outer, '--allowed-dir', inner]);
  t.after(() => server.close());

  const r = await server.callTool('fs_write', { file_path: '/d1/sub/f.txt', content: 'bounded by d0' });
  assert.equal(r.isError, undefined, allText(r));
  assert.equal(fs.readFileSync(path.join(inner, 'sub', 'f.txt'), 'utf-8'), 'bounded by d0');
  // Nothing above `outer` -- the bound held at the grant that exists.
  assert.deepEqual(fs.readdirSync(R), ['outer']);
});
