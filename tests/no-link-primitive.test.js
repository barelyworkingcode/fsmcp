'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnServer, toVirtual } = require('./helpers');

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

test('the mutating syscall surface is exactly the six calls we have argued about', () => {
  const src = path.join(__dirname, '..', 'src');
  const found = new Set();

  // Every fs call that changes something on disk. Read-only calls (stat,
  // lstat, readdir, readlink, readFile, existsSync) are deliberately not
  // listed: they cannot plant anything, and enumerating them would make this
  // a test about churn rather than about capability.
  const MUTATORS = /fs\.(writeFileSync|mkdirSync|unlinkSync|renameSync|rmSync|appendFileSync|truncateSync|chmodSync|chownSync|utimesSync|createWriteStream|openSync)/g;

  // `fs.openSync` is on that list because its FLAG decides whether it
  // mutates: `openSync(p, 'w')` truncates the file to zero length before
  // anything is written to it, which is precisely the non-atomic destruction
  // atomicWrite.ts exists to avoid, and `'a'`/`'w+'`/`'a+'` all create.
  // `openSync(p, 'r')` cannot create, truncate, extend or alter anything --
  // it is the read half of `pread`, and fs_read's base64 byte windowing
  // (issue #19) needs it to read a bounded window out of a large file
  // without allocating the whole file the way readFileSync would. So the
  // rule is on the flag, not on the name: a read-only open is exempt, every
  // other open is a sixth mutating primitive and has to argue for itself
  // here. `filePath` at fs_read's call site has already been through
  // decodeInboundPath + checkPathV, the same containment every other tool
  // applies, and opening it read-only adds no reach beyond the readFileSync
  // that was there before.
  const READ_ONLY_OPEN = /fs\.openSync\([^;]*?,\s*'r'\s*\)/g;

  for (const file of sourceFiles(src)) {
    const code = stripComments(fs.readFileSync(file, 'utf-8'));
    const totalOpens = (code.match(/fs\.openSync\(/g) || []).length;
    const readOnlyOpens = (code.match(READ_ONLY_OPEN) || []).length;
    assert.equal(
      readOnlyOpens,
      totalOpens,
      `${path.relative(src, file)} calls fs.openSync with a flag other than 'r'. Any other flag ` +
        `creates or truncates, which is a mutating primitive and needs its own containment ` +
        `argument -- do not relax this by widening the pattern.`
    );
    // Read-only opens are removed before the mutator scan so the assertion
    // below stays a statement about capability rather than about spelling.
    const mutatingOnly = code.replace(READ_ONLY_OPEN, 'fs.__readOnlyOpen()');
    for (const m of mutatingOnly.matchAll(MUTATORS)) found.add(m[1]);
  }

  assert.deepStrictEqual(
    [...found].sort(),
    ['chmodSync', 'mkdirSync', 'renameSync', 'rmSync', 'unlinkSync', 'writeFileSync'],
    'the set of ways fsmcp can change the filesystem has changed. Each of ' +
      'these has a containment argument attached to it somewhere in src/; ' +
      'a new one needs one written before it ships. openSync in ' +
      'particular would be the right way to fix TOCTOU (O_NOFOLLOW) and the ' +
      'wrong way to do anything else.'
  );
});

/**
 * chmodSync is the sixth, added for issue #20, and this is the argument the
 * assertion above demands before a call joins that list.
 *
 * It is here because the fifth-call budget produced a wrong answer. The
 * permission-bit preservation in atomicWrite.ts used to route the mode
 * through fs.writeFileSync's own `mode` option specifically to avoid a
 * sixth call -- and writeFileSync's `mode` is open(2)'s `mode`, which the
 * process umask masks. Under the macOS default `umask 022` a 0664 file came
 * back 0644 and a 0777 file came back 0755: the function did not preserve
 * the thing its own doc comment said it went out of its way to preserve.
 * chmod(2) does not consult the umask. So the choice was a sixth syscall or
 * a fix that does not work, and this test is the thing that makes spending
 * it deliberate rather than incidental.
 *
 * What contains it:
 *
 *   - It is called on exactly one path expression, `tmpPath`, in exactly
 *     one function. `tmpPath` is built inside writeFileAtomic from
 *     path.dirname of the target plus six random bytes; no client argument
 *     reaches it, and nothing outside that function can name it.
 *   - It runs between the writeFileSync that creates that temp file and the
 *     renameSync that consumes it, so the file it chmods is one fsmcp
 *     created microseconds earlier and is about to replace with itself.
 *   - The mode it sets is `st_mode & 0o777` of the file being replaced, so
 *     it can only restore a bit the target already had. It cannot grant a
 *     new one, and the mask means fsmcp still cannot produce a setuid,
 *     setgid or sticky file -- which matters more now than it did before,
 *     since the `cp -p` seeding step DOES carry setuid onto the temp file
 *     and this chmod is what takes it back off.
 *   - It is not a general chmod capability: there is no fs_chmod tool, and
 *     nothing in tools/ can reach this call with a path of its own choosing.
 *
 * This test pins all of that, so "chmodSync moved somewhere else" fails
 * here rather than passing quietly on the strength of the name alone.
 */
test('chmodSync exists in exactly one place, on exactly one path, and cannot set setuid', () => {
  const src = path.join(__dirname, '..', 'src');
  const sites = [];

  for (const file of sourceFiles(src)) {
    const code = stripComments(fs.readFileSync(file, 'utf-8'));
    for (const m of code.matchAll(/fs\.chmodSync\(([^)]*)\)/g)) {
      sites.push({ file: path.relative(src, file), args: m[1].trim() });
    }
  }

  assert.deepStrictEqual(
    sites,
    [{ file: 'atomicWrite.ts', args: 'tmpPath, mode & 0o777' }],
    'fsmcp may change a file mode in exactly one place: atomicWrite.ts, on its own temp ' +
      'file, to the masked mode of the file being replaced. A second call site, a different ' +
      'path expression, or a mode that is not masked to 0o777 is a new capability and needs ' +
      'its own argument -- a chmod that can take a caller-supplied path is an fs_chmod tool ' +
      'that nobody declared.'
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
  // Issue #7: `root` (the CLI's only --allowed-dir) is this call's whole
  // scope, positioned first and unlabelled, so vpath.ts's assignLabels
  // always names it "d0" -- see toVirtual's doc in helpers.js for why the
  // rewrite below is a literal prefix swap, not a path.join, and why that
  // matters for exactly the escape shapes this test constructs.
  const v = (hostPath) => toVirtual(hostPath, root);

  const cases = [
    ['a percent-encoded ".." is a filename, not a traversal', v(`${root}/..%2f..%2foutside/secret.txt`)],
    ['a doubled separator does not hide the ".."', v(`${root}//../outside/secret.txt`)],
    ['interleaved "." segments do not absorb the ".."', v(`${root}/./././../outside/secret.txt`)],
    ['more ".." than there are components stops at the root', v(`${root}/../../../../../../../etc/passwd`)],
    ['a trailing separator on a file path', v(`${root}/../outside/secret.txt/`)],
    ['a trailing "." component', v(`${root}/../outside/secret.txt/.`)],
    ['a self-referential symlink chain does not launder the ".."', v(`${root}/L_self/L_self/L_self/../outside/secret.txt`)],
    ['a symlink cycle is refused rather than hanging', v(`${root}/L_loopA`)],
  ];

  // ---------------------------------------------------------------------
  // Design finding (issue #7): the pre-#7 suite also pinned a "case-drifted
  // root does not match the allowed dir" case here --
  // `${root.toUpperCase()}/../outside/secret.txt` sent as `file_path`,
  // proving isWithinAnyDir's case-sensitive prefix compare refuses a
  // client-supplied path whose ROOT differs from the allowed dir only in
  // case.
  //
  // That case can no longer be EXPRESSED once inbound addressing is
  // virtual-only. A client never spells the host root at all any more --
  // every address is `/d0/...`, and vpath.ts's virtualToHost substitutes
  // the real, correctly-cased hostDir itself; there is no argument position
  // left for a client to smuggle a case-drifted root into. This is not a
  // narrower guarantee than before, it is the same guarantee reached a
  // different way (the client-facing surface that would have needed
  // case-sensitivity no longer exists), but it is also not the SAME test,
  // so per issue #7's instruction this is called out rather than quietly
  // dropped: canonicalizePath's own case-sensitivity is untouched and still
  // exercised at the unit level (security.test.js does not go through
  // vpath.ts at all), but nothing in this suite proves it from the wire
  // any more, because nothing on the wire can reach it any more.
  // ---------------------------------------------------------------------

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
        file_path: v(`${root}/a.txt${String.fromCharCode(0)}/../../outside/secret.txt`),
      });
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /NUL/);
    });

    await t.test('the server survived every one of them', async () => {
      const result = await server.callTool('fs_read', { file_path: v(path.join(root, 'a.txt')) });
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
    // path omitted, not root: root IS this server's whole scope, and issue
    // #7 refuses a raw host path as an argument -- omitting it (fs_list's
    // own "defaults to the allowed directories") reaches the same directory.
    const result = await server.callTool('fs_list', {});
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

/**
 * The same question as the mutating-syscall surface above, asked of the
 * other way this process can change something: subprocesses.
 *
 * Until issue #20, every spawn in this tree was ripgrep, and ripgrep only
 * reads. atomicWrite.ts now spawns `/bin/cp`, because rename(2) lands the
 * new content on a fresh inode and Node has no binding that can carry the
 * old inode's extended attributes or its ACL across -- no listxattr, no
 * getxattr, no ACL API, no FFI. macOS's copyfile(3) does it in one call and
 * `cp -p` is that call with a command line in front of it. fs.copyFileSync
 * was measured first and preserves neither, so widening LINK_PRIMITIVES
 * would have bought a forbidden call that does not even work.
 *
 * That makes `cp` the first subprocess fsmcp runs that WRITES, which is
 * exactly the kind of thing the surface test above exists to stop happening
 * by accident. The argument for it lives in atomicWrite.ts; this pins the
 * shape of it so the argument cannot quietly stop matching the code:
 *
 *   - the program is a string literal, never a variable, so no argument and
 *     no environment lookup can decide what fsmcp executes;
 *   - `cp` is spelled `/bin/cp`, absolutely. `rg` is resolved through PATH
 *     because it is an optional third-party binary with a Node fallback;
 *     `cp` has neither property, and a PATH-resolved `cp` would let anything
 *     that can prepend to PATH decide what happens to a granted file;
 *   - the argv is a literal array, so there is no shell, no quoting and no
 *     command string anywhere -- the same rule fs_grep has held since the
 *     shell-injection fix, now stated for the whole tree rather than for
 *     ripgrep alone;
 *   - the only spawn that writes lives in atomicWrite.ts and nowhere else.
 */
test('the subprocess surface is ripgrep, plus exactly one writing spawn in atomicWrite.ts', () => {
  const src = path.join(__dirname, '..', 'src');
  const spawns = [];
  const shellApis = [];

  for (const file of sourceFiles(src)) {
    const code = stripComments(fs.readFileSync(file, 'utf-8'));
    const rel = path.relative(src, file);
    for (const m of code.matchAll(/execFileSync\(\s*([^,]+),/g)) {
      spawns.push({ file: rel, program: m[1].trim() });
    }
    // execSync/spawnSync-with-shell/exec take a COMMAND STRING, which is a
    // shell. None of them has ever appeared in this tree and none may.
    for (const m of code.matchAll(/\b(execSync|spawnSync|exec|spawn|fork)\s*\(/g)) {
      if (m[1] === 'exec' || m[1] === 'spawn') {
        // `execFileSync(` already matched above; only flag a bare exec/spawn.
        continue;
      }
      shellApis.push(`${rel}: ${m[1]}`);
    }
  }

  assert.deepStrictEqual(shellApis, [], 'the only way this process may spawn anything is execFileSync with an argv array');

  // Resolve the two program identifiers this tree uses to their literal
  // values, so a rename of the constant cannot smuggle a different binary
  // past this assertion.
  const atomic = stripComments(fs.readFileSync(path.join(src, 'atomicWrite.ts'), 'utf-8'));
  assert.match(atomic, /const CP = '\/bin\/cp';/, 'CP must be the absolute path /bin/cp, not a PATH lookup');
  assert.match(
    atomic,
    /execFileSync\(CP, \['-pN', '--', from, to\], \{ stdio: 'pipe' \}\)/,
    "atomicWrite's spawn must stay a literal argv array of exactly two operands, both of which " +
      'writeFileAtomic owns: `to` is its own temp path and `from` is the target every caller has ' +
      'already validated. No -R (cannot descend), no -l/-s (cannot create a link), `--` before ' +
      'the operands.'
  );

  assert.deepStrictEqual(
    spawns.sort((a, b) => (a.file + a.program).localeCompare(b.file + b.program)),
    [
      { file: 'atomicWrite.ts', program: 'CP' },
      { file: 'tools/find.ts', program: "'rg'" },
      { file: 'tools/find.ts', program: "'rg'" },
      { file: 'tools/grep.ts', program: "'rg'" },
      { file: 'tools/grep.ts', program: "'rg'" },
    ],
    'a new subprocess appeared, or an existing one moved. Every spawn in this tree must name ' +
      'its program as a literal, and the only one that may WRITE anything is atomicWrite.ts\'s ' +
      'cp -- which is contained by the fact that both of its operands are paths writeFileAtomic ' +
      'itself owns. A spawn that takes a program name, or a path, from anywhere else needs its ' +
      'own containment argument first.'
  );
});
