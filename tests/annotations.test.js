'use strict';

/**
 * Every tool published by fsmcp must carry both MCP annotations --
 * `readOnlyHint` and `openWorldHint` -- explicitly, as JSON booleans, under
 * their exact spellings.
 *
 * Why both matter and why "absent" is never neutral:
 *
 *   - Per the MCP spec, `openWorldHint` DEFAULTS TO TRUE. relay reads an
 *     absent hint as "this tool reaches outside the machine" and refuses it
 *     under any grant that does not allow external access. fsmcp published
 *     no `openWorldHint` at all until this change, which meant every one of
 *     its local-filesystem-only tools -- fs_read, fs_glob, fs_grep,
 *     fs_write, fs_edit -- was silently treated as reaching the network.
 *
 *   - relay's access-mode check reads an absent `readOnlyHint` as
 *     "mutating". fs_write and fs_edit mutate, so that default happened to
 *     be correct for them by accident, but fs_read, fs_glob and fs_grep
 *     already carried an explicit `readOnlyHint: true` -- the absence
 *     problem was openWorldHint's alone before this change.
 *
 * fs_bash (readOnlyHint: false, openWorldHint: true -- an arbitrary shell
 * reaches anywhere by construction) has since been removed outright rather
 * than fixed: allowed_dirs was never a boundary for it, so every containment
 * guarantee the rest of this server makes was void while it was registered
 * (issue #5). fs_list, fs_find, fs_mkdir, fs_move and fs_delete were added in
 * its place, each confined to allowed_dirs the same as every other tool
 * here.
 *
 * An omitted annotation is not "no opinion" to the caller consuming it; it
 * is a permission decision made by whichever field was forgotten. This test
 * pins the full, intentional table so that:
 *
 *   (a) a wrong classification for an existing tool fails loudly, and
 *   (b) a tool added later with no entry here fails loudly too, rather than
 *       silently inheriting whatever `tools/list` happens to say about it --
 *       the very failure mode this table exists to close off.
 *
 * The MCPTool type requires both fields (see src/types.ts), so (a) is also
 * caught at compile time for any tool that sets one but not the other; this
 * test is what catches a tool that sets neither, or sets the wrong values,
 * and what verifies the values survive onto the real JSON-RPC wire.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { spawnServer } = require('./helpers');

// The single source of truth for this task: every tool fsmcp is expected to
// publish, and the two hints it must carry.
//
//   fs_read, fs_glob, fs_grep,
//   fs_list, fs_find            -- read the local filesystem only.
//   fs_write, fs_edit,
//   fs_mkdir, fs_move, fs_delete -- mutate the local filesystem only.
//
// Nothing in this table is openWorldHint: true any more -- that was fs_bash
// alone (an arbitrary shell reaches anywhere by construction), and it is
// gone (issue #5, Part 1) rather than fixed.
const EXPECTED = {
  fs_read: { readOnlyHint: true, openWorldHint: false },
  fs_glob: { readOnlyHint: true, openWorldHint: false },
  fs_grep: { readOnlyHint: true, openWorldHint: false },
  fs_list: { readOnlyHint: true, openWorldHint: false },
  fs_find: { readOnlyHint: true, openWorldHint: false },
  fs_write: { readOnlyHint: false, openWorldHint: false },
  fs_edit: { readOnlyHint: false, openWorldHint: false },
  fs_mkdir: { readOnlyHint: false, openWorldHint: false },
  fs_move: { readOnlyHint: false, openWorldHint: false },
  fs_delete: { readOnlyHint: false, openWorldHint: false },
};

async function fetchTools() {
  const server = spawnServer([]);
  try {
    const resp = await server.request('tools/list', {});
    return resp.result.tools;
  } finally {
    server.close();
  }
}

test('tools/list publishes exactly the expected set of tool names', async () => {
  const tools = await fetchTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(
    names,
    Object.keys(EXPECTED).sort(),
    'a tool was added or removed without updating this pinned table -- ' +
      'classify its readOnlyHint/openWorldHint (see EXPECTED above) rather ' +
      'than letting it default'
  );
});

for (const [name, expected] of Object.entries(EXPECTED)) {
  test(`${name} publishes readOnlyHint: ${expected.readOnlyHint}`, async () => {
    const tools = await fetchTools();
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} was not present in tools/list`);
    assert.ok(tool.annotations, `${name} published no annotations object at all`);
    assert.equal(
      tool.annotations.readOnlyHint,
      expected.readOnlyHint,
      `${name}.annotations.readOnlyHint should be ${expected.readOnlyHint}`
    );
  });

  test(`${name} publishes openWorldHint: ${expected.openWorldHint}`, async () => {
    const tools = await fetchTools();
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} was not present in tools/list`);
    assert.ok(tool.annotations, `${name} published no annotations object at all`);
    assert.equal(
      tool.annotations.openWorldHint,
      expected.openWorldHint,
      `${name}.annotations.openWorldHint should be ${expected.openWorldHint}`
    );
  });
}

test('every tool carries both hints -- none is left to the absent-means-something default', async () => {
  const tools = await fetchTools();
  const missing = [];
  for (const tool of tools) {
    const ann = tool.annotations;
    if (!ann || typeof ann.readOnlyHint !== 'boolean' || typeof ann.openWorldHint !== 'boolean') {
      missing.push(tool.name);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `these tools are missing readOnlyHint and/or openWorldHint: ${missing.join(', ')}`
  );
});

test('the hints reach the real JSON-RPC wire as JSON booleans under their exact spellings', async () => {
  // Bypass the JSON-RPC client's own parsing and inspect the raw bytes on
  // the wire, because relay matches the exact key spelling and JSON
  // true/false rather than, say, the string "true" or a differently-cased
  // key -- a client-side helper that coerces types could hide either bug.
  const server = spawnServer([]);
  try {
    const raw = await new Promise((resolve, reject) => {
      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString();
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          server.child.stdout.off('data', onData);
          resolve(buf.slice(0, nl));
        }
      };
      server.child.stdout.on('data', onData);
      server.child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n'
      );
      setTimeout(() => {
        server.child.stdout.off('data', onData);
        reject(new Error('timed out waiting for tools/list on the wire'));
      }, 10000);
    });

    for (const [name, expected] of Object.entries(EXPECTED)) {
      // Look for the literal key:value substrings for this tool's block.
      // Locate the tool by name first so a false match in another tool's
      // annotations cannot pass this test for the wrong reason.
      const marker = `"name":"${name}"`;
      const idx = raw.indexOf(marker);
      assert.ok(idx !== -1, `raw wire JSON did not contain a tool named "${name}"`);
      // The annotations object for this tool sits within a bounded window
      // after its name key; 2000 chars comfortably covers one tool's schema.
      const window = raw.slice(idx, idx + 4000);
      assert.match(
        window,
        /"annotations":\{/,
        `${name}'s wire JSON has no "annotations" object`
      );
      assert.match(
        window,
        new RegExp(`"readOnlyHint":${expected.readOnlyHint}\\b`),
        `${name} should carry "readOnlyHint":${expected.readOnlyHint} verbatim on the wire`
      );
      assert.match(
        window,
        new RegExp(`"openWorldHint":${expected.openWorldHint}\\b`),
        `${name} should carry "openWorldHint":${expected.openWorldHint} verbatim on the wire`
      );
    }
  } finally {
    server.close();
  }
});
