'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnServer } = require('./helpers');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-it-'));
}

// A single server started with no --allowed-dir flags. Every scenario below
// supplies (or omits) _meta per-call, which is exactly how relay and a
// standalone client each drive this server over the wire.
test('server with no CLI --allowed-dir', async (t) => {
  const server = spawnServer([]);
  t.after(() => server.close());

  const tmp = mkTmpDir();
  const file = path.join(tmp, 'secret.txt');
  fs.writeFileSync(file, 'top secret');

  await t.test('absent _meta refuses fs_read', async () => {
    const result = await server.callTool('fs_read', { file_path: file } /* no meta arg at all */);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no allowed directories/i);
  });

  await t.test('_meta present but allowed_dirs empty refuses fs_read', async () => {
    const result = await server.callTool('fs_read', { file_path: file }, { allowed_dirs: [] });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no allowed directories/i);
  });

  await t.test('_meta.allowed_dirs naming the dir permits fs_read inside it', async () => {
    const result = await server.callTool('fs_read', { file_path: file }, { allowed_dirs: [tmp] });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /top secret/);
  });

  await t.test('_meta.allowed_dirs naming a different dir refuses fs_read', async () => {
    const otherDir = mkTmpDir();
    const result = await server.callTool('fs_read', { file_path: file }, { allowed_dirs: [otherDir] });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /outside allowed directories/i);
  });

  await t.test('_meta.allowed_dirs: ["/"] is the documented explicit opt-out', async () => {
    const result = await server.callTool('fs_read', { file_path: file }, { allowed_dirs: ['/'] });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /top secret/);
  });

  await t.test('fs_write is refused with no scope', async () => {
    const target = path.join(tmp, 'new-file.txt');
    const result = await server.callTool('fs_write', { file_path: target, content: 'x' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no allowed directories/i);
    assert.equal(fs.existsSync(target), false, 'nothing should have been written');
  });

  await t.test('fs_bash is refused with no scope (cwd cannot be validated)', async () => {
    const result = await server.callTool('fs_bash', { command: 'echo hi' });
    assert.equal(result.isError, true);
  });

  await t.test('fs_glob with no path and no scope refuses rather than falling back to cwd', async () => {
    const result = await server.callTool('fs_glob', { pattern: '**/*' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no allowed directories/i);
  });

  await t.test('fs_grep with no path and no scope refuses rather than falling back to cwd', async () => {
    const result = await server.callTool('fs_grep', { pattern: 'secret' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no allowed directories/i);
  });

  await t.test('fs_glob with an explicit scope finds the file and never searches outside it', async () => {
    const result = await server.callTool('fs_glob', { pattern: '*.txt' }, { allowed_dirs: [tmp] });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /secret\.txt/);
  });
});

// A server started with a CLI --allowed-dir flag, as a real standalone user
// would run it. Confirms the CLI path still works exactly as documented,
// merged with (but not overridden by) an absent/empty _meta.
test('server with --allowed-dir <dir> on the CLI', async (t) => {
  const tmp = mkTmpDir();
  const file = path.join(tmp, 'cli-scoped.txt');
  fs.writeFileSync(file, 'cli scoped content');

  const server = spawnServer(['--allowed-dir', tmp]);
  t.after(() => server.close());

  await t.test('fs_read succeeds inside the CLI-configured dir with no _meta at all', async () => {
    const result = await server.callTool('fs_read', { file_path: file });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /cli scoped content/);
  });

  await t.test('fs_read still refuses a path outside the CLI-configured dir', async () => {
    const outside = mkTmpDir();
    const outsideFile = path.join(outside, 'x.txt');
    fs.writeFileSync(outsideFile, 'x');
    const result = await server.callTool('fs_read', { file_path: outsideFile });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /outside allowed directories/i);
  });
});

// The documented standalone opt-out: `--allowed-dir /`. Must behave exactly
// like the pre-fix "no restrictions" default, but only because an operator
// typed it, never as an implicit fallback.
test('server with --allowed-dir / (explicit opt-out)', async (t) => {
  const server = spawnServer(['--allowed-dir', '/']);
  t.after(() => server.close());

  const tmp = mkTmpDir();
  const file = path.join(tmp, 'anywhere.txt');
  fs.writeFileSync(file, 'reachable from anywhere');

  await t.test('fs_read succeeds for an arbitrary absolute path', async () => {
    const result = await server.callTool('fs_read', { file_path: file });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /reachable from anywhere/);
  });
});
