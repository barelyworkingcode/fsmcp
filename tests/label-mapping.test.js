'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnServer } = require('./helpers');
const { assignLabels, hostToVirtual, hostToVirtualOrRedact, REDACTED_PATH } = require('../dist/vpath');

/**
 * The outbound label mapping, tested as ONE defect rather than as the four
 * bugs it was reported as.
 *
 * `security.ts` decides containment by canonicalising both sides
 * (`isWithinAnyDir`). `hostToVirtual` used to decide the label by comparing
 * strings against the directory exactly as the operator wrote it. Those two
 * rules disagree by construction, and every way of making them disagree is a
 * live bug that reaches a client on an `ok` result:
 *
 *   #21   a granted root that is itself a symlink -- recursive fs_glob
 *         returns an empty success
 *   #21c  an aliased ancestor (/Users/runner -> /Users/admin) -- a glob
 *         returns each file twice, half the lines the redaction placeholder
 *   #35   an allowed_dirs entry containing ".." -- fs_list and fs_glob redact
 *         EVERY path while fs_read, fs_grep and fs_find work
 *   --    /tmp vs /private/tmp, the same defect waiting on any macOS host
 *
 * A fifth, which is why enumerating spellings is not enough on its own: an
 * entry with BOTH a ".." and a symlinked ancestor. `fs_list` builds its
 * entries with `path.join`, which collapses the ".." lexically without
 * resolving the symlink, producing a third string that is neither the
 * operator's spelling nor the canonical one.
 *
 * So the tests are organised by GRANT SHAPE, not by tool: every shape must
 * produce identical output through every tool, because they are all the same
 * directory. The unit tests below that pin the two things the fix must not
 * cost -- the alarm, and the entry's own name.
 */

const CANARY = 'MAPPING-CANARY-out-of-scope';

/**
 * One directory, five ways to write it. `realhome/ws` is the real thing;
 * `alias -> realhome` gives every path a second spelling with no symlinked
 * ROOT involved (the ordinary-macOS-host case from the #21 comment), and the
 * ".." forms are #35's.
 *
 * realpath'd up front for the same reason buildScopeFixture does it: on
 * macOS os.tmpdir() is itself behind /var -> /private/var, so without
 * resolving first every assertion would be about the wrong symlink hop.
 */
function buildAliasFixture() {
  const testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-map-')));
  const ws = path.join(testRoot, 'realhome', 'ws');
  fs.mkdirSync(path.join(ws, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'notes', 'todo.txt'), 'todo body\n');
  fs.writeFileSync(path.join(ws, 'notes', 'meeting.md'), 'meeting body\n');
  fs.mkdirSync(path.join(testRoot, 'outside'), { recursive: true });
  fs.writeFileSync(path.join(testRoot, 'outside', 'secret.txt'), `${CANARY}\n`);
  fs.symlinkSync('realhome', path.join(testRoot, 'alias'));

  const aliasWs = path.join(testRoot, 'alias', 'ws');
  return {
    testRoot,
    ws,
    outside: path.join(testRoot, 'outside'),
    shapes: {
      'plain (the control)': ws,
      'symlinked ancestor': aliasWs,
      // Built by CONCATENATION, never path.join: path.join collapses ".."
      // lexically before it returns, which would quietly hand every case
      // below the same string as the control and make this whole file assert
      // nothing. That is the same reason vpath.ts's virtualToHost is
      // deliberately concatenation rather than a join.
      'entry containing ".."': `${ws}/../ws`,
      '".." AND a symlinked ancestor': `${aliasWs}/../ws`,
    },
  };
}

function textOf(result) {
  return (result.content || []).map((c) => c.text).join('\n');
}

async function callWithRoot(root, name, args) {
  const server = spawnServer([]);
  try {
    await server.request('initialize', {});
    return await server.callTool(name, args, { allowed_dirs: [root] });
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// End to end: every grant shape, every tool, identical output.
// ---------------------------------------------------------------------------

test('every spelling of one grant produces identical virtual paths through every tool', async (t) => {
  const fx = buildAliasFixture();
  t.after(() => fs.rmSync(fx.testRoot, { recursive: true, force: true }));

  // The control: what the plain grant returns. Every other spelling of the
  // same directory must return exactly this, because it IS that directory.
  const expected = {
    fs_glob: ['/d0/notes/meeting.md', '/d0/notes/todo.txt'],
    fs_list: ['/d0/notes/meeting.md', '/d0/notes/todo.txt'],
    fs_find: ['/d0/notes/todo.txt'],
    fs_grep: ['/d0/notes/meeting.md', '/d0/notes/todo.txt'],
  };

  for (const [name, root] of Object.entries(fx.shapes)) {
    const calls = {
      fs_glob: await callWithRoot(root, 'fs_glob', { pattern: '**/*' }),
      fs_list: await callWithRoot(root, 'fs_list', { path: '/d0/notes' }),
      fs_find: await callWithRoot(root, 'fs_find', { pattern: 'todo' }),
      fs_grep: await callWithRoot(root, 'fs_grep', { pattern: 'body' }),
    };

    for (const [tool, result] of Object.entries(calls)) {
      const text = textOf(result);
      assert.ok(!result.isError, `${name} / ${tool}: ${text}`);
      // The headline symptom of #35, asserted by itself so a failure names it.
      assert.ok(!text.includes(REDACTED_PATH),
        `${name} / ${tool}: the redaction placeholder fired on a correct call: ${text}`);
      // ...and no host path in either direction, which is issue #7's rule and
      // does not get a discount for an unusual grant spelling.
      assert.ok(!text.includes(fx.testRoot), `${name} / ${tool}: leaked a host path: ${text}`);

      // fs_list emits tab-separated columns; take the path column.
      const paths = text.split('\n').filter(Boolean)
        .map((line) => (line.includes('\t') ? line.split('\t').pop() : line))
        .sort();
      assert.deepStrictEqual(paths, expected[tool], `${name} / ${tool}`);
    }

    const read = textOf(await callWithRoot(root, 'fs_read', { file_path: '/d0/notes/todo.txt' }));
    assert.match(read, /todo body/, `${name} / fs_read`);
  }
});

test('the /tmp vs /private/tmp spelling of one grant maps correctly', async (t) => {
  // The fourth case, which nobody had reported yet and which is waiting on
  // every macOS host: /tmp is a symlink to /private/tmp, so an operator who
  // types the obvious thing gets a grant whose canonical form differs from
  // what they wrote.
  const real = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'fsmcp-tmpalias-')));
  t.after(() => fs.rmSync(real, { recursive: true, force: true }));
  fs.mkdirSync(path.join(real, 'notes'));
  fs.writeFileSync(path.join(real, 'notes', 'todo.txt'), 'todo body\n');

  // `real` is /private/tmp/...; the alias spelling is the /tmp/... one.
  assert.ok(real.startsWith('/private/tmp/'), `expected macOS /tmp aliasing, got ${real}`);
  const alias = `/tmp/${real.slice('/private/tmp/'.length)}`;

  for (const root of [real, alias]) {
    const text = textOf(await callWithRoot(root, 'fs_list', { path: '/d0/notes' }));
    assert.ok(!text.includes(REDACTED_PATH), `${root}: placeholder on a correct call: ${text}`);
    assert.match(text, /\/d0\/notes\/todo\.txt/, `${root}: ${text}`);
  }
});

// ---------------------------------------------------------------------------
// The two things the fix must not cost.
// ---------------------------------------------------------------------------

test('the alarm still fires: a path outside every grant is still redacted', async (t) => {
  const fx = buildAliasFixture();
  t.after(() => fs.rmSync(fx.testRoot, { recursive: true, force: true }));

  // This is the property the whole fix is balanced against. hostToVirtual is
  // now willing to resolve a path before giving up on it, and that must not
  // become a way to name something that is genuinely out of scope. Asserted
  // for every grant spelling, because the canonical fallback is reached most
  // often under exactly the malformed spellings this fix exists for.
  for (const [name, root] of Object.entries(fx.shapes)) {
    const labels = assignLabels([root], new Map());
    assert.ok(Array.isArray(labels), `${name}: assignLabels refused: ${JSON.stringify(labels)}`);

    for (const outside of [
      path.join(fx.outside, 'secret.txt'),          // a real file, one level out
      path.join(fx.testRoot, 'outside'),            // the directory itself
      '/etc/passwd',                                // somewhere else entirely
      `${fx.ws}-old/x.txt`,                         // a sibling sharing a prefix
      path.join(fx.testRoot, 'realhome', 'other'),  // a sibling of the grant
    ]) {
      assert.strictEqual(hostToVirtual(outside, labels), null,
        `${name}: ${outside} was mapped into the grant`);
      assert.strictEqual(hostToVirtualOrRedact(outside, labels), REDACTED_PATH,
        `${name}: ${outside} was not redacted`);
    }
  }
});

test('the canonical fallback never renames an entry to its symlink target', async (t) => {
  const testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-map-name-')));
  t.after(() => fs.rmSync(testRoot, { recursive: true, force: true }));
  const grant = path.join(testRoot, 'g');
  fs.mkdirSync(grant, { recursive: true });
  fs.writeFileSync(path.join(grant, 'a.txt'), 'a\n');
  fs.symlinkSync('a.txt', path.join(grant, 'link.txt'));

  // Resolving the WHOLE path would map `<grant>/link.txt` onto `/d0/a.txt`,
  // so fs_list would report a name that is not the name of the entry it just
  // listed. The fallback resolves the PARENT only and keeps the basename --
  // the same rule validatePathNoFollowFinal (security.ts, C2) uses, for the
  // same reason.
  const labels = assignLabels([`${grant}/../g`], new Map());
  assert.ok(Array.isArray(labels));
  assert.strictEqual(hostToVirtual(path.join(grant, 'link.txt'), labels), '/d0/link.txt');

  // ...and end to end, through the tool that would have shown the wrong name.
  const text = textOf(await callWithRoot(`${grant}/../g`, 'fs_list', { path: '/d0' }));
  assert.match(text, /\/d0\/link\.txt/, text);
});

test('an ordinary grant contributes exactly one spelling, and maps as it always did', (t) => {
  const testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-map-plain-')));
  t.after(() => fs.rmSync(testRoot, { recursive: true, force: true }));

  const labels = assignLabels([testRoot], new Map());
  assert.ok(Array.isArray(labels));
  // Literal, lexical and canonical all agree for a grant that is neither
  // reached through a symlink nor written with a "..", so the comparison
  // stays byte-for-byte what it has always been for nearly every deployment.
  assert.deepStrictEqual(labels[0].spellings, [testRoot]);
  assert.strictEqual(labels[0].hostDir, testRoot);
  assert.strictEqual(labels[0].realHostDir, testRoot);

  assert.strictEqual(hostToVirtual(testRoot, labels), '/d0');
  assert.strictEqual(hostToVirtual(path.join(testRoot, 'x', 'y.txt'), labels), '/d0/x/y.txt');
});

test('a nested grant still maps to its most specific label, in every spelling', (t) => {
  const testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-map-nested-')));
  t.after(() => fs.rmSync(testRoot, { recursive: true, force: true }));
  const outer = path.join(testRoot, 'a');
  const inner = path.join(outer, 'b');
  fs.mkdirSync(inner, { recursive: true });

  // Written with a ".." on the inner entry, so the longest-prefix rule has to
  // hold across spellings and not just across literal strings.
  const labels = assignLabels([outer, `${inner}/../b`], new Map());
  assert.ok(Array.isArray(labels));
  assert.strictEqual(hostToVirtual(path.join(inner, 'f.txt'), labels), '/d1/f.txt');
  assert.strictEqual(hostToVirtual(path.join(outer, 'f.txt'), labels), '/d0/f.txt');
});

test('the "--allowed-dir /" opt-out still maps with a separator', (t) => {
  const labels = assignLabels(['/'], new Map());
  assert.ok(Array.isArray(labels));
  assert.strictEqual(hostToVirtual('/', labels), '/d0');
  // The bug this guards is `/d0var/x`: slicing off the directory without its
  // separator when the directory IS the separator.
  assert.strictEqual(hostToVirtual('/var/x', labels), '/d0/var/x');
});
