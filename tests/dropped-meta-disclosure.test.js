'use strict';

/**
 * Issue #26: the dropped-`_meta`-entries report used to name raw host paths
 * to the client, on a SUCCESS result.
 *
 * When a call's `_meta.allowed_dirs` carries an entry that is not inside any
 * `--allowed-dir` root, C1 drops it and `main.ts` appends a note saying so.
 * That note used to end `...: /Users/admin/…/ws3b` -- a real host path, in
 * a success payload, on every call for as long as the misconfiguration
 * stood.
 *
 * Nothing else in this server could have caught it, which is why it needed
 * fixing where it is produced rather than behind a backstop:
 *
 *   - `vpath.ts` translates each known path at its own construction site.
 *     These paths have no site; they are appended after every tool handler
 *     has already returned.
 *   - `redactLeakedHostPaths` is `isError`-scoped by design (PR #10), so it
 *     never sees a success result at all.
 *   - Widening it would not help either: a dropped directory is BY
 *     CONSTRUCTION absent from `ctx.labels`. The redactor works by knowing
 *     the granted roots and replacing them with their labels; this path is
 *     precisely one that is not granted, so there is nothing to map it to.
 *   - `disclose: "count"` governs what relay renders into a tool
 *     DESCRIPTION. It has nothing to do with a result payload.
 *
 * And it was reachable in the deployment fsmcp exists for, not only over
 * bare stdio: relay builds `_meta` server-side from stored context, but
 * "server-side" is not "in scope" -- register fsmcp with `--allowed-dir /A`
 * while the profile also grants `/B`, and relay sends both. `/B` is an
 * operator-configured host path the client was never granted.
 *
 * The fix follows `assignLabels`' duplicate-label split: the operator gets
 * the entries on stderr, the client gets the fact and the count.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnServer, waitFor } = require('./helpers');

function allText(result) {
  return (result.content || []).map((c) => c.text).join('\n');
}

/**
 * Two sibling directories with a deliberately distinctive name on the one
 * that will be dropped. A generic name ("b") could match a substring of the
 * result by coincidence and make a leak look like a pass, or the reverse.
 */
function mkFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-dropped-')));
  const granted = path.join(root, 'granted-root');
  const ungranted = path.join(root, 'ungranted-root-DROPPED-CANARY-4b1e7c');
  fs.mkdirSync(granted);
  fs.mkdirSync(ungranted);
  fs.writeFileSync(path.join(granted, 'a.txt'), 'in scope\n');
  fs.writeFileSync(path.join(ungranted, 'secret.txt'), 'not in scope\n');
  return { root, granted, ungranted };
}

test('a dropped _meta.allowed_dirs entry is reported to the client as a count, never as a host path', async (t) => {
  const fx = mkFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  // The exact shape from the issue: the CLI floor names one root, the
  // profile names two. This is what an operator produces by tightening the
  // registration without noticing a profile still grants a second root.
  const server = spawnServer(['--allowed-dir', fx.granted]);
  t.after(() => server.close());

  const meta = { allowed_dirs: [fx.granted, fx.ungranted] };
  const result = await server.callTool('fs_read', { file_path: '/d0/a.txt' }, meta);

  // A SUCCESS result. This is the whole reason the isError-scoped backstop
  // cannot reach it, so if this ever stops being true the test below is
  // asserting something weaker than it claims.
  assert.equal(result.isError, undefined, allText(result));
  assert.match(allText(result), /in scope/);

  // The note is still there -- C1 requires the narrowing to be visible
  // rather than silent, and an agent that cannot see it is confined behaves
  // worse, not better.
  assert.match(allText(result), /_meta\.allowed_dirs entries were dropped/i);
  assert.match(allText(result), /1 of them/);

  // ...but with no coordinates. Checked three ways, because each catches a
  // different way of half-fixing this: the whole path, the distinctive
  // basename on its own, and the temp root that every path in this fixture
  // shares (which would catch the granted root leaking too).
  assert.ok(
    !allText(result).includes(fx.ungranted),
    `the dropped entry's host path leaked to the client: ${allText(result)}`
  );
  assert.ok(
    !allText(result).includes('DROPPED-CANARY-4b1e7c'),
    `the dropped entry's basename leaked to the client: ${allText(result)}`
  );
  assert.ok(
    !allText(result).includes(fx.root),
    `a host path leaked to the client: ${allText(result)}`
  );

  // The operator's half: the entries, in full, on stderr -- the stream a
  // stdio MCP's host collects a child's diagnostics on, and not the
  // protocol stream, so it cannot corrupt a response. This is the audience
  // that needs the paths and the only one that can act on them; the client
  // cannot fix a registration.
  await waitFor(() => server.stderr().includes('_meta.allowed_dirs entries were dropped'));
  assert.ok(
    server.stderr().includes(fx.ungranted),
    `the operator was not told which entry was dropped: ${server.stderr()}`
  );
});

test('the dropped-entry note names no host path on a refusal either', async (t) => {
  const fx = mkFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const server = spawnServer(['--allowed-dir', fx.granted]);
  t.after(() => server.close());

  // The note is appended to EVERY call while the misconfiguration stands,
  // refusals included, and a refusal takes a different route out of
  // registry.call (through redactLeakedHostPaths) than a success does. Both
  // routes end at the same append in main.ts, so both need pinning -- a fix
  // applied only to the success path would leave this one leaking.
  const result = await server.callTool(
    'fs_read',
    { file_path: '/d0/nope.txt' },
    { allowed_dirs: [fx.granted, fx.ungranted] }
  );
  assert.equal(result.isError, true, allText(result));
  assert.match(allText(result), /_meta\.allowed_dirs entries were dropped/i);
  assert.ok(
    !allText(result).includes('DROPPED-CANARY-4b1e7c'),
    `the dropped entry leaked on a refusal: ${allText(result)}`
  );
});
