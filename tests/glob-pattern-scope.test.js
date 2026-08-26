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
 *
 * Issue #36: **#25's rule was right and its enforcement was not.** The two
 * checks were regexes over the RAW pattern text, and glob does not walk the
 * raw text -- it walks the component list minimatch produces from it.
 * `[.][.]/*` and `\.\./*` parse to exactly the same components as `../*` and
 * neither regex saw a `..` in either. So the tests below come in two
 * families now, and the second one is the point:
 *
 *  - the SPELLING family (`../*`, `[.][.]/*`, `\.\./*`, `{[.][.],sub}/*`)
 *    must all get the identical refusal, because a rule that enumerates
 *    spellings is a rule that will be escaped again;
 *  - the WALK family asserts a property that does not mention the pattern at
 *    all: a pattern aimed above the grant does not walk what is up there, and
 *    cannot, whatever it is spelled like.
 *
 * A test that only checked the new spellings would be the same mistake one
 * layer along -- it would pass against a third regex.
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

test('a ".." glob itself has already removed is not refused; one it keeps is (#36)', async (t) => {
  const fx = buildFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  // **This assertion was reversed by issue #36, and the reasoning it used to
  // carry was reversed with it.** #25 refused `sub/../top.txt` as well, on
  // the grounds that "a pattern is not resolved to one path -- a pattern
  // with a wildcard before the '..' does not have a single answer to
  // resolve -- so there is nothing to hand the containment check", and that
  // resolving some patterns and not others would leave a boundary a caller
  // could probe.
  //
  // The premise was true of a REGEX over the pattern text. It is not true of
  // glob's own parser, which is what decides this now: minimatch collapses
  // `<literal>/..` itself, before the walk, so the components glob is handed
  // for `sub/../top.txt` are literally `['top.txt']`. There is no `..` left
  // to contain, no path arithmetic happens, and refusing it would be
  // refusing a pattern that provably cannot climb. Where the collapse does
  // NOT happen -- a magic component next to the `..`, or a globstar before
  // it -- the `..` survives into the component list and is refused.
  //
  // The boundary #25 worried about is real and is not probeable: it is drawn
  // by the pattern text alone, never by what is on disk. `sub/../top.txt`
  // and `nosuchdir/../top.txt` are both walked as `top.txt` and give the
  // identical answer, so nothing about the host is visible across it.
  const collapsed = await glob(fx.grant, 'sub/../top.txt');
  assert.ok(!collapsed.isError, `expected a success, got: ${textOf(collapsed)}`);
  assert.deepStrictEqual(textOf(collapsed).split('\n').filter(Boolean), ['/d0/top.txt']);

  const missing = await glob(fx.grant, 'nosuchdir/../top.txt');
  assert.strictEqual(textOf(missing), textOf(collapsed),
    'a pattern naming a directory that exists is distinguishable from one that does not');

  // ...and every shape where the `..` survives the parse is still refused.
  // Note the first one: minimatch's collapse runs on the raw string parts,
  // before a one-member character class is normalised to that member, so
  // `sub/[.][.]/top.txt` keeps its `..` where `sub/../top.txt` loses it.
  // Two spellings of one pattern, answered differently -- reported rather
  // than smoothed over, because smoothing it over means predicting the
  // parser again, and it costs nothing: both answers are decided by the
  // pattern text alone, both are the same on every host, and the refusal is
  // the conservative side of the pair.
  for (const pattern of ['sub/[.][.]/top.txt', '**/../top.txt', 'sub/../../*', '*/../../top.txt']) {
    const result = await glob(fx.grant, pattern);
    assert.ok(result.isError, `${pattern}: expected a refusal, got: ${textOf(result)}`);
    assert.strictEqual(result._meta && result._meta.scope_violation, true);
  }
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

// ---------------------------------------------------------------------------
// Issue #36 -- the ".." refusal was bypassable, and the walk left the grant
// ---------------------------------------------------------------------------

/**
 * Every way of writing a `..` path component that this repository knows
 * about, plus the shapes that combine one with brace expansion.
 *
 * They are listed as data rather than folded into one clever pattern on
 * purpose: `../*` was the only one #25 refused, and the other five reached
 * the filesystem. What matters is not that this list is complete -- it is
 * not, and cannot be, which is the whole reason the containment moved into
 * the walk -- but that every entry gets the SAME answer, which is the
 * property a list-based rule cannot have.
 */
const DOTDOT_SPELLINGS = [
  '../*',            // the literal, the only one #25 caught
  '[.][.]/*',        // a character class per dot -- minimatch normalises it to '..'
  '\\.\\./*',        // escaped dots -- same
  '.[.]/*',          // one of each
  '[.]./*',          // the other way round
  '{[.][.],sub}/*',  // hidden in a brace alternative, first
  '{sub,[.][.]}/*',  // hidden in a brace alternative, second
  '[.][.]/[.][.]/*', // twice
  '[.][.]/[.][.]/[.][.]/**/*', // three times, with a globstar under it
];

test('every spelling of a ".." component gets the identical refusal (#36)', async (t) => {
  const fx = buildFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  // Measured on the merged #25 build, against this exact fixture shape:
  // `../*` was refused and `[.][.]/*`, `\.\./*`, `[.][.]/[.][.]/*` all came
  // back `ok`, `{[.][.],sub}/*` came back `ok` with the in-grant hit, and
  // `[.][.]/[.][.]/[.][.]/**/*` walked the tree above the grant.
  const literal = await glob(fx.grant, '../*');
  assert.ok(literal.isError);

  for (const pattern of DOTDOT_SPELLINGS) {
    const result = await glob(fx.grant, pattern);
    assert.ok(result.isError, `${pattern}: expected a refusal, got: ${textOf(result)}`);
    assert.strictEqual(result._meta && result._meta.scope_violation, true,
      `${pattern}: must carry _meta.scope_violation: ${JSON.stringify(result)}`);
    assert.strictEqual(textOf(result), textOf(literal),
      `${pattern}: refused with different words than "../*" -- a caller can tell the spellings apart`);
    assert.ok(!textOf(result).includes('secret.txt'), `${pattern}: hits leaked: ${textOf(result)}`);
    assert.ok(!textOf(result).includes(pattern), `${pattern}: the refusal echoed the pattern`);
  }
});

test('a ".." spelling cannot be used to confirm a host directory name (#36)', async (t) => {
  const fx = buildFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  // This is #25's oracle, reached through the spelling #25 did not refuse.
  // On the merged build these three answered, in order: "/d0/top.txt",
  // "No matches found.", "/d0/top.txt" -- so a caller could climb out of the
  // grant, guess the grant's own directory name a character at a time, and
  // read the answer off whether the reply was empty. It is also the case a
  // pruned walk cannot close on its own: a correct guess climbs out and
  // comes straight back IN, so no candidate outside the grant is ever
  // offered to the walk's own containment hook. That is why the refusal is
  // derived from glob's parser and not only from the walk.
  const name = path.basename(fx.grant);
  const correct = await glob(fx.grant, `[.][.]/${name}/*`);
  const wrong = await glob(fx.grant, `[.][.]/${name.slice(0, -1)}X/*`);
  const narrowing = await glob(fx.grant, `[.][.]/[a-r]${name.slice(1)}/*`);

  assert.strictEqual(textOf(correct), textOf(wrong),
    'a correct host-directory guess is distinguishable from a wrong one');
  assert.strictEqual(textOf(correct), textOf(narrowing));
  assert.ok(correct.isError && wrong.isError && narrowing.isError);
  assert.ok(!textOf(correct).includes('top.txt'), `hits leaked: ${textOf(correct)}`);
});

/**
 * A grant with a large tree living OUTSIDE it, one level up.
 *
 * `dirs` is what costs the walk time -- glob descends per directory -- so
 * this is sized for a walk that is comfortably longer than the noise floor
 * while still building in well under a second.
 */
function buildAboveGrantFixture(dirs = 6000) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-glob36-')));
  const grant = path.join(root, 'grant');
  fs.mkdirSync(grant, { recursive: true });
  fs.writeFileSync(path.join(grant, 'top.txt'), 'in scope\n');
  const outside = path.join(root, 'outside');
  for (let i = 0; i < dirs; i++) {
    const d = path.join(outside, `d${i}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'f.txt'), 'OUT-OF-SCOPE-36\n');
  }
  return { root, grant, outside };
}

async function timedGlob(root, pattern, opts = {}) {
  const server = spawnServer([], opts.env ? { env: opts.env } : {});
  try {
    await server.request('initialize', {});
    const started = Date.now();
    const result = await server.callTool('fs_glob', { pattern }, { allowed_dirs: [root] });
    return { result, ms: Date.now() - started };
  } finally {
    server.close();
  }
}

test('a pattern aimed above the grant does not walk what is up there, and never reaches the budget (#36)', async (t) => {
  const fx = buildAboveGrantFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  // Self-calibrating rather than a fixed millisecond threshold: the same
  // tree is walked twice, once by a call that is ALLOWED to walk it (the
  // whole fixture root is the grant) and once by a call that is pointed at
  // it from below with a `..`. The first measures what walking it costs on
  // whatever machine is running this; the second must not pay that cost,
  // because it must not walk. A wall-clock constant here would either be
  // flaky on a loaded machine or so loose it proved nothing.
  const allowed = await timedGlob(fx.root, 'outside/**/*');
  assert.ok(!allowed.result.isError, `calibration walk failed: ${textOf(allowed.result)}`);
  assert.ok(allowed.ms > 120,
    `calibration walk was too fast (${allowed.ms}ms) for this comparison to mean anything; grow the fixture`);

  // The budget is deliberately set BELOW what walking that tree costs, which
  // is what separates the two things this has to distinguish. Issue #36
  // measured a walk running 44.08s against a 30s budget, so "it finishes
  // eventually" is not the property to pin. A build that merely bounds the
  // walk returns AT the budget; a build that cannot walk out of the grant at
  // all returns in the noise, long before it.
  const budgetMs = Math.max(50, Math.floor(allowed.ms / 2));
  const aimedUp = await timedGlob(fx.grant, '[.][.]/outside/**/*', {
    env: { FSMCP_GREP_TIMEOUT_MS: String(budgetMs) },
  });

  // The containment claim.
  assert.ok(aimedUp.result.isError, `expected a refusal, got: ${textOf(aimedUp.result)}`);
  assert.strictEqual(aimedUp.result._meta && aimedUp.result._meta.scope_violation, true);
  assert.ok(!textOf(aimedUp.result).includes('OUT-OF-SCOPE-36'));
  assert.ok(!/cut short/.test(textOf(aimedUp.result)),
    'a pattern that may not walk should be refused, not reported as a truncated walk');

  // The bound. On the merged #25 build this call took as long as the
  // calibration walk (measured on this fixture: 86ms against an 89ms walk of
  // the same tree; on a 24,000-file tree, 723-818ms against 49ms in-grant)
  // and returned `ok`.
  assert.ok(aimedUp.ms < budgetMs,
    `took ${aimedUp.ms}ms of a ${budgetMs}ms budget for a pattern that must not walk at all`);
  assert.ok(aimedUp.ms < allowed.ms / 4,
    `a pattern aimed above the grant took ${aimedUp.ms}ms against a ${allowed.ms}ms walk of the same tree -- it walked it`);
});

test('an in-grant walk over a symlink that escapes is still a success, not a scope violation (#36)', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-glob36-link-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const grant = path.join(root, 'grant');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(grant, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(grant, 'in.txt'), 'in scope\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUT-OF-SCOPE-36\n');
  fs.symlinkSync(outside, path.join(grant, 'linkdir'));

  // The walk's containment hook and the "the walk left the grant" refusal
  // are deliberately NOT the same test. A symlink inside a grant pointing
  // out of it is an ordinary thing to find in an ordinary tree, and the
  // long-standing behaviour -- drop the hits, answer normally -- must not
  // become a refusal now that the walk asks the containment question itself.
  // What the refusal means is "the WALK left the grant", not "something out
  // of scope was noticed".
  for (const pattern of ['*/*', '**/*', 'linkdir/*']) {
    const result = await glob(grant, pattern);
    assert.ok(!result.isError, `${pattern}: expected a success, got: ${textOf(result)}`);
    assert.ok(!textOf(result).includes('secret.txt'),
      `${pattern}: a name from outside the grant reached the caller: ${textOf(result)}`);
  }

  // ...and the in-grant file is still found, so the pruning did not just
  // turn the whole walk off.
  assert.deepStrictEqual(
    textOf(await glob(grant, '**/*')).split('\n').filter(Boolean),
    ['/d0/in.txt']
  );
});
