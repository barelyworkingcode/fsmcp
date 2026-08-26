import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ToolRegistry, schema, stringProp, intProp, enumProp, requireStringArg, optionalStringArg, virtualPathDescription } from '../registry';
import { textResult, errorResult, scopeViolationResult, ToolContext, LabelEntry } from '../types';
import { validatePath, NO_ALLOWED_DIRS_MESSAGE } from '../security';
import { checkPathV, decodeInboundPath, hostToVirtualOrRedact, translateResult } from '../vpath';
import { decodeUtf8Strict } from '../encoding';

// Detect ripgrep at load time.
//
// execFileSync, not execSync: nothing in this file may reach a shell. The
// probe's own arguments are constants and would have been harmless either
// way, but a shell-running spawn sitting in the same file as the search is
// how the search came to use one -- and it changes the answer, too. execSync
// consults the user's shell, so an `rg` that is a shell function or alias
// reports available and then is not there for the real search; execFileSync
// resolves an executable on PATH, which is exactly what the search does.
let rgAvailable = false;
try {
  execFileSync('rg', ['--version'], { stdio: 'pipe' });
  rgAvailable = true;
} catch {
  // rg not installed
}

/**
 * Wall-clock bound on a single fs_grep call, in milliseconds.
 *
 * Both search paths use it, so they behave alike: the ripgrep path passes it
 * as execFileSync's `timeout`, the Node fallback checks it as it walks. It
 * used to exist only on the ripgrep path, which left the fallback -- the path
 * every host without ripgrep takes, including the one this was found on --
 * with no bound at all.
 *
 * That is a process-wide hazard rather than a slow call. fsmcp is one
 * synchronous stdio loop, so a search that does not return does not degrade
 * itself; it takes every tool with it for every caller, the same shape as the
 * deeply-nested MIME message that killed macmcp outright. And `pattern` is
 * caller-supplied and compiled with `new RegExp`, so the caller chooses the
 * work: `(a+)+$` against a few dozen non-matching characters backtracks for
 * longer than the machine will be up.
 *
 * The pattern itself is deliberately NOT inspected. Catastrophic backtracking
 * cannot be decided statically -- any heuristic refuses legitimate patterns
 * and still misses crafted ones -- so the work is bounded and the input is
 * not judged.
 *
 * FSMCP_GREP_TIMEOUT_MS overrides it. That is a test seam: it lets the
 * truncation behaviour be pinned in milliseconds rather than by burning 30
 * real seconds in the suite.
 */
export const GREP_TIMEOUT_MS = 30_000;

export function grepBudgetMs(): number {
  const raw = process.env.FSMCP_GREP_TIMEOUT_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return GREP_TIMEOUT_MS;
}

/**
 * Why one search path cannot be searched -- a reason phrase in the exact
 * words this codebase's other tools already use (`fs_glob`, `fs_find` and
 * `fs_list` all answer `directory not found: <path>`) -- or null when it is
 * fine.
 *
 * This exists because of what ripgrep does NOT hand back. rg reports a
 * failure as free text on stderr (`rg: <path>: Permission denied (os error
 * 13)`, `rg: <path>: IO error for operation on <path>: No such file or
 * directory (os error 2)` -- both measured against ripgrep 15.2.0, not
 * guessed) with no structure to it: no `.path` property the way a
 * `NodeJS.ErrnoException` carries one for `describeError`, and nothing like
 * the `data.path.text` field its `--json` match stream provides. Recovering
 * the path from that prose would mean a parser for ripgrep's error
 * messages, which is precisely the fragility issue #7 moved this file OFF
 * when `--json` replaced plain-text parsing for matches -- and a wrong split
 * there would not mis-format a result, it would emit a host path.
 *
 * So the path is never recovered from rg's output at all. fsmcp already
 * knows which directories it put on rg's argv, in host terms, and it can ask
 * the filesystem about them itself. Nothing in this function reads a byte of
 * ripgrep's stdout or stderr.
 *
 * Read/execute is checked, not just existence, because the two triggers in
 * issue #22 are one of each: a granted root renamed out from under a running
 * call (gone) and a granted root this process cannot read (mode 000, or a
 * macOS TCC-protected folder). `fs.accessSync` asks the kernel the same
 * question rg asked -- `R_OK` for a file, `R_OK | X_OK` for a directory,
 * since listing one needs both.
 *
 * A negative answer is never an oracle: every path this is called on has
 * already been through `checkPathV`/`validatePath` (an explicit `path`
 * argument) or IS one of this call's allowed directories (default scope), so
 * the caller only ever learns about a directory it was already granted.
 */
export function unsearchableReason(searchPath: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(searchPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT and ENOTDIR both mean "this name resolves to nothing" (the
    // second is a path whose parent turned out to be a file). Anything else
    // -- EACCES or EPERM on a parent directory -- is a permission answer,
    // and calling it "not found" would send an operator looking for the
    // wrong problem, which is the same conflation this issue is about.
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'directory not found';
    return 'directory not readable';
  }
  const isDir = stat.isDirectory();
  try {
    fs.accessSync(searchPath, isDir ? fs.constants.R_OK | fs.constants.X_OK : fs.constants.R_OK);
  } catch {
    return isDir ? 'directory not readable' : 'file not readable';
  }
  return null;
}

/** Every path in `searchPaths` that cannot be searched, with the reason. */
function unsearchablePaths(searchPaths: string[]): { path: string; reason: string }[] {
  const problems: { path: string; reason: string }[] = [];
  for (const p of searchPaths) {
    const reason = unsearchableReason(p);
    if (reason !== null) problems.push({ path: p, reason });
  }
  return problems;
}

/**
 * The error a tool returns for search paths it cannot search, in the same
 * shape and the same words `fs_glob`/`fs_find`/`fs_list` use -- host paths
 * embedded and then translated at this construction site, which is the
 * per-call-site pattern the rest of this codebase follows (CLAUDE.md,
 * "Outbound translation is deliberate"). `redactLeakedHostPaths` stays what
 * it is meant to be behind this: an alarm for a path nobody translated, not
 * the thing that makes this message safe.
 */
function unsearchableError(problems: { path: string; reason: string }[], labels: LabelEntry[]) {
  const message = problems.map(({ path: p, reason }) => `${reason}: ${p}`).join('; ');
  return translateResult(errorResult(message), problems.map((x) => x.path), labels);
}

export function registerGrep(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_grep',
      description:
        'Search file contents with regex. Uses ripgrep if available, falls back to Node.js. Default output mode is files_with_matches (file paths only).',
      inputSchema: schema(
        {
          pattern: stringProp('Regex pattern to search for'),
          path: stringProp(virtualPathDescription('Optional; defaults to every directory in this call\'s granted scope.')),
          glob: stringProp("Glob to filter files (e.g. '*.ts')"),
          type: stringProp("File type filter (e.g. 'ts', 'js', 'py')"),
          output_mode: enumProp('Output mode', [
            'content',
            'files_with_matches',
            'count',
          ]),
          context: intProp('Lines of context around matches (content mode only)'),
          head_limit: intProp('Limit output to first N results'),
        },
        ['pattern']
      ),
      // Searches local files (ripgrep or the Node fallback), both confined
      // to this machine's filesystem.
      annotations: { readOnlyHint: true, openWorldHint: false },
      category: 'File System',
    },
    (args: Record<string, unknown>, ctx: ToolContext) => {
      const patternArg = requireStringArg(args, 'pattern');
      if (typeof patternArg !== 'string') return patternArg;
      const pattern = patternArg;
      const globFilter = args.glob as string | undefined;
      const typeFilter = args.type as string | undefined;
      const outputMode = (args.output_mode as string) ?? 'files_with_matches';
      const contextLines = args.context as number | undefined;
      const headLimit = args.head_limit as number | undefined;

      const pathArg = optionalStringArg(args, 'path');
      if (typeof pathArg === 'object') return pathArg; // a wrong-typed path is an MCPCallResult refusal

      // Determine search paths ("." is treated as omitted)
      let searchPaths: string[];
      if (pathArg && pathArg !== '.') {
        // Issue #7: decode the client's virtual-space address into the host
        // path checkPath (and the search below) already expect -- see
        // read.ts for the full reasoning.
        const decoded = decodeInboundPath(pathArg, ctx.labels);
        if (typeof decoded !== 'string') return decoded;
        const p = decoded;
        const pathErr = checkPathV(p, ctx.allowedDirs, ctx.labels);
        if (pathErr) return pathErr;
        // Issue #22: answer for a directory that is not there (or cannot be
        // read) in the same words the sibling tools do, BEFORE either
        // backend runs -- fs_glob, fs_find and fs_list all check this
        // up front and all answer `directory not found: /d0/nodir`.
        // fs_grep did not, and the two backends failed differently and both
        // wrongly: ripgrep exits 2 and its stderr came back verbatim (so an
        // ordinary typo produced `redactLeakedHostPaths`'s "this is a bug in
        // fsmcp, please report it" -- an alarm as the routine error path),
        // while the Node fallback's walker swallows the ENOENT from its own
        // `statSync` and reports "No matches found.", which is a claim about
        // a directory that does not exist. One check here fixes both, and
        // it is the caller's own already-validated path, so it says nothing
        // the caller did not already address.
        const reason = unsearchableReason(p);
        if (reason) return unsearchableError([{ path: p, reason }], ctx.labels);
        searchPaths = [p];
      } else if (ctx.allowedDirs.length > 0) {
        searchPaths = ctx.allowedDirs.filter((d) => fs.existsSync(d));
        if (searchPaths.length === 0) return errorResult('none of the allowed directories exist');
      } else {
        // No allowed dirs configured: an absent path must resolve to the
        // (empty) scope, not to an unrestricted cwd fallback. Empty scope is
        // itself a scope refusal, not a different kind of error.
        return scopeViolationResult(NO_ALLOWED_DIRS_MESSAGE);
      }

      if (rgAvailable) {
        return grepWithRg(
          pattern, searchPaths, globFilter, typeFilter,
          outputMode, contextLines, headLimit, ctx.allowedDirs, ctx.labels
        );
      }
      return grepFallback(
        pattern, searchPaths, globFilter, typeFilter,
        outputMode, contextLines, headLimit, grepBudgetMs(), ctx.allowedDirs, ctx.labels
      );
    }
  );
}

/**
 * Build ripgrep's argument vector.
 *
 * This returns an **argv array**, and it is the caller's contract that it is
 * passed to `execFileSync` as one -- never joined into a string. Exported so
 * the construction can be pinned by a test on a host with no ripgrep on it.
 *
 * `--` before the pattern stops *ripgrep* reading a pattern that begins with
 * a dash as a flag. It says nothing about a shell and never did: this code
 * used to hand `rgArgs.join(' ')` to `execSync`, which runs /bin/sh, so the
 * caller-supplied `pattern` (and `glob`, and `type`) were shell source. A
 * pattern of `hello; touch /tmp/pwned; echo done` became
 *
 *     rg -n -- hello; touch /tmp/pwned; echo done /some/allowed/dir
 *
 * -- three commands, of which ripgrep ran one. That is arbitrary command
 * execution with no relation to `allowed_dirs`, from a tool annotated
 * `readOnlyHint: true`, i.e. from the most restricted grant relay can issue.
 * It did not fire on the development host only because the `rg` there is a
 * shell function, so the old `execSync('rg --version')` probe reported it
 * unavailable and the pure-Node fallback ran instead. That is a property of
 * one machine, not a mitigation.
 *
 * The fix is not to quote or to escape: it is that no shell parses any of
 * this. Every element below is one argv element, so a `;`, a backtick, a
 * `$(...)` or a newline in a pattern reaches ripgrep as the text it is.
 */
export function buildRgArgs(
  pattern: string,
  searchPaths: string[],
  globFilter: string | undefined,
  typeFilter: string | undefined,
  outputMode: string,
  contextLines: number | undefined,
  headLimit: number | undefined,
): string[] {
  // Issue #7: always --json, and never -l/-c/-n. Outbound translation has to
  // know exactly which substring of a line is the path and which is
  // caller-visible file content, so a caller's own path is never rewritten
  // and a file's own content is never mistaken for one; ripgrep's structured
  // event stream gives that split for free (`data.path.text` versus
  // `data.lines.text`) where the old plain-text output required RECOVERING
  // it with a regex. filterPathsInScope's old regex already flagged that
  // recovery as fragile for a path containing a colon (issue #5); building a
  // rewrite step on top of that same regex would have made the fragility
  // load-bearing in a new way -- a wrong split would not just mis-filter a
  // result, it could rewrite the wrong substring, or fail to rewrite a host
  // path at all. `-c` is dropped from this list of flags for a second
  // reason, not just style: ripgrep does not honour `--json` when `-c` is
  // also given (measured: it silently falls back to `-c`'s own plain-text
  // output regardless of flag order), so count mode has to be derived from
  // the json stream's own per-file stats instead (formatRgJson, `matched_lines`).
  const rgArgs: string[] = ['--json'];

  if (outputMode === 'content' && contextLines !== undefined) {
    rgArgs.push('-C', String(contextLines));
  }

  if (globFilter) rgArgs.push('--glob', globFilter);
  if (typeFilter) rgArgs.push('--type', typeFilter);
  if (headLimit) rgArgs.push('--max-count', String(headLimit));

  rgArgs.push('--', pattern, ...searchPaths);

  return rgArgs;
}

/** One event from ripgrep's `--json` output (ndjson: one object per line). */
interface RgJsonEvent {
  type: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    stats?: { matched_lines?: number };
  };
}

/**
 * Parse ripgrep's `--json` stdout into events, dropping any line that is not
 * valid JSON rather than guessing at it. In ordinary operation every line is
 * well-formed -- ripgrep writes one complete JSON object per line and this
 * function only ever sees output from a process that exited 0 (a killed,
 * possibly-mid-line process is handled entirely separately, on `e.stdout`,
 * by the ETIMEDOUT branch below, and its partial bytes never reach this
 * parser at all).
 */
function parseRgJson(output: string): RgJsonEvent[] {
  const events: RgJsonEvent[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && typeof ev.type === 'string') events.push(ev);
    } catch {
      continue;
    }
  }
  return events;
}

/**
 * Turn ripgrep's `--json` stream into this tool's plain-text contract
 * (unchanged from before this issue: a bare path per line for
 * files_with_matches, `path:count`, or `path:line:content` / `path-line-content`
 * for content mode) -- with every path re-validated and translated to its
 * virtual form on the way out.
 *
 * Re-validation is not defense in depth here, it is the actual containment
 * step for this tool's output, the same reasoning fs_glob/fs_find already
 * apply to their own hits: whatever walked the tree chose what got reported,
 * so a symlink inside an allowed directory that points outside it can come
 * back looking like an in-scope path. `inScope` caches per path so a file
 * with many matches pays validatePath once.
 *
 * `hostToVirtualOrRedact` runs only on the path field, never on
 * `lines.text` -- that field is the *file's own content*, which can
 * legitimately contain arbitrary bytes including something that happens to
 * look like a host path, and must reach the caller byte for byte, not
 * silently rewritten because it resembles one of fsmcp's own directories.
 */
export function formatRgJson(
  output: string,
  outputMode: string,
  allowedDirs: string[],
  labels: LabelEntry[],
): string {
  const events = parseRgJson(output);
  const scopeCache = new Map<string, boolean>();
  const inScope = (p: string): boolean => {
    let cached = scopeCache.get(p);
    if (cached === undefined) {
      cached = validatePath(p, allowedDirs) === null;
      scopeCache.set(p, cached);
    }
    return cached;
  };

  if (outputMode === 'files_with_matches') {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const ev of events) {
      if (ev.type !== 'match') continue;
      const p = ev.data?.path?.text;
      if (typeof p !== 'string' || seen.has(p) || !inScope(p)) continue;
      seen.add(p);
      lines.push(hostToVirtualOrRedact(p, labels));
    }
    return lines.join('\n');
  }

  if (outputMode === 'count') {
    // `end` fires once per searched file, and only for a file that had at
    // least one match (confirmed: a zero-match file among several searched
    // ones emits no begin/end pair at all) -- exactly the set `-c` reports.
    const lines: string[] = [];
    for (const ev of events) {
      if (ev.type !== 'end') continue;
      const p = ev.data?.path?.text;
      const count = ev.data?.stats?.matched_lines;
      if (typeof p !== 'string' || typeof count !== 'number' || !inScope(p)) continue;
      lines.push(`${hostToVirtualOrRedact(p, labels)}:${count}`);
    }
    return lines.join('\n');
  }

  // content: reconstruct plain rg's own separators -- ":" for a matched
  // line, "-" for a context line -- and its "--" group break wherever the
  // next line is not immediately contiguous with the last one emitted
  // (different file, or a gap `-C` did not bridge). Tracked across the
  // whole event stream, not per file, because that is what plain rg's own
  // output does too (verified against a real ripgrep binary): a file
  // boundary is just a special case of "not contiguous".
  const lines: string[] = [];
  let lastPath: string | null = null;
  let lastLine = -Infinity;
  for (const ev of events) {
    if (ev.type !== 'match' && ev.type !== 'context') continue;
    const p = ev.data?.path?.text;
    const lineNumber = ev.data?.line_number;
    const text = ev.data?.lines?.text;
    if (typeof p !== 'string' || typeof lineNumber !== 'number' || typeof text !== 'string') continue;
    if (!inScope(p)) continue;

    if (lines.length > 0 && (p !== lastPath || lineNumber !== lastLine + 1)) {
      lines.push('--');
    }
    const sep = ev.type === 'match' ? ':' : '-';
    const content = text.endsWith('\n') ? text.slice(0, -1) : text;
    lines.push(`${hostToVirtualOrRedact(p, labels)}${sep}${lineNumber}${sep}${content}`);
    lastPath = p;
    lastLine = lineNumber;
  }
  return lines.join('\n');
}

function grepWithRg(
  pattern: string,
  searchPaths: string[],
  globFilter: string | undefined,
  typeFilter: string | undefined,
  outputMode: string,
  contextLines: number | undefined,
  headLimit: number | undefined,
  allowedDirs: string[],
  labels: LabelEntry[],
) {
  const rgArgs = buildRgArgs(
    pattern, searchPaths, globFilter, typeFilter,
    outputMode, contextLines, headLimit
  );

  const budgetMs = grepBudgetMs();

  try {
    const output = execFileSync('rg', rgArgs, {
      encoding: 'utf-8',
      timeout: budgetMs,
      // --json is several times larger than the plain-text output it
      // replaces (every match repeats the path, wraps the line in a JSON
      // object, and escapes it) for the same underlying result, so the old
      // 10MB plain-text ceiling would cut off searches this tool answered
      // in full before issue #7.
      maxBuffer: 40 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const filtered = formatRgJson(output, outputMode, allowedDirs, labels);
    return textResult(filtered === '' ? 'No matches found.' : filtered);
  } catch (err: unknown) {
    const e = (err ?? {}) as {
      status?: number | null;
      code?: string;
      stderr?: unknown;
      stdout?: unknown;
      message?: string;
    };

    // rg exits 1 when no matches found
    if (e.status === 1) {
      return textResult('No matches found.');
    }

    // A timeout kills rg with SIGTERM, so `status` is null (never 1) and
    // whatever rg had already written is on `e.stdout`. That partial is
    // discarded rather than returned: it is a prefix of an answer with no way
    // to say so on this path, and returning it would make "these are the
    // matches" and "these are the matches I got to" the same reply. What was
    // missing is that the caller was told any of it -- rg writes nothing to
    // stderr when it is killed, so this used to return the string
    // "grep error: " and nothing else.
    if (e.code === 'ETIMEDOUT') {
      const partial = typeof e.stdout === 'string' && e.stdout.length > 0
        ? ` Partial output (${e.stdout.length} bytes) was discarded because it cannot be `
          + `distinguished from a complete result.`
        : '';
      return errorResult(
        `grep timed out after ${budgetMs}ms and was stopped.${partial} Narrow the search `
          + `with path, glob or type, or simplify the pattern.`
      );
    }

    // Any other failure -- in practice ripgrep's exit 2, which it uses for
    // ANY error it hit, including one it carried on past.
    //
    // Issue #22: this branch used to be `errorResult(`grep error: ${stderr}`)`
    // and nothing else, the one call site in this codebase that translated
    // no path at all, on the reasoning that rg's prose has no path field to
    // translate and that `redactLeakedHostPaths` would catch anything that
    // slipped. It did not. rg writes `<path>: <reason>`, the backstop's
    // boundary class did not accept a colon, and so a message naming a
    // granted ROOT went to the client verbatim -- the host's account name,
    // the layout above the grant, the real absolute path -- while the
    // byte-identical message naming anything INSIDE that root (followed by
    // `/`) was caught. Reproduced live twice: a granted root renamed out
    // from under a call, and a granted root with mode 000, the second on a
    // default-scope search with no `path` argument at all.
    //
    // The fix is the one the rest of this codebase already uses: translate
    // at the construction site. The paths that can appear in rg's stderr are
    // not arbitrary -- they are `searchPaths`, which fsmcp itself just put on
    // the argv, or descendants of them, and a descendant is always lexically
    // prefixed by its ancestor (`translatePathIn`'s substring match, the
    // same property `describeError` relies on for a syscall error naming a
    // path deeper than the one the caller passed). So no parser for
    // ripgrep's message is needed, or wanted: `translateResult(result,
    // searchPaths, labels)` renames the known strings and leaves the rest of
    // the text -- including the caller's own echoed pattern on a regex parse
    // error -- byte for byte.
    //
    // Before falling back to rg's own words, though, this asks the
    // filesystem what is wrong itself (`unsearchablePaths`), because "rg
    // said something" is a poor answer when fsmcp can say `directory not
    // readable: /d1` the way every sibling tool would.
    const problems = unsearchablePaths(searchPaths);

    // rg exits 2 even when it searched everything else successfully -- one
    // unreadable file anywhere under a granted tree is enough (measured:
    // matches on stdout, `<path>: Permission denied` on stderr, exit 2).
    // Discarding those matches and answering with an error was the old
    // behaviour, and it is wrong in the common case: an agent searching a
    // real project tree that contains a single mode-000 file got no results
    // at all. Report what rg did find, and say plainly that it is a floor --
    // the same shape `grepFallback` below already uses for a search its
    // budget cut short. This note is fsmcp's own words plus VIRTUAL paths
    // only: it rides on a SUCCESS result, which `redactLeakedHostPaths` is
    // structurally unable to inspect (it is `isError`-scoped by design, PR
    // #10), so nothing built from rg's text may go in it.
    const stdout = typeof e.stdout === 'string' ? e.stdout : '';
    const partial = stdout.length > 0 ? formatRgJson(stdout, outputMode, allowedDirs, labels) : '';
    if (partial !== '') {
      const what = problems.length > 0
        ? problems.map(({ path: p, reason }) => `${reason}: ${hostToVirtualOrRedact(p, labels)}`).join('; ')
        : 'ripgrep could not read every path in scope (a file or directory whose permissions '
          + 'deny it, or one that changed while the search ran)';
      return textResult(
        `${partial}\n\n[fsmcp: these results are a floor, not a complete answer -- ${what}. `
          + `Files that could not be read were not searched, and one of them may match.]`
      );
    }

    // Nothing came back, so this is an error, and the question is whose
    // account of it to give: fsmcp's own (`directory not readable: /d1`) or
    // ripgrep's. The two can both be true at once -- an unreadable granted
    // root AND a pattern rg refuses to compile -- and answering with the
    // filesystem's story when the real fault was the pattern would send a
    // caller after the wrong thing.
    //
    // `--json`'s own event stream settles it, structurally, with no reading
    // of rg's prose: rg emits a `summary` event once it has actually run a
    // search, and emits nothing at all on stdout when it rejects its own
    // arguments (measured against ripgrep 15.2.0: a missing directory or an
    // unreadable one still produces a summary; `--type nosuchtype`, an
    // unparseable `--glob`, and a pattern that fails to compile produce
    // empty stdout). So a summary means the search ran and hit the
    // filesystem, where fsmcp can say something better than rg can; no
    // summary means only rg knows why it refused. If a future ripgrep
    // changes that, the failure mode is a misattributed message, never a
    // leaked path -- both branches below are translated.
    const searchRan = parseRgJson(stdout).some((ev) => ev.type === 'summary');
    if (problems.length > 0 && searchRan) return unsearchableError(problems, labels);

    // Last resort: rg's own words, now translated. stderr first, but it is
    // empty for a whole class of spawn failures, and an error message with
    // nothing in it is the one thing this must not produce. What can still
    // reach a caller untranslated here is a path that is under NO granted
    // directory (ripgrep naming its own config file from
    // RIPGREP_CONFIG_PATH, say) -- fsmcp has nothing to translate that
    // against and the backstop cannot know it either, so it stays a
    // documented residue rather than a claim this branch is now airtight.
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
    const detail = stderr || e.message || String(err);
    return translateResult(errorResult(`grep error: ${detail}`), searchPaths, labels);
  }
}

/**
 * The pure-Node search, used on any host without ripgrep on PATH.
 *
 * `budgetMs` bounds the whole call in wall-clock time and defaults to the
 * same budget the ripgrep path spends. The deadline is checked between files
 * and between lines, which is the only place it CAN be checked: JavaScript
 * offers no way to interrupt a regex mid-match, so `regex.test(line)` runs to
 * completion however long it takes. A single catastrophically-backtracking
 * match against one very long line therefore still overruns the bound, and
 * this comment is the honest statement of that -- the bound stops the search
 * from continuing, it does not stop a match in progress. What it does buy is
 * that the pathological case is one line's worth of overrun instead of
 * unbounded: without it, the same pattern kept matching against every line of
 * every file for as long as the process lived.
 *
 * `allowedDirsForRevalidation` re-validates every file the walk turns up
 * before it is ever opened or reported, the same containment fs_glob already
 * applies to its own hits (see `formatRgJson` above for why the ripgrep path
 * needs the same treatment, not just this one). It is optional, and
 * defaults to skipping that check, purely as a test seam: the ReDoS-budget
 * tests below call this function directly with a bare tmp directory and no
 * concept of allowed_dirs at all, and defaulting to "no allowed dirs" would
 * make them fail closed for a reason that has nothing to do with what they
 * are testing. The real call site in fs_grep's handler always passes
 * `ctx.allowedDirs`.
 *
 * `labels` is the same kind of test seam, for the same reason, for issue #7:
 * this function used to build every one of its own output lines directly
 * from `file` (a host path), on the documented assumption that
 * `ToolRegistry.call`'s generic outbound pass would translate it -- but that
 * pass (`redactLeakedHostPaths`) was scoped to `isError` results only, in
 * the same PR #10 review that removed the whole-result rewrite, and a
 * SUCCESS result (an ordinary search that found matches) is exactly the
 * case that backstop cannot touch. Confirmed: with ripgrep absent from
 * PATH, `fs_grep` returned the sandbox's real absolute path in every output
 * mode (`files_with_matches`, `count`, and `content`'s path column) --
 * precisely the disclosure issue #7 exists to close, surviving intact on
 * this one backend. `labels` is `undefined` by default so the ReDoS-budget
 * tests below, which construct a bare tmp directory with no concept of
 * `allowed_dirs` or labels at all, keep asserting against the exact host
 * path they created (translating with an empty label set would REDACT it
 * instead, which is not what those tests are about); the real call site in
 * fs_grep's handler always passes `ctx.labels`. Only the PATH column is
 * translated -- `lines[idx]` in content mode is the file's own matched
 * text, which must reach the caller byte for byte the same way
 * `formatRgJson`'s `lines.text` does.
 *
 * Exported so a test can hand it a small budget directly.
 */
export function grepFallback(
  pattern: string,
  searchPaths: string[],
  globFilter: string | undefined,
  typeFilter: string | undefined,
  outputMode: string,
  contextLines: number | undefined,
  headLimit: number | undefined,
  budgetMs: number = grepBudgetMs(),
  allowedDirsForRevalidation?: string[],
  labels?: LabelEntry[],
) {
  // See this function's doc: translate only when a real call site supplied
  // labels at all. `hostToVirtualOrRedact` would otherwise treat "no labels
  // passed" the same as "labels is genuinely empty" and redact every path,
  // which is right for a real empty-scope call but wrong for the unit tests
  // below that never had a concept of labels to begin with.
  const displayPath = (f: string): string => (labels === undefined ? f : hostToVirtualOrRedact(f, labels));
  const deadline = Date.now() + budgetMs;
  const expired = () => Date.now() >= deadline;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return errorResult(`invalid regex: ${pattern}`);
  }

  // The walk is inside the budget too: enumerating a very large tree is its
  // own way to not come back, and a file list that is itself a floor must not
  // be reported as "N of M".
  const walked = searchPaths.flatMap((p) => walkFiles(p, globFilter, typeFilter, deadline));
  const files = allowedDirsForRevalidation === undefined
    ? walked
    : walked.filter((f) => validatePath(f, allowedDirsForRevalidation) === null);
  const walkTruncated = expired();

  const results: string[] = [];
  let resultCount = 0;
  let filesSearched = 0;
  let stopped = walkTruncated;

  for (const file of files) {
    if (headLimit && resultCount >= headLimit) break;
    if (expired()) {
      stopped = true;
      break;
    }

    let content: string;
    try {
      // Issue #11: `fs.readFileSync(file, 'utf-8')` silently substitutes
      // U+FFFD for any byte that is not valid UTF-8, so a match against
      // (or reported line of) the substituted string is not what is
      // actually on disk -- exactly the corruption fs_read now refuses
      // outright. This tool only reports, it never writes, so there is no
      // write-back to corrupt, but reporting a lossily-decoded line is
      // still handing the caller text that does not match the file, with
      // no way to tell. Skipped the same way an unreadable file already is
      // (the catch below), so fs_grep agrees with fs_read about what it
      // declines to decode: read as raw bytes first, decode strictly, and
      // treat a decode failure as "cannot search this file's content" --
      // not as "found nothing", which is why `filesSearched` is only
      // incremented once a file's content is actually usable.
      content = decodeUtf8Strict(fs.readFileSync(file));
    } catch {
      continue;
    }

    filesSearched++;
    const lines = content.split('\n');
    const matchingLines: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (expired()) {
        stopped = true;
        break;
      }
      if (regex.test(lines[i])) {
        matchingLines.push(i);
      }
    }

    // Matches found before the deadline are real matches and are reported,
    // even if this file was only partly searched.
    if (matchingLines.length > 0) {
      switch (outputMode) {
        case 'files_with_matches':
          results.push(displayPath(file));
          resultCount++;
          break;
        case 'count':
          results.push(`${displayPath(file)}:${matchingLines.length}`);
          resultCount++;
          break;
        case 'content': {
          const ctx = contextLines ?? 0;
          const shown = new Set<number>();
          for (const lineIdx of matchingLines) {
            for (let j = Math.max(0, lineIdx - ctx); j <= Math.min(lines.length - 1, lineIdx + ctx); j++) {
              shown.add(j);
            }
          }
          const sortedLines = [...shown].sort((a, b) => a - b);
          // lines[idx] is the file's own matched text -- never translated,
          // same rule formatRgJson's lines.text and fs_read's own bytes
          // follow (PR #10: a whole-result rewrite used to corrupt exactly
          // this kind of content).
          const shownPath = displayPath(file);
          for (const idx of sortedLines) {
            results.push(`${shownPath}:${idx + 1}:${lines[idx]}`);
          }
          resultCount += matchingLines.length;
          break;
        }
      }
    }

    if (stopped) break;
  }

  if (stopped) {
    // A search that stopped early and one that finished having found nothing
    // must not give the same answer. "No matches found." is a claim about
    // every file in scope; this call cannot make it.
    const scope = walkTruncated
      ? `at least ${files.length} files (the file list was itself cut short)`
      : `${files.length} files`;

    if (filesSearched === 0) {
      return errorResult(
        `grep stopped after ${budgetMs}ms without finishing a single file, so nothing can `
          + `be reported about ${scope}. Narrow the search with path, glob or type, or `
          + `simplify the pattern.`
      );
    }

    const note =
      `[fsmcp: search stopped after ${budgetMs}ms, having searched ${filesSearched} of `
      + `${scope}. These results are a floor, not a complete answer: a file that was not `
      + `searched may still match.]`;

    if (results.length === 0) {
      return textResult(
        `No matches in the ${filesSearched} file(s) searched before the search stopped.\n${note}`
      );
    }
    return textResult(`${results.join('\n')}\n\n${note}`);
  }

  if (results.length === 0) {
    return textResult('No matches found.');
  }

  return textResult(results.join('\n'));
}

function walkFiles(
  dir: string,
  globFilter: string | undefined,
  typeFilter: string | undefined,
  deadline: number,
): string[] {
  const results: string[] = [];

  // If it's a file, just return it
  try {
    if (fs.statSync(dir).isFile()) return [dir];
  } catch {
    return [];
  }

  const typeExt = typeFilter ? `.${typeFilter}` : undefined;

  function walk(current: string): void {
    if (Date.now() >= deadline) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (Date.now() >= deadline) return;
      const fullPath = path.join(current, entry.name);

      // Skip hidden dirs and node_modules
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      // Type filter
      if (typeExt && !entry.name.endsWith(typeExt)) continue;

      // Basic glob filter (just extension matching for fallback)
      if (globFilter) {
        const ext = globFilter.startsWith('*.') ? globFilter.slice(1) : null;
        if (ext && !entry.name.endsWith(ext)) continue;
      }

      results.push(fullPath);
    }
  }

  walk(dir);
  return results;
}
