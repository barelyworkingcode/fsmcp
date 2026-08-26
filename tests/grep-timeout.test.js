'use strict';

/**
 * fs_grep compiles a caller-supplied `pattern` with `new RegExp`, so the
 * caller chooses how much work the search does. `(a+)+$` against a few dozen
 * non-matching characters backtracks for longer than the machine will be up.
 *
 * The ripgrep path always had a 30s bound. The pure-Node fallback -- the path
 * taken by every host without ripgrep on PATH, including the one this was
 * found on -- had none. fsmcp is a single synchronous stdio loop, so that is
 * not a slow call: it hangs the process and every tool in it for every
 * caller.
 *
 * Both halves are tested here, and both assert that a search which stopped
 * early SAYS so. A partial answer presented as a complete one is the failure
 * that matters -- "no matches" and "I stopped looking" must not be the same
 * reply.
 *
 * These stay fast by injecting a small bound (a `budgetMs` argument, or
 * FSMCP_GREP_TIMEOUT_MS through a real server) instead of spending 30 real
 * seconds.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnServer, makeFakeRg } = require('./helpers');
const { grepFallback, GREP_TIMEOUT_MS, grepBudgetMs } = require('../dist/tools/grep');

// A pattern that backtracks catastrophically, and lines short enough that one
// line costs ~30ms rather than forever -- so the deadline check between lines
// has something to catch, and the whole file still finishes in ~2s when
// nothing bounds it.
const BOMB_PATTERN = '(a+)+$';
const BOMB_LINE = 'a'.repeat(22) + 'X';

function mkBombDir(lines = 60) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-redos-')));
  fs.writeFileSync(
    path.join(dir, 'bomb.txt'),
    Array.from({ length: lines }, () => BOMB_LINE).join('\n')
  );
  return dir;
}

test('the fallback stops a catastrophically backtracking search at its budget', () => {
  const dir = mkBombDir();
  try {
    const started = Date.now();
    const res = grepFallback(
      BOMB_PATTERN, [dir], undefined, undefined, 'files_with_matches', undefined, undefined,
      150
    );
    const elapsed = Date.now() - started;

    // Generous: the bound is checked between lines and JavaScript cannot
    // interrupt a match in progress, so one line's worth of overrun is
    // expected and documented. Unbounded, this file takes ~2s.
    assert.ok(elapsed < 1500, `search ran ${elapsed}ms against a 150ms budget -- not bounded`);
    assert.match(res.content[0].text, /stopped after 150ms/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a truncated search never answers "No matches found."', () => {
  const dir = mkBombDir();
  try {
    const res = grepFallback(
      BOMB_PATTERN, [dir], undefined, undefined, 'files_with_matches', undefined, undefined,
      100
    );
    const text = res.content[0].text;

    // The whole point: this must not read as a complete, empty answer.
    assert.ok(
      !/^No matches found\.$/.test(text.trim()),
      'a search that stopped early reported itself as a completed search with no matches'
    );
    assert.match(text, /stopped/i);
    assert.match(text, /floor|not a complete answer/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('matches found before the deadline are still returned, marked as a floor', () => {
  const dir = mkBombDir();
  // A file that matches instantly, sorted before bomb.txt so it is searched first.
  fs.writeFileSync(path.join(dir, 'aaa-hit.txt'), 'aaaa\n');
  try {
    const res = grepFallback(
      '^aaaa$', [dir], undefined, undefined, 'files_with_matches', undefined, undefined,
      100
    );
    const text = res.content[0].text;
    assert.ok(text.includes('aaa-hit.txt'), `expected the real match to survive; got: ${text}`);
    assert.equal(res.isError, undefined, 'a partial result with matches is not an error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a search that got through nothing at all is an error, not an empty result', () => {
  const dir = mkBombDir();
  try {
    const res = grepFallback(
      BOMB_PATTERN, [dir], undefined, undefined, 'files_with_matches', undefined, undefined,
      0
    );
    assert.equal(res.isError, true, 'reporting on zero files searched must not look like success');
    assert.match(res.content[0].text, /without finishing a single file/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a search that completes is unchanged: exact matches, and the plain no-match answer', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-redos-')));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'needle here\n');
  try {
    const hit = grepFallback('needle', [dir], undefined, undefined, 'files_with_matches', undefined, undefined, 30000);
    assert.equal(hit.content[0].text, path.join(dir, 'a.txt'));
    assert.ok(!/stopped/.test(hit.content[0].text), 'a complete search must carry no truncation note');

    const miss = grepFallback('nosuchthing', [dir], undefined, undefined, 'files_with_matches', undefined, undefined, 30000);
    assert.equal(miss.content[0].text, 'No matches found.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('both paths share one budget, overridable for tests', () => {
  assert.equal(GREP_TIMEOUT_MS, 30_000);
  assert.equal(grepBudgetMs(), 30_000);

  const prev = process.env.FSMCP_GREP_TIMEOUT_MS;
  try {
    process.env.FSMCP_GREP_TIMEOUT_MS = '250';
    assert.equal(grepBudgetMs(), 250);
    process.env.FSMCP_GREP_TIMEOUT_MS = 'not-a-number';
    assert.equal(grepBudgetMs(), 30_000, 'a junk override must fall back, not disable the bound');
    process.env.FSMCP_GREP_TIMEOUT_MS = '0';
    assert.equal(grepBudgetMs(), 30_000, 'a zero override must not disable the bound');
  } finally {
    if (prev === undefined) delete process.env.FSMCP_GREP_TIMEOUT_MS;
    else process.env.FSMCP_GREP_TIMEOUT_MS = prev;
  }
});

test('the fallback bound is wired through a real server, not just callable', async () => {
  const dir = mkBombDir();
  // A stand-in `rg` whose --version probe fails, so fsmcp takes the fallback
  // deterministically whether or not this host has ripgrep.
  const { bin, log } = makeFakeRg(dir, { versionExitCode: 1 });
  const server = spawnServer(['--allowed-dir', dir], {
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_RG_LOG: log,
      FSMCP_GREP_TIMEOUT_MS: '150',
    },
  });
  try {
    const res = await server.callTool('fs_grep', { pattern: BOMB_PATTERN });
    const text = res.content[0].text;
    assert.match(text, /stopped after 150ms/, `expected a truncation report; got: ${text}`);
    assert.ok(!/^No matches found\.$/.test(text.trim()));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the ripgrep path's own timeout ----------------------------------------

test('a ripgrep timeout is an error naming the timeout, not a silent partial', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-rgto-')));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  // Emits one line of output, then blocks past the budget.
  const { bin, log } = makeFakeRg(dir, { sleepMs: 1500 });
  const server = spawnServer(['--allowed-dir', dir], {
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_RG_LOG: log,
      FSMCP_GREP_TIMEOUT_MS: '200',
    },
  });
  try {
    const res = await server.callTool('fs_grep', { pattern: 'hello' });
    const text = res.content[0].text;

    assert.equal(res.isError, true, 'a timed-out search must not be reported as a result');
    assert.match(text, /timed out after 200ms/);
    assert.ok(
      !text.includes('PARTIAL-MATCH-LINE'),
      'the partial output rg had already written was returned as if it were the answer'
    );
    assert.match(text, /[Pp]artial output/, 'the caller should be told a partial was discarded');
    assert.ok(text.trim().length > 'grep error: '.length, 'the error must not be empty');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
