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
- **security.ts** validates paths via `validatePath()` -- resolves symlinks, checks prefix against allowed dirs. Empty allowed dirs = no restrictions.
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
