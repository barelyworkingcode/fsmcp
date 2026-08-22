'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validatePath, canonicalizePath } = require('../dist/security');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-sec-'));
}

test('empty allowedDirs refuses an absolute path (fail closed, not "no restrictions")', () => {
  const err = validatePath('/etc/hosts', []);
  assert.ok(err, 'expected a refusal, got null (permitted)');
  assert.match(err, /no allowed directories/i);
});

test('empty allowedDirs refuses even a path that looks harmless', () => {
  const tmp = mkTmpDir();
  const file = path.join(tmp, 'note.txt');
  fs.writeFileSync(file, 'hi');
  const err = validatePath(file, []);
  assert.ok(err, 'a real, existing file must still be refused when scope is empty');
});

test('a populated allowedDirs list permits a path inside it', () => {
  const tmp = mkTmpDir();
  const file = path.join(tmp, 'inside.txt');
  fs.writeFileSync(file, 'hi');
  const err = validatePath(file, [tmp]);
  assert.equal(err, null);
});

test('a populated allowedDirs list refuses a path outside it', () => {
  const tmp = mkTmpDir();
  const outside = mkTmpDir(); // a different directory
  const file = path.join(outside, 'outside.txt');
  fs.writeFileSync(file, 'hi');
  const err = validatePath(file, [tmp]);
  assert.ok(err, 'expected a refusal for a path outside every allowed dir');
  assert.match(err, /outside allowed directories/i);
});

test('a relative path is refused regardless of scope', () => {
  const err = validatePath('relative/path.txt', ['/tmp']);
  assert.ok(err);
  assert.match(err, /absolute/i);
});

test('the documented opt-out ("--allowed-dir /") is genuinely unrestricted', () => {
  const tmp = mkTmpDir();
  const file = path.join(tmp, 'anywhere.txt');
  fs.writeFileSync(file, 'hi');
  const err = validatePath(file, ['/']);
  assert.equal(err, null, 'listing "/" as an allowed dir must permit any absolute path');
});

// ---------------------------------------------------------------------------
// Symlink escape: a symlink *inside* an allowed directory pointing outside it.
//
// validatePath used to resolve with fs.realpathSync and fall back to a flat
// path.resolve when the path did not exist yet -- the ordinary case for
// fs_write creating a new file. That fallback left the symlink component in
// the string, so the containment check passed and the write followed the link
// out of the sandbox.
//
// These roots are realpath'd: on macOS os.tmpdir() is /var/folders/... which
// is itself reached through the /var -> /private/var symlink, and an
// un-realpath'd root would make every case here refuse for the wrong reason
// (the same trap as testing under /tmp).
// ---------------------------------------------------------------------------

function mkSymlinkFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-link-')));
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(allowed, 'sub'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  fs.symlinkSync(outside, path.join(allowed, 'link'));                       // -> outside dir
  fs.symlinkSync(path.join(outside, 'gone'), path.join(allowed, 'dangling'));// dangling, -> outside
  fs.symlinkSync(path.join(allowed, 'sub'), path.join(allowed, 'inlink'));   // stays inside
  return { root, allowed, outside };
}

test('a NON-EXISTING file behind a symlink out of the allowed dir is refused', () => {
  const { allowed } = mkSymlinkFixture();
  // This is the escape: the file does not exist, so realpathSync threw and the
  // old code compared the lexical string, symlink component and all.
  const err = validatePath(path.join(allowed, 'link', 'ESCAPED.txt'), [allowed]);
  assert.ok(err, 'a new file behind an escaping symlink must be refused');
  assert.match(err, /outside allowed directories/i);
});

test('an EXISTING file behind a symlink out of the allowed dir is refused', () => {
  const { allowed } = mkSymlinkFixture();
  const err = validatePath(path.join(allowed, 'link', 'secret.txt'), [allowed]);
  assert.ok(err, 'an existing file behind an escaping symlink must be refused');
  assert.match(err, /outside allowed directories/i);
});

test('a DANGLING symlink out of the allowed dir is refused', () => {
  const { allowed } = mkSymlinkFixture();
  // realpath throws ENOENT for a dangling link exactly as it does for an
  // absent file, which would put it in the lexical tail -- but a write through
  // it still creates the file at the link's target, outside the sandbox.
  const err = validatePath(path.join(allowed, 'dangling'), [allowed]);
  assert.ok(err, 'a dangling symlink pointing outside must be refused');
  assert.match(err, /outside allowed directories/i);
});

test('".." is applied to the resolved path, not collapsed lexically first', () => {
  const { root, allowed, outside } = mkSymlinkFixture();
  fs.symlinkSync(outside, path.join(allowed, 'sub', 'link2'));
  // Built by concatenation, NOT path.join: path.join would collapse ".."
  // lexically before validatePath ever saw it, which is the very thing under
  // test. Lexically this reads as <allowed>/x (inside); the kernel resolves it
  // through the symlink to <root>/x (outside), which is where a write lands.
  const raw = allowed + '/sub/link2/../../x';
  assert.equal(path.resolve(raw), path.join(allowed, 'x'), 'lexically this looks inside');
  const err = validatePath(raw, [allowed]);
  assert.ok(err, '".." through a symlink must not be collapsed lexically');
  assert.match(err, /outside allowed directories/i);
  // and the canonical form is the one the kernel would use: link2 -> <outside>,
  // so the two ".." climb out of <root> entirely.
  assert.equal(canonicalizePath(raw), path.join(path.dirname(root), 'x'));
});

test('a symlink cycle is refused rather than hanging or resolving', () => {
  const { allowed } = mkSymlinkFixture();
  fs.symlinkSync(path.join(allowed, 'loopb'), path.join(allowed, 'loopa'));
  fs.symlinkSync(path.join(allowed, 'loopa'), path.join(allowed, 'loopb'));
  const err = validatePath(path.join(allowed, 'loopa', 'x'), [allowed]);
  assert.ok(err, 'a symlink cycle must be refused');
  assert.match(err, /symbolic links/i);
  assert.equal(canonicalizePath(path.join(allowed, 'loopa')), null);
});

// Positive controls: the fix must not refuse legitimate work.

test('a legitimate NEW file inside the allowed dir is still permitted', () => {
  const { allowed } = mkSymlinkFixture();
  assert.equal(validatePath(path.join(allowed, 'brand-new.txt'), [allowed]), null);
  assert.equal(validatePath(path.join(allowed, 'a', 'b', 'c', 'deep-new.txt'), [allowed]), null);
});

test('a symlink that stays inside the allowed dir is still permitted', () => {
  const { allowed } = mkSymlinkFixture();
  assert.equal(validatePath(path.join(allowed, 'inlink', 'ok.txt'), [allowed]), null);
});

test('".." that comes back inside the allowed dir is still permitted', () => {
  const { allowed } = mkSymlinkFixture();
  assert.equal(validatePath(allowed + '/sub/../ok.txt', [allowed]), null);
});
