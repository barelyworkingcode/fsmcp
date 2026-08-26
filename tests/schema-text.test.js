'use strict';

/**
 * Every path ARGUMENT's schema description used to say "Absolute path to
 * the file" (or "directory", "destination") -- true before issue #7, and
 * actively misleading after it: `decodeInboundPath` refuses a host path as
 * an address, and the refusal deliberately does not echo what was sent
 * (PR #10), so a client that follows the OLD schema text into sending a
 * host path has almost nothing to learn from the reply. Hermes's end-to-end
 * pass through relay worked out "/d0/..." addressing from live results
 * without ever reading the schema; the next client may not be so lucky, and
 * schema text a client never has to guess around is the whole point of a
 * schema.
 *
 * These are pinned against a live `tools/list` response, not the source
 * strings, so a description that regresses to the old wording (or a new
 * tool added without going through `virtualPathDescription`) fails here
 * regardless of which file it happened in.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnServer } = require('./helpers');

// Every argument name, across all ten tools, that addresses a path rather
// than describing one (pattern/glob/type/content/old_string/new_string are
// not path arguments and are deliberately excluded).
const PATH_ARG_NAMES = new Set(['file_path', 'path', 'source', 'destination']);

test('every path argument\'s schema text describes a virtual address, not a host path', async (t) => {
  const server = spawnServer([]);
  t.after(() => server.close());

  const res = await server.request('tools/list', {});
  const tools = res.result.tools;
  assert.ok(tools.length >= 10, `expected at least 10 tools, got ${tools.length}`);

  let pathArgsChecked = 0;

  for (const tool of tools) {
    for (const [propName, propSchema] of Object.entries(tool.inputSchema.properties)) {
      if (!PATH_ARG_NAMES.has(propName)) continue;
      pathArgsChecked++;
      const desc = propSchema.description;

      assert.doesNotMatch(
        desc,
        /absolute path/i,
        `${tool.name}.${propName} still describes itself as an absolute path: ${desc}`
      );

      // The description must describe the address SHAPE without asserting a
      // concrete label: labels are assigned per call (vpath.ts's
      // assignLabels) and are not known when this static schema is built,
      // so naming one (e.g. "/d0") here would be wrong for any caller whose
      // only label is something else.
      assert.match(
        desc,
        /<label>/,
        `${tool.name}.${propName} does not describe the /<label>/... address shape: ${desc}`
      );
      assert.doesNotMatch(
        desc,
        /\/d0\b/,
        `${tool.name}.${propName} names a concrete label ("d0"), which may not exist for every caller: ${desc}`
      );
    }
  }

  // Sanity: this suite is only meaningful if it actually walked every path
  // argument fsmcp publishes -- file_path (read/write/edit), path
  // (glob/grep/list/find/mkdir/delete), source+destination (move).
  assert.equal(pathArgsChecked, 11, `expected 11 path-argument schema entries across all tools, saw ${pathArgsChecked}`);
});

test('fs_glob\'s own description no longer promises absolute paths', async (t) => {
  const server = spawnServer([]);
  t.after(() => server.close());

  const res = await server.request('tools/list', {});
  const glob = res.result.tools.find((tool) => tool.name === 'fs_glob');
  assert.ok(glob, 'fs_glob must be published');
  assert.doesNotMatch(glob.description, /absolute path/i, `fs_glob's description still claims absolute paths: ${glob.description}`);
  assert.match(glob.description, /<label>/, `fs_glob's description should describe the virtual address shape: ${glob.description}`);
});
