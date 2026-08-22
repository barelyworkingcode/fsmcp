'use strict';

/**
 * fs_grep used to build ripgrep's command line as a *string*
 * (`execSync(rgArgs.join(' '))`), so the caller-supplied `pattern`, `glob`
 * and `type` were parsed by /bin/sh. A pattern of
 *
 *     hello; touch /tmp/CANARY; echo done
 *
 * produced `rg -n -- hello; touch /tmp/CANARY; echo done <dir>` -- three
 * commands. `allowed_dirs` governs none of them, and fs_grep is annotated
 * `readOnlyHint: true`, so this handed arbitrary command execution to the
 * most restricted grant relay can issue.
 *
 * These tests must not depend on ripgrep being installed (it is not, on the
 * host this was found on -- which is the only reason the hole never fired
 * there). Two independent angles:
 *
 *  - a stand-in `rg` placed early on the server's PATH, which records the
 *    argv it was handed. This is the strong one: it asserts the *filesystem*
 *    (a canary file that a shell would have created and did not) rather than
 *    the tool's success sentence, and it shows the `;` arriving at ripgrep as
 *    text.
 *  - a direct unit test of `buildRgArgs`, which needs no `rg` at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnServer } = require('./helpers');
const { buildRgArgs } = require('../dist/tools/grep');

/**
 * A stand-in for ripgrep, early on PATH. It answers `--version` (so fsmcp's
 * load-time probe reports ripgrep available and the rg path is the one under
 * test) and otherwise appends its argv, as JSON, to $FAKE_RG_LOG.
 *
 * Written as a node script with an absolute shebang so it does not depend on
 * a shell or on `env` resolution.
 */
function makeFakeRg(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(dir, 'rg-argv.log');
  const script = `#!${process.execPath}
const fs = require('fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  console.log('ripgrep 99.9.9 (test stand-in)');
  process.exit(0);
}
fs.appendFileSync(process.env.FAKE_RG_LOG, JSON.stringify(argv) + '\\n');
console.log('fake-rg-ran');
`;
  const rg = path.join(bin, 'rg');
  fs.writeFileSync(rg, script);
  fs.chmodSync(rg, 0o755);
  return { bin, log };
}

function mkFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-inj-'));
  const allowed = path.join(root, 'allowed');
  fs.mkdirSync(allowed);
  fs.writeFileSync(path.join(allowed, 'haystack.txt'), 'hello world\n');
  const { bin, log } = makeFakeRg(root);
  const canary = path.join(root, 'CANARY-INJECTION');
  return { root, allowed, bin, log, canary };
}

function readArgvLog(log) {
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

async function grepWithFakeRg(fx, args) {
  const server = spawnServer(['--allowed-dir', fx.allowed], {
    env: {
      PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
      FAKE_RG_LOG: fx.log,
    },
  });
  try {
    return await server.callTool('fs_grep', args);
  } finally {
    server.close();
  }
}

test('a ";" in a grep pattern does not run a second command (canary is not created)', async () => {
  const fx = mkFixture();
  try {
    const pattern = `hello; touch ${fx.canary}; echo done`;
    await grepWithFakeRg(fx, { pattern, path: fx.allowed, output_mode: 'content' });

    // The filesystem is the assertion, not the tool's reply. Under the old
    // string-joined execSync this file exists.
    assert.equal(
      fs.existsSync(fx.canary),
      false,
      `command injection: ${fx.canary} was created by a grep pattern`
    );

    const calls = readArgvLog(fx.log);
    assert.equal(calls.length, 1, 'expected the search to invoke rg exactly once');
    const argv = calls[0];
    assert.ok(
      argv.includes(pattern),
      `the whole pattern must reach rg as ONE argv element; got ${JSON.stringify(argv)}`
    );
    // ...and nothing else may have been split out of it.
    assert.equal(argv.filter((a) => a.includes('touch')).length, 1);
    assert.ok(!argv.includes('touch'), 'the pattern was split on whitespace by a shell');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('command substitution in a grep pattern is text, not a subshell', async () => {
  const fx = mkFixture();
  try {
    // Both spellings; either one being evaluated creates the canary.
    const pattern = 'hello$(touch ' + fx.canary + ')`touch ' + fx.canary + '`';
    await grepWithFakeRg(fx, { pattern, path: fx.allowed });

    assert.equal(
      fs.existsSync(fx.canary),
      false,
      `command substitution ran: ${fx.canary} exists`
    );
    const argv = readArgvLog(fx.log)[0];
    assert.ok(argv.includes(pattern), `pattern must arrive verbatim; got ${JSON.stringify(argv)}`);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a shell redirect in a grep pattern writes no file', async () => {
  const fx = mkFixture();
  try {
    const pattern = `hello > ${fx.canary}`;
    await grepWithFakeRg(fx, { pattern, path: fx.allowed });

    assert.equal(fs.existsSync(fx.canary), false, 'a ">" in the pattern was honoured as a redirect');
    const argv = readArgvLog(fx.log)[0];
    assert.ok(argv.includes(pattern));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('the glob and type filters are argv elements too, not shell source', async () => {
  const fx = mkFixture();
  try {
    await grepWithFakeRg(fx, {
      pattern: 'hello',
      path: fx.allowed,
      glob: `*.ts; touch ${fx.canary}`,
      type: 'ts',
    });

    assert.equal(fs.existsSync(fx.canary), false, 'injection through the `glob` argument');
    const argv = readArgvLog(fx.log)[0];
    assert.ok(
      argv.includes(`*.ts; touch ${fx.canary}`),
      `glob must arrive as one element; got ${JSON.stringify(argv)}`
    );
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

// --- buildRgArgs, with no ripgrep and no server involved --------------------

test('buildRgArgs keeps a pattern with shell metacharacters as a single element', () => {
  const pattern = 'hello; touch /tmp/pwned; echo done';
  const argv = buildRgArgs(pattern, ['/some/dir'], undefined, undefined, 'content', undefined, undefined);

  const dashdash = argv.indexOf('--');
  assert.ok(dashdash !== -1, 'expected the -- terminator');
  assert.equal(argv[dashdash + 1], pattern, 'the pattern must be exactly one argv element, verbatim');
  assert.deepEqual(argv.slice(dashdash + 2), ['/some/dir']);
});

test('buildRgArgs never emits an element that is two shell words glued together', () => {
  const argv = buildRgArgs(
    'a b c',
    ['/dir one', '/dir two'],
    '*.{ts,js}',
    'ts',
    'content',
    3,
    5
  );
  // Every flag and every value stands alone; nothing was pre-joined.
  assert.deepEqual(argv, [
    '-n', '-C', '3',
    '--glob', '*.{ts,js}',
    '--type', 'ts',
    '--max-count', '5',
    '--', 'a b c', '/dir one', '/dir two',
  ]);
});

test('buildRgArgs does not prepend the program name (it is argv, not a command line)', () => {
  const argv = buildRgArgs('x', ['/d'], undefined, undefined, 'files_with_matches', undefined, undefined);
  assert.ok(!argv.includes('rg'), 'the program name belongs in execFileSync, not in the argv array');
  assert.deepEqual(argv, ['-l', '--', 'x', '/d']);
});

test('a newline in a pattern is one element, not two commands', () => {
  const pattern = 'hello\ntouch /tmp/pwned';
  const argv = buildRgArgs(pattern, ['/d'], undefined, undefined, 'count', undefined, undefined);
  assert.equal(argv[argv.indexOf('--') + 1], pattern);
});
