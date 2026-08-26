'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnServer, toVirtual, toVirtualVia } = require('./helpers');

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
    // Issue #7: _meta.allowed_dirs stays host paths (operator/relay-side,
    // deliberately unchanged); the fs_read ARGUMENT is what must now be
    // virtual, addressed against the label _meta's one entry gets (d0, by
    // position -- src/vpath.ts's assignLabels).
    const result = await server.callTool('fs_read', { file_path: toVirtual(file, tmp) }, { allowed_dirs: [tmp] });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /top secret/);
  });

  await t.test('_meta.allowed_dirs naming a different dir refuses fs_read', async () => {
    const otherDir = mkTmpDir();
    // `file` lives under `tmp`, not `otherDir` -- the only root this call's
    // scope grants a label for -- so it is addressed via toVirtualVia's
    // "climb out with a literal .." shape, the same way a caller who knew
    // the two directories were siblings could type one by hand. That still
    // has to resolve through validatePath/canonicalizePath and land outside
    // otherDir for this refusal to mean what it used to.
    const result = await server.callTool(
      'fs_read',
      { file_path: toVirtualVia(file, otherDir) },
      { allowed_dirs: [otherDir] }
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /outside allowed directories/i);
  });

  await t.test('_meta.allowed_dirs: ["/"] is the documented explicit opt-out', async () => {
    const result = await server.callTool('fs_read', { file_path: toVirtual(file, '/') }, { allowed_dirs: ['/'] });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /top secret/);
  });

  await t.test('fs_write is refused with no scope', async () => {
    const target = path.join(tmp, 'new-file.txt');
    // No scope at all (labels.length === 0): decodeInboundPath refuses on
    // that alone, before ever looking at the argument's shape, so the
    // argument here can stay a host path without weakening what this
    // asserts -- see decodeInboundPath's doc in src/vpath.ts.
    const result = await server.callTool('fs_write', { file_path: target, content: 'x' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no allowed directories/i);
    assert.equal(fs.existsSync(target), false, 'nothing should have been written');
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
    // path omitted: fs_glob defaults to the allowed directories, which here
    // is exactly tmp -- no virtual address needed to reach it.
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
    const result = await server.callTool('fs_read', { file_path: toVirtual(file, tmp) });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /cli scoped content/);
  });

  await t.test('fs_read still refuses a path outside the CLI-configured dir', async () => {
    const outside = mkTmpDir();
    const outsideFile = path.join(outside, 'x.txt');
    fs.writeFileSync(outsideFile, 'x');
    // outsideFile is not under tmp (this call's only root); toVirtualVia
    // climbs out to it with a literal "..", still resolved and refused by
    // the real containment check, not by the address failing to parse.
    const result = await server.callTool('fs_read', { file_path: toVirtualVia(outsideFile, tmp) });
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
    const result = await server.callTool('fs_read', { file_path: toVirtual(file, '/') });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /reachable from anywhere/);
  });
});

// ---------------------------------------------------------------------------
// Symlink escape, end to end over stdio against a real dist/main.js.
//
// The unit cases in security.test.js pin validatePath; these pin the thing a
// caller actually observes -- that fs_write refuses, and that no file appears
// outside the allowed directory afterwards. The tool's own success sentence is
// not the ground truth here, the filesystem is: the original bug reported
// "Wrote 27 bytes to <allowed>/link/ESCAPED.txt" for a file it had created
// outside the sandbox.
//
// The root is realpath'd because os.tmpdir() is reached through the
// /var -> /private/var symlink on macOS; without it every path here would be
// refused for the wrong reason and the tests would pass without testing
// anything.
// ---------------------------------------------------------------------------

function mkLinkFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-esc-')));
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(allowed, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'existing.txt'), 'pre-existing secret');
  fs.symlinkSync(outside, path.join(allowed, 'link'));
  return { root, allowed, outside };
}

test('a symlink out of an allowed dir is not a way out of it', async (t) => {
  const { allowed, outside } = mkLinkFixture();
  const server = spawnServer(['--allowed-dir', allowed]);
  t.after(() => server.close());

  await t.test('fs_write to a NEW file through the symlink is refused and writes nothing', async () => {
    const target = path.join(allowed, 'link', 'ESCAPED.txt');
    const result = await server.callTool('fs_write', { file_path: toVirtual(target, allowed), content: 'escaped!' });
    assert.equal(result.isError, true, 'fs_write must refuse');
    assert.match(result.content[0].text, /outside allowed directories/i);
    assert.equal(
      fs.existsSync(path.join(outside, 'ESCAPED.txt')),
      false,
      'nothing may appear outside the allowed directory'
    );
    assert.deepEqual(
      fs.readdirSync(outside).sort(),
      ['existing.txt'],
      'the outside directory must be untouched'
    );
  });

  await t.test('fs_read of an existing file through the symlink is refused', async () => {
    const result = await server.callTool('fs_read', {
      file_path: toVirtual(path.join(allowed, 'link', 'existing.txt'), allowed),
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /outside allowed directories/i);
    assert.doesNotMatch(result.content[0].text, /pre-existing secret/);
  });

  await t.test('fs_edit through the symlink is refused', async () => {
    const result = await server.callTool('fs_edit', {
      file_path: toVirtual(path.join(allowed, 'link', 'existing.txt'), allowed),
      old_string: 'secret',
      new_string: 'edited',
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /outside allowed directories/i);
    assert.equal(
      fs.readFileSync(path.join(outside, 'existing.txt'), 'utf-8'),
      'pre-existing secret',
      'the file outside must be unmodified'
    );
  });

  await t.test('fs_glob does not report paths that resolve outside the allowed dir', async () => {
    const result = await server.callTool('fs_glob', { pattern: 'link/*' });
    assert.equal(result.isError, undefined);
    assert.doesNotMatch(result.content[0].text, /existing\.txt/);
  });

  // Positive control: the refusals above must not be the server refusing
  // everything. A legitimate new file inside the allowed dir still writes.
  await t.test('a legitimate new file inside the allowed dir still writes', async () => {
    const legit = path.join(allowed, 'nested', 'legit.txt');
    const result = await server.callTool('fs_write', { file_path: toVirtual(legit, allowed), content: 'fine' });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.match(result.content[0].text, /Wrote 4 bytes/);
    assert.equal(fs.readFileSync(legit, 'utf-8'), 'fine');
  });
});
