'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const MAIN_JS = path.join(__dirname, '..', 'dist', 'main.js');

/**
 * Spawn a real fsmcp server (dist/main.js) with the given CLI args and give
 * back a small JSON-RPC client over its stdio. Used for the integration
 * tests that need to observe how _meta.allowed_dirs and --allowed-dir
 * actually combine at the wire, not just how validatePath() behaves in
 * isolation.
 */
function spawnServer(args = [], opts = {}) {
  const child = spawn(process.execPath, [MAIN_JS, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // `env` lets a test put a stand-in executable early on PATH. fs_grep
    // resolves `rg` through PATH in the *server* process, so this is the only
    // way to observe the argv ripgrep is actually handed on a host that has
    // no ripgrep installed.
    env: opts.env ? { ...process.env, ...opts.env } : { ...process.env },
  });

  let nextId = 1;
  const pending = new Map();
  let buf = '';

  const rl = readline.createInterface({ input: child.stdout, terminal: false });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  function request(method, params) {
    const id = nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for response to ${method} (stderr: ${stderr})`));
      }, 10000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  async function callTool(name, toolArgs, meta) {
    const params = { name, arguments: toolArgs };
    if (meta !== undefined) params._meta = meta;
    const resp = await request('tools/call', params);
    return resp.result;
  }

  function close() {
    rl.close();
    child.stdin.end();
    child.kill();
  }

  // `stderr()` is a getter rather than the accumulated string itself
  // because the string is appended to as the child runs -- a snapshot taken
  // at spawn time would always be empty. fsmcp writes operator-only detail
  // there deliberately (vpath.ts's duplicate-label refusal, main.ts's
  // dropped-_meta report), so a test that pins "the client is told the fact
  // and the operator is told the paths" has to be able to read both halves.
  return { request, callTool, close, child, stderr: () => stderr };
}

/**
 * A stand-in for ripgrep, to be placed early on a server's PATH.
 *
 * It answers `--version` (so fsmcp's load-time probe reports ripgrep
 * available and the rg path is the one exercised) and otherwise appends its
 * argv, as JSON, to $FAKE_RG_LOG. Written as a node script with an absolute
 * shebang so it depends on no shell and on no `env` resolution.
 *
 * Options:
 *   sleepMs          - emit one line of output and then block for this long,
 *                      to exercise the call timeout. The line is written with
 *                      fs.writeSync so it really reaches the pipe before the
 *                      process is killed, which is what makes it a *partial*
 *                      result rather than nothing.
 *   versionExitCode  - make the `--version` probe fail, which forces fsmcp to
 *                      use its pure-Node fallback. Lets a test pin fallback
 *                      behaviour on a host that does have ripgrep installed.
 */
function makeFakeRg(dir, opts = {}) {
  const sleepMs = opts.sleepMs || 0;
  const versionExitCode = opts.versionExitCode || 0;
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(dir, 'rg-argv.log');
  const script = `#!${process.execPath}
const fs = require('fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  console.log('ripgrep 99.9.9 (test stand-in)');
  process.exit(${versionExitCode});
}
fs.appendFileSync(process.env.FAKE_RG_LOG, JSON.stringify(argv) + '\\n');
const sleepMs = ${sleepMs};
if (sleepMs > 0) {
  fs.writeSync(1, 'PARTIAL-MATCH-LINE\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
  process.exit(0);
}
console.log('fake-rg-ran');
`;
  const rg = path.join(bin, 'rg');
  fs.writeFileSync(rg, script);
  fs.chmodSync(rg, 0o755);
  return { bin, log };
}

/**
 * Poll `predicate` until it is true, or fail after `timeoutMs`.
 *
 * Needed for anything that asserts on a server's STDERR: stdout and stderr
 * are two separate pipes, so the 'data' event carrying a diagnostic line is
 * not ordered against the JSON-RPC response that shares the same handler
 * turn. Awaiting the response therefore proves nothing about stderr having
 * arrived yet, and a bare assertion on it is a race that passes locally and
 * fails on a loaded machine. Polling, rather than a fixed sleep, keeps the
 * happy path fast and still gives a slow one room.
 */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition still false after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Read back the argv arrays a makeFakeRg stand-in recorded. */
function readArgvLog(log) {
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/**
 * Issue #7: build the virtual-space address a test should send over the wire
 * for a path it constructed in host terms. `rootHostDir` is the allowed
 * directory that address's label stands for; `label` defaults to "d0"
 * because every fixture in this suite passes a single, unlabelled
 * `--allowed-dir`, which src/vpath.ts's assignLabels always names "d0" (the
 * first, and only, entry of the effective scope).
 *
 * This is a literal string replace of the `rootHostDir` PREFIX, not a real
 * path.join: src/vpath.ts's virtualToHost is deliberately literal
 * concatenation rather than a lexically-normalising join, precisely so a
 * caller-supplied "../.." after the label reaches canonicalizePath's
 * kernel-style walk unresolved rather than pre-collapsed -- this helper has
 * to preserve that same shape, or a test built with it would stop
 * exercising the exact escape it names. `hostPath` therefore must actually
 * start with `rootHostDir`; anything else is a test construction bug, not a
 * case this helper is meant to handle (see OUTSIDE_HOST_PATH below for a
 * path that has no virtual form at all, on purpose).
 */
function toVirtual(hostPath, rootHostDir, label = 'd0') {
  if (hostPath === rootHostDir) return `/${label}`;
  if (!hostPath.startsWith(rootHostDir)) {
    throw new Error(`toVirtual: ${JSON.stringify(hostPath)} does not start with ${JSON.stringify(rootHostDir)}`);
  }
  // rootHostDir === "/" (the --allowed-dir / opt-out) is the one case
  // slicing off just rootHostDir's own length leaves the path's leading "/"
  // glued straight onto the label with no separator of its own -- mirrors
  // the fix in src/vpath.ts's hostToVirtual, for the same reason.
  const sep = rootHostDir.endsWith('/') ? rootHostDir : `${rootHostDir}/`;
  return `/${label}/${hostPath.slice(sep.length)}`;
}

/**
 * Like toVirtual, for a host path that is NOT a descendant of `rootHostDir`
 * -- a sibling directory outside the grant, the shape most "in -> out" /
 * "out -> in" containment cases in this suite need. Built with
 * `path.relative`, which climbs out with a literal ".." the same way a
 * caller who already knows the shape of the filesystem around their grant
 * could type one by hand; canonicalizePath (security.ts) then resolves that
 * ".." against the REAL directory tree, exactly as it would for any other
 * caller-supplied "..". This is a different, weaker guarantee than
 * toVirtual's literal-suffix preservation (path.relative is free to
 * normalise the middle of the path however Node likes), which is fine here
 * because these cases are testing "does validatePath's containment check
 * still refuse a path that climbs out of its root", not pinning one exact
 * string shape for the traversal the way the escape-matrix's ".."-through-
 * a-symlink cases do.
 */
function toVirtualVia(targetHostPath, rootHostDir, label = 'd0') {
  return `/${label}/${path.relative(rootHostDir, targetHostPath)}`;
}

/**
 * A raw host path is refused as an address by itself -- issue #7 does not
 * accept one as a convenience alongside the virtual form, precisely so a
 * client cannot use a guessable host path as a probe. Tests that want to
 * pin THAT refusal (as opposed to a `toVirtual`-built address that decodes
 * to something canonicalizePath then refuses) use this constant so the
 * intent reads at the call site instead of an unexplained absolute string.
 */
const NOT_A_VIRTUAL_PATH = /is not a valid address/i;

/**
 * A unique string that identifies bait content living outside the escape
 * matrix fixture's allowed dir. Used instead of a plain word ("secret") so a
 * false positive can't be explained away as a coincidental substring match
 * somewhere in the fixture's own in-scope content.
 */
const OUTSIDE_CANARY = 'CANARY-6f19a3-outside-secret-must-never-be-named-in-scope';

/**
 * Build the fixture root from issue #5, Part 5 -- programmatically, in a
 * fresh temp dir, so it never collides with a real path on the machine
 * running the suite and never leaves anything checked into the repo. Each
 * test that needs it calls this itself and cleans up with removeFixture in
 * a t.after, rather than sharing one fixture across tests: several of the
 * cases here (fs_delete, fs_move) mutate the fixture, and a shared instance
 * would make one test's cleanup order change another test's answer.
 *
 * Layout (bait deliberately outside `root`, so "refused" and "no result"
 * stay distinguishable -- a tool that can't see outside root and a tool
 * that was refused permission to look would otherwise produce the same
 * empty answer):
 *
 *   <testRoot>/root/                  <- the only allowed_dir
 *       a.txt
 *       notes/note1.txt
 *       deep/nested/dirs/
 *       link-out       -> <testRoot>/fake-etc   (dir symlink, out of scope)
 *       link-out-file  -> ../../outside/secret.txt
 *       dangling       -> ../../outside/nothere (target never created)
 *       sub/link-up    -> ../..
 *   <testRoot>/outside/               <- never in scope
 *       secret.txt                    <- contains OUTSIDE_CANARY
 *   <testRoot>/fake-etc/              <- a stand-in for /etc, NOT /etc itself
 *       passwd                       <- contains its own canary string
 *
 * `fake-etc` stands in for the real `/etc` in the containment-write-and-
 * delete cases (row 12): pointing `link-out` at the actual `/etc` would mean
 * a bug in the code under test could really touch the host's /etc, which is
 * exactly the kind of test failure that shouldn't exist. The real /etc is
 * used exactly once, in escape-matrix.test.js's own read-only symlink case,
 * and never for anything that writes or deletes.
 *
 * realpath'd up front: on macOS, os.tmpdir() is reached through the
 * /var -> /private/var symlink, so every path built under it is *itself*
 * behind a symlink hop before the fixture's own symlinks even come into
 * play. Without resolving that first, every "inside root" assertion below
 * would be comparing an unresolved path against validatePath's resolved
 * answer and would fail for a reason that has nothing to do with what the
 * test is checking.
 */
function buildScopeFixture() {
  const testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-escape-')));
  const root = path.join(testRoot, 'root');
  const outside = path.join(testRoot, 'outside');
  const fakeEtc = path.join(testRoot, 'fake-etc');

  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(fakeEtc, { recursive: true });

  fs.writeFileSync(path.join(root, 'a.txt'), 'inside a.txt\n');
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'notes', 'note1.txt'), 'a note\n');
  fs.mkdirSync(path.join(root, 'deep', 'nested', 'dirs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });

  fs.writeFileSync(path.join(outside, 'secret.txt'), OUTSIDE_CANARY);
  fs.writeFileSync(path.join(fakeEtc, 'passwd'), 'root:x:0:0:fake-etc-standin-not-the-real-thing\n');

  // Directory symlink pointing clean out of scope, at the /etc stand-in.
  fs.symlinkSync(fakeEtc, path.join(root, 'link-out'));
  // Relative symlink to a specific file outside, for the "write through a
  // symlink" case (row 4).
  fs.symlinkSync(path.join('..', '..', 'outside', 'secret.txt'), path.join(root, 'link-out-file'));
  // Dangling symlink: its target is never created, so a write through it
  // would be the only thing that ever brings that path into existence --
  // which is exactly what row 5 must prove never happens.
  fs.symlinkSync(path.join('..', '..', 'outside', 'nothere'), path.join(root, 'dangling'));
  // sub/link-up -> ../.. resolves (kernel-style, from the symlink's own
  // directory `root/sub`) to testRoot. Combined with a query path that
  // appends its own "../.." after it, this is the exact shape
  // security.ts's canonicalizePath docstring warns about: a lexical
  // (string-collapsing) resolver cancels "link-up/../.." against "sub" and
  // reads the whole thing as staying inside root, while the kernel resolves
  // the symlink first and applies ".." to *that*, landing well outside.
  fs.symlinkSync(path.join('..', '..'), path.join(root, 'sub', 'link-up'));

  return { testRoot, root, outside, fakeEtc, canary: OUTSIDE_CANARY };
}

/** Remove everything buildScopeFixture created. */
function removeFixture(fixture) {
  fs.rmSync(fixture.testRoot, { recursive: true, force: true });
}

module.exports = {
  spawnServer,
  waitFor,
  makeFakeRg,
  readArgvLog,
  buildScopeFixture,
  removeFixture,
  OUTSIDE_CANARY,
  toVirtual,
  toVirtualVia,
  NOT_A_VIRTUAL_PATH,
};
