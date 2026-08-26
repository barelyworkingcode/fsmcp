'use strict';

/**
 * Issue #5, Part 5 -- the fixture root and the escape matrix.
 *
 * Every case below is proven at the wire: a real `dist/main.js` is spawned
 * (tests/helpers.js's spawnServer) and driven over JSON-RPC exactly the way
 * relay or a standalone client would drive it. The fixture is built fresh
 * per top-level `test()` (tests/helpers.js's buildScopeFixture) in a
 * mkdtemp'd directory, never checked into the repo and never under the
 * user's home, and is cleaned up in `t.after`.
 *
 * Fixture layout (see helpers.js for the full rationale on each piece):
 *
 *   <testRoot>/root/                  <- the only allowed_dir
 *       a.txt, notes/note1.txt, deep/nested/dirs/
 *       link-out       -> <testRoot>/fake-etc   (dir symlink, out of scope)
 *       link-out-file  -> ../../outside/secret.txt
 *       dangling       -> ../../outside/nothere (target never created)
 *       sub/link-up    -> ../..
 *   <testRoot>/outside/               <- never in scope
 *       secret.txt                    <- OUTSIDE_CANARY
 *   <testRoot>/fake-etc/              <- stand-in for /etc, NOT /etc itself
 *       passwd
 *
 * The bait (outside/secret.txt) lives outside `root` specifically so that a
 * tool refusing to look and a tool finding nothing produce distinguishable
 * evidence: every containment assertion here checks the filesystem itself
 * (byte-compare, existsSync, readdirSync) rather than trusting the error
 * string alone, per the issue's instruction that a refused write must leave
 * the bait provably untouched.
 *
 * Rows 16-19 of the issue's table are marked (star) there because they need
 * a live relay and `relay audit` as evidence of what actually happened on
 * the wire between relay and this server -- that is out of a spawned
 * fsmcp's own reach entirely (there is no relay in this process tree), so
 * it belongs to whichever agent drives the live relay + relayremote
 * verification pass (issue #5's Part 6 / the ★ rows), not to this file.
 * They are intentionally NOT stubbed out here as always-skipped tests: a
 * skipped test that can never pass in this file is not useful documentation,
 * it is noise the next reader has to figure out is not actually theirs to
 * fix.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  spawnServer,
  buildScopeFixture,
  removeFixture,
  OUTSIDE_CANARY,
  toVirtual,
  toVirtualVia,
  NOT_A_VIRTUAL_PATH,
} = require('./helpers');

// Issue #7: every fixture in this file passes a single, unlabelled
// --allowed-dir (fx.root) as this call's only root, either via the CLI flag
// or as the sole entry of _meta.allowed_dirs -- src/vpath.ts's assignLabels
// always names the first (and here, only) entry of the effective scope
// "d0". `v(hostPath)` is shorthand for the common case of addressing
// something under fx.root; rows that narrow the scope to a DIFFERENT root
// (the C1 narrowing table) build their own address against that root
// instead of this one.
function v(hostPath, fx) {
  return toVirtual(hostPath, fx.root);
}

function mkTmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function allText(result) {
  return result.content.map((c) => c.text).join('\n');
}

// ---------------------------------------------------------------------------
// Row 1 -- the positive control. Every escape test below is only meaningful
// if ordinary, in-scope use of the same tools still works; a server that
// refuses everything would pass every "refused" row for the wrong reason.
// ---------------------------------------------------------------------------
test('row 1: read/write/edit/mkdir/move/delete all succeed inside root', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  await t.test('fs_read', async () => {
    const r = await server.callTool('fs_read', { file_path: v(path.join(fx.root, 'a.txt'), fx) });
    assert.equal(r.isError, undefined, allText(r));
    assert.match(allText(r), /inside a\.txt/);
  });

  const created = path.join(fx.root, 'lifecycle.txt');
  await t.test('fs_write', async () => {
    const r = await server.callTool('fs_write', { file_path: v(created, fx), content: 'hello' });
    assert.equal(r.isError, undefined, allText(r));
    assert.equal(fs.readFileSync(created, 'utf-8'), 'hello');
  });

  await t.test('fs_edit', async () => {
    const r = await server.callTool('fs_edit', {
      file_path: v(created, fx),
      old_string: 'hello',
      new_string: 'world',
    });
    assert.equal(r.isError, undefined, allText(r));
    assert.equal(fs.readFileSync(created, 'utf-8'), 'world');
  });

  const newDir = path.join(fx.root, 'lifecycle-dir');
  await t.test('fs_mkdir', async () => {
    const r = await server.callTool('fs_mkdir', { path: v(newDir, fx) });
    assert.equal(r.isError, undefined, allText(r));
    assert.ok(fs.statSync(newDir).isDirectory());
  });

  const moved = path.join(newDir, 'lifecycle.txt');
  await t.test('fs_move', async () => {
    const r = await server.callTool('fs_move', { source: v(created, fx), destination: v(moved, fx) });
    assert.equal(r.isError, undefined, allText(r));
    assert.equal(fs.existsSync(created), false);
    assert.equal(fs.readFileSync(moved, 'utf-8'), 'world');
  });

  await t.test('fs_delete', async () => {
    const r = await server.callTool('fs_delete', { path: v(moved, fx) });
    assert.equal(r.isError, undefined, allText(r));
    assert.equal(fs.existsSync(moved), false);
  });
});

// ---------------------------------------------------------------------------
// Rows 2, 3, 6: reads that must be refused. Grouped because none of them
// mutate anything, so one fixture and one server safely serve all three --
// unlike the delete/move/write rows below, a bug that broke isolation here
// would show up as a wrong assertion in the same subtest, not a
// hard-to-diagnose failure two subtests later.
//
// Rows 7, 8, 9 (fs_glob/fs_find/fs_grep must never surface an out-of-scope
// path) live in the same test for the same reason.
// ---------------------------------------------------------------------------
test('rows 2, 3, 6: read refusals; rows 7, 8, 9: search tools never surface an outside path', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer([]);
  t.after(() => server.close());
  const meta = { allowed_dirs: [fx.root] };

  await t.test('row 2: a lexical ../outside/ path is refused', async () => {
    // Built with a template literal, not path.join, so the literal ".."
    // reaches the wire -- path.join would normalize it away in this
    // process before the server ever saw it, which would test path.join,
    // not fsmcp's own containment check.
    const target = `${fx.root}/../outside/secret.txt`;
    const r = await server.callTool('fs_read', { file_path: v(target, fx) }, meta);
    assert.equal(r.isError, true);
    assert.match(allText(r), /outside allowed directories/i);
  });

  await t.test('row 3: reading through a directory symlink out of scope is refused', async () => {
    const target = path.join(fx.root, 'link-out', 'passwd');
    const r = await server.callTool('fs_read', { file_path: v(target, fx) }, meta);
    assert.equal(r.isError, true);
    assert.match(allText(r), /outside allowed directories/i);
    assert.doesNotMatch(allText(r), /fake-etc-standin/);
  });

  await t.test('row 6: a symlink resolved kernel-style, then walked back out with "..", is refused', async () => {
    // See helpers.js's buildScopeFixture doc for why this exact shape
    // matters: canonicalizePath's own docstring warns that a resolver
    // which collapses ".." lexically (against the *string* "link-up/..
    // /..") would read this as staying inside root, while the correct
    // (kernel-style) resolution follows the symlink first and applies
    // ".." to where THAT lands -- which is well outside root. This is
    // the one row where a regression would look identical to a passing
    // test unless the resolution order is actually kernel-correct.
    const target = `${fx.root}/sub/link-up/../../outside/secret.txt`;
    const r = await server.callTool('fs_read', { file_path: v(target, fx) }, meta);
    assert.equal(r.isError, true);
    assert.match(allText(r), /outside allowed directories/i);
  });

  await t.test('row 7: fs_glob "**/*" names nothing outside root', async () => {
    // The fixture's own symlinks (link-out -> fake-etc, sub/link-up ->
    // testRoot) are exactly the shape that made this a real bug once
    // (commit 0be03fe's neighbourhood): a recursive glob can be made to
    // *walk into* a symlinked directory even though it will never be
    // followed for read/write, and whatever it finds there must still be
    // filtered on the way out, not just left unreachable by luck.
    const r = await server.callTool('fs_glob', { pattern: '**/*' }, meta);
    assert.equal(r.isError, undefined, allText(r));
    const text = allText(r);
    assert.doesNotMatch(text, /outside[/\\]secret\.txt/);
    assert.doesNotMatch(text, /fake-etc/);
    for (const line of text.split('\n')) {
      if (!line.trim() || line.startsWith('(showing')) continue;
      // Issue #7: fs_glob's own output is virtual now (translated by
      // hostToVirtualOrRedact in glob.ts), so "reported a path outside
      // root" is checked against the /d0/... form, not fx.root itself --
      // fx.root never appears in a result at all any more, which is the
      // property row 1 of issue #7's acceptance table exists to prove.
      assert.ok(
        line.startsWith('/d0/') || line === '/d0',
        `fs_glob reported a path outside root: ${line}`
      );
    }
  });

  await t.test('row 8: fs_find "secret" has no hit outside root', async () => {
    const r = await server.callTool('fs_find', { pattern: 'secret' }, meta);
    assert.equal(r.isError, undefined, allText(r));
    const text = allText(r);
    assert.doesNotMatch(text, /outside[/\\]secret\.txt/);
    assert.doesNotMatch(text, /fake-etc/);
  });

  await t.test('row 9: fs_grep for the outside canary has zero matches', async () => {
    const r = await server.callTool('fs_grep', { pattern: OUTSIDE_CANARY }, meta);
    assert.equal(r.isError, undefined, allText(r));
    assert.match(allText(r), /no matches found/i);
    assert.doesNotMatch(allText(r), new RegExp(OUTSIDE_CANARY));
  });
});

// ---------------------------------------------------------------------------
// Row 4 -- write through a symlink to a specific outside file. Given its own
// fixture: this is the one row the issue explicitly calls out for a byte
// compare, and isolating it means a bug here can never be masked by (or
// blamed on) another row's side effects.
// ---------------------------------------------------------------------------
test('row 4: writing through a symlink to an outside file is refused, and the file is untouched', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  const secretPath = path.join(fx.outside, 'secret.txt');
  const before = fs.readFileSync(secretPath); // Buffer, for a real byte compare

  const r = await server.callTool('fs_write', {
    file_path: v(path.join(fx.root, 'link-out-file'), fx),
    content: 'OVERWRITTEN-THROUGH-THE-LINK',
  });
  assert.equal(r.isError, true, allText(r));
  assert.match(allText(r), /outside allowed directories/i);

  const after = fs.readFileSync(secretPath);
  assert.ok(before.equals(after), 'outside/secret.txt must be byte-identical after the refused write');
});

// ---------------------------------------------------------------------------
// Row 5 -- write via a dangling symlink. The target has never existed; the
// only way it comes into being is if fsmcp creates it. "Refused" on its own
// would not distinguish "created nothing" from "created it anyway and then
// reported an error" (fs.writeFileSync following a dangling symlink is
// exactly what creates the file at the link's target on a real OS).
// ---------------------------------------------------------------------------
test('row 5: writing through a dangling symlink creates nothing at the target', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  const target = path.join(fx.outside, 'nothere');
  assert.equal(fs.existsSync(target), false, 'sanity: the dangling target must not pre-exist');

  const r = await server.callTool('fs_write', {
    file_path: v(path.join(fx.root, 'dangling'), fx),
    content: 'should never land anywhere',
  });
  assert.equal(r.isError, true, allText(r));
  assert.match(allText(r), /outside allowed directories/i);
  assert.equal(fs.existsSync(target), false, 'the dangling symlink target must still not exist');
});

// ---------------------------------------------------------------------------
// Rows 10, 11, 12 -- fs_delete's containment rules. Run in one fixture,
// root-refusal and non-empty-refusal first (neither mutates anything), the
// actual deletion (row 12) last, so ordering can never make one row's
// assertion depend on another row's cleanup.
// ---------------------------------------------------------------------------
test('rows 10, 11, 12: fs_delete containment', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  await t.test('row 10: deleting the allowed_dir root itself is refused', async () => {
    const r = await server.callTool('fs_delete', { path: v(fx.root, fx), recursive: true });
    assert.equal(r.isError, true);
    assert.match(allText(r), /allowed_dir root/i);
    assert.ok(fs.statSync(fx.root).isDirectory(), 'the sandbox root must survive its occupant');
  });

  await t.test('row 11: deleting a non-empty directory without recursive is refused', async () => {
    const notes = path.join(fx.root, 'notes');
    const r = await server.callTool('fs_delete', { path: v(notes, fx) });
    assert.equal(r.isError, true);
    assert.match(allText(r), /not empty/i);
    assert.equal(fs.existsSync(path.join(notes, 'note1.txt')), true, 'nothing should have been removed');
  });

  await t.test('row 12: deleting a symlink removes the link, and the /etc stand-in is intact', async () => {
    const link = path.join(fx.root, 'link-out');
    const passwdBefore = fs.readFileSync(path.join(fx.fakeEtc, 'passwd'));

    const r = await server.callTool('fs_delete', { path: v(link, fx) });
    assert.equal(r.isError, undefined, allText(r));

    // The link itself is gone -- lstat (not existsSync, which follows
    // symlinks and would report false for a perfectly intact link pointing
    // at a directory that still exists) must throw ENOENT for it.
    assert.throws(() => fs.lstatSync(link), /ENOENT/);

    // The stand-in "/etc" was never touched: it still exists, still
    // contains its file, with the exact same bytes. A stand-in rather than
    // the real /etc is used here specifically so this assertion failing
    // could never mean the test harness itself damaged the host.
    assert.ok(fs.statSync(fx.fakeEtc).isDirectory());
    const passwdAfter = fs.readFileSync(path.join(fx.fakeEtc, 'passwd'));
    assert.ok(passwdBefore.equals(passwdAfter), '/etc stand-in must be byte-identical after the delete');
  });
});

// ---------------------------------------------------------------------------
// Row 13 -- fs_move must validate both endpoints independently. A move that
// only checked the source would let a caller pick the destination outside
// root at will, and vice versa.
// ---------------------------------------------------------------------------
test('row 13: fs_move refuses both in->out and out->in', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  await t.test('in -> out is refused, and nothing appears outside', async () => {
    const source = path.join(fx.root, 'a.txt');
    const before = fs.readFileSync(source);
    const dest = path.join(fx.outside, 'moved-a.txt');

    const r = await server.callTool('fs_move', {
      source: v(source, fx),
      destination: toVirtualVia(dest, fx.root),
    });
    assert.equal(r.isError, true);
    assert.match(allText(r), /outside allowed directories/i);
    assert.equal(fs.existsSync(dest), false);
    assert.ok(before.equals(fs.readFileSync(source)), 'the source must be untouched');
  });

  await t.test('out -> in is refused, and nothing new appears inside', async () => {
    const source = path.join(fx.outside, 'secret.txt');
    const before = fs.readFileSync(source);
    const dest = path.join(fx.root, 'moved-in.txt');

    const r = await server.callTool('fs_move', {
      source: toVirtualVia(source, fx.root),
      destination: v(dest, fx),
    });
    assert.equal(r.isError, true);
    assert.match(allText(r), /outside allowed directories/i);
    assert.equal(fs.existsSync(dest), false);
    assert.ok(before.equals(fs.readFileSync(source)), 'the outside file must be untouched');
  });
});

// ---------------------------------------------------------------------------
// Row 14 -- fs_bash no longer exists at all (issue #5, Part 1). This is
// already pinned generally by annotations.test.js's EXPECTED tool table;
// it is repeated here, narrowly, because it is a named row in the Part 5
// escape matrix and this file is where that table is checked off end to
// end.
// ---------------------------------------------------------------------------
test('row 14: fs_bash is not in tools/list, and calling it is "unknown tool"', async (t) => {
  const server = spawnServer([]);
  t.after(() => server.close());

  const list = await server.request('tools/list', {});
  const names = list.result.tools.map((tool) => tool.name);
  assert.ok(!names.includes('fs_bash'), 'fs_bash must not be published');

  const r = await server.callTool('fs_bash', { command: 'echo hi' });
  assert.equal(r.isError, true);
  assert.match(allText(r), /unknown tool/i);
});

// ---------------------------------------------------------------------------
// Row 15 -- _meta cannot widen a CLI grant to "/". narrowAllowedDirs (C1)
// treats each _meta dir independently: kept only if it canonicalizes inside
// a CLI dir, dropped otherwise. "/" does not canonicalize inside `root`
// (root is inside "/", not the reverse), so it is dropped outright -- and
// because it was the *only* _meta dir supplied, the effective scope for
// this call becomes empty, not "fall back to the CLI grant". That is the
// deliberately stricter reading: a caller who supplies an invalid/widening
// _meta value gets a loud, reported refusal instead of the call silently
// running with whatever scope happens to survive. The one thing that must
// never happen -- and what this row exists to pin -- is the escape from
// `root` to the entire filesystem that a naive union of CLI and _meta dirs
// used to permit.
// ---------------------------------------------------------------------------
test('row 15: --allowed-dir root + _meta.allowed_dirs ["/"] never widens past root', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  // file_path stays a host path in both reads below on purpose: "/" is the
  // only _meta dir and it is dropped (not contained within fx.root), so the
  // effective scope -- and this call's labels -- are empty either way.
  // decodeInboundPath refuses on an empty scope before it ever looks at the
  // argument's shape (src/vpath.ts), so what the argument says is
  // immaterial to what's under test here: that "/" cannot widen past root.
  const outsideRead = await server.callTool(
    'fs_read',
    { file_path: path.join(fx.outside, 'secret.txt') },
    { allowed_dirs: ['/'] }
  );
  assert.equal(outsideRead.isError, true, 'the widen to "/" must never succeed');
  assert.doesNotMatch(allText(outsideRead), new RegExp(OUTSIDE_CANARY));

  // The drop is reported, not silent (C1's explicit requirement): the
  // operator-visible notice must name "/" as the rejected entry.
  assert.match(allText(outsideRead), /_meta\.allowed_dirs entries were dropped/i);
  assert.match(allText(outsideRead), /\//);

  // Because "/" was the only _meta dir and it was dropped, the effective
  // scope for THIS call is empty -- so even an in-scope read refuses too.
  // This is the documented, deliberate outcome (narrowAllowedDirs never
  // substitutes the CLI grant back in for a dropped entry), not a second
  // bug: it is strictly safer than the alternative of silently keeping the
  // CLI's root, because it surfaces the bad _meta value in the reply
  // instead of masking it.
  const insideRead = await server.callTool(
    'fs_read',
    { file_path: path.join(fx.root, 'a.txt') },
    { allowed_dirs: ['/'] }
  );
  assert.equal(insideRead.isError, true);
  assert.match(allText(insideRead), /no allowed directories/i);

  // Positive control: the same in-scope read succeeds with no _meta at all,
  // proving the refusal above is about the bad _meta value, not about the
  // server or the fixture being broken.
  const controlRead = await server.callTool('fs_read', { file_path: v(path.join(fx.root, 'a.txt'), fx) });
  assert.equal(controlRead.isError, undefined, allText(controlRead));
});

// ===========================================================================
// Cases the issue's table does not spell out but the code invites.
// ===========================================================================

// A scope refusal must be distinguishable, in the audit log, from an
// ordinary miss -- that is the entire point of _meta.scope_violation
// (types.ts's scopeViolationResult). Without this test, a future change
// that made every errorResult also carry scope_violation:true (or, worse,
// stopped setting it on real scope refusals) would pass every "refused"
// assertion elsewhere in this file, because those all match on the message
// text, not on _meta.
test('a scope refusal carries _meta.scope_violation: true; a plain miss does not', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  // file_path stays a host path here on purpose: fx.outside has no virtual
  // form under this call's only label (d0 -> fx.root), so this is refused
  // at decodeInboundPath as "not a valid address" rather than reaching
  // validatePath's "outside allowed directories" -- but both refusal
  // shapes are scope violations (src/vpath.ts's decodeInboundPath doc),
  // which is exactly the property this assertion is checking.
  const refusal = await server.callTool('fs_read', { file_path: path.join(fx.outside, 'secret.txt') });
  assert.equal(refusal.isError, true);
  assert.match(allText(refusal), NOT_A_VIRTUAL_PATH, 'expected the decode-stage refusal, not validatePath\'s');
  assert.equal(refusal._meta && refusal._meta.scope_violation, true, 'a scope refusal must set _meta.scope_violation');

  const miss = await server.callTool('fs_read', { file_path: v(path.join(fx.root, 'does-not-exist.txt'), fx) });
  assert.equal(miss.isError, true);
  assert.match(allText(miss), /file not found/i);
  assert.ok(
    !miss._meta || miss._meta.scope_violation !== true,
    'an ordinary "file not found" must NOT carry scope_violation -- it is not a scope refusal'
  );
});

// The C1 narrowing table (security.ts's narrowAllowedDirs) has exactly four
// rows. Each is proved independently below, including that a dropped _meta
// dir is reported rather than silent -- a single "it narrows sometimes"
// test would not catch a regression that got, say, the "CLI absent" row
// backwards while leaving the others looking fine.
test('C1: all four rows of the CLI/_meta narrowing table', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const inside = path.join(fx.root, 'a.txt');
  const notesFile = path.join(fx.root, 'notes', 'note1.txt');

  await t.test('CLI set, _meta set and contained: effective scope is the intersection (narrower than CLI)', async () => {
    const server = spawnServer(['--allowed-dir', fx.root]);
    try {
      const notesDir = path.join(fx.root, 'notes');
      const meta = { allowed_dirs: [notesDir] };
      // This call's ONLY label (d0) stands for notesDir, not fx.root -- the
      // effective scope narrowAllowedDirs computed for it, not the CLI
      // grant. `inside` (fx.root/a.txt) is a sibling of notesDir, not a
      // descendant, so it is addressed by climbing out with toVirtualVia,
      // the same shape a caller who knew the two were siblings could type
      // by hand; `notesFile` genuinely is a descendant of notesDir.
      const outsideNarrowedScope = await server.callTool(
        'fs_read',
        { file_path: toVirtualVia(inside, notesDir) },
        meta
      );
      assert.equal(
        outsideNarrowedScope.isError,
        true,
        'a.txt sits inside the CLI grant but outside the _meta-narrowed one, and must refuse'
      );
      const insideNarrowedScope = await server.callTool(
        'fs_read',
        { file_path: toVirtual(notesFile, notesDir) },
        meta
      );
      assert.equal(insideNarrowedScope.isError, undefined, allText(insideNarrowedScope));
    } finally {
      server.close();
    }
  });

  await t.test('CLI set, _meta absent: effective scope is the CLI grant, unchanged', async () => {
    const server = spawnServer(['--allowed-dir', fx.root]);
    try {
      const r = await server.callTool('fs_read', { file_path: v(inside, fx) } /* no _meta arg at all */);
      assert.equal(r.isError, undefined, allText(r));
    } finally {
      server.close();
    }
  });

  await t.test('CLI absent, _meta set: effective scope is the _meta dirs (relay-mediated mode)', async () => {
    const server = spawnServer([]);
    try {
      const meta = { allowed_dirs: [fx.root] };
      const insideRead = await server.callTool('fs_read', { file_path: v(inside, fx) }, meta);
      assert.equal(insideRead.isError, undefined, allText(insideRead));
      const outsideRead = await server.callTool(
        'fs_read',
        { file_path: toVirtualVia(path.join(fx.outside, 'secret.txt'), fx.root) },
        meta
      );
      assert.equal(outsideRead.isError, true);
    } finally {
      server.close();
    }
  });

  await t.test('CLI absent, _meta absent: empty scope, deny all (fefb031, unchanged)', async () => {
    const server = spawnServer([]);
    try {
      const r = await server.callTool('fs_read', { file_path: inside });
      assert.equal(r.isError, true);
      assert.match(allText(r), /no allowed directories/i);
    } finally {
      server.close();
    }
  });

  await t.test('a dropped _meta dir is reported, and a valid sibling entry in the same call still survives', async () => {
    const server = spawnServer(['--allowed-dir', fx.root]);
    try {
      // One entry is a genuine narrowing (kept); one is outside the CLI
      // grant entirely (dropped). Proves dropping is per-entry, not
      // all-or-nothing for the whole _meta.allowed_dirs array. The
      // surviving entry (notesDir) is this call's only label, d0.
      const notesDir = path.join(fx.root, 'notes');
      const meta = { allowed_dirs: [notesDir, fx.outside] };
      const r = await server.callTool('fs_read', { file_path: toVirtual(notesFile, notesDir) }, meta);
      assert.equal(r.isError, undefined, allText(r));
      assert.match(allText(r), /_meta\.allowed_dirs entries were dropped/i);
      assert.match(allText(r), new RegExp(fx.outside.replace(/[/\\]/g, '.')));
    } finally {
      server.close();
    }
  });
});

// fs_glob already had this bug once (0be03fe): whatever walks the tree
// chooses what gets reported, so a symlink inside scope that points out can
// come back looking like an in-scope path unless the output itself is
// re-validated. fs_find and fs_grep are new tools built with the same
// walking shape, so they inherit the same hazard by construction, not by
// copy-paste -- this proves the fix was actually carried over to both,
// using the fixture's own out-of-scope symlink (link-out -> fake-etc)
// rather than a synthetic one, so it exercises the exact same directory
// entry the read/write rows above do.
test('fs_find and fs_grep never surface a path that resolves outside root via an in-scope symlink', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  await t.test('fs_find for a name that only exists behind the symlink finds nothing outside root', async () => {
    const r = await server.callTool('fs_find', { pattern: 'passwd' });
    assert.equal(r.isError, undefined, allText(r));
    assert.doesNotMatch(allText(r), /fake-etc/);
  });

  await t.test('fs_grep for content that only exists behind the symlink finds nothing outside root', async () => {
    const r = await server.callTool('fs_grep', { pattern: 'fake-etc-standin-not-the-real-thing' });
    assert.equal(r.isError, undefined, allText(r));
    assert.match(allText(r), /no matches found/i);
    assert.doesNotMatch(allText(r), /fake-etc/);
  });
});

// C3: Node's recursive fs.rmSync is *documented* to unlink a symlink it
// encounters rather than follow it, but the issue is explicit that this
// should be pinned by a test rather than trusted from the docs -- a Node
// upgrade that changed this out from under fsmcp would otherwise be
// discovered by someone's data disappearing, not by a red test.
test('fs_delete recursive unlinks a symlink inside the tree rather than descending through it', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  // A symlink placed inside an in-scope directory, pointing at the
  // out-of-scope /etc stand-in -- if a recursive delete of the containing
  // directory ever followed it, fake-etc's own contents would be removed
  // too, despite fake-etc never having been named by the call.
  const linkInsideNotes = path.join(fx.root, 'notes', 'link-to-fake-etc');
  fs.symlinkSync(fx.fakeEtc, linkInsideNotes);
  const passwdBefore = fs.readFileSync(path.join(fx.fakeEtc, 'passwd'));

  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  const r = await server.callTool('fs_delete', { path: v(path.join(fx.root, 'notes'), fx), recursive: true });
  assert.equal(r.isError, undefined, allText(r));
  assert.equal(fs.existsSync(path.join(fx.root, 'notes')), false, 'notes/ itself should be gone');

  assert.ok(fs.statSync(fx.fakeEtc).isDirectory(), 'fake-etc must survive: it was never named by the call');
  const passwdAfter = fs.readFileSync(path.join(fx.fakeEtc, 'passwd'));
  assert.ok(passwdBefore.equals(passwdAfter), 'fake-etc/passwd must be byte-identical after the recursive delete');
});

// C4: a directory moved onto its own descendant is refused explicitly,
// rather than left to whatever rename(2) happens to report (EINVAL, with a
// message that says nothing about why and that fsmcp does not control).
test('fs_move refuses to move a directory into itself', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  const source = path.join(fx.root, 'deep');
  const destination = path.join(fx.root, 'deep', 'nested', 'moved-into-self');

  const r = await server.callTool('fs_move', { source: v(source, fx), destination: v(destination, fx) });
  assert.equal(r.isError, true);
  assert.match(allText(r), /cannot move a directory into itself/i);
  assert.ok(fs.statSync(path.join(fx.root, 'deep', 'nested', 'dirs')).isDirectory(), 'the source tree must be untouched');
  assert.equal(fs.existsSync(destination), false);
});

// fs_move's `overwrite: true` branch is a recursive delete
// (`fs.rmSync(destination, { recursive: true, force: true })`) wearing this
// tool's name -- and fs_delete's "refusing to delete an allowed_dir root"
// guard was never mirrored here. checkPath(destination) passes for the
// allowed_dir root itself, because a root is inside itself, so moving
// anything onto the root with overwrite: true reached that rmSync
// unguarded and erased the entire sandbox root -- the tool call itself then
// reported a plain "move failed: ENOENT" (rename onto a destination that
// rmSync had just deleted out from under it), giving no hint that the
// actual damage was the loss of the root directory. Fixed by hoisting
// fs_delete's guard into security.ts's refuseAllowedDirRoot and applying it
// to fs_move's overwrite branch too.
test('fs_move with overwrite:true onto the allowed_dir root does not erase the root', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  const source = path.join(fx.root, 'a.txt');
  assert.ok(fs.existsSync(source), 'sanity: the file this test moves must exist beforehand');

  const r = await server.callTool('fs_move', {
    source: v(source, fx),
    destination: v(fx.root, fx),
    overwrite: true,
  });

  assert.equal(r.isError, true, 'moving onto the allowed_dir root with overwrite must be refused');
  assert.match(allText(r), /allowed_dir root/i);
  assert.ok(fs.statSync(fx.root).isDirectory(), 'the sandbox root must still exist');
  assert.ok(fs.existsSync(source), 'the refused move must not have touched the source file either');
  assert.ok(
    fs.existsSync(path.join(fx.root, 'notes', 'note1.txt')),
    'everything else that lived under the root must have survived, not just the root entry itself'
  );
});

// `(args.recursive as boolean) ?? false` -- what fs_delete used to write --
// is a type assertion, not a check, and `??` only substitutes the default
// for null/undefined. A non-empty *string* "false" is truthy in JS, so it
// sailed straight through to `!recursive` reading it as true: a caller (or
// a lossy layer upstream that stringifies booleans) spelling the opt-out as
// text instead of JSON's `false` got the exact opposite of what they typed,
// with fs_delete's whole safety contract -- recursive defaults to false, so
// destroying a non-empty directory requires an explicit opt-in -- silently
// inverted under it. Fixed by registry.ts's parseBoolArg, which refuses a
// non-boolean cleanly instead of guessing.
test('fs_delete treats recursive:"false" (a truthy string) as a bad argument, not as true', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  const notes = path.join(fx.root, 'notes');
  const r = await server.callTool('fs_delete', { path: v(notes, fx), recursive: 'false' });

  assert.equal(r.isError, true, 'a stringly-typed "false" must not be read as true');
  assert.match(allText(r), /recursive must be true or false/i);
  assert.equal(fs.existsSync(path.join(notes, 'note1.txt')), true, 'nothing should have been removed');
});

// Same mistake, same fix, for fs_move's `overwrite`: a caller sending
// overwrite:"false" must not have an existing destination silently replaced
// out from under them.
test('fs_move treats overwrite:"false" (a truthy string) as a bad argument, not as true', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  const source = path.join(fx.root, 'a.txt');
  const destination = path.join(fx.root, 'notes', 'note1.txt');
  const destBefore = fs.readFileSync(destination, 'utf-8');

  const r = await server.callTool('fs_move', { source: v(source, fx), destination: v(destination, fx), overwrite: 'false' });

  assert.equal(r.isError, true, 'a stringly-typed "false" must not be read as true');
  assert.match(allText(r), /overwrite must be true or false/i);
  assert.equal(fs.readFileSync(destination, 'utf-8'), destBefore, 'the existing destination must survive untouched');
  assert.ok(fs.existsSync(source), 'the refused move must not have touched the source either');
});

// C3's entry cap: a runaway (or a caller-supplied path several directories
// too high) must be a loud refusal, not "however long it takes to remove
// everything under it" -- and, just as importantly, not a PARTIAL delete
// that leaves the tree in a state nobody asked for and nothing reports.
// countEntries in delete.ts is checked before any removal begins, which is
// exactly what this test pins: the directory must be completely intact
// afterward, not "missing some but not all of its entries".
test('fs_delete refuses past the entry cap rather than partially deleting', async (t) => {
  const tmp = mkTmpDir('fsmcp-cap-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const bigDir = path.join(tmp, 'toobig');
  fs.mkdirSync(bigDir);
  const ENTRY_COUNT = 10_001; // one past fs_delete's MAX_DELETE_ENTRIES (10_000)
  for (let i = 0; i < ENTRY_COUNT; i++) {
    fs.writeFileSync(path.join(bigDir, `f${i}`), '');
  }

  const server = spawnServer(['--allowed-dir', tmp]);
  t.after(() => server.close());

  const r = await server.callTool('fs_delete', { path: toVirtual(bigDir, tmp), recursive: true });
  assert.equal(r.isError, true);
  assert.match(allText(r), /more than 10000 entries/i);
  assert.equal(fs.readdirSync(bigDir).length, ENTRY_COUNT, 'not one entry should have been removed');
});

// Row 3/12 use a stand-in for /etc so a bug in the code under test can never
// really touch the host. This is the one case that names the real /etc, and
// it is read-only and refusal-only on purpose: proving the refusal here
// does not require -- and must never risk -- writing to or deleting
// anything under /etc.
test('a symlink to the real /etc is refused on read (the one place the real path is used, read-only)', async (t) => {
  const tmp = mkTmpDir('fsmcp-real-etc-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'root');
  fs.mkdirSync(root);
  fs.symlinkSync('/etc', path.join(root, 'real-etc'));

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const r = await server.callTool('fs_read', { file_path: toVirtual(path.join(root, 'real-etc', 'passwd'), root) });
  assert.equal(r.isError, true);
  assert.match(allText(r), /outside allowed directories/i);
});

// ---------------------------------------------------------------------------
// main.ts reads `_meta.allowed_dirs` off the wire and hands it straight to
// narrowAllowedDirs as `string[] | undefined` -- a type assertion, not a
// check. narrowAllowedDirs's own "CLI set" branches (the ordinary
// relay-mediated deployment: `--allowed-dir <root>` plus a per-call
// `_meta`) do `for (const metaDir of metaDirs)` the moment `metaDirs` is
// anything other than `undefined`. A caller who sends `_meta.allowed_dirs`
// as `null`, a bare object, or a number -- not an array at all -- turns
// that loop into `for (const x of null)` / `for (const x of {})`, which
// V8 throws for synchronously: "TypeError: ... is not iterable". That
// throw happens in main.ts's request handler, OUTSIDE registry.call's
// try/catch (registry.ts only wraps the tool handler itself, and this
// throw happens before a tool handler is ever reached while computing the
// ctx it would be called with), so it is an uncaught exception in a
// readline 'line' listener -- which Node does not recover from. fsmcp is
// one synchronous stdio loop serving every caller; this crashes the whole
// process, taking down every OTHER in-flight or future call with it, from
// a single malformed field on one call. That is the exact failure mode
// grep.ts's timeout comment warns about ("it takes every tool with it for
// every caller"), reachable here with no regex and no ripgrep at all.
//
// Fixed by validating `_meta.allowed_dirs` is genuinely an array before it
// ever reaches narrowAllowedDirs: anything else is treated the same as a
// caller-supplied empty array (a scope of nothing -- C1's "asserting a
// scope of nothing" reasoning), which fails closed instead of throwing,
// and is reported on the result the same way a dropped entry already is.
// ---------------------------------------------------------------------------
test('a non-array _meta.allowed_dirs fails the one call closed, and does not take the server down with it', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  const malformedValues = [null, {}, 42, 'not-an-array', true, [42], [null]];

  // file_path stays a host path throughout this loop on purpose: a
  // malformed _meta.allowed_dirs is treated as an empty scope (C1), which
  // means this call's labels are empty too, and decodeInboundPath refuses
  // on that alone before ever looking at the argument (src/vpath.ts) --
  // exactly the fail-closed behaviour under test.
  for (const badValue of malformedValues) {
    const r = await server.callTool(
      'fs_read',
      { file_path: path.join(fx.root, 'a.txt') },
      { allowed_dirs: badValue }
    );
    assert.equal(
      r.isError,
      true,
      `_meta.allowed_dirs: ${JSON.stringify(badValue)} must fail closed, not silently succeed`
    );
  }

  // The server process must still be alive and answering -- a crash on any
  // one of the malformed calls above would make every request after it
  // (including this one, from a well-behaved caller with no _meta at all)
  // hang until the test's own request timeout, rather than fail fast and
  // visibly.
  const control = await server.callTool('fs_read', { file_path: v(path.join(fx.root, 'a.txt'), fx) });
  assert.equal(control.isError, undefined, allText(control));
  assert.match(allText(control), /inside a\.txt/);
});

// ---------------------------------------------------------------------------
// A missing or wrong-typed required argument used to reach whatever the
// tool does with `undefined` (or the wrong-typed value) with no check in
// between, and every tool's own way of mishandling that was different.
// fs_find is the confirmed instance: calling it without `pattern` reached
// `pattern.toLowerCase()` inside fuzzyScore, uncaught by anything upstream
// of registry.call's backstop try/catch, and answered with a raw JS
// internal-property message instead of naming the missing argument.
// Fixed by registry.ts's requireStringArg, applied to every required
// string argument across all ten tools.
// ---------------------------------------------------------------------------
test('fs_find without pattern refuses cleanly, not with a raw JS property-access error', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  // The exact mistake that surfaced this: a caller sent `query` instead of
  // `pattern`, so `args.pattern` is `undefined`.
  const r = await server.callTool('fs_find', { query: 'secret' });
  assert.equal(r.isError, true);
  assert.doesNotMatch(
    allText(r),
    /cannot read propert/i,
    'the refusal must not be a raw JS TypeError message'
  );
  assert.match(allText(r), /pattern is required/i, 'the refusal must name the missing argument');
});

// fs_edit's new_string sent as JSON `null` used to be silently written into
// the file as the four characters "null": Array.prototype.join stringifies
// a `null` separator/element (unlike `undefined`, which it treats as "use
// the default"), and `(args.new_string as string)` cannot tell the two
// apart. That is corruption reported as success, not a crash -- strictly
// worse than the TypeError the same mistake throws when old_string is the
// wrong type instead. Fixed by requiring new_string (and old_string,
// file_path) to actually be strings before either ever reaches
// content.split/parts.join.
test('fs_edit refuses new_string: null instead of writing the word "null" into the file', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  const file = path.join(fx.root, 'a.txt');
  const before = fs.readFileSync(file, 'utf-8');

  const r = await server.callTool('fs_edit', {
    file_path: v(file, fx),
    old_string: 'inside',
    new_string: null,
  });

  assert.equal(r.isError, true, 'new_string: null must be refused, not treated as a replacement value');
  assert.match(allText(r), /new_string must be a string/i);
  assert.equal(fs.readFileSync(file, 'utf-8'), before, 'the file must be untouched by the refused edit');
});

// ---------------------------------------------------------------------------
// C5 ("max bytes on fs_read and fs_write") named this requirement
// explicitly and it was never implemented: fs_read loaded a file's entire
// contents into memory with fs.readFileSync before offset/limit ever
// trimmed it down, and fs_write had no size check on `content` at all.
// fsmcp is one synchronous process serving every caller, so an unbounded
// read or write is an unbounded synchronous allocation blocking every
// other in-flight call. Fixed with a 10MB cap on each, checked before any
// read/write syscall runs.
// ---------------------------------------------------------------------------
test('fs_read refuses a file over its byte cap instead of loading it whole', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  const big = path.join(fx.root, 'big.txt');
  // One byte over a 10MB cap -- written directly with the real fs module
  // (not through fs_write, which has its own cap) so this test exercises
  // fs_read's limit specifically.
  fs.writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1, 'x'));

  const r = await server.callTool('fs_read', { file_path: v(big, fx) });
  assert.equal(r.isError, true, 'a file over the byte cap must be refused, not read in full');
  assert.match(allText(r), /byte limit/i);
});

test('fs_write refuses content over its byte cap instead of writing it', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  const target = path.join(fx.root, 'toobig.txt');
  const hugeContent = 'x'.repeat(10 * 1024 * 1024 + 1);

  const r = await server.callTool('fs_write', { file_path: v(target, fx), content: hugeContent });
  assert.equal(r.isError, true, 'content over the byte cap must be refused');
  assert.match(allText(r), /byte limit/i);
  assert.equal(fs.existsSync(target), false, 'nothing should have been written, not even a partial file');
});

// ===========================================================================
// PR #10 review findings: the whole-result outbound rewrite that used to sit
// in ToolRegistry.call (translateResultToVirtual) was too broad. Three
// distinct problems, each with the exact repro that found it, all fixed by
// replacing that mechanism with translation at each path's own construction
// site (vpath.ts's translatePathIn/translateResult/checkPathV/describeError)
// plus a narrow, isError-only backstop (redactLeakedHostPaths). These pin
// all three so the whole-result rewrite cannot quietly come back.
// ===========================================================================

// P1: the old rewrite scanned EVERY result's text for the granted host
// directory and replaced it -- including fs_read's own file content. A file
// whose bytes happen to contain the sandbox's real path (a config, a log, a
// script naming its own location) came back corrupted, not just translated.
// The fix must be structural, not "translate less" -- fs_read's content
// must never be a candidate for replacement at all, which this proves with
// a real write-then-read round trip using the sandbox's own root as the
// planted content.
test("P1: file content containing the sandbox's own host path survives fs_write/fs_read byte-identical", async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  // The planted content IS the real host root, verbatim, with nothing
  // after it -- exactly the shape that found this in review (`content:
  // "<ROOT>"`). This matters: the old whole-result rewrite only replaced a
  // host directory when it was immediately followed by "/", a newline, or
  // the end of the string (a path-boundary guard against matching a
  // sibling directory's longer name); content with the root followed by,
  // say, a space would not have tripped it, so this has to reproduce the
  // exact boundary shape, not just "content that mentions the root",
  // or it would not actually have caught the bug it is named for.
  const planted = fx.root;
  const target = path.join(fx.root, 'mentions-root.txt');

  const w = await server.callTool('fs_write', { file_path: v(target, fx), content: planted });
  assert.equal(w.isError, undefined, allText(w));

  // Ground truth: the real file, read directly, off the disk.
  assert.equal(fs.readFileSync(target, 'utf-8'), planted, 'sanity: fs_write must have written the real bytes');

  const r = await server.callTool('fs_read', { file_path: v(target, fx) });
  assert.equal(r.isError, undefined, allText(r));
  // fs_read's cat-n format prefixes a line number and a tab; strip it
  // rather than assert on the raw content array, so this pins the CONTENT
  // byte-for-byte without also re-pinning the formatting fs_read already
  // has other tests for.
  const [, readBack] = /^\s*1\t(.*)$/.exec(allText(r)) || [];
  assert.equal(readBack, planted, "fs_read must return the file's content byte-identical, not translated");
});

// P2: the old rewrite made the "not a valid address" refusal an oracle. It
// echoed the caller's own (rejected) argument back in the message, and that
// echo passed through the same whole-result rewrite everything else did --
// so a CORRECT host-path guess came back rewritten to its label ("path /d0/
// a.txt is not a valid address"), while a wrong guess came back verbatim.
// Comparing the two replies told a caller whether it had just guessed the
// real sandbox root. The fix is to stop echoing the argument at all, so a
// right guess and a wrong guess are indistinguishable.
test('P2: the invalid-address refusal does not confirm a correct host-path guess', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  const correctGuess = path.join(fx.root, 'a.txt'); // the real root, right the first time
  const wrongGuess = '/Users/admin/projects/myapp/a.txt'; // an unrelated absolute path

  const right = await server.callTool('fs_read', { file_path: correctGuess });
  const wrong = await server.callTool('fs_read', { file_path: wrongGuess });

  assert.equal(right.isError, true, 'a raw host path must still be refused, correct guess or not');
  assert.equal(wrong.isError, true);

  // The property under test: nothing distinguishes a correct guess from an
  // incorrect one. Equal isError, equal _meta, and -- the specific thing
  // that leaked before -- byte-identical reply text.
  assert.deepEqual(right._meta, wrong._meta);
  assert.equal(
    allText(right),
    allText(wrong),
    'a correct host-path guess produced a different reply than an incorrect one -- that difference is an oracle'
  );

  // And neither reply names fx.root at all, confirmed independently of the
  // equality check above (which would also pass if both leaked it equally).
  assert.doesNotMatch(allText(right), new RegExp(fx.root.replace(/[/\\]/g, '.')));
});

// P3: the old rewrite's application was incidental (it fires only when a
// result happens to contain a granted host directory as a substring), not a
// deliberate decision at each call site -- which is a reason not to rely on
// it, demonstrated here two ways: fs_grep's own diagnostic text (the
// caller's regex, echoed back by ripgrep on a parse error) must survive
// untouched the same way fs_read's file content must in P1, and a real
// syscall error (unlike P1/P2, on the ERROR path) must still be translated
// via the deliberate describeError/err.path route, not incidentally.
test('P3: caller-echoed text is never touched, but a real syscall error path still is, deliberately', async (t) => {
  const fx = buildScopeFixture();
  t.after(() => removeFixture(fx));
  const server = spawnServer(['--allowed-dir', fx.root]);
  t.after(() => server.close());

  await t.test("fs_grep's regex-parse-error echoes the caller's pattern byte-for-byte", async () => {
    const badPattern = '(unclosed group';
    const r = await server.callTool('fs_grep', { pattern: badPattern });
    assert.equal(r.isError, true);
    assert.match(allText(r), new RegExp(badPattern.replace(/[().]/g, '\\$&')), "the caller's own pattern must survive untouched");
  });

  await t.test('a real fs_mkdir syscall error (EEXIST-shaped) still translates its host path', async () => {
    const collision = path.join(fx.root, 'already-here');
    fs.writeFileSync(collision, 'x'); // a plain file where fs_mkdir will try to create a directory

    const r = await server.callTool('fs_mkdir', { path: v(collision, fx) });
    assert.equal(r.isError, true);
    assert.doesNotMatch(allText(r), new RegExp(fx.root.replace(/[/\\]/g, '.')), 'the raw host root must not appear in a real syscall error');
    assert.match(allText(r), /\/d0\/already-here/, "the syscall error's own path must still be translated to its virtual form");
  });
});

// ===========================================================================
// P4: a duplicate label refuses the whole call, rather than silently
// resolving the ambiguity to one of the colliding directories.
// ===========================================================================

// virtualToHost resolves a label with Array.prototype.find, which returns
// the FIRST match -- so two directories sharing a label do not error on
// their own, they silently make the second one unaddressable and make
// fs_glob/fs_find/fs_grep report the identical virtual path for two
// genuinely different files. This codebase already refuses this SHAPE of
// ambiguity elsewhere rather than picking a winner (fs_edit on a
// non-unique old_string, validatePath on an empty scope), so
// assignLabels (vpath.ts) refuses too: every tool call under a
// colliding configuration fails closed, naming both directories, instead
// of half-working.
test('P4: a duplicate label fails every call closed, not just the ambiguous address', async (t) => {
  await t.test('two explicit label= entries claiming the same label', async () => {
    const dirA = mkTmpDir('fsmcp-duplabelA-');
    const dirB = mkTmpDir('fsmcp-duplabelB-');
    t.after(() => {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    });
    fs.writeFileSync(path.join(dirA, 'notes.txt'), 'FROM-A');
    fs.writeFileSync(path.join(dirB, 'notes.txt'), 'FROM-B');

    const server = spawnServer(['--allowed-dir', `z=${dirA}`, '--allowed-dir', `z=${dirB}`]);
    try {
      // Every tool fails, not just an fs_read of the ambiguous address --
      // the whole label space for this call is unusable, so nothing ever
      // reaches a tool handler.
      const glob = await server.callTool('fs_glob', { pattern: '**/*' });
      assert.equal(glob.isError, true);
      assert.match(allText(glob), /the label "z" is claimed by two different allowed directories/);

      const read = await server.callTool('fs_read', { file_path: '/z/notes.txt' });
      assert.equal(read.isError, true);
      assert.match(allText(read), /the label "z" is claimed by two different allowed directories/);

      // NEITHER colliding directory is named to the client. This used to
      // name both, reasoning that allowedDirs only ever holds the
      // operator's own CLI directories or _meta entries the caller itself
      // supplied. That is true standalone and false in the deployment this
      // server exists for: under relay, --allowed-dir is not passed at all
      // and the whole scope arrives via _meta, which relay populates from
      // operator context and the client cannot set. So the colliding
      // directories are the operator's host paths and the reader is exactly
      // the party issue #7 keeps them from. The operator's copy, with both
      // paths, goes to stderr.
      assert.ok(!allText(glob).includes(dirA), 'client message must not name a host directory');
      assert.ok(!allText(glob).includes(dirB), 'client message must not name a host directory');
      assert.ok(!allText(read).includes(dirA), 'client message must not name a host directory');
    } finally {
      server.close();
    }
  });

  await t.test('an explicit label= collides with another entry\'s auto-assigned d<N>', async () => {
    // --allowed-dir d1=/x --allowed-dir /y --allowed-dir /z: /y sits at
    // position 1 in the effective scope, so it auto-assigns "d1" -- the
    // exact label /x explicitly claimed. No operator reading their own
    // three flags in order would predict this from position alone.
    const dirX = mkTmpDir('fsmcp-duplabelX-');
    const dirY = mkTmpDir('fsmcp-duplabelY-');
    const dirZ = mkTmpDir('fsmcp-duplabelZ-');
    t.after(() => {
      fs.rmSync(dirX, { recursive: true, force: true });
      fs.rmSync(dirY, { recursive: true, force: true });
      fs.rmSync(dirZ, { recursive: true, force: true });
    });

    const server = spawnServer(['--allowed-dir', `d1=${dirX}`, '--allowed-dir', dirY, '--allowed-dir', dirZ]);
    try {
      const list = await server.callTool('fs_list', {});
      assert.equal(list.isError, true);
      assert.match(allText(list), /the label "d1" is claimed by two different allowed directories/);
      // Same rule as the explicit-collision case above: the label, never the
      // host directories. This shape is the one a human would never predict
      // -- an explicit label= that happens to equal the d<N> another entry
      // would have been auto-assigned -- which makes it the one most likely
      // to fire against a real operator's configuration rather than a test's.
      assert.ok(!allText(list).includes(dirX), 'client message must not name a host directory');
      assert.ok(!allText(list).includes(dirY), 'client message must not name a host directory');
    } finally {
      server.close();
    }
  });

  await t.test('the same directory under the same label twice is redundant, not ambiguous, and must not refuse', async () => {
    const dirA = mkTmpDir('fsmcp-duplabelSame-');
    t.after(() => fs.rmSync(dirA, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dirA, 'ok.txt'), 'fine');

    const server = spawnServer(['--allowed-dir', `q=${dirA}`, '--allowed-dir', `q=${dirA}`]);
    try {
      const list = await server.callTool('fs_list', { path: '/q' });
      assert.equal(list.isError, undefined, allText(list));
      assert.match(allText(list), /\/q\/ok\.txt/);
    } finally {
      server.close();
    }
  });

  await t.test('non-colliding labels in the same config are unaffected', async () => {
    const dirA = mkTmpDir('fsmcp-nodupe-');
    t.after(() => fs.rmSync(dirA, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dirA, 'ok.txt'), 'fine');

    const server = spawnServer(['--allowed-dir', dirA]);
    try {
      const list = await server.callTool('fs_list', {});
      assert.equal(list.isError, undefined, allText(list));
      assert.match(allText(list), /\/d0\/ok\.txt/);
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #24 -- the category the matrix above did not have.
//
// Every row up to here is an argument that points OUTSIDE the grant: a
// lexical `../outside/`, a symlink whose target is elsewhere, a second root
// smuggled in through `_meta`. This one points AT the boundary and escapes
// through the implementation instead. `fs_write { file_path: "/d0" }` -- the
// grant root itself -- passes containment, because a root is inside itself,
// and then every write-side tool derives a SIBLING of its target:
// `writeFileAtomic`'s temp file is `path.dirname(filePath) +
// "/.<basename>.fsmcp-tmp-<random>"`, and fs_write's own
// `fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })` one line
// above it is the same shape with no cleanup at all. For a root, that
// dirname is the directory ABOVE the sandbox. Measured before the fix:
// 5,000,000 bytes of caller-chosen content in the grant's parent, with only
// the final rename failing (EISDIR) once the bytes were already on disk
// there -- and `relay audit` recording a plain `tool_error` with no
// `scope_violation`, so nothing told the operator a file had been created
// outside the granted directory.
//
// The fixture here is deliberately NOT buildScopeFixture: these cases need a
// grant whose PARENT is a directory the test owns and can make read-only,
// which is what turns "the call failed" into "the file creation was
// attempted in the parent" (see the read-only-parent test below). Layout:
//
//   <tmp>/parent/          <- outside the grant, watched and chmod'd
//   <tmp>/parent/grant/    <- the only allowed_dir, label d0
//   <tmp>/parent/grant/notes/note1.txt
// ---------------------------------------------------------------------------

/**
 * Build the issue #24 fixture and return `{ tmp, parent, grant }`.
 * `existing: false` leaves the grant root (and its parent) uncreated -- the
 * shape fs_mkdir's half of this bug needs, where `mkdirSync(root, {
 * recursive: true })` creates missing ANCESTORS of the root, outside it.
 */
function buildRootFixture(existing = true) {
  const tmp = mkTmpDir('fsmcp-root-');
  const parent = path.join(tmp, 'parent');
  const grant = path.join(parent, 'grant');
  if (existing) {
    fs.mkdirSync(path.join(grant, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(grant, 'notes', 'note1.txt'), 'a note\n');
    fs.writeFileSync(path.join(grant, 'a.txt'), 'inside a.txt\n');
    // A symlink that lives inside the grant and points back at the grant
    // root: perfectly in scope by every check in this file, and still a
    // path that RESOLVES to the root, which is the only thing the refusal
    // is allowed to key off.
    fs.symlinkSync(grant, path.join(grant, 'self'));
  }
  return { tmp, parent, grant };
}

/**
 * Everything in `parent` that is not the grant itself. Empty is the only
 * acceptable answer after a refused call: the grant's parent belongs to
 * nobody this server is allowed to write for.
 *
 * A post-hoc check like this is necessary but NOT sufficient as evidence,
 * and this file should not be read as claiming otherwise --
 * `writeFileAtomic`'s best-effort `unlinkSync` removes the stray temp file
 * on its way out, so on the broken build this assertion usually passes
 * anyway and the breach is invisible to it. The read-only-parent test is
 * the one that proves where the write was aimed.
 */
function strayInParent(parent) {
  return fs.readdirSync(parent).filter((e) => e !== 'grant');
}

// The spellings that reach the same root. Only the first of them looks like
// a root, which is the whole reason the refusal must be made on the RESOLVED
// path rather than by comparing the argument against the label: the issue
// confirms `/d0/notes/..` reaches it too, and `/d0/self` (a symlink inside
// the grant pointing at the grant) reaches it without containing a single
// suspicious character.
const ROOT_SPELLINGS = ['/d0', '/d0/', '/d0/.', '/d0/notes/..', '/d0/self'];

test('issue #24: every write-side tool refuses a target that resolves to the grant root, in every spelling', async (t) => {
  const fx = buildRootFixture();
  t.after(() => fs.rmSync(fx.tmp, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', fx.grant]);
  t.after(() => server.close());

  // Asserted on every case below, not just once: the refusal has to be the
  // sandbox's own, with the audit flag relay reads, and it has to leave the
  // parent directory alone.
  function assertRefused(r, where) {
    assert.equal(r.isError, true, `${where}: expected a refusal, got ${allText(r)}`);
    assert.match(allText(r), /allowed_dir root/i, where);
    assert.equal(
      r._meta && r._meta.scope_violation,
      true,
      `${where}: a refusal that stops a write outside the grant must carry _meta.scope_violation, ` +
        `or relay's audit records it as an ordinary tool_error and the operator never sees the boundary hold`
    );
    // The errno the broken build produced from three stack frames down.
    // Named explicitly so a future change that goes back to letting the
    // syscall answer fails here rather than passing on the message match.
    assert.doesNotMatch(allText(r), /EISDIR|EACCES|ENOTEMPTY|illegal operation/i, where);
    assert.deepEqual(strayInParent(fx.parent), [], `${where}: nothing may be created outside the grant`);
    assert.ok(fs.statSync(fx.grant).isDirectory(), `${where}: the grant root must survive`);
  }

  for (const spelling of ROOT_SPELLINGS) {
    await t.test(`fs_write ${spelling}`, async () => {
      const r = await server.callTool('fs_write', { file_path: spelling, content: 'HELLO-OUTSIDE' });
      assertRefused(r, `fs_write ${spelling}`);
    });

    await t.test(`fs_edit ${spelling}`, async () => {
      const r = await server.callTool('fs_edit', {
        file_path: spelling,
        old_string: 'a',
        new_string: 'b',
      });
      assertRefused(r, `fs_edit ${spelling}`);
    });

    await t.test(`fs_mkdir ${spelling}`, async () => {
      const r = await server.callTool('fs_mkdir', { path: spelling });
      assertRefused(r, `fs_mkdir ${spelling}`);
    });

    await t.test(`fs_move onto ${spelling}`, async () => {
      const r = await server.callTool('fs_move', { source: '/d0/a.txt', destination: spelling });
      assertRefused(r, `fs_move -> ${spelling}`);
      assert.ok(fs.existsSync(path.join(fx.grant, 'a.txt')), 'the refused move must not have touched the source');
    });

    await t.test(`fs_move onto ${spelling} with overwrite: true`, async () => {
      const r = await server.callTool('fs_move', {
        source: '/d0/a.txt',
        destination: spelling,
        overwrite: true,
      });
      assertRefused(r, `fs_move (overwrite) -> ${spelling}`);
      assert.ok(fs.existsSync(path.join(fx.grant, 'a.txt')), 'the refused move must not have touched the source');
      assert.ok(
        fs.existsSync(path.join(fx.grant, 'notes', 'note1.txt')),
        'everything under the root must have survived, not just the root entry itself'
      );
    });
  }

  // fs_delete's half of the same rule, asserted here alongside the write
  // half so the two are read together: same words in the message, and
  // deliberately NOT a scope violation, because deleting the root would
  // have removed something INSIDE the grant. That difference is the whole
  // reason security.ts has two functions and not one.
  await t.test('fs_delete at the root is refused with the same words, but is not a scope violation', async () => {
    const r = await server.callTool('fs_delete', { path: '/d0', recursive: true });
    assert.equal(r.isError, true);
    assert.match(allText(r), /allowed_dir root/i);
    assert.ok(
      !r._meta || r._meta.scope_violation !== true,
      'refusing to delete the root keeps everything inside the grant, so it is a tool error, not a scope refusal'
    );
    assert.ok(fs.statSync(fx.grant).isDirectory());
  });
});

// The read-only-parent test from issue #24, and the one piece of evidence
// that distinguishes "the call failed" from "the file was created outside
// the grant and then cleaned up". On the broken build, with the parent at
// 0555, the failure MOVES from the rename to the open --
//
//   EACCES: permission denied, open '[fsmcp: path outside the granted
//   directories -- redacted]'
//
// -- which can only happen if the open was aimed at the parent, since the
// grant itself is still perfectly writable (case C below proves that in the
// same server, in the same state). The post-hoc readdir check in the test
// above cannot see this at all: writeFileAtomic's catch unlinks the stray
// temp file on the way out, so the artifact is transient in the happy path.
// A transient breach is still a breach -- the cleanup does not run if the
// process is killed, and the size is caller-chosen up to MAX_WRITE_BYTES --
// but it is why this test, not that one, is the proof.
test('issue #24: with the grant\'s parent read-only, a root-addressed write is refused by the sandbox, never attempted in the parent', async (t) => {
  const fx = buildRootFixture();
  // chmod back before the cleanup below, or rmSync cannot remove `grant`
  // from inside a 0555 `parent`.
  t.after(() => {
    fs.chmodSync(fx.parent, 0o755);
    fs.rmSync(fx.tmp, { recursive: true, force: true });
  });
  const server = spawnServer(['--allowed-dir', fx.grant]);
  t.after(() => server.close());

  fs.chmodSync(fx.parent, 0o555);

  // B -- the isolating case. A refusal mentioning EACCES/open here means
  // the write was aimed at the parent directory.
  const atRoot = await server.callTool('fs_write', { file_path: '/d0', content: 'HELLO-OUTSIDE' });
  assert.equal(atRoot.isError, true);
  assert.doesNotMatch(
    allText(atRoot),
    /EACCES|permission denied|EISDIR/i,
    'an errno from the parent directory means the write was attempted OUTSIDE the grant'
  );
  assert.match(allText(atRoot), /allowed_dir root/i);
  assert.equal(atRoot._meta && atRoot._meta.scope_violation, true);

  // C -- the control from the issue, in the same read-only-parent state:
  // the parent's permissions are irrelevant to an ordinary write inside the
  // grant, and must stay irrelevant. This is the assertion that a fix which
  // over-refuses (say, one that also refused anything whose parent is not
  // writable) would fail.
  const inside = await server.callTool('fs_write', { file_path: '/d0/newfile.txt', content: 'HELLO-OUTSIDE' });
  assert.equal(inside.isError, undefined, allText(inside));
  assert.equal(fs.readFileSync(path.join(fx.grant, 'newfile.txt'), 'utf-8'), 'HELLO-OUTSIDE');

  // And the same control for the other three write-side tools, so "the
  // legitimate case still works" is pinned for each of them and not just
  // for fs_write.
  const edited = await server.callTool('fs_edit', {
    file_path: '/d0/newfile.txt',
    old_string: 'HELLO-OUTSIDE',
    new_string: 'HELLO-INSIDE',
  });
  assert.equal(edited.isError, undefined, allText(edited));
  assert.equal(fs.readFileSync(path.join(fx.grant, 'newfile.txt'), 'utf-8'), 'HELLO-INSIDE');

  const made = await server.callTool('fs_mkdir', { path: '/d0/sub' });
  assert.equal(made.isError, undefined, allText(made));
  assert.ok(fs.statSync(path.join(fx.grant, 'sub')).isDirectory());

  const moved = await server.callTool('fs_move', { source: '/d0/newfile.txt', destination: '/d0/sub/moved.txt' });
  assert.equal(moved.isError, undefined, allText(moved));
  assert.equal(fs.readFileSync(path.join(fx.grant, 'sub', 'moved.txt'), 'utf-8'), 'HELLO-INSIDE');

  assert.deepEqual(strayInParent(fx.parent), [], 'nothing may be created outside the grant by any of the above');
});

// fs_mkdir's half of issue #24, which leaves DURABLE evidence rather than a
// transient temp file: `fs.mkdirSync(dirPath, { recursive: true })` creates
// every missing ancestor of its argument, so against a grant whose root
// does not exist yet, `fs_mkdir { path: "/d0" }` created the grant's PARENT
// -- a directory outside allowed_dirs, which stays there -- and answered
// "Created directory: /d0" as though nothing else had happened. Nothing
// cleans this one up, so the assertion below is direct evidence, not a
// proxy for it.
test('issue #24: fs_mkdir at a grant root that does not exist yet does not create the grant\'s parent', async (t) => {
  const fx = buildRootFixture(false);
  t.after(() => fs.rmSync(fx.tmp, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', fx.grant]);
  t.after(() => server.close());

  assert.equal(fs.existsSync(fx.parent), false, 'sanity: neither the grant nor its parent exists yet');

  const r = await server.callTool('fs_mkdir', { path: '/d0' });

  assert.equal(r.isError, true, `expected a refusal, got ${allText(r)}`);
  assert.match(allText(r), /allowed_dir root/i);
  assert.equal(r._meta && r._meta.scope_violation, true);
  assert.equal(
    fs.existsSync(fx.parent),
    false,
    "fs_mkdir must not create the grant's parent -- that is a directory outside allowed_dirs"
  );

  // This assertion used to read "the legitimate case in the same shape
  // still works": `fs_mkdir { path: "/d0/sub" }` against this same
  // not-yet-created grant succeeded, and #24 recorded that as correct on
  // the grounds that creating the missing root on the way to a path INSIDE
  // it is not what the root rule refuses. It was not correct -- it is issue
  // #33. `mkdirSync(..., { recursive: true })` walks up until it finds a
  // directory that exists, so the call that "worked" created `parent` too,
  // outside the grant, exactly like the refused `/d0` call above; the only
  // difference was that nothing refused it. The behaviour now expected here
  // is refusal, and the reason it is refused is the grant, not the
  // argument. Full coverage lives in tests/missing-grant-root.test.js; kept
  // here so the two halves of the same defect are read together.
  const sub = await server.callTool('fs_mkdir', { path: '/d0/sub' });
  assert.equal(sub.isError, true, allText(sub));
  assert.match(allText(sub), /granted directory .* does not exist on the host/i);
  assert.ok(
    !sub._meta || sub._meta.scope_violation !== true,
    'a grant that points at nothing is an operator configuration error, not the client addressing something out of scope'
  );
  assert.equal(
    fs.existsSync(fx.parent),
    false,
    "a path INSIDE a grant whose root is missing must not create the grant's ancestors either"
  );
});
