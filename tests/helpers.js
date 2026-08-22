'use strict';

const { spawn } = require('child_process');
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

module.exports = { spawnServer };
