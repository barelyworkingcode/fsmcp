'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnServer } = require('./helpers');

/**
 * Issue #25: `fs_glob`'s `pattern` was the one path-shaped input in this
 * server that never went through `decodeInboundPath`/`checkPathV`, and
 * `globSync` ignores `cwd` entirely for an absolute pattern -- so `pattern`
 * was a host-path traversal primitive that the validated `path` argument did
 * not bound.
 *
 * The per-hit `validatePath` filter meant no name and no byte from outside
 * the grant was ever emitted, and that is exactly why this needs its own
 * tests: what escaped was not data, it was ANSWERS. A pattern naming the
 * grant's own real location returned hits; one character wrong returned an
 * empty string; `?`/`*`/`[a-r]` turn that difference into a
 * character-by-character search of the host's layout -- the capability issue
 * #7 exists to remove, handed back by the one tool that took a pattern.
 * Filtering the output cannot close it, because the signal IS the empty
 * output.
 *
 * So the assertions here are mostly about *sameness*: a refused pattern must
 * produce the same refusal whether or not the thing it named exists. A test
 * that only checked "an out-of-scope pattern returns no files" would have
 * passed against the bug.
 *
 * The other two halves of the issue:
 *
 *  - naming somewhere out of scope was an empty SUCCESS, the only tool here
 *    where that was not a refusal; it is now a scope violation carrying
 *    `_meta.scope_violation`, like every other tool's;
 *  - the walk was unbounded, and fsmcp is one synchronous loop behind one
 *    shared relay child, so a single call blocked every other client for its
 *    whole duration. There is a wall-clock budget now, and -- the part that
 *    matters as much as the bound -- a walk cut short says so instead of
 *    returning a shorter list that reads as complete.
 */

function textOf(result) {
  return (result.content || []).map((c) => c.text).join('\n');
}

/**
 * The fixture is deliberately built under a REAL, unique temp root and the
 * probes below are built from that root's own path, so "a correct guess" is
 * genuinely correct on the machine running the suite -- a hard-coded
 * `/etc/...` alone would only prove that fsmcp refuses a directory that
 * happens not to be granted, which is a much weaker claim than the oracle
 * this closes.
 */
function buildFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-glob25-')));
  const grant = path.join(root, 'grant');
  const sibling = path.join(root, 'sibling');
  fs.mkdirSync(path.join(grant, 'sub'), { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(grant, 'sub', 'file.txt'), 'in scope\n');
  fs.writeFileSync(path.join(grant, 'top.txt'), 'in scope\n');
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'OUT-OF-SCOPE-25\n');
  return { root, grant, sibling };
}

async function glob(root, pattern, opts = {}) {
  const server = spawnServer([], opts.env ? { env: opts.env } : {});
  try {
    await server.request('initialize', {});
    return await server.callTool('fs_glob', { pattern }, { allowed_dirs: [root] });
  } finally {
    server.close();
  }
}

test('an absolute pattern is refused, and refused as a SCOPE violation', async (t) => {
  const fx = buildFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  for (const pattern of [
    '/etc/*',
    `${fx.sibling}/*`,
    `${fx.grant}/**/*`, // absolute and INSIDE the grant: still refused
  ]) {
    const result = await glob(fx.grant, pattern);
    assert.ok(result.isError, `${pattern}: expected a refusal, got: ${textOf(result)}`);
    assert.strictEqual(result._meta && result._meta.scope_violation, true,
      `${pattern}: a location out of scope must carry _meta.scope_violation: ${JSON.stringify(result)}`);
    assert.match(textOf(result), /pattern must be relative/i);
  }
});

test('the host-path oracle is closed: a correct guess and a wrong one get the identical refusal', async (t) => {
  const fx = buildFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  // Before the fix these two were distinguishable in the most useful way
  // possible: the first returned "/d0/sub/file.txt" and "/d0/top.txt", the
  // second returned "". That difference is the whole oracle -- repeat it
  // character by character and the host's directory layout falls out.
  const correct = await glob(fx.grant, `${fx.grant}/**/*`);
  const wrong = await glob(fx.grant, `${fx.grant.slice(0, -1)}X/**/*`);

  assert.strictEqual(textOf(correct), textOf(wrong),
    'a correct host-path guess is distinguishable from a wrong one');
  assert.strictEqual(correct.isError, wrong.isError);
  assert.deepStrictEqual(correct._meta, wrong._meta);
  assert.ok(!textOf(correct).includes('file.txt'), `hits leaked through an absolute pattern: ${textOf(correct)}`);
});

test('a character-class probe of the host layout is refused identically whether or not it matches', async (t) => {
  const fx = buildFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  // The same probe in its narrowing form: [a-r] vs [s-z] against the first
  // letter of "grant". Before the fix, one returned files and the other an
  // empty string, which is one bit of the host's directory name per call.
  const parent = path.dirname(fx.grant);
  const hit = await glob(fx.grant, `${parent}/[a-r]rant/**/*`);
  const miss = await glob(fx.grant, `${parent}/[s-z]rant/**/*`);
  assert.strictEqual(textOf(hit), textOf(miss));
  assert.ok(hit.isError && miss.isError);
});

test('a brace alternative cannot smuggle an absolute pattern past the check', async (t) => {
  const fx = buildFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  // Measured against the raw library: `{/etc,sub}` with a wildcard below it
  // really does return /etc/hosts, because glob expands braces and then
  // ignores `cwd` for the absolute alternative. `path.isAbsolute(pattern)`
  // does not see this one, which is why it gets its own check.
  for (const pattern of ['{/etc,sub}/*', `{sub,${fx.sibling}}/*`]) {
    const result = await glob(fx.grant, pattern);
    assert.ok(result.isError, `${pattern}: expected a refusal, got: ${textOf(result)}`);
    assert.strictEqual(result._meta && result._meta.scope_violation, true);
    assert.ok(!textOf(result).includes('secret.txt'));
  }
});

test('a ".." component in a pattern is refused, including inside a brace alternative', async (t) => {
  const fx = buildFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  for (const pattern of ['../*', './../*', 'sub/../../*', '{sub,..}/*', '..', '{..,sub}/*']) {
    const result = await glob(fx.grant, pattern);
    assert.ok(result.isError, `${pattern}: expected a refusal, got: ${textOf(result)}`);
    assert.strictEqual(result._meta && result._meta.scope_violation, true,
      `${pattern}: must carry _meta.scope_violation: ${JSON.stringify(result)}`);
    assert.match(textOf(result), /must not contain a "\.\." path component/i);
    assert.ok(!textOf(result).includes('secret.txt'));
  }
});

test('a ".." that would have stayed inside the grant is refused too -- deliberately', async (t) => {
  const fx = buildFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  // `sub/../top.txt` resolves inside the grant, and a path ARGUMENT spelled
  // that way is accepted (canonicalizePath resolves it and the containment
  // check passes). A PATTERN is not resolved to one path -- a pattern with a
  // wildcard before the ".." does not have a single answer to resolve -- so
  // there is nothing to hand the containment check, and this is refused
  // rather than guessed at. Pinned here so the over-refusal reads as the
  // decision it is rather than as an oversight someone later "fixes" by
  // resolving patterns.
  const result = await glob(fx.grant, 'sub/../top.txt');
  assert.ok(result.isError);
  assert.strictEqual(result._meta && result._meta.scope_violation, true);
});

test('the refusal never echoes the pattern back', async (t) => {
  const fx = buildFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  // An echo is not a leak on its own -- the caller wrote it -- but a refusal
  // that varies with the input is the oracle again, one level up. This is the
  // same rule decodeInboundPath follows for a rejected path argument.
  for (const pattern of [`${fx.grant}/**/*`, '/etc/passwd', '../*']) {
    const text = textOf(await glob(fx.grant, pattern));
    assert.ok(!text.includes(pattern), `the refusal echoed the pattern: ${text}`);
    assert.ok(!text.includes(fx.grant), `the refusal named a host path: ${text}`);
  }
});

test('an out-of-scope pattern is never an empty success', async (t) => {
  const fx = buildFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  // The runbook rule, as a direct assertion: two different states ("you may
  // not look there" and "there is nothing there") must not collapse into one
  // reply.
  for (const pattern of ['/etc/*', '../*']) {
    const result = await glob(fx.grant, pattern);
    assert.ok(result.isError, `${pattern}: an out-of-scope pattern came back as a success`);
    assert.notStrictEqual(textOf(result).trim(), '');
  }
});

test('ordinary relative patterns are untouched', async (t) => {
  const fx = buildFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  const recursive = textOf(await glob(fx.grant, '**/*.txt')).split('\n').filter(Boolean);
  assert.deepStrictEqual(recursive.sort(), ['/d0/sub/file.txt', '/d0/top.txt']);

  const literal = textOf(await glob(fx.grant, 'sub/*.txt')).split('\n').filter(Boolean);
  assert.deepStrictEqual(literal, ['/d0/sub/file.txt']);

  // Braces still work -- only the two shapes that can name a location are
  // refused, not brace expansion itself.
  const braced = textOf(await glob(fx.grant, '{sub,nothere}/*.txt')).split('\n').filter(Boolean);
  assert.deepStrictEqual(braced, ['/d0/sub/file.txt']);

  // A relative pattern that matches nothing says so, rather than returning
  // the bare empty string the two bugs in #21 and #25 both produced.
  assert.match(textOf(await glob(fx.grant, '**/*.nothing')), /No matches found/i);
});

test('a NUL byte in a pattern is a clean refusal, not a thrown exception', async (t) => {
  const fx = buildFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  const result = await glob(fx.grant, 'a\u0000b');
  assert.ok(result.isError, `expected a refusal, got: ${textOf(result)}`);
  assert.match(textOf(result), /NUL byte/i);
  // Malformed input, not a scope violation: the same distinction
  // basicPathError draws for a NUL in a path.
  assert.ok(!(result._meta && result._meta.scope_violation),
    'a malformed pattern is not a scope violation');
});

test('the walk is bounded in wall-clock time, and a cut-short walk says so', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-glob25-budget-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Big enough that the walk takes far longer than the 1ms budget below
  // (measured at ~15ms for this shape), so the bound is exercised rather
  // than raced. The 1000-result cap does not bound this: the pattern
  // deliberately matches NOTHING, so the old code walked every directory and
  // then returned an empty list, having done all the work anyway.
  for (let i = 0; i < 1000; i++) {
    const d = path.join(root, `d${i}`);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'f.txt'), 'x');
  }

  const cut = await glob(root, '**/*.nomatch', { env: { FSMCP_GREP_TIMEOUT_MS: '1' } });
  assert.ok(!cut.isError, `expected a success with a note, got: ${textOf(cut)}`);
  assert.match(textOf(cut), /cut short after 1ms/,
    `a truncated walk must say so, not return a shorter answer that reads as complete: ${textOf(cut)}`);
  assert.notStrictEqual(textOf(cut).trim(), '');

  // With the ordinary budget the same fixture is answered in full, so the
  // bound is a bound and not a cap on real work.
  const full = textOf(await glob(root, '**/*.txt')).split('\n').filter(Boolean);
  assert.strictEqual(full.length, 1000);
  assert.ok(!/cut short/.test(full.join('\n')));
});

test('an absolute pattern naming the RESOLVED form of a symlinked grant is refused too', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-glob25-sym-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const realTarget = path.join(root, 'real_target');
  const link = path.join(root, 'symlinked_root');
  fs.mkdirSync(path.join(realTarget, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(realTarget, 'sub', 'file.txt'), 'x\n');
  fs.symlinkSync('real_target', link);

  // The interaction between #21 and #25, pinned. #21 teaches the outbound
  // map the RESOLVED spelling of a grant, which on its own widens this
  // oracle by one spelling: an absolute pattern naming the real target
  // started coming back as real /d0/... paths where it used to come back
  // redacted. Both spellings must be refused before the walk, and for the
  // same reason -- neither of them is something a client is able to know.
  for (const pattern of [`${realTarget}/sub/*`, `${link}/sub/*`]) {
    const result = await glob(link, pattern);
    assert.ok(result.isError, `${pattern}: expected a refusal, got: ${textOf(result)}`);
    assert.strictEqual(result._meta && result._meta.scope_violation, true);
    assert.ok(!textOf(result).includes('file.txt'), `${pattern}: hits leaked: ${textOf(result)}`);
  }

  // ...and the ordinary relative pattern still works under that same grant,
  // which is #21's fix.
  const ok = textOf(await glob(link, '**/*.txt')).split('\n').filter(Boolean);
  assert.deepStrictEqual(ok, ['/d0/sub/file.txt']);
});
