'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
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

module.exports = { spawnServer, makeFakeRg, readArgvLog };
