# fsMCP

MCP server providing file system tools via stdio. 6 tools, 2 categories. TypeScript/Node.js. One runtime dependency (glob).

## Architecture

Single-threaded stdin/stdout MCP server. Newline-delimited JSON-RPC 2.0. Protocol version `2024-11-05`.

```
src/
  main.ts        Stdin loop, JSON-RPC dispatch (initialize, tools/list, tools/call)
  types.ts       Wire types, MCPTool interface, result helpers (textResult, errorResult)
  registry.ts    ToolRegistry class + JSON schema builder helpers
  security.ts    Path validation against allowed_dirs (_meta + CLI flags)
  tools/         One file per tool, each exports register(registry)
```

Entry point reads stdin line-by-line, dispatches to `ToolRegistry`, writes JSON to stdout. Synchronous.

## Tools

| Tool | Category | Read-only | Backend |
|------|----------|-----------|---------|
| fs_read | File System | yes | fs.readFileSync, cat -n format |
| fs_write | File System | no | fs.writeFileSync, auto-creates dirs |
| fs_edit | File System | no | split/join literal string replacement |
| fs_glob | File System | yes | glob npm package, mtime sort |
| fs_grep | File System | yes | ripgrep (rg) with Node.js fallback |
| fs_bash | Shell | no | child_process.execSync, persistent cwd |

## Key Patterns

- **Tool = module** with `export function register(registry: ToolRegistry)`. Handler signature: `(args, ctx) => MCPCallResult`.
- **ToolContext** carries `allowedDirs` merged from `_meta` (Relay per-token) and `--allowed-dir` CLI flags.
- **contextSchema** declared in `initialize` response's `serverInfo`. Relay reads this during discovery and renders the appropriate UI for configuring per-token context (e.g. allowed_dirs). Schema fields have `type`, `description`, and `ui` hint.
- **security.ts** validates paths via `validatePath()` -- resolves symlinks, checks prefix against allowed dirs. Empty allowed dirs = refuse everything (fail closed, not "no restrictions"); an operator who wants unrestricted access passes `--allowed-dir /` explicitly.
- **Path resolution is component-by-component, not `realpath`-or-lexical.** `canonicalizePath()` walks from the root, follows every symlink in the part that exists, and carries only the not-yet-existing tail lexically. `fs.realpathSync` is all-or-nothing and throws for a path whose last component does not exist -- the ordinary case for `fs_write` -- and the old lexical fallback left symlink components in the string, so a symlink inside an allowed dir pointing outside it let a *new* file be written outside the sandbox. Two things the obvious "realpath the parent" shortcut still gets wrong: `..` must be applied to the resolved path, never collapsed lexically first (`<allowed>/sub/link/../../x` reads as `<allowed>/x` but lands outside -- and `fs.realpathSync` itself normalises `..` lexically, so this leaked *existing* files too), and a **dangling** symlink must be followed via `lstat`/`readlink` rather than treated as absent, because a write through it still creates the file at its target.
- **Tool output that is a path is re-validated.** `fs_glob` filters every hit through `validatePath` rather than trusting descendants of a validated directory: the pattern chooses what gets walked, so `link/*` returned an in-scope-looking path whose bytes live outside.
- **fs_grep** shells out to `rg` if available, falls back to recursive readdir + RegExp.
- **fs_bash** persists cwd via `___FSMCP_CWD___$(pwd)` marker appended to commands.
- **fs_edit** uses `split().join()` for literal matching (no regex special char issues).
- **No throws across tool boundary** -- registry wraps handlers in try/catch, all errors returned as `MCPCallResult` with `isError: true`.

## Build

```bash
npm ci && npx tsc   # build
./build.sh          # build, install to ~/.local/bin, register with Relay
```

## Adding a Tool

1. Create `src/tools/foo.ts`
2. Export `registerFoo(registry: ToolRegistry)`
3. Define tool with `registry.register({ name, description, inputSchema, category, annotations }, handler)`
4. Use `schema()`, `stringProp()`, `intProp()`, `boolProp()`, `enumProp()` from registry
5. Return via `textResult()` or `errorResult()` from types
6. Accept `ToolContext` as second arg; call `validatePath()` for any file paths
7. Import and call `registerFoo(registry)` in `main.ts`
