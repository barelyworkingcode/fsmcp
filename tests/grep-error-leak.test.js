'use strict';

/**
 * Issue #22: fs_grep handed a remote client the host's real absolute path --
 * account name, layout above the grant and all -- for two ordinary operator
 * conditions: a granted root that had been renamed, and a granted root the
 * server process cannot read.
 *
 * Two independent faults, both pinned here:
 *
 *  1. `grepWithRg`'s catch-all branch returned ripgrep's stderr verbatim
 *     (`grep error: ${detail}`), the one call site in this codebase that
 *     translated no path at all. It was documented as an accepted exception
 *     on the grounds that `redactLeakedHostPaths` would catch anything that
 *     slipped -- and the backstop's path-boundary lookahead accepted only
 *     `/`, a newline or end-of-string. rg (like every Unix tool) writes
 *     `<path>: <reason>`, and a colon was not in that class, so a message
 *     naming a granted ROOT went out verbatim while the byte-identical
 *     message naming anything INSIDE that root was caught. The fix is
 *     translation at the construction site, the same per-site pattern the
 *     rest of the codebase uses; the widened boundary class is defence in
 *     depth and is pinned separately below.
 *
 *  2. Because nothing was translated, the backstop was fs_grep's routine
 *     error path: a mistyped directory answered "this is a bug in fsmcp,
 *     not a property of the request; please report it" where fs_find and
 *     fs_glob both answer `directory not found: /d0/nodir`. An alarm that
 *     fires in normal operation is not an alarm.
 *
 * The assertions are written to hold on BOTH backends. On a host with
 * ripgrep the pre-fix answer was the leak (or the backstop's generic
 * refusal); on a host without it the pure-Node fallback answered "No matches
 * found." for a directory that does not exist, which is a success result
 * making a claim about a directory it never opened. Neither is what these
 * ask for. The few cases that genuinely need a failing `rg` say so and skip
 * without one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { spawnServer } = require('./helpers');
const { redactLeakedHostPaths } = require('../dist/vpath');

let rgAvailable = true;
try {
  execFileSync('rg', ['--version'], { stdio: 'pipe' });
} catch {
  rgAvailable = false;
}

function allText(result) {
  return result.content.map((c) => c.text).join('\n');
}

/**
 * Two granted roots, each with one matching file, plus a third directory
 * that the caller can make unreadable or make vanish. realpath'd for the
 * same reason buildScopeFixture is: on macOS os.tmpdir() is reached through
 * a symlink, and an assertion about "the host path must not appear" has to
 * be about the path the server actually resolves.
 */
function mkRoots() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-i22-')));
  const a = path.join(base, 'wsA');
  const b = path.join(base, 'wsB');
  fs.mkdirSync(path.join(a, 'notes'), { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(a, 'notes', 'a.md'), 'probe alpha\n');
  fs.writeFileSync(path.join(b, 'b.md'), 'probe beta\n');
  return { base, a, b };
}

function rmRoots(fx) {
  // Anything a test chmod 000'd has to be reachable again before rm.
  for (const p of [fx.a, fx.b, path.join(fx.a, 'sec'), path.join(fx.base, 'wsC')]) {
    try {
      fs.chmodSync(p, 0o755);
    } catch {
      /* never existed, or already gone */
    }
  }
  fs.rmSync(fx.base, { recursive: true, force: true });
}

/**
 * chmod 000 does not deny root, and a suite run as root would assert
 * nothing. Confirm the kernel really refuses this process before relying on
 * it, rather than writing a test that silently passes for the wrong reason.
 */
function reallyUnreadable(dir) {
  try {
    fs.readdirSync(dir);
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// The leak itself
// ---------------------------------------------------------------------------

test('issue #22 trigger A: a granted root that is gone is named virtually, never in host terms', async (t) => {
  const fx = mkRoots();
  t.after(() => rmRoots(fx));

  // The operator renamed it -- the exact shape from the issue (`mv ws3b
  // ws3b.away`). The grant still names the old path, so this is a live
  // directory in the client's address space that resolves to nothing.
  fs.renameSync(fx.b, `${fx.b}.away`);

  const server = spawnServer(['--allowed-dir', fx.a, '--allowed-dir', fx.b]);
  t.after(() => server.close());

  const r = await server.callTool('fs_grep', { pattern: 'probe', path: '/d1' });

  assert.equal(r.isError, true);
  assert.ok(
    !allText(r).includes(fx.b),
    `fs_grep named the real host path: ${allText(r)}`
  );
  assert.ok(!allText(r).includes(fx.base), 'the layout above the grant must not appear either');
  // Not just "does not leak": it says what fs_find and fs_glob say.
  assert.equal(allText(r), 'directory not found: /d1');
});

test('issue #22 trigger B: a granted root that cannot be read is named virtually, never in host terms', async (t) => {
  const fx = mkRoots();
  t.after(() => rmRoots(fx));

  fs.chmodSync(fx.b, 0o000);
  if (!reallyUnreadable(fx.b)) {
    t.skip('this process can read a mode-000 directory (running as root?)');
    return;
  }

  const server = spawnServer(['--allowed-dir', fx.a, '--allowed-dir', fx.b]);
  t.after(() => server.close());

  const explicit = await server.callTool('fs_grep', { pattern: 'probe', path: '/d1' });
  assert.equal(explicit.isError, true);
  assert.ok(!allText(explicit).includes(fx.b), `fs_grep named the real host path: ${allText(explicit)}`);
  assert.equal(allText(explicit), 'directory not readable: /d1');

  // The half of this trigger that needs no `path` argument at all: the
  // default-scope search an agent makes constantly. The readable root's
  // matches still come back -- one unreadable root does not zero the answer
  // -- and the reply says plainly that it is a floor.
  const scoped = await server.callTool('fs_grep', { pattern: 'probe' });
  const text = allText(scoped);
  assert.ok(!text.includes(fx.b), `fs_grep named the real host path: ${text}`);
  assert.ok(!text.includes(fx.base), 'the layout above the grant must not appear either');
  if (rgAvailable) {
    assert.match(text, /\/d0\/notes\/a\.md/, 'the readable root\'s match must survive');
    assert.match(text, /floor, not a complete answer/);
    assert.match(text, /\/d1/, 'the floor note must name the unreadable root -- in virtual form');
  }
});

test('issue #22: a mistyped directory is an ordinary error, not "this is a bug in fsmcp"', async (t) => {
  const fx = mkRoots();
  t.after(() => rmRoots(fx));

  const server = spawnServer(['--allowed-dir', fx.a, '--allowed-dir', fx.b]);
  t.after(() => server.close());

  const r = await server.callTool('fs_grep', { pattern: 'a', path: '/d0/nodir' });

  assert.equal(r.isError, true);
  // The backstop is an alarm. An agent that mistypes a path must not be told
  // its filesystem server is broken and asked to file a bug.
  assert.doesNotMatch(allText(r), /this is a bug in fsmcp/i);
  assert.doesNotMatch(allText(r), /internal error/i);
  // fs_find and fs_glob's exact answer for the identical condition.
  assert.equal(allText(r), 'directory not found: /d0/nodir');

  const find = await server.callTool('fs_find', { pattern: 'a', path: '/d0/nodir' });
  const glob = await server.callTool('fs_glob', { pattern: '*', path: '/d0/nodir' });
  assert.equal(allText(find), allText(r), 'fs_grep must agree with fs_find about this condition');
  assert.equal(allText(glob), allText(r), 'fs_grep must agree with fs_glob about this condition');
});

test('issue #22: one unreadable directory inside a granted tree does not discard the matches', async (t) => {
  if (!rgAvailable) {
    t.skip('needs a real ripgrep: only the rg backend exits 2 for a partial failure');
    return;
  }
  const fx = mkRoots();
  t.after(() => rmRoots(fx));

  const sec = path.join(fx.a, 'sec');
  fs.mkdirSync(sec);
  fs.writeFileSync(path.join(sec, 's.md'), 'probe hidden\n');
  fs.chmodSync(sec, 0o000);
  if (!reallyUnreadable(sec)) {
    t.skip('this process can read a mode-000 directory (running as root?)');
    return;
  }

  const server = spawnServer(['--allowed-dir', fx.a]);
  t.after(() => server.close());

  // ripgrep exits 2 for ANY error it hit, including one it walked past --
  // so a single mode-000 file or directory anywhere under a real project
  // tree used to turn the whole search into an error (and, before the fix,
  // into the backstop's generic refusal, since the offending path was the
  // root followed by "/"). The matches it did find are real.
  const r = await server.callTool('fs_grep', { pattern: 'probe', path: '/d0' });

  assert.notEqual(r.isError, true, `a partial failure must not discard the matches: ${allText(r)}`);
  assert.match(allText(r), /\/d0\/notes\/a\.md/);
  assert.match(allText(r), /floor, not a complete answer/);
  // The floor note rides on a SUCCESS result, which redactLeakedHostPaths is
  // isError-scoped and structurally cannot inspect (PR #10). Nothing built
  // from ripgrep's own text may go in it.
  assert.ok(!allText(r).includes(fx.a), `the floor note leaked a host path: ${allText(r)}`);
});

// ---------------------------------------------------------------------------
// The backstop's boundary class, tested directly
// ---------------------------------------------------------------------------

test('issue #22: the backstop treats "<granted root>: reason" as a leak', () => {
  const labels = [{ label: 'd0', hostDir: '/Users/someone/ws3' }];
  const fires = (text) =>
    redactLeakedHostPaths({ content: [{ type: 'text', text }], isError: true }, labels)
      .content[0].text.startsWith('fsmcp: internal error');

  // The one-character gap that was issue #22: a colon is what every Unix
  // tool puts after a path, ripgrep included.
  assert.equal(fires('rg: /Users/someone/ws3: Permission denied (os error 13)'), true);
  // Node's own errno text quotes the path instead.
  assert.equal(fires("EACCES: permission denied, scandir '/Users/someone/ws3'"), true);
  assert.equal(fires('failed at /Users/someone/ws3, giving up'), true);
  assert.equal(fires('see (/Users/someone/ws3) for details'), true);
  // The cases that always worked, still working.
  assert.equal(fires('/Users/someone/ws3/sub: nope'), true);
  assert.equal(fires('/Users/someone/ws3'), true);
  assert.equal(fires('/Users/someone/ws3\nmore'), true);

  // And the reason the boundary test exists at all: an unrelated sibling
  // that merely shares a prefix is NOT the granted directory. Letters,
  // digits, ".", "-" and "_" are ordinary characters inside a directory
  // name and must never be read as the end of one.
  assert.equal(fires('/Users/someone/ws3-old/x: nope'), false);
  assert.equal(fires('/Users/someone/ws3b: Permission denied'), false);
  assert.equal(fires('/Users/someone/ws3.bak: gone'), false);
});

// ---------------------------------------------------------------------------
// fs_find, same root cause: ripgrep's exit 2 discarded
// ---------------------------------------------------------------------------

test('issue #22 (fs_find): an unreadable granted root is an error, not "No matches found."', async (t) => {
  const fx = mkRoots();
  t.after(() => rmRoots(fx));

  fs.chmodSync(fx.b, 0o000);
  if (!reallyUnreadable(fx.b)) {
    t.skip('this process can read a mode-000 directory (running as root?)');
    return;
  }

  const server = spawnServer(['--allowed-dir', fx.a, '--allowed-dir', fx.b]);
  t.after(() => server.close());

  const r = await server.callTool('fs_find', { pattern: 'md', path: '/d1' });
  assert.equal(r.isError, true, `"No matches found." is a claim about a directory fs_find never opened: ${allText(r)}`);
  assert.equal(allText(r), 'directory not readable: /d1');
  assert.ok(!allText(r).includes(fx.b));
});

test('issue #22 (fs_find): one unreadable root does not zero the matches from the readable ones', async (t) => {
  if (!rgAvailable) {
    t.skip('needs a real ripgrep: the Node walker skips an unreadable directory per-directory already');
    return;
  }
  const fx = mkRoots();
  t.after(() => rmRoots(fx));

  fs.chmodSync(fx.b, 0o000);
  if (!reallyUnreadable(fx.b)) {
    t.skip('this process can read a mode-000 directory (running as root?)');
    return;
  }

  const server = spawnServer(['--allowed-dir', fx.a, '--allowed-dir', fx.b]);
  t.after(() => server.close());

  // `rg --files` exits 2 because of wsB and fs_find used to throw away the
  // listing it had already produced for wsA with it, answering "No matches
  // found." -- a success, about files it had in hand.
  const r = await server.callTool('fs_find', { pattern: 'md' });
  assert.match(allText(r), /\/d0\/notes\/a\.md/, `a readable root's files must survive: ${allText(r)}`);
  assert.match(allText(r), /floor over the files that could be listed/);
  assert.ok(!allText(r).includes(fx.b), `fs_find named the real host path: ${allText(r)}`);
});
