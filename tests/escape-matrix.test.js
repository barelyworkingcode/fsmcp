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

const { spawnServer, buildScopeFixture, removeFixture, OUTSIDE_CANARY } = require('./helpers');

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
    const r = await server.callTool('fs_read', { file_path: path.join(fx.root, 'a.txt') });
    assert.equal(r.isError, undefined, allText(r));
    assert.match(allText(r), /inside a\.txt/);
  });

  const created = path.join(fx.root, 'lifecycle.txt');
  await t.test('fs_write', async () => {
    const r = await server.callTool('fs_write', { file_path: created, content: 'hello' });
    assert.equal(r.isError, undefined, allText(r));
    assert.equal(fs.readFileSync(created, 'utf-8'), 'hello');
  });

  await t.test('fs_edit', async () => {
    const r = await server.callTool('fs_edit', {
      file_path: created,
      old_string: 'hello',
      new_string: 'world',
    });
    assert.equal(r.isError, undefined, allText(r));
    assert.equal(fs.readFileSync(created, 'utf-8'), 'world');
  });

  const newDir = path.join(fx.root, 'lifecycle-dir');
  await t.test('fs_mkdir', async () => {
    const r = await server.callTool('fs_mkdir', { path: newDir });
    assert.equal(r.isError, undefined, allText(r));
    assert.ok(fs.statSync(newDir).isDirectory());
  });

  const moved = path.join(newDir, 'lifecycle.txt');
  await t.test('fs_move', async () => {
    const r = await server.callTool('fs_move', { source: created, destination: moved });
    assert.equal(r.isError, undefined, allText(r));
    assert.equal(fs.existsSync(created), false);
    assert.equal(fs.readFileSync(moved, 'utf-8'), 'world');
  });

  await t.test('fs_delete', async () => {
    const r = await server.callTool('fs_delete', { path: moved });
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
    const r = await server.callTool('fs_read', { file_path: target }, meta);
    assert.equal(r.isError, true);
    assert.match(allText(r), /outside allowed directories/i);
  });

  await t.test('row 3: reading through a directory symlink out of scope is refused', async () => {
    const target = path.join(fx.root, 'link-out', 'passwd');
    const r = await server.callTool('fs_read', { file_path: target }, meta);
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
    const r = await server.callTool('fs_read', { file_path: target }, meta);
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
      assert.ok(
        line.startsWith(fx.root + path.sep) || line === fx.root,
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
    file_path: path.join(fx.root, 'link-out-file'),
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
    file_path: path.join(fx.root, 'dangling'),
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
    const r = await server.callTool('fs_delete', { path: fx.root, recursive: true });
    assert.equal(r.isError, true);
    assert.match(allText(r), /allowed_dir root/i);
    assert.ok(fs.statSync(fx.root).isDirectory(), 'the sandbox root must survive its occupant');
  });

  await t.test('row 11: deleting a non-empty directory without recursive is refused', async () => {
    const notes = path.join(fx.root, 'notes');
    const r = await server.callTool('fs_delete', { path: notes });
    assert.equal(r.isError, true);
    assert.match(allText(r), /not empty/i);
    assert.equal(fs.existsSync(path.join(notes, 'note1.txt')), true, 'nothing should have been removed');
  });

  await t.test('row 12: deleting a symlink removes the link, and the /etc stand-in is intact', async () => {
    const link = path.join(fx.root, 'link-out');
    const passwdBefore = fs.readFileSync(path.join(fx.fakeEtc, 'passwd'));

    const r = await server.callTool('fs_delete', { path: link });
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

    const r = await server.callTool('fs_move', { source, destination: dest });
    assert.equal(r.isError, true);
    assert.match(allText(r), /outside allowed directories/i);
    assert.equal(fs.existsSync(dest), false);
    assert.ok(before.equals(fs.readFileSync(source)), 'the source must be untouched');
  });

  await t.test('out -> in is refused, and nothing new appears inside', async () => {
    const source = path.join(fx.outside, 'secret.txt');
    const before = fs.readFileSync(source);
    const dest = path.join(fx.root, 'moved-in.txt');

    const r = await server.callTool('fs_move', { source, destination: dest });
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
  const controlRead = await server.callTool('fs_read', { file_path: path.join(fx.root, 'a.txt') });
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

  const refusal = await server.callTool('fs_read', { file_path: path.join(fx.outside, 'secret.txt') });
  assert.equal(refusal.isError, true);
  assert.equal(refusal._meta && refusal._meta.scope_violation, true, 'a scope refusal must set _meta.scope_violation');

  const miss = await server.callTool('fs_read', { file_path: path.join(fx.root, 'does-not-exist.txt') });
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
      const meta = { allowed_dirs: [path.join(fx.root, 'notes')] };
      const outsideNarrowedScope = await server.callTool('fs_read', { file_path: inside }, meta);
      assert.equal(
        outsideNarrowedScope.isError,
        true,
        'a.txt sits inside the CLI grant but outside the _meta-narrowed one, and must refuse'
      );
      const insideNarrowedScope = await server.callTool('fs_read', { file_path: notesFile }, meta);
      assert.equal(insideNarrowedScope.isError, undefined, allText(insideNarrowedScope));
    } finally {
      server.close();
    }
  });

  await t.test('CLI set, _meta absent: effective scope is the CLI grant, unchanged', async () => {
    const server = spawnServer(['--allowed-dir', fx.root]);
    try {
      const r = await server.callTool('fs_read', { file_path: inside } /* no _meta arg at all */);
      assert.equal(r.isError, undefined, allText(r));
    } finally {
      server.close();
    }
  });

  await t.test('CLI absent, _meta set: effective scope is the _meta dirs (relay-mediated mode)', async () => {
    const server = spawnServer([]);
    try {
      const meta = { allowed_dirs: [fx.root] };
      const insideRead = await server.callTool('fs_read', { file_path: inside }, meta);
      assert.equal(insideRead.isError, undefined, allText(insideRead));
      const outsideRead = await server.callTool('fs_read', { file_path: path.join(fx.outside, 'secret.txt') }, meta);
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
      // all-or-nothing for the whole _meta.allowed_dirs array.
      const meta = { allowed_dirs: [path.join(fx.root, 'notes'), fx.outside] };
      const r = await server.callTool('fs_read', { file_path: notesFile }, meta);
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

  const r = await server.callTool('fs_delete', { path: path.join(fx.root, 'notes'), recursive: true });
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

  const r = await server.callTool('fs_move', { source, destination });
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
    source,
    destination: fx.root,
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
  const r = await server.callTool('fs_delete', { path: notes, recursive: 'false' });

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

  const r = await server.callTool('fs_move', { source, destination, overwrite: 'false' });

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

  const r = await server.callTool('fs_delete', { path: bigDir, recursive: true });
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

  const r = await server.callTool('fs_read', { file_path: path.join(root, 'real-etc', 'passwd') });
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
  const control = await server.callTool('fs_read', { file_path: path.join(fx.root, 'a.txt') });
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
    file_path: file,
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

  const r = await server.callTool('fs_read', { file_path: big });
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

  const r = await server.callTool('fs_write', { file_path: target, content: hugeContent });
  assert.equal(r.isError, true, 'content over the byte cap must be refused');
  assert.match(allText(r), /byte limit/i);
  assert.equal(fs.existsSync(target), false, 'nothing should have been written, not even a partial file');
});
