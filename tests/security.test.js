'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validatePath } = require('../dist/security');

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
