# fsMCP

MCP server providing file system tools via stdio. 10 tools, 1 category. TypeScript/Node.js. One runtime dependency (glob). No shell: nothing here reaches `execSync` or a shell string; `execFileSync` with an argv array is the only way this process ever spawns anything (ripgrep, for `fs_grep` and `fs_find`).

## Architecture

Single-threaded stdin/stdout MCP server. Newline-delimited JSON-RPC 2.0. Protocol version `2024-11-05`.

```
src/
  main.ts        Stdin loop, JSON-RPC dispatch (initialize, tools/list, tools/call), _meta narrowing (C1)
  types.ts       Wire types, MCPTool interface, result helpers (textResult, errorResult, scopeViolationResult)
  registry.ts    ToolRegistry class + JSON schema builder helpers
  security.ts    Path validation against allowed_dirs (_meta + CLI flags), _meta narrowing rule
  vpath.ts       Virtual <-> host path translation (issue #7), layered on top of security.ts, never inside it
  tools/         One file per tool, each exports register(registry)
```

Entry point reads stdin line-by-line, dispatches to `ToolRegistry`, writes JSON to stdout. Synchronous.

## Tools

All ten tools are category "File System" -- there is no second category any more (the old "Shell" category, and `fs_bash` with it, is gone: see "fs_bash removal" below).

| Tool | Read-only | Backend |
|------|-----------|---------|
| fs_read | yes | fs.readFileSync, cat -n format |
| fs_glob | yes | glob npm package, mtime sort, 1000-result cap |
| fs_grep | yes | ripgrep (rg) with Node.js fallback, wall-clock budget |
| fs_list | yes | fs.readdirSync, one directory, non-recursive, 5000-entry cap |
| fs_find | yes | `rg --files --no-follow` (Node walker fallback) + in-process fuzzy scoring, 200-result cap |
| fs_write | no | fs.writeFileSync, auto-creates dirs |
| fs_edit | no | split/join literal string replacement |
| fs_mkdir | no | fs.mkdirSync, recursive defaults true |
| fs_move | no | fs.renameSync, both endpoints validated |
| fs_delete | no | fs.unlinkSync (symlinks/files) or fs.rmSync recursive (directories), 10000-entry cap |

relay's `access: read` grant admits only tools with `readOnlyHint: true` (exact-key lookup; absent/null/malformed reads as mutating), so this split is what makes a read-only profile a one-field decision instead of an `allowed_tools` list an operator has to keep correct by hand. `destructiveHint`/`idempotentHint` are not consulted by relay -- don't rely on them for gating.

### fs_bash removal

`fs_bash` (arbitrary shell, `readOnlyHint: false`, `openWorldHint: true`) is gone, not fixed. `allowed_dirs` was never a boundary for it -- a command reaches any path with or without a `cd` -- and every containment guarantee the rest of this server makes was void while it was registered. Removing it also removed the module-level `currentCwd`, the only cross-call mutable state fsmcp ever had.

## Key Patterns

- **Tool = module** with `export function register(registry: ToolRegistry)`. Handler signature: `(args, ctx) => MCPCallResult`.
- **ToolContext** carries `allowedDirs`, computed once per call in `main.ts` by `narrowAllowedDirs()` (security.ts) from `_meta.allowed_dirs` (relay per-call context) and `--allowed-dir` CLI flags -- **never** a plain union of the two. See "C1: `_meta` may only narrow" below. It also carries `labels: LabelEntry[]` (types.ts), this call's virtual-space labels for `allowedDirs`, in the same order -- see "Virtual path space (issue #7)" below.
- **contextSchema v2**, declared in `initialize`'s `serverInfo`, alongside `contextSchemaVersion: 2`:
  ```json
  "contextSchema": {
    "allowed_dirs": {
      "type": "array", "items": { "type": "string" },
      "description": "Directories this client may read, search and modify within",
      "scope": "restrict", "source": "operator",
      "applies_to": ["fs_*"], "enumerable": false
    }
  }
  ```
  Every keyword here is load-bearing and must stay byte-exact: absent `contextSchemaVersion`, relay parses this as v1 (looks for a field literally named `allowed_dirs`, derives it from the project path) -- and a **remote** access profile has no project path, so a v1 fsmcp cannot be granted to one at all. `source: "operator"` (not `"project_path"`) is the fix: an operator types the roots instead of relay deriving them. `enumerable: false` because fsmcp cannot offer candidate directories without listing the host's filesystem to whatever UI renders them. No `ui` key -- ignored under v2, and it was stale under v1 too.
- **C1: `_meta` may only narrow, never widen.** `_meta` is a field relay populates from context configured elsewhere in the chain, but fsmcp cannot verify anything upstream enforced anything, so it treats `_meta.allowed_dirs` as caller-supplied, same as any other wire argument. `narrowAllowedDirs(cliDirs, metaDirs)` implements the whole rule in one place: CLI+meta both set -> **intersection** (each `_meta` dir kept only if it canonicalizes inside some CLI dir; the rest are dropped and reported on the result, not swallowed); CLI set, meta absent -> CLI; CLI absent, meta set -> meta (relay-mediated mode); both absent -> empty, i.e. deny all. "Absent" vs "present but empty" matters and is preserved from `params._meta?.allowed_dirs` through to this function -- collapsing them with `?? []` is what let a plain union stand in for this table before.
- **Virtual path space (issue #7): `vpath.ts` is a translation layer on top of `security.ts`, never a replacement for it.** A client addresses paths as `/<label>/…`, never a host path -- `decodeInboundPath(virtualPath, ctx.labels)` turns that into the exact host-path string every tool has always validated, by literal string concatenation (deliberately not `path.join`, which would lexically collapse a `..` before `canonicalizePath`'s kernel-style walk ever saw it -- see the function's doc). Every tool handler calls this immediately after reading a path ARGUMENT (`file_path`/`path`/`source`/`destination`) and before calling `checkPathV()`/`checkPathNoFollowFinalV()` (vpath.ts wrappers around security.ts's own `checkPath`/`checkPathNoFollowFinal`, which run completely unmodified and still decide -- the wrapper only translates the message).
- **Outbound translation is deliberate, per call site, never a whole-result scan.** An earlier version of this ran every result (success AND error) through a single blanket rewrite in `ToolRegistry.call`, replacing any occurrence of a granted host directory with its label. PR #10 review found that this was too broad in three ways: (1) it scanned `fs_read`'s own file content and `fs_grep`'s content-mode matched lines, so a file whose bytes happened to contain the sandbox's real path came back silently corrupted, not translated -- confirmed with a write-then-read byte round trip; (2) the "not a valid address" refusal echoed the caller's rejected argument, and that echo passed through the same rewrite, so a CORRECT host-path guess came back rewritten to its label while a wrong one came back verbatim -- a working oracle for exactly the thing issue #7 exists to close; (3) it was applied incidentally (fires whenever a result happens to contain a matching substring) rather than as a decision made at each site, which is itself a reason not to lean on it. Fixed by translating each known path at its own construction site instead: `translatePathIn(text, hostPath, labels)` replaces one SPECIFIC, already-known path substring (never a scan for anything host-directory-shaped), `translateResult(result, hostPaths, labels)` applies it across a result for the path(s) a tool handler already has in scope, and `describeError(err, labels)` rebuilds a caught exception's message using Node's own `err.path`/`err.dest` (a `NodeJS.ErrnoException`'s structured properties, not text-mined from `.message`). The decode-refusal message no longer echoes the caller's argument at all. `ToolRegistry.call` keeps a narrow backstop, `redactLeakedHostPaths()` -- scoped to `isError` results ONLY, so it can never touch `fs_read`/`fs_grep`-content success payloads -- which replaces an entire result with a generic "this is a bug" message if a granted host directory somehow still leaked through; an alarm, not a translation mechanism.
- `fs_glob`/`fs_find`/`fs_list` translate each output path individually via `hostToVirtualOrRedact()`, which **redacts** (a placeholder string) rather than emits a path that cannot be mapped to any granted label -- that case would mean a path reached output from outside the grant, which is a bug security.ts's own checks should already have prevented, not a value this layer can make sense of.
- Labels: `label=/abs/path` in an `allowed_dirs` entry (CLI or `_meta`, stripped by `stripLabels()` before the bare host path ever reaches `narrowAllowedDirs`/`validatePath` -- an unstripped `"label=/x"` is not absolute and would otherwise resolve against fsmcp's own CWD) wins; otherwise `d<N>` by position in the call's *effective* (already narrowed) scope. `_meta.allowed_dirs` and `--allowed-dir` themselves are unchanged: still plain host-path strings, still operator/relay-side.
- **Scope refusals carry `_meta.scope_violation: true`.** `checkPath()`/`checkPathNoFollowFinal()` (security.ts) wrap `validatePath`/`validatePathNoFollowFinal` and return the ready-made `MCPCallResult` a tool handler should return directly -- `scopeViolationResult()` (types.ts) when the refusal is "outside your scope" (including the empty-scope case), plain `errorResult()` for everything else (bad regex, file not found, malformed path). Relay's audit reads this off a `tool_error` result as a field on that outcome, not a distinct outcome of its own -- it's what lets an operator's audit log tell "the sandbox held" apart from "the tool broke."
- **security.ts** validates paths via `validatePath()` -- resolves symlinks, checks prefix against allowed dirs. Empty allowed dirs = refuse everything (fail closed, not "no restrictions"); an operator who wants unrestricted access passes `--allowed-dir /` explicitly. NUL bytes and paths over `PATH_MAX` are refused up front (`basicPathError`), so they're clean refusals rather than an exception thrown three stack frames into `fs.lstatSync`.
- **Path resolution is component-by-component, not `realpath`-or-lexical.** `canonicalizePath()` walks from the root, follows every symlink in the part that exists, and carries only the not-yet-existing tail lexically. `fs.realpathSync` is all-or-nothing and throws for a path whose last component does not exist -- the ordinary case for `fs_write` -- and the old lexical fallback left symlink components in the string, so a symlink inside an allowed dir pointing outside it let a *new* file be written outside the sandbox. Two things the obvious "realpath the parent" shortcut still gets wrong: `..` must be applied to the resolved path, never collapsed lexically first (`<allowed>/sub/link/../../x` reads as `<allowed>/x` but lands outside -- and `fs.realpathSync` itself normalises `..` lexically, so this leaked *existing* files too), and a **dangling** symlink must be followed via `lstat`/`readlink` rather than treated as absent, because a write through it still creates the file at its target. Do not rewrite this function; extend around it.
- **`validatePathNoFollowFinal()` (C2)** exists for `fs_delete` alone: it canonicalizes `dirname(path)` as usual but re-joins `basename(path)` un-followed, so deleting `<root>/link-out` (a symlink pointing at, say, `/etc`) refuses or succeeds based on the *link* being in scope, never on where it points. `fs_delete` then uses `lstat`/`unlink` on that exact path -- never `stat`, or the same follow happens one line later.
- **Tool output that is a path is re-validated.** `fs_glob`, `fs_find` and `fs_grep` all filter every hit through `validatePath` rather than trusting descendants of a validated directory: whatever walks the tree chooses what gets reported, so a symlink inside an allowed directory that points outside it can come back as an in-scope-looking path. `fs_list` does not recurse, so it has no such gap: every entry it reports is `path.join(validatedDir, entry.name)` for a name `readdir` produced, which cannot contain a separator or `..`.
- **fs_grep** shells out to `rg` if available, falls back to recursive readdir + RegExp; both paths are bounded by `grepBudgetMs()` and both re-validate every path before it reaches the caller. The `rg` path always passes `--json` (never `-l`/`-c`/`-n`), parsed by `formatRgJson()`: issue #7 needed something to reliably split "this substring is the path" from "this substring is the file's own content" in order to translate only the former, and the old plain-text parsing (`path:line:content`, regex-anchored on the numeric line number because content can itself contain colons) was already flagged as fragile for an unusual filename -- building a rewrite step on that fragility would have made it load-bearing in a new way. `--json` gives the split structurally (`data.path.text` vs `data.lines.text`) instead. `-c`/count cannot be combined with `--json` (verified against a real ripgrep: it silently reverts to `-c`'s own plain output), so count is derived from each file's `end` event (`stats.matched_lines`) instead. The Node fallback (`grepFallback`) is untouched -- it builds its own output strings from paths it already controls, so `ToolRegistry.call`'s generic outbound translation is sufficient for it without a JSON round-trip.
- **fs_find** = `rg --files --no-follow` (Node walker fallback, which skips every symlink outright) + in-process fzf-style subsequence scoring (contiguity + word-boundary bonuses) over the resulting, re-validated file list. No new dependency -- `glob` stays the only runtime one.
- **fs_edit** uses `split().join()` for literal matching (no regex special char issues).
- **fs_move** validates both `source` and `destination` independently and in full (C4), refuses an existing destination unless `overwrite: true`, and refuses moving a directory into (or onto) its own descendant.
- **fs_delete** refuses to remove an `allowed_dir` root itself, defaults `recursive` to `false`, caps a recursive delete at 10,000 entries (refusing past it rather than truncating silently), and relies on `fs.rmSync`'s recursive mode unlinking a symlink it meets rather than following it -- pinned by test, not just assumed.
- **TOCTOU is a documented non-goal (C7),** for every mutating tool including the new ones: winning the check-then-use race requires writing a symlink inside an allowed directory, which the same uid running fsmcp could already do directly. If fsmcp ever runs more privileged than whoever can write into an allowed dir, the fix is `openat`-per-component with `O_NOFOLLOW` from a pinned root fd, not a better check.
- **No throws across tool boundary** -- registry wraps handlers in try/catch as a backstop, but tools are expected to check cleanly (absolute path, NUL bytes, overlong paths -- all centralized in `security.ts`) rather than lean on the catch.

## Build

```bash
npm ci && npx tsc   # build
./build.sh          # build, install to ~/.local/bin, register with Relay
```

## Adding a Tool

1. Create `src/tools/foo.ts`
2. Export `registerFoo(registry: ToolRegistry)`
3. Define tool with `registry.register({ name, description, inputSchema, category, annotations }, handler)` -- `annotations: { readOnlyHint, openWorldHint }` is required on the type, not optional; set both explicitly and honestly
4. Use `schema()`, `stringProp()`, `intProp()`, `boolProp()`, `enumProp()` from registry
5. Return via `textResult()` or `errorResult()` from types; use `scopeViolationResult()` (or `checkPath()`/`checkPathNoFollowFinal()` from security.ts, which return it for you) for any refusal that means "outside your scope"
6. Accept `ToolContext` as second arg. For any path ARGUMENT the client supplies, call `decodeInboundPath(arg, ctx.labels)` (vpath.ts) first and use the host path it returns -- not the raw argument -- for everything after. Check that decoded host path with `checkPathV()`/`checkPathNoFollowFinalV()` (vpath.ts) -- not `checkPath()`/`checkPathNoFollowFinal()` (security.ts) directly, or the refusal message will still name the host path, and not `validatePath()` + `errorResult()` by hand, or the refusal won't carry `_meta.scope_violation` when it should. A path the tool itself PRODUCES (a search hit, a directory listing entry) needs `hostToVirtualOrRedact()` (vpath.ts) on the way out. Any OTHER message that embeds a path this handler already decoded (a success sentence, a `file not found`) must be wrapped in `translateResult(result, [thatPath, ...], ctx.labels)` before it is returned -- outbound translation is deliberate per call site, not automatic (see "Outbound translation is deliberate" above); a caught exception's message should go through `describeError(err, ctx.labels)` instead of `err.message` directly, so `err.path`/`err.dest` get translated. Never pass a tool's own file CONTENT (what `fs_read` returns, or a matched line in `fs_grep` content mode) to any of these -- it is not a path, and translating it would corrupt it (PR #10)
7. Import and call `registerFoo(registry)` in `main.ts`
