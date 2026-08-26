'use strict';

/**
 * The `initialize` handshake is the only thing relay ever reads to decide
 * what kind of grant fsmcp can be given and what it will tell the client
 * about its own confinement. Nothing downstream reports back: every failure
 * mode here is silent from fsmcp's side, which is why these are wire tests
 * against a real spawned `dist/main.js` rather than assertions about a
 * literal in src/.
 *
 * The key this file exists for is `allowed_dirs.disclose: "count"`
 * (fsmcp#15 / relay#33). Relay appends a scope note built from this field
 * into EVERY governed tool's `description` at tools/list time, so a client
 * that never sees a host path in any fsmcp *result* could still read one out
 * of its own tool list -- a live Hermes run did exactly that and repeated the
 * sandbox's absolute host path to its operator, unprompted, while fsmcp
 * itself had emitted none.
 *
 * Both ways of getting the spelling wrong are silent, and both were
 * confirmed against a live relay:
 *
 *   - A CASE NEAR-MISS (`"Count"`) makes relay refuse the ENTIRE schema. It
 *     logs `disclose is "Count", which is not the keyword "count"` at
 *     connect time and then lists NONE of fsmcp's tools -- every tool
 *     withheld from every grant. fsmcp is handed no error and keeps serving
 *     a handshake that looks perfectly well-formed from here.
 *
 *   - An UNRECOGNISED word (`"hidden"`, `"redact"`, `"none"` is recognised
 *     but wrong for a different reason) is IGNORED rather than refused, and
 *     the note then renders the raw value -- i.e. the host path is back, the
 *     leak is reopened, and from fsmcp's side it looks like success.
 *
 * So the assertions below are deliberately exact-string and deliberately
 * enumerate the near-misses: an edit to ANY other spelling has to fail here,
 * because nothing else in the stack will ever say so.
 *
 * `"count"` and not `"none"` is a judgement, not an oversight, and is pinned
 * for the same reason: an agent that cannot see its own limits behaves
 * worse, not better (relay's docs/access-profiles.md records one concluding
 * a mailbox was "accessible through every tool" having been refused every
 * time). "Confined to N values" is the boundary without the coordinates.
 *
 * The rest of the declaration is pinned here as a regression net. Those keys
 * were load-bearing before this change -- absent `contextSchemaVersion: 2`
 * relay falls back to v1 parsing and a remote access profile cannot be
 * granted fsmcp at all -- and adding a key must not have disturbed them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { spawnServer } = require('./helpers');

// The complete, intentional `allowed_dirs` declaration. Compared with a
// deep-equal rather than key by key so that an ADDED key fails too: relay
// parses this object as a whole, and a key fsmcp did not mean to publish is
// as much a change to what relay is told as a missing one.
const EXPECTED_ALLOWED_DIRS = {
  type: 'array',
  items: { type: 'string' },
  description: 'Directories this client may read, search and modify within',
  scope: 'restrict',
  source: 'operator',
  applies_to: ['fs_*'],
  enumerable: false,
  disclose: 'count',
};

// Spellings that must never appear. Each one is a real failure with a
// distinct blast radius, and none of them is reported back to fsmcp:
//
//   "Count"/"COUNT"/"cOuNt" -- case near-miss; relay refuses the whole
//                              schema and withholds all ten tools.
//   " count"/"count "       -- relay matches the keyword exactly, with no
//                              trimming, so whitespace is a near-miss too.
//   "none"                  -- recognised by relay, but hides the fact of
//                              confinement from the agent (see header).
//   "value"                 -- relay's absent-default; the host path renders
//                              and this change accomplishes nothing.
//   "hidden"/"redact"/"counts"/"" -- unrecognised; IGNORED, so the value
//                              renders. The fail-open direction.
const FORBIDDEN_SPELLINGS = [
  'Count',
  'COUNT',
  'cOuNt',
  ' count',
  'count ',
  'none',
  'value',
  'hidden',
  'redact',
  'counts',
  '',
];

/** The parsed `initialize` result, from a freshly spawned real server. */
async function initializeResult() {
  const server = spawnServer([]);
  try {
    const resp = await server.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'fsmcp-context-schema-test', version: '0' },
    });
    assert.ok(resp && resp.result, 'initialize returned no result');
    return resp.result;
  } finally {
    server.close();
  }
}

/**
 * The same handshake, but the undecoded line of bytes the server actually
 * wrote to stdout. Relay reads JSON, not this suite's client object, and a
 * client-side helper is exactly the sort of thing that could coerce a type
 * or normalise a case and hide the bug this file is about.
 */
async function rawInitializeLine() {
  const server = spawnServer([]);
  try {
    return await new Promise((resolve, reject) => {
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
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'fsmcp-context-schema-test', version: '0' },
          },
        }) + '\n'
      );
      setTimeout(() => {
        server.child.stdout.off('data', onData);
        reject(new Error('timed out waiting for initialize on the wire'));
      }, 10000);
    });
  } finally {
    server.close();
  }
}

test('initialize declares allowed_dirs.disclose as exactly the string "count"', async () => {
  const result = await initializeResult();
  const schema = result.serverInfo && result.serverInfo.contextSchema;
  assert.ok(schema, 'initialize published no contextSchema at all');
  const field = schema.allowed_dirs;
  assert.ok(field, 'contextSchema published no allowed_dirs field');

  // Strict === against the lowercase keyword: no trim(), no toLowerCase(),
  // no regex. Relay matches the keyword byte for byte and reports nothing
  // back either way, so this assertion is the only place a wrong spelling
  // can be caught before it reaches a live grant.
  assert.strictEqual(
    field.disclose,
    'count',
    'allowed_dirs.disclose must be the byte-exact keyword "count" -- a case ' +
      'near-miss makes relay refuse the whole schema (no tools at all), and ' +
      'an unrecognised word is silently ignored (host path renders again)'
  );
  assert.strictEqual(typeof field.disclose, 'string', 'disclose must be a JSON string');
});

test('allowed_dirs.disclose is none of the near-miss spellings', async () => {
  const result = await initializeResult();
  const disclose = result.serverInfo.contextSchema.allowed_dirs.disclose;
  for (const wrong of FORBIDDEN_SPELLINGS) {
    assert.notStrictEqual(
      disclose,
      wrong,
      `allowed_dirs.disclose is ${JSON.stringify(wrong)} -- see FORBIDDEN_SPELLINGS ` +
        'above for what that costs; nothing downstream will tell fsmcp about it'
    );
  }
  // Belt and braces for a spelling nobody thought to enumerate: anything
  // that is not the exact keyword is one of the two silent failures.
  assert.strictEqual(disclose, 'count');
});

test('"disclose":"count" appears verbatim on the JSON-RPC wire', async () => {
  const raw = await rawInitializeLine();

  // Read the value out of the actual bytes rather than trusting a parse:
  // this is what relay's decoder sees.
  const m = raw.match(/"disclose"\s*:\s*"([^"]*)"/);
  assert.ok(m, `initialize's wire JSON carries no "disclose" key at all:\n${raw}`);
  assert.strictEqual(
    m[1],
    'count',
    'the value on the wire must be the exact keyword; relay does not ' +
      'normalise case or whitespace before matching it'
  );
  assert.match(raw, /"disclose":"count"/, 'expected the literal bytes "disclose":"count"');

  // A near-miss anywhere in the handshake is a bug even if some other
  // "disclose" also happens to be right.
  for (const wrong of FORBIDDEN_SPELLINGS) {
    if (wrong === '') continue;
    assert.ok(
      !raw.includes(`"disclose":"${wrong}"`),
      `wire JSON contains "disclose":"${wrong}"`
    );
  }

  // The key is only meaningful on a restrict-scoped field, and it must be
  // on `allowed_dirs` specifically -- not on some sibling relay does not
  // govern. Locate it relative to the field name in the raw bytes.
  const fieldIdx = raw.indexOf('"allowed_dirs"');
  assert.ok(fieldIdx !== -1, 'wire JSON has no allowed_dirs field');
  assert.ok(
    raw.indexOf('"disclose":"count"') > fieldIdx,
    'the disclose keyword must sit inside the allowed_dirs declaration'
  );
});

test('the allowed_dirs declaration is exactly the intended set of keys and values', async () => {
  const result = await initializeResult();
  // deepEqual over the whole object: `scope`, `source`, `applies_to`,
  // `enumerable`, `type`/`items` and the description text were all
  // load-bearing before disclose existed (v1 fallback, remote-profile
  // grants, the enumeration the UI must not attempt), and adding a key is
  // exactly the kind of edit that disturbs a neighbour.
  assert.deepStrictEqual(
    result.serverInfo.contextSchema.allowed_dirs,
    EXPECTED_ALLOWED_DIRS,
    'the allowed_dirs context-schema declaration changed -- every keyword ' +
      'here is matched byte-exact by relay'
  );
});

test('contextSchemaVersion is still the number 2 and contextSchema still declares only allowed_dirs', async () => {
  const result = await initializeResult();
  const info = result.serverInfo;
  // The number 2, not the string "2": absent or unparsed, relay reads the
  // whole block as v1, which derives allowed_dirs from a project path -- and
  // a remote access profile has none, so fsmcp becomes ungrantable there.
  assert.strictEqual(info.contextSchemaVersion, 2);
  assert.strictEqual(typeof info.contextSchemaVersion, 'number');
  assert.deepStrictEqual(Object.keys(info.contextSchema), ['allowed_dirs']);
  assert.strictEqual(info.name, 'fsmcp');
});

test('contextSchemaVersion reaches the wire as a JSON number, not a quoted string', async () => {
  const raw = await rawInitializeLine();
  assert.match(raw, /"contextSchemaVersion":2(?!\d)/);
  assert.ok(
    !raw.includes('"contextSchemaVersion":"2"'),
    'contextSchemaVersion must not be quoted -- relay would fall back to v1 parsing'
  );
});

test('the initialize handshake still names no host path of its own', async () => {
  // The whole point of disclose:"count" is that relay stops rendering the
  // grant's host paths. That is worthless if fsmcp reintroduces one in the
  // handshake itself -- e.g. an "example" or a default in the description
  // text. The description is operator-facing prose about what the field
  // means, and must stay free of anything absolute.
  const result = await initializeResult();
  const desc = result.serverInfo.contextSchema.allowed_dirs.description;
  assert.strictEqual(typeof desc, 'string');
  assert.ok(
    !/(^|[\s"'(])\/(?:Users|home|private|var|tmp|etc)\b/.test(desc),
    `allowed_dirs description embeds a host-looking path: ${JSON.stringify(desc)}`
  );
});

test('every published tool still declares both annotations as explicit booleans', async () => {
  // Regression net, not a test of this change (tests/annotations.test.js
  // pins the full per-tool table). It is restated against the same handshake
  // because relay reads BOTH halves of it to build a grant: this schema
  // decides whether fsmcp can be granted at all, and `readOnlyHint` decides
  // whether a tool is admitted to a `read` grant. An absent or non-boolean
  // readOnlyHint reads as "mutating", so a tool would vanish from a
  // read-only profile with nothing said about it -- the same silent shape as
  // the disclose near-miss above.
  const server = spawnServer([]);
  try {
    const resp = await server.request('tools/list', {});
    const tools = resp.result.tools;
    assert.ok(Array.isArray(tools) && tools.length > 0, 'tools/list published no tools');
    const bad = [];
    for (const tool of tools) {
      const ann = tool.annotations;
      if (!ann) {
        bad.push(`${tool.name}: no annotations object`);
        continue;
      }
      if (typeof ann.readOnlyHint !== 'boolean') {
        bad.push(`${tool.name}: readOnlyHint is ${JSON.stringify(ann.readOnlyHint)}`);
      }
      if (typeof ann.openWorldHint !== 'boolean') {
        bad.push(`${tool.name}: openWorldHint is ${JSON.stringify(ann.openWorldHint)}`);
      }
    }
    assert.deepStrictEqual(bad, [], bad.join('; '));
  } finally {
    server.close();
  }
});
