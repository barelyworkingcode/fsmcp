'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnServer } = require('./helpers');

/**
 * Two questions this file answers, which the escape matrix does not.
 *
 * The matrix proves fsmcp refuses to *traverse* a symlink that leads out of
 * the sandbox. That leaves the prior question unasked: can a caller create
 * one? Every containment argument in security.ts is about resolving links
 * that already exist, and all of it is worth nothing if a tool in this
 * surface can plant a fresh link pointing wherever the caller likes and then
 * walk through it -- the sandbox would hand out its own escape hatch, and
 * every path in the resulting traversal would be honestly, correctly
 * validated on the way.
 *
 * The answer today is that no tool can, because no tool calls a
 * link-creating syscall. That is a property of the whole source tree rather
 * than of any one handler, so it is asserted against the source tree: a
 * per-tool test would pass unchanged on the day someone adds an eleventh
 * tool that does.
 *
 * The second half is path spellings that mean something other than they
 * look like -- the ones a validator built around path.resolve tends to miss.
 * Individually unremarkable; collectively they are the shapes an escape
 * attempt actually arrives in.
 */

// The complete set of Node fs calls that create a new name for existing
// bytes, or a name that resolves somewhere else. `copyFile` is here not
// because it makes a link but because it writes to a destination that no
// handler in this tree validates -- if one appears, that destination needs
// the same checkPath treatment fs_move's does, and this test is the prompt
// to go and look.
//
// Anchored on `fs.` and terminated with a word boundary, because the bare
// substrings do not mean what they look like: `linkSync` is inside both
// `unlinkSync` and `readlinkSync`, and `link(` is inside `unlink(`. A
// substring search here reports the two calls fsmcp legitimately makes to
// *remove* and to *read* a link as though they created one -- and a test
// that cries wolf on correct code gets loosened, then deleted.
const LINK_PRIMITIVES = [
  /\bfs\.symlinkSync\b/,
  /\bfs\.symlink\b/,
  /\bfs\.linkSync\b/,
  /\bfs\.link\b/,
  /\bfs\.copyFileSync\b/,
  /\bfs\.copyFile\b/,
  /\bfs\.cpSync\b/,
];

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Strip comments before searching. security.ts discusses symlinks at length
 * and names `fs.realpathSync` in prose to explain why it is *not* used; a
 * grep that counted those would fail on documentation, train whoever hits it
 * to loosen the pattern, and cost the test its meaning.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('no tool can create a symlink or a hard link', () => {
  const src = path.join(__dirname, '..', 'src');
  const offenders = [];

  for (const file of sourceFiles(src)) {
    const code = stripComments(fs.readFileSync(file, 'utf-8'));
    for (const primitive of LINK_PRIMITIVES) {
      const hit = code.match(primitive);
      if (hit) {
        offenders.push(`${path.relative(src, file)}: ${hit[0]}`);
      }
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    'a link-creating syscall appeared in src/. If this is deliberate, the new ' +
      'tool must validate the *destination* the way fs_move does, and it must ' +
      'refuse to create a link whose target resolves outside allowed_dirs -- ' +
      'otherwise the sandbox now issues its own escape hatches. Do not just ' +
      'add the call to LINK_PRIMITIVES.'
  );
});

test('the mutating syscall surface is exactly the five calls we have argued about', () => {
  const src = path.join(__dirname, '..', 'src');
  const found = new Set();

  // Every fs call that changes something on disk. Read-only calls (stat,
  // lstat, readdir, readlink, readFile, existsSync) are deliberately not
  // listed: they cannot plant anything, and enumerating them would make this
  // a test about churn rather than about capability.
  const MUTATORS = /fs\.(writeFileSync|mkdirSync|unlinkSync|renameSync|rmSync|appendFileSync|truncateSync|chmodSync|chownSync|utimesSync|createWriteStream|openSync)/g;

  for (const file of sourceFiles(src)) {
    const code = stripComments(fs.readFileSync(file, 'utf-8'));
    for (const m of code.matchAll(MUTATORS)) found.add(m[1]);
  }

  assert.deepStrictEqual(
    [...found].sort(),
    ['mkdirSync', 'renameSync', 'rmSync', 'unlinkSync', 'writeFileSync'],
    'the set of ways fsmcp can change the filesystem has changed. Each of ' +
      'these five has a containment argument attached to it somewhere in ' +
      'src/; a sixth needs one written before it ships. openSync in ' +
      'particular would be the right way to fix TOCTOU (O_NOFOLLOW) and the ' +
      'wrong way to do anything else.'
  );
});

/**
 * Path spellings that resolve somewhere other than where they read. Each is
 * a single fs_read, and the assertion is on the *bytes*: a refusal message
 * proves nothing on its own, because a tool that silently returned an empty
 * result would also fail to contain the canary.
 */
test('path spellings that mean something other than they look like', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-spell-'));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  const CANARY = 'CANARY-SPELLING-4417';

  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), CANARY);
  fs.writeFileSync(path.join(root, 'a.txt'), 'in scope');
  fs.symlinkSync('.', path.join(root, 'L_self'));
  fs.symlinkSync('L_loopB', path.join(root, 'L_loopA'));
  fs.symlinkSync('L_loopA', path.join(root, 'L_loopB'));

  const server = spawnServer(['--allowed-dir', root]);

  const cases = [
    ['a percent-encoded ".." is a filename, not a traversal', `${root}/..%2f..%2foutside/secret.txt`],
    ['a doubled separator does not hide the ".."', `${root}//../outside/secret.txt`],
    ['interleaved "." segments do not absorb the ".."', `${root}/./././../outside/secret.txt`],
    ['more ".." than there are components stops at the root', `${root}/../../../../../../../etc/passwd`],
    ['a trailing separator on a file path', `${root}/../outside/secret.txt/`],
    ['a trailing "." component', `${root}/../outside/secret.txt/.`],
    ['a self-referential symlink chain does not launder the ".."', `${root}/L_self/L_self/L_self/../outside/secret.txt`],
    ['a symlink cycle is refused rather than hanging', `${root}/L_loopA`],
    // On a case-insensitive volume the kernel would open this; the check is
    // case-sensitive, so it refuses. That is the fail-closed direction --
    // worth pinning so a future "normalise the case" change has to argue
    // with a test rather than quietly opening the other direction.
    ['a case-drifted root does not match the allowed dir', `${root.toUpperCase()}/../outside/secret.txt`],
  ];

  try {
    for (const [name, filePath] of cases) {
      await t.test(name, async () => {
        const result = await server.callTool('fs_read', { file_path: filePath });
        const text = JSON.stringify(result);
        assert.ok(!text.includes(CANARY), `leaked the canary via: ${filePath}`);
        assert.ok(!text.includes('root:x:'), `leaked /etc/passwd via: ${filePath}`);
        assert.strictEqual(result.isError, true, `must refuse, not return empty: ${filePath}`);
      });
    }

    await t.test('a NUL byte is refused by name, not passed to a syscall', async () => {
      const result = await server.callTool('fs_read', {
        file_path: `${root}/a.txt${String.fromCharCode(0)}/../../outside/secret.txt`,
      });
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /NUL/);
    });

    await t.test('the server survived every one of them', async () => {
      const result = await server.callTool('fs_read', { file_path: path.join(root, 'a.txt') });
      assert.strictEqual(result.isError, undefined);
      assert.match(result.content[0].text, /in scope/);
    });
  } finally {
    server.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/**
 * fs_list reports an entry's type but not a symlink's target. The target of
 * an in-scope link can point anywhere, so printing it would disclose an
 * out-of-scope path name through a tool that is otherwise fully contained --
 * the same class as the fs_glob leak, where the bytes were refused but the
 * names were not.
 *
 * What it does still report is the entry's own st_size, which for a symlink
 * is the length of the target string. That is a known, accepted residue: it
 * discloses one integer about a path the caller cannot read, name, or reach.
 */
test('fs_list names a symlink but never its target', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-listleak-'));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'L_secret'));
  fs.symlinkSync('/etc', path.join(root, 'L_etc'));

  const server = spawnServer(['--allowed-dir', root]);
  try {
    const result = await server.callTool('fs_list', { path: root });
    const text = result.content[0].text;

    assert.ok(text.includes('L_secret'), 'the link itself is in scope and should be listed');
    assert.ok(text.includes('symlink'), 'and should be identified as a symlink');
    assert.ok(!text.includes(outside), 'but its target must not be named');
    assert.ok(!/\/etc(\s|$)/.test(text), 'nor the /etc target of the other link');
  } finally {
    server.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
