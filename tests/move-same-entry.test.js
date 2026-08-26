'use strict';

/**
 * Issue #39: `fs_move` on two names for ONE inode used to reply
 * `Moved a.txt to b.txt` and audit `ok` while nothing had moved.
 *
 * Everything about the mechanism is right and none of it changes here.
 * #23's same-entry detection is on `{dev, ino}` -- the filesystem's own
 * answer, and the only one that knows APFS is case-insensitive -- a
 * hard-linked pair legitimately shares those, and `rename(2)` is specified
 * to "return successfully and perform no other action" for exactly that
 * case. `/bin/mv` behaves the same way. Nothing is destroyed, which is why
 * #23 routed it here deliberately.
 *
 * What was wrong is the sentence, and the audit row it produces. "Moved X to
 * Y" asserts something that did not happen, and an agent that believes it
 * has moved a file and then acts on that belief is the failure mode this
 * codebase keeps finding in new places (issue #21's empty success, #23's
 * `tool_error` for a destroyed file).
 *
 * THE CONSTRAINT that makes this awkward, and which these tests pin: fsMCP
 * cannot tell a hard-linked pair from a case-insensitive alias from `lstat`
 * alone. `nlink` is not a discriminator -- it is 2+ for a hard-linked pair
 * and also for a case alias of a file with a hard link anywhere else, and it
 * says nothing about whether the other link is the destination this call
 * named. For the case alias the rename genuinely happened; for the hard link
 * it genuinely did not. So the two calls must produce the SAME reply, that
 * reply must assert neither, and the test asserts they are identical modulo
 * the paths -- because a message that quietly differed would be claiming a
 * distinction the server cannot make.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnServer } = require('./helpers');

function allText(result) {
  return (result.content || []).map((c) => c.text).join('\n');
}

function mkRoot(t, prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('fs_move on a hard-linked pair does not claim a move, and destroys nothing', async (t) => {
  const root = mkRoot(t, 'fsmcp-hardlink-');
  fs.writeFileSync(path.join(root, 'a.txt'), 'payload\n');
  fs.linkSync(path.join(root, 'a.txt'), path.join(root, 'b.txt'));

  const server = spawnServer([]);
  t.after(() => server.close());

  const result = await server.callTool(
    'fs_move',
    { source: '/d0/a.txt', destination: '/d0/b.txt' },
    { allowed_dirs: [root] }
  );

  // A SUCCESS, deliberately: the requested end state holds, nothing failed,
  // and turning a legitimate no-op into an error would be one more audit
  // line reading as a failure when the truth is "already so" -- the same
  // argument the literal self-move branch already makes.
  assert.equal(result.isError, undefined, allText(result));
  const text = allText(result);

  // The whole point of the issue: the reply must not assert a move.
  assert.doesNotMatch(text, /^Moved /, text);
  assert.doesNotMatch(text, /\bMoved\b/, text);

  // It must name the situation and BOTH readings of it, since it cannot
  // tell them apart.
  assert.match(text, /same file/i, text);
  assert.match(text, /hard link/i, text);
  assert.match(text, /case/i, text);
  assert.match(text, /cannot tell/i, text);

  // ...and it must not assert the other side either. "nothing was moved" is
  // as wrong for a case alias as "Moved" is for a hard link.
  assert.doesNotMatch(text, /nothing was moved/i, text);

  // Virtual paths only, never the host path.
  assert.ok(text.includes('/d0/a.txt') && text.includes('/d0/b.txt'), text);
  assert.ok(!text.includes(root), `the reply leaked the host path: ${text}`);

  // The filesystem is exactly as it was: rename(2) did nothing, and this
  // fix changes only the sentence.
  assert.deepEqual(fs.readdirSync(root).sort(), ['a.txt', 'b.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf-8'), 'payload\n');
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf-8'), 'payload\n');
});

test('a case-only rename gets the SAME reply, because fsMCP cannot tell the two apart', async (t) => {
  const root = mkRoot(t, 'fsmcp-casealias-');
  fs.writeFileSync(path.join(root, 'c.txt'), 'payload\n');

  const server = spawnServer([]);
  t.after(() => server.close());

  const result = await server.callTool(
    'fs_move',
    { source: '/d0/c.txt', destination: '/d0/C.txt' },
    { allowed_dirs: [root] }
  );
  assert.equal(result.isError, undefined, allText(result));
  const text = allText(result);

  // On a case-insensitive volume (macOS's default) the rename really did
  // happen: one entry, spelled the new way. That is the observation the
  // reply points the caller at, and it is the caller's to make -- not a
  // discriminator this server invented.
  if (fs.readdirSync(root).length === 1) {
    assert.deepEqual(fs.readdirSync(root), ['C.txt']);
    // Same wording as the hard-link case, path substitution aside. A reply
    // that differed here would be asserting a distinction `lstat` cannot
    // support.
    assert.match(text, /same file/i, text);
    assert.match(text, /hard link/i, text);
    assert.doesNotMatch(text, /\bMoved\b/, text);
    assert.ok(text.includes('/d0/c.txt') && text.includes('/d0/C.txt'), text);
  } else {
    // A case-SENSITIVE volume: these are two different entries and this is
    // an ordinary move, which needs no flag because the destination did not
    // exist. Asserted rather than skipped so the test says something on
    // either kind of filesystem.
    assert.deepEqual(fs.readdirSync(root).sort(), ['C.txt']);
    assert.match(text, /^Moved /, text);
  }
});

test('the same-entry branch still runs before the overwrite guard, deliberately', async (t) => {
  const root = mkRoot(t, 'fsmcp-hardlink-ow-');
  fs.writeFileSync(path.join(root, 'a.txt'), 'payload\n');
  fs.linkSync(path.join(root, 'a.txt'), path.join(root, 'b.txt'));

  const server = spawnServer([]);
  t.after(() => server.close());

  // The destination exists, and the call succeeds anyway with no
  // `overwrite: true`. That is the intended behaviour, not an oversight:
  // `overwrite` gates DESTRUCTION, and on this branch there is nothing to
  // destroy -- the destination IS the source, one inode with two names.
  // Demanding the flag would be asking permission to destroy a file when
  // the only file involved is the caller's own source, which is precisely
  // the sentence issue #23 removed after obeying it destroyed data.
  const result = await server.callTool(
    'fs_move',
    { source: '/d0/a.txt', destination: '/d0/b.txt' },
    { allowed_dirs: [root] }
  );
  assert.equal(result.isError, undefined, allText(result));
  assert.doesNotMatch(allText(result), /overwrite/i, allText(result));
  assert.deepEqual(fs.readdirSync(root).sort(), ['a.txt', 'b.txt']);
});

test('an ordinary move still says Moved, and a self-move still says nothing to move', async (t) => {
  const root = mkRoot(t, 'fsmcp-ordinary-');
  fs.writeFileSync(path.join(root, 'one.txt'), 'x\n');
  fs.writeFileSync(path.join(root, 'self.txt'), 'y\n');

  const server = spawnServer([]);
  t.after(() => server.close());

  // The 99% case must be untouched by this change: a real move of a real
  // file to a name that does not exist still reports a move, because one
  // happened.
  const moved = await server.callTool(
    'fs_move',
    { source: '/d0/one.txt', destination: '/d0/two.txt' },
    { allowed_dirs: [root] }
  );
  assert.equal(moved.isError, undefined, allText(moved));
  assert.match(allText(moved), /^Moved \/d0\/one\.txt to \/d0\/two\.txt$/, allText(moved));
  assert.ok(!fs.existsSync(path.join(root, 'one.txt')));
  assert.equal(fs.readFileSync(path.join(root, 'two.txt'), 'utf-8'), 'x\n');

  // And the neighbouring branch -- same entry AND same resolved name -- keeps
  // #23's own wording rather than being folded into the new message: there
  // is no ambiguity there at all, so there is nothing to hedge about.
  const self = await server.callTool(
    'fs_move',
    { source: '/d0/self.txt', destination: '/d0/self.txt' },
    { allowed_dirs: [root] }
  );
  assert.equal(self.isError, undefined, allText(self));
  assert.match(allText(self), /is already at .*; nothing to move$/, allText(self));
});
