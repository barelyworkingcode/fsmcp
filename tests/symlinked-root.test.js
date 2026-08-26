'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnServer } = require('./helpers');

/**
 * Issue #21: a granted root that is itself a symlink.
 *
 * The shape the runbook for this stack singles out as the one that must
 * never happen -- "a scope violation must be an error, never an empty
 * result; an empty list means something else is broken" -- had a second way
 * to occur that has nothing to do with scope: `fs_glob` returned an empty
 * SUCCESS for a recursive pattern whenever the operator's grant was reached
 * through a symlink, because `globSync`'s default `follow: false` will not
 * walk through a `cwd` that is a link. The client was told the folder was
 * empty; `relay audit` recorded `ok`. On macOS that is not an exotic
 * configuration: `/tmp`, a relocated home directory, an external volume
 * behind a link and a cloud-storage alias all get there without the
 * operator thinking about it.
 *
 * The fix has two halves and this file tests both, because either one alone
 * is worse than useless:
 *
 *  1. `fs_glob` hands `globSync` the root as `canonicalizePath` resolves it,
 *     so the walk starts on a real directory. (`follow: true` was tried and
 *     does not resolve a symlinked `cwd`; it would also make glob follow
 *     every link inside the tree, which is the traversal the per-hit
 *     re-validation exists to catch.)
 *  2. `hostToVirtual` recognises both spellings of a granted directory, so
 *     hits that now arrive in resolved form map to `/d0/...` instead of the
 *     redaction placeholder. Half 1 without half 2 trades an empty answer
 *     for a page of `[redacted]`, which is a different way of telling the
 *     caller nothing.
 *
 * And the half that must NOT move: containment. A symlink pointing out of
 * the grant, from inside a symlinked root, is the combination where a
 * change to the outbound map is most likely to go wrong -- so the escape
 * cases below assert both that the out-of-scope path is absent and that no
 * placeholder appeared in its place, since a redaction would mean the map
 * was consulted about a path that should never have survived `validatePath`.
 *
 * `fs_find`, `fs_grep` and `fs_list` were never broken here, but only
 * because `rg` echoes back the unresolved directory string it was handed.
 * That is luck, not design -- nothing pins it, and a future `rg` flag or a
 * fallback rewrite could start emitting resolved paths at any time -- so
 * they are pinned here too, against the same fixture, in the same file as
 * the tool that did break.
 */

const REDACTED = /\[fsmcp: path outside the granted directories/;

/**
 * symlinked_root -> real_target (issue #21's own shape), plus the two ways
 * out of it that must stay refused.
 *
 *   <testRoot>/real_target/            <- what the grant really is
 *       sub/file.txt                   <- contains BEHIND_CANARY
 *       sub/new.txt
 *       escape_file.txt -> <testRoot>/outside/secret.txt   (file link, out)
 *       escape_dir      -> <testRoot>/outside              (dir link, out)
 *   <testRoot>/symlinked_root -> real_target   <- the ONLY allowed_dir
 *   <testRoot>/outside/secret.txt      <- contains OUT_CANARY, never in scope
 *
 * realpath'd up front for the same reason buildScopeFixture does it: on
 * macOS os.tmpdir() is itself behind /var -> /private/var, and without
 * resolving that first every assertion here would be about the wrong
 * symlink hop.
 */
function buildSymlinkedRootFixture() {
  const testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-symroot-')));
  const realTarget = path.join(testRoot, 'real_target');
  const outside = path.join(testRoot, 'outside');
  const symlinkedRoot = path.join(testRoot, 'symlinked_root');

  fs.mkdirSync(path.join(realTarget, 'sub'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  fs.writeFileSync(path.join(realTarget, 'sub', 'file.txt'), `${BEHIND_CANARY}\n`);
  fs.writeFileSync(path.join(realTarget, 'sub', 'new.txt'), 'another file\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), `${OUT_CANARY}\n`);

  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(realTarget, 'escape_file.txt'));
  fs.symlinkSync(outside, path.join(realTarget, 'escape_dir'));
  // Relative, the way an operator's own link normally is.
  fs.symlinkSync('real_target', symlinkedRoot);

  return { testRoot, realTarget, outside, symlinkedRoot };
}

// Distinct strings rather than a plain word, so a false positive cannot be
// explained away as a coincidental substring of the fixture's own content.
const BEHIND_CANARY = 'CANARY-21-behind-the-symlinked-root';
const OUT_CANARY = 'CANARY-21-outside-must-never-be-named-in-scope';

function textOf(result) {
  return (result.content || []).map((c) => c.text).join('\n');
}

/**
 * Every case here grants the root through `_meta.allowed_dirs`, which is the
 * relay-mediated shape this issue was found in (relay passes the whole scope
 * through `_meta`; `--allowed-dir` is not passed at all).
 */
async function callWithRoot(root, name, args) {
  const server = spawnServer([]);
  try {
    await server.request('initialize', {});
    return await server.callTool(name, args, { allowed_dirs: [root] });
  } finally {
    server.close();
  }
}

test('fs_glob: a recursive pattern under a SYMLINKED root returns the files, not an empty success', async (t) => {
  const fx = buildSymlinkedRootFixture();
  t.after(() => fs.rmSync(fx.testRoot, { recursive: true, force: true }));

  const result = await callWithRoot(fx.symlinkedRoot, 'fs_glob', { pattern: '**/*.txt' });
  const text = textOf(result);

  // The exact failure from the issue: a success result whose text is empty.
  assert.notStrictEqual(text.trim(), '', 'fs_glob returned an empty success under a symlinked root');
  assert.ok(!result.isError, `expected a success result, got: ${text}`);
  const lines = text.split('\n').filter(Boolean);
  assert.ok(lines.includes('/d0/sub/file.txt'), `expected /d0/sub/file.txt in: ${text}`);
  assert.ok(lines.includes('/d0/sub/new.txt'), `expected /d0/sub/new.txt in: ${text}`);
});

test('fs_glob: the same pattern with an explicit path argument, under a symlinked root', async (t) => {
  const fx = buildSymlinkedRootFixture();
  t.after(() => fs.rmSync(fx.testRoot, { recursive: true, force: true }));

  const result = await callWithRoot(fx.symlinkedRoot, 'fs_glob', { pattern: '**/*.txt', path: '/d0' });
  const lines = textOf(result).split('\n').filter(Boolean);
  assert.ok(lines.includes('/d0/sub/file.txt'), `expected /d0/sub/file.txt in: ${lines.join(', ')}`);
});

test('fs_glob: a literal-prefixed pattern still works (it never went through the ** walk)', async (t) => {
  const fx = buildSymlinkedRootFixture();
  t.after(() => fs.rmSync(fx.testRoot, { recursive: true, force: true }));

  const lines = textOf(await callWithRoot(fx.symlinkedRoot, 'fs_glob', { pattern: 'sub/*.txt' }))
    .split('\n')
    .filter(Boolean);
  assert.ok(lines.includes('/d0/sub/file.txt'));
  assert.ok(lines.includes('/d0/sub/new.txt'));
});

test('fs_glob: hits under a symlinked root map to /d0/..., never to the redaction placeholder', async (t) => {
  const fx = buildSymlinkedRootFixture();
  t.after(() => fs.rmSync(fx.testRoot, { recursive: true, force: true }));

  // The second half of the fix, on its own terms: resolving the walk means
  // every hit now arrives spelled with the RESOLVED root, and an outbound
  // map that only knew the operator's unresolved spelling would redact all
  // of them. This is what "necessary but not sufficient" looks like as an
  // assertion.
  const text = textOf(await callWithRoot(fx.symlinkedRoot, 'fs_glob', { pattern: '**/*.txt' }));
  assert.ok(!REDACTED.test(text), `hits came back redacted instead of mapped: ${text}`);
  for (const line of text.split('\n').filter(Boolean)) {
    assert.ok(line.startsWith('/d0/'), `not a virtual path: ${line}`);
  }
});

test('fs_glob: no host path -- in EITHER spelling -- reaches the caller under a symlinked root', async (t) => {
  const fx = buildSymlinkedRootFixture();
  t.after(() => fs.rmSync(fx.testRoot, { recursive: true, force: true }));

  // Issue #7's rule does not get a discount for the resolved spelling: the
  // real target's path is as much a host path as the granted link's is, and
  // it is the one a resolved-path leak would actually be spelled with.
  const text = textOf(await callWithRoot(fx.symlinkedRoot, 'fs_glob', { pattern: '**/*' }));
  assert.ok(!text.includes(fx.realTarget), `leaked the resolved host path: ${text}`);
  assert.ok(!text.includes(fx.symlinkedRoot), `leaked the granted host path: ${text}`);
});

test('fs_glob: a symlink pointing OUT of a symlinked root is still refused, and not redacted either', async (t) => {
  const fx = buildSymlinkedRootFixture();
  t.after(() => fs.rmSync(fx.testRoot, { recursive: true, force: true }));

  // `escape_file.txt` is a real hit as far as glob is concerned -- confirmed
  // by running globSync against the resolved root directly -- so this is the
  // per-hit validatePath filter doing its job, not the pattern failing to
  // match. Both assertions matter: absent (containment held) AND not
  // redacted (the outbound map was never asked about a path that should not
  // have survived the check, so the placeholder is not quietly standing in
  // for a hole).
  for (const pattern of ['**/*.txt', '*.txt', 'escape_dir/*.txt', '**/*']) {
    const text = textOf(await callWithRoot(fx.symlinkedRoot, 'fs_glob', { pattern }));
    assert.ok(!text.includes('escape_file.txt'), `${pattern}: named a symlink whose bytes are out of scope: ${text}`);
    assert.ok(!text.includes('secret.txt'), `${pattern}: named a file out of scope: ${text}`);
    assert.ok(!text.includes(fx.outside), `${pattern}: leaked an out-of-scope host path: ${text}`);
    assert.ok(!REDACTED.test(text), `${pattern}: an out-of-scope hit reached the outbound map: ${text}`);
  }
});

test('fs_glob: an ordinary (non-symlinked) root is unchanged', async (t) => {
  const fx = buildSymlinkedRootFixture();
  t.after(() => fs.rmSync(fx.testRoot, { recursive: true, force: true }));

  // Granting the real directory instead of the link must produce exactly the
  // same answer -- the point of the fix is that the two spellings of one
  // grant stop disagreeing, not that the symlinked case gets special output.
  const viaLink = textOf(await callWithRoot(fx.symlinkedRoot, 'fs_glob', { pattern: '**/*.txt' }));
  const viaReal = textOf(await callWithRoot(fx.realTarget, 'fs_glob', { pattern: '**/*.txt' }));
  assert.strictEqual(viaLink, viaReal);
});

test('fs_find under a symlinked root: pinned, not left to luck', async (t) => {
  const fx = buildSymlinkedRootFixture();
  t.after(() => fs.rmSync(fx.testRoot, { recursive: true, force: true }));

  // fs_find works today only because `rg --files` echoes back the unresolved
  // directory string it was handed. Nothing pinned that, so nothing would
  // have caught the day it changed -- and the failure would have been the
  // same silent, successful nothing fs_glob was returning.
  const text = textOf(await callWithRoot(fx.symlinkedRoot, 'fs_find', { pattern: 'file' }));
  assert.ok(text.includes('/d0/sub/file.txt'), `fs_find found nothing under a symlinked root: ${text}`);
  assert.ok(!REDACTED.test(text), `fs_find results came back redacted: ${text}`);
  assert.ok(!text.includes(fx.realTarget), `fs_find leaked the resolved host path: ${text}`);
  assert.ok(!text.includes(fx.symlinkedRoot), `fs_find leaked the granted host path: ${text}`);
  assert.ok(!text.includes('secret.txt'), `fs_find named a file out of scope: ${text}`);
});

test('fs_grep under a symlinked root: pinned, not left to luck', async (t) => {
  const fx = buildSymlinkedRootFixture();
  t.after(() => fs.rmSync(fx.testRoot, { recursive: true, force: true }));

  const text = textOf(await callWithRoot(fx.symlinkedRoot, 'fs_grep', { pattern: BEHIND_CANARY }));
  assert.ok(text.includes('/d0/sub/file.txt'), `fs_grep found nothing under a symlinked root: ${text}`);
  assert.ok(!REDACTED.test(text), `fs_grep results came back redacted: ${text}`);
  assert.ok(!text.includes(fx.realTarget), `fs_grep leaked the resolved host path: ${text}`);
  assert.ok(!text.includes(fx.symlinkedRoot), `fs_grep leaked the granted host path: ${text}`);
});

test('fs_grep under a symlinked root does not reach through a symlink pointing out of it', async (t) => {
  const fx = buildSymlinkedRootFixture();
  t.after(() => fs.rmSync(fx.testRoot, { recursive: true, force: true }));

  const text = textOf(await callWithRoot(fx.symlinkedRoot, 'fs_grep', { pattern: OUT_CANARY }));
  assert.ok(!text.includes(OUT_CANARY.slice(0, 20)) || text.includes('No matches'),
    `fs_grep reached out of the grant: ${text}`);
  assert.ok(!text.includes('secret.txt'), `fs_grep named a file out of scope: ${text}`);
  assert.ok(!text.includes(fx.outside), `fs_grep leaked an out-of-scope host path: ${text}`);
});

test('fs_list and fs_read under a symlinked root are unaffected', async (t) => {
  const fx = buildSymlinkedRootFixture();
  t.after(() => fs.rmSync(fx.testRoot, { recursive: true, force: true }));

  const listed = textOf(await callWithRoot(fx.symlinkedRoot, 'fs_list', { path: '/d0/sub' }));
  assert.ok(listed.includes('/d0/sub/file.txt'), `fs_list under a symlinked root: ${listed}`);
  assert.ok(!REDACTED.test(listed), `fs_list came back redacted: ${listed}`);

  const read = textOf(await callWithRoot(fx.symlinkedRoot, 'fs_read', { file_path: '/d0/sub/file.txt' }));
  assert.ok(read.includes(BEHIND_CANARY), `fs_read under a symlinked root: ${read}`);
});

test('fs_read through a symlink out of a symlinked root is still a scope violation', async (t) => {
  const fx = buildSymlinkedRootFixture();
  t.after(() => fs.rmSync(fx.testRoot, { recursive: true, force: true }));

  // The mapping now recognises the resolved spelling of the grant. That must
  // not make anything reachable that was not reachable before: inbound
  // translation still concatenates the UNRESOLVED hostDir and security.ts
  // still resolves and refuses.
  const result = await callWithRoot(fx.symlinkedRoot, 'fs_read', { file_path: '/d0/escape_file.txt' });
  assert.ok(result.isError, `expected a refusal, got: ${textOf(result)}`);
  assert.strictEqual(result._meta && result._meta.scope_violation, true,
    `expected _meta.scope_violation on: ${JSON.stringify(result)}`);
  assert.ok(!textOf(result).includes(OUT_CANARY), 'the out-of-scope file was read');
});

test('a host path is still not a valid address, in either spelling of a symlinked root', async (t) => {
  const fx = buildSymlinkedRootFixture();
  t.after(() => fs.rmSync(fx.testRoot, { recursive: true, force: true }));

  // The oracle issue #7 closed stays closed. Teaching the OUTBOUND map the
  // resolved spelling says nothing about what the INBOUND decoder accepts:
  // both spellings are still just host paths, and a host path is not an
  // address. Both must be refused the same way, or which one gets a
  // different message is itself the oracle.
  for (const hostPath of [
    path.join(fx.symlinkedRoot, 'sub', 'file.txt'),
    path.join(fx.realTarget, 'sub', 'file.txt'),
  ]) {
    const result = await callWithRoot(fx.symlinkedRoot, 'fs_read', { file_path: hostPath });
    assert.ok(result.isError, `${hostPath}: expected a refusal, got: ${textOf(result)}`);
    assert.match(textOf(result), /is not a valid address/i);
    assert.ok(!textOf(result).includes(hostPath), `${hostPath}: the refusal echoed the caller's argument`);
  }
});
