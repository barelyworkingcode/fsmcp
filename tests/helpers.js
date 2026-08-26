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

  return { request, callTool, close, child };
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

module.exports = { spawnServer, makeFakeRg, readArgvLog, buildScopeFixture, removeFixture, OUTSIDE_CANARY };
