'use strict';

/**
 * Issue #23 -- `fs_move` destroyed data in two different ways, and both of
 * them came out of the same line: `overwrite: true` was
 * `rmSync(destination)` followed by `renameSync(source, destination)`.
 * Deleting before knowing what is being deleted.
 *
 *   Defect 1 (critical): when `source` and `destination` are the SAME entry,
 *   the unlink takes the source's own data with it and the rename then fails
 *   ENOENT with nothing left to move. The everyday trigger is a case-only
 *   rename -- macOS ships APFS case-INSENSITIVE, so `meeting.md` and
 *   `Meeting.md` are one directory entry -- and fsMCP walked the caller into
 *   it: the first attempt refused with "pass overwrite: true to replace it",
 *   and obeying that sentence destroyed the file. Also reachable by a
 *   literal self-move, by a `.`-component alias of the same path, and --
 *   recursively -- when both names are the same DIRECTORY.
 *
 *   Defect 2 (high): `overwrite: true` onto a directory destination was an
 *   unbounded recursive delete. `mv file dir/` is the POSIX idiom every
 *   agent knows; fs_move read it as "replace that directory", erased the
 *   tree, and reported success (relay's audit logged `ok`).
 *
 * Every case below is proven at the wire against a real `dist/main.js`
 * (helpers.js's spawnServer), the same interface relay drives, and every
 * assertion checks the FILESYSTEM -- bytes, inodes, readdir -- not just the
 * reply text. A tool that says "move failed" while the file is gone is
 * exactly the failure mode this issue is about, so the reply string is never
 * the evidence on its own.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnServer, toVirtual } = require('./helpers');

function mkTmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function allText(result) {
  return result.content.map((c) => c.text).join('\n');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Does `dir` live on a case-INSENSITIVE filesystem?
 *
 * This matters more than it looks. The everyday trigger for defect 1 is
 * case-insensitivity, and on a case-SENSITIVE volume `meeting.md` ->
 * `Meeting.md` is just an ordinary rename to a destination that does not
 * exist: the buggy code never reaches its `rmSync` at all and the test
 * passes for a reason that has nothing to do with the bug. A green tick
 * earned that way is worse than no test, so the case-dependent cases below
 * detect this and SKIP loudly (with a message on the test and a line on
 * stderr) rather than claim a pass they did not earn.
 *
 * Asked the same way the fix itself asks it -- `{dev, ino}` from `lstat`,
 * the filesystem's own answer -- rather than by trusting `process.platform`
 * or `diskutil`: a macOS host can perfectly well have a case-sensitive APFS
 * volume mounted, and `os.tmpdir()` can be on it.
 */
function isCaseInsensitive(dir) {
  const lower = path.join(dir, 'fsmcp-case-probe');
  const upper = path.join(dir, 'FSMCP-CASE-PROBE');
  fs.writeFileSync(lower, 'probe');
  try {
    const a = fs.lstatSync(lower);
    let b;
    try {
      b = fs.lstatSync(upper);
    } catch {
      return false;
    }
    return a.dev === b.dev && a.ino === b.ino;
  } finally {
    fs.rmSync(lower, { force: true });
  }
}

function skipUnlessCaseInsensitive(t, dir) {
  if (isCaseInsensitive(dir)) return false;
  const why =
    `${dir} is on a case-SENSITIVE filesystem, so this case-only-rename case cannot ` +
    `exercise issue #23 here -- it would pass without the fix. Not counted as a pass.`;
  process.stderr.write(`\n[issue #23] SKIPPED: ${why}\n`);
  t.skip(why);
  return true;
}

/** A fixture root with nothing in it but what the calling test puts there. */
function newRoot(t, prefix) {
  const dir = mkTmpDir(prefix);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CONTENT = 'IRREPLACEABLE CONTENT\n';

// ---------------------------------------------------------------------------
// Defect 1: same entry, two names.
// ---------------------------------------------------------------------------

// The headline case, and the one the issue opens with. Note that this call
// passes NO `overwrite`: a case-only rename is a rename, not a replacement,
// and it must simply work. On main this is the refusal that reads "pass
// overwrite: true to replace it" -- the sentence that talks the caller into
// destroying the file.
test('a case-only rename works, with no overwrite flag and no data loss', async (t) => {
  const root = newRoot(t, 'fsmcp-i23-case-');
  if (skipUnlessCaseInsensitive(t, root)) return;

  const before = path.join(root, 'meeting.md');
  fs.writeFileSync(before, CONTENT);
  const digest = sha256(before);

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const r = await server.callTool('fs_move', {
    source: toVirtual(before, root),
    destination: toVirtual(path.join(root, 'Meeting.md'), root),
  });

  assert.notEqual(r.isError, true, `case-only rename must succeed, got: ${allText(r)}`);
  // readdir, not existsSync: on a case-insensitive volume existsSync answers
  // yes for either spelling, so only the directory's own listing can say
  // which name the entry actually carries now.
  assert.deepEqual(fs.readdirSync(root), ['Meeting.md']);
  assert.equal(sha256(path.join(root, 'Meeting.md')), digest, 'the bytes must be the original bytes');
});

// The exact repro from the issue: the caller obeyed the tool's own
// instruction and passed overwrite: true. On main the file is gone -- both
// spellings, no copy anywhere -- and the reply says "move failed: ENOENT",
// which reads to an operator as "nothing happened".
test('a case-only rename with overwrite:true does not destroy the file', async (t) => {
  const root = newRoot(t, 'fsmcp-i23-case-ow-');
  if (skipUnlessCaseInsensitive(t, root)) return;

  const before = path.join(root, 'meeting.md');
  fs.writeFileSync(before, CONTENT);
  const digest = sha256(before);

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const r = await server.callTool('fs_move', {
    source: toVirtual(before, root),
    destination: toVirtual(path.join(root, 'Meeting.md'), root),
    overwrite: true,
  });

  assert.notEqual(r.isError, true, `case-only rename must succeed, got: ${allText(r)}`);
  assert.deepEqual(fs.readdirSync(root), ['Meeting.md']);
  assert.equal(sha256(path.join(root, 'Meeting.md')), digest);
});

// Same entry, same name, spelled identically. rename(2) would succeed and do
// nothing; what must never happen is the unlink. On main the file is
// deleted and the call reports ENOENT.
test('a literal self-move with overwrite:true does not destroy the file', async (t) => {
  const root = newRoot(t, 'fsmcp-i23-self-');
  const file = path.join(root, 'self.txt');
  fs.writeFileSync(file, CONTENT);
  const digest = sha256(file);

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const address = toVirtual(file, root);
  const r = await server.callTool('fs_move', { source: address, destination: address, overwrite: true });

  assert.notEqual(r.isError, true, `a self-move must not be an error, got: ${allText(r)}`);
  assert.match(allText(r), /nothing to move/i, 'and it must say nothing moved, rather than claim a move');
  assert.equal(sha256(file), digest, 'the file must be byte-identical');
});

// Same entry, reached through a `.` component -- the shape no lexical
// string comparison of the two arguments would catch, and one of the three
// cases a single {dev, ino} check gets right at once.
test('a "."-component alias of the same path with overwrite:true does not destroy the file', async (t) => {
  const root = newRoot(t, 'fsmcp-i23-dot-');
  fs.mkdirSync(path.join(root, 'notes'));
  const file = path.join(root, 'notes', 'alias.txt');
  fs.writeFileSync(file, CONTENT);
  const digest = sha256(file);

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const r = await server.callTool('fs_move', {
    source: toVirtual(file, root),
    destination: `${toVirtual(path.join(root, 'notes'), root)}/./alias.txt`,
    overwrite: true,
  });

  assert.notEqual(r.isError, true, `a "."-alias self-move must not be an error, got: ${allText(r)}`);
  assert.equal(sha256(file), digest, 'the file must be byte-identical');
});

// The recursive form of defect 1: both names are the same DIRECTORY, so the
// unlink on main is `rmSync(recursive: true)` on the source's own tree.
test('a directory moved onto itself with overwrite:true does not destroy the tree', async (t) => {
  const root = newRoot(t, 'fsmcp-i23-selfdir-');
  const tree = path.join(root, 'tree');
  fs.mkdirSync(path.join(tree, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'one.txt'), 'one\n');
  fs.writeFileSync(path.join(tree, 'nested', 'two.txt'), 'two\n');

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const address = toVirtual(tree, root);
  const r = await server.callTool('fs_move', { source: address, destination: address, overwrite: true });

  assert.notEqual(r.isError, true, `a directory self-move must not be an error, got: ${allText(r)}`);
  assert.equal(fs.readFileSync(path.join(tree, 'one.txt'), 'utf-8'), 'one\n');
  assert.equal(fs.readFileSync(path.join(tree, 'nested', 'two.txt'), 'utf-8'), 'two\n');
});

// A case-only rename of a directory: the same {dev, ino} answer, applied to
// a tree rather than a file. It must rename, not delete-then-fail.
test('a case-only rename of a directory keeps its contents', async (t) => {
  const root = newRoot(t, 'fsmcp-i23-casedir-');
  if (skipUnlessCaseInsensitive(t, root)) return;

  const lower = path.join(root, 'notes');
  fs.mkdirSync(lower);
  fs.writeFileSync(path.join(lower, 'one.txt'), 'one\n');

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const r = await server.callTool('fs_move', {
    source: toVirtual(lower, root),
    destination: toVirtual(path.join(root, 'Notes'), root),
    overwrite: true,
  });

  assert.notEqual(r.isError, true, `case-only directory rename must succeed, got: ${allText(r)}`);
  assert.deepEqual(fs.readdirSync(root), ['Notes']);
  assert.equal(fs.readFileSync(path.join(root, 'Notes', 'one.txt'), 'utf-8'), 'one\n');
});

// ---------------------------------------------------------------------------
// Defect 2: a directory destination is not a thing to delete.
// ---------------------------------------------------------------------------

function buildMv2(root) {
  const projects = path.join(root, 'projects');
  fs.mkdirSync(path.join(projects, 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(projects, 'beta'), { recursive: true });
  fs.writeFileSync(path.join(root, 'todo.txt'), 'todo\n');
  fs.writeFileSync(path.join(projects, 'top.txt'), 'top\n');
  fs.writeFileSync(path.join(projects, 'alpha', 'one.txt'), 'one\n');
  fs.writeFileSync(path.join(projects, 'beta', 'two.txt'), 'two\n');
  return projects;
}

function assertMv2Intact(root) {
  const projects = path.join(root, 'projects');
  assert.ok(fs.statSync(projects).isDirectory(), 'projects/ must still be a directory');
  assert.equal(fs.readFileSync(path.join(projects, 'top.txt'), 'utf-8'), 'top\n');
  assert.equal(fs.readFileSync(path.join(projects, 'alpha', 'one.txt'), 'utf-8'), 'one\n');
  assert.equal(fs.readFileSync(path.join(projects, 'beta', 'two.txt'), 'utf-8'), 'two\n');
  assert.equal(fs.readFileSync(path.join(root, 'todo.txt'), 'utf-8'), 'todo\n', 'and the source is untouched too');
}

// The POSIX idiom, spelled the way the issue spells it. On main this
// returned "Moved /d0/mv2/todo.txt to /d0/mv2/projects" and relay's audit
// logged `ok` -- for a call that had just recursively deleted a five-file
// tree.
test('overwrite:true onto a directory destination is refused, not a recursive delete', async (t) => {
  const root = newRoot(t, 'fsmcp-i23-dirdest-');
  buildMv2(root);

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const r = await server.callTool('fs_move', {
    source: toVirtual(path.join(root, 'todo.txt'), root),
    destination: toVirtual(path.join(root, 'projects'), root),
    overwrite: true,
  });

  assert.equal(r.isError, true, `must be refused, got: ${allText(r)}`);
  assert.match(allText(r), /existing directory/i);
  // The refusal has to name the call the caller meant, or it is just a wall.
  assert.match(allText(r), /\/d0\/projects\/todo\.txt/, 'the refusal must name the full destination path');
  assertMv2Intact(root);
});

// The same call WITHOUT overwrite. On main the refusal here is "destination
// already exists (pass overwrite: true to replace it)" -- an instruction to
// run the call above, which destroyed the tree. The refusal must not point
// at a flag that will not (and must not) do what it says.
test('a directory destination is refused without pointing the caller at overwrite:true', async (t) => {
  const root = newRoot(t, 'fsmcp-i23-dirdest-noflag-');
  buildMv2(root);

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const r = await server.callTool('fs_move', {
    source: toVirtual(path.join(root, 'todo.txt'), root),
    destination: toVirtual(path.join(root, 'projects'), root),
  });

  assert.equal(r.isError, true);
  assert.doesNotMatch(
    allText(r),
    /pass overwrite: true/i,
    'the refusal must not instruct the caller into the call that used to destroy the tree'
  );
  assert.match(allText(r), /\/d0\/projects\/todo\.txt/, 'it must name the correct call instead');
  assertMv2Intact(root);
});

// A directory source onto a non-empty directory destination is the same
// destruction with both endpoints swapped in type: still refused, and the
// count of what would have been destroyed is named.
test('a directory onto a non-empty directory is refused with the entry count named', async (t) => {
  const root = newRoot(t, 'fsmcp-i23-dirdir-');
  buildMv2(root);
  const src = path.join(root, 'archive');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'kept.txt'), 'kept\n');

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const r = await server.callTool('fs_move', {
    source: toVirtual(src, root),
    destination: toVirtual(path.join(root, 'projects'), root),
    overwrite: true,
  });

  assert.equal(r.isError, true, `must be refused, got: ${allText(r)}`);
  assert.match(allText(r), /3 entries/, 'the refusal must say how much it declined to destroy');
  assertMv2Intact(root);
  assert.equal(fs.readFileSync(path.join(src, 'kept.txt'), 'utf-8'), 'kept\n');
});

// ---------------------------------------------------------------------------
// The ordinary paths still work -- a fix that just refuses more is not a fix.
// ---------------------------------------------------------------------------

test('overwrite:true still replaces an existing FILE at the destination', async (t) => {
  const root = newRoot(t, 'fsmcp-i23-ok-file-');
  fs.writeFileSync(path.join(root, 'from.txt'), 'new\n');
  fs.writeFileSync(path.join(root, 'to.txt'), 'old\n');

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const r = await server.callTool('fs_move', {
    source: toVirtual(path.join(root, 'from.txt'), root),
    destination: toVirtual(path.join(root, 'to.txt'), root),
    overwrite: true,
  });

  assert.notEqual(r.isError, true, allText(r));
  assert.equal(fs.readFileSync(path.join(root, 'to.txt'), 'utf-8'), 'new\n');
  assert.equal(fs.existsSync(path.join(root, 'from.txt')), false);
});

test('naming the full destination path moves the file INTO the directory', async (t) => {
  const root = newRoot(t, 'fsmcp-i23-into-');
  buildMv2(root);

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const r = await server.callTool('fs_move', {
    source: toVirtual(path.join(root, 'todo.txt'), root),
    destination: toVirtual(path.join(root, 'projects', 'todo.txt'), root),
  });

  assert.notEqual(r.isError, true, allText(r));
  assert.equal(fs.readFileSync(path.join(root, 'projects', 'todo.txt'), 'utf-8'), 'todo\n');
  assert.equal(fs.existsSync(path.join(root, 'todo.txt')), false);
  // and nothing else in the tree moved
  assert.equal(fs.readFileSync(path.join(root, 'projects', 'alpha', 'one.txt'), 'utf-8'), 'one\n');
});

// ---------------------------------------------------------------------------
// The structural guarantee, pinned at the source level.
// ---------------------------------------------------------------------------

/**
 * Both defects were the same syscall in the same place. The behavioural
 * tests above pin the cases the issue found; this pins the property that
 * makes the whole class impossible: `fs_move` does not remove anything.
 * rename(2) replaces an existing file atomically on its own and refuses
 * (ENOTEMPTY) to replace a directory with contents, so as long as there is
 * no unlink in this file, no fs_move call can destroy more than the single
 * entry the caller named -- which is also why fs_delete's 10,000-entry cap
 * has no counterpart here: there is no recursive delete to count.
 *
 * Read from the source tree rather than inferred from behaviour, the same
 * way tests/no-link-primitive.test.js pins the absence of symlink/hard-link
 * primitives: a future edit that "just needs to clear the destination
 * first" is exactly what this is here to catch, and it would pass every
 * behavioural test above right up until it did not.
 */
test('fs_move makes no removal syscall at all', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'tools', 'move.ts'), 'utf-8');
  // Strip block and line comments: this file TALKS about rmSync at length,
  // deliberately, and the point is that it never calls one.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['rmSync', 'unlinkSync', 'rmdirSync', 'rm(', 'unlink(']) {
    assert.equal(
      code.includes(forbidden),
      false,
      `src/tools/move.ts must not call ${forbidden}: fs_move deletes nothing (issue #23)`
    );
  }
  assert.equal(code.includes('renameSync'), true, 'sanity: fs_move must still be a rename');
});

// ---------------------------------------------------------------------------
// The third data-loss case in the same line, which the issue did not name.
// ---------------------------------------------------------------------------

/**
 * `rmSync(destination)` then `renameSync(...)` also destroyed the
 * destination whenever the RENAME failed -- the unlink had already
 * committed, and there was nothing to put in the hole it left. Found while
 * fixing the two defects in the issue, and proven live across two real
 * volumes: a cross-device `overwrite: true` (a grant can legitimately span
 * two filesystems; `rename(2)` cannot) reported "move failed: EXDEV" while
 * the destination file it had deleted was simply gone. Same audit shape as
 * defect 1 -- `tool_error`, reading as "nothing happened", for a call that
 * destroyed a file.
 *
 * Reproduced here on ONE volume, so this test needs no second filesystem:
 * a source whose parent directory is not writable cannot be unlinked from
 * it, so `rename(2)` fails EACCES at exactly the same point EXDEV does.
 * What is being pinned is not the errno, it is the invariant -- a move that
 * fails leaves BOTH endpoints exactly as they were -- which `rename(2)`
 * alone gives for free and which no delete-then-rename can give at all.
 */
test('a move that fails leaves the destination intact', async (t) => {
  // Not newRoot(): the cleanup has to make `locked` writable again BEFORE
  // the tree is removed, so it is one hook rather than two whose order
  // would matter.
  const root = mkTmpDir('fsmcp-i23-atomic-');
  const locked = path.join(root, 'locked');
  t.after(() => {
    fs.chmodSync(locked, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'src.txt'), 'source\n');
  fs.writeFileSync(path.join(root, 'dest.txt'), 'DESTINATION MUST SURVIVE\n');
  fs.chmodSync(locked, 0o500);

  // Root ignores the mode bits, and so would any host where this somehow
  // stays writable: say so and skip rather than assert something this run
  // cannot actually test.
  let writable = false;
  try {
    fs.writeFileSync(path.join(locked, 'probe'), 'x');
    fs.rmSync(path.join(locked, 'probe'), { force: true });
    writable = true;
  } catch {
    writable = false;
  }
  if (writable) {
    const why = 'a 0500 directory is still writable here (running as root?), so rename cannot be made to fail';
    process.stderr.write(`\n[issue #23] SKIPPED: ${why}\n`);
    t.skip(why);
    return;
  }

  const server = spawnServer(['--allowed-dir', root]);
  t.after(() => server.close());

  const r = await server.callTool('fs_move', {
    source: toVirtual(path.join(locked, 'src.txt'), root),
    destination: toVirtual(path.join(root, 'dest.txt'), root),
    overwrite: true,
  });

  assert.equal(r.isError, true, 'the move must fail -- the source cannot be unlinked from its parent');
  assert.equal(
    fs.readFileSync(path.join(root, 'dest.txt'), 'utf-8'),
    'DESTINATION MUST SURVIVE\n',
    'a failed move must not have deleted the destination on its way to failing'
  );
  assert.equal(fs.readFileSync(path.join(locked, 'src.txt'), 'utf-8'), 'source\n', 'and the source is untouched');
});
