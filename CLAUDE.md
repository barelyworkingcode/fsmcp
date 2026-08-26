# fsMCP

Go MCP server over stdio. Ten tools, one root directory, zero dependencies
beyond the standard library and ripgrep.

Read `docs/DESIGN.md` before changing anything. It holds the reasoning; the
code holds the code.

## Layout

```
main.go                    flags, root open, rg check, JSON-RPC loop
internal/proto/            JSON-RPC types, result envelope, error taxonomy
internal/fsapi/root.go     the *os.Root wrapper, path normalisation, error mapping
internal/fsapi/registry.go tool registration, args_sha256 check, dispatch
internal/fsapi/<tool>.go   one file per tool
internal/fsapi/atomic.go   the atomic replace and if_sha256 preconditions
internal/fsapi/rg.go       the shared ripgrep invocation
testkit/                   fixture builder and the stdio-level batteries
```

## Invariants

**Containment is the kernel's, not ours.** Everything goes through the one
`*os.Root`. Never call `os.Open`, `os.Stat`, `filepath.Abs` or
`filepath.EvalSymlinks` on caller input. There is no path canonicalisation
anywhere, and adding one would reintroduce the TOCTOU window this design
removes.

**Never wrap a raw Go error into a result.** Map it to a taxonomy code and
write the message yourself. An unwrapped `*os.PathError` is the only way a root
path could reach a caller, so not wrapping is the whole defence. Use
`fsapi.Fail(err, callerPath)`.

**ripgrep runs outside the boundary.** It is a subprocess, so `os.Root` does
not protect it. Every invocation carries `searchInvariants` (`--no-config`,
`--hidden`, `--no-ignore`) and reaches its search directory through
`appendSearchDir`; both live in `rg.go` and neither is a preference:

- `--no-config` — `RIPGREP_CONFIG_PATH` can inject `--follow`, which walks out
  of the root (verified).
- `--hidden`, `--no-ignore` — rg's defaults skip dotfiles and honour ignore
  files, **including ones above the root**, so without these something outside
  the boundary decides what is visible inside it, and the omission is reported
  as a complete result (verified).
- `-e` for the pattern, and `--` before the search directory, so neither a
  pattern nor a directory *name* beginning with `-` is read as a flag.
  `fs_mkdir` will create a directory called `--follow` or `--pre=/bin/sh`, and
  both were live escapes before the `--` (verified: content from outside the
  root returned, and a written file executed).
- argv array never a shell string, and never `-L`.

**Every mutation states a precondition.** `if_sha256` distinguishes absent from
explicit `null`; collapsing them loses the guarantee.

**`fs_move` compares `(dev, ino)`, not path strings.** APFS is case-insensitive
by default, so a case-only rename is indistinguishable from a self-move by
path. Simplifying this back to a string compare reintroduces a
data-destruction bug.

## Adding a tool

1. `internal/fsapi/<name>.go`, exporting `Register<Name>(reg *Registry)`.
2. Follow `stat.go` for shape: description, input schema, args struct, handler.
3. Take paths through `NormalizePath`, then the `*Root`. Return errors via
   `Fail`.
4. Publish `readOnlyHint` and `openWorldHint` explicitly.
5. Bound your own result against `root.MaxResponseBytes()` and report
   `truncated`. The whole-response backstop in `main.go` reports an fsMCP bug —
   reaching it for an ordinary oversized request trains everyone to ignore the
   one alarm that should only mean a real bug.
6. Wire it in `main.go`.
7. Add its hazards to `docs/ACCEPTANCE.md` and a test to
   `docs/TRACEABILITY.md`.

## Comments

Two kinds are worth writing: **this is subtle** (a careful reader would
misread it) and **this is deliberate** (it looks wrong and someone will "fix"
it back into a bug — name the constraint). Everything else is a naming or
layout failure; rename or extract instead.

No history, no issue numbers, no accounts of what a previous version did
wrong. Present tense only.

## Testing

```bash
go test ./...
testkit/mkfixture.sh /tmp/fx          # prints the root; plants real hazards
testkit/containment.sh   <bin> /tmp/fx/root
testkit/fidelity.sh      <bin> /tmp/fx/root
testkit/search-escape.sh <bin> /tmp/fx/root /tmp/fx/outside
python3 testkit/mutation.py <bin> /tmp/fx/root
```

The fixture plants a deny-delete ACL; `chmod -RN` before removing it.

`containment.sh`, `fidelity.sh` and `search-escape.sh` **print, they do not
assert** — they exit 0 whatever they saw, so a human has to read the output.
They are an eyeball check against a real `rg` and a real disk, never a CI gate.
Every hazard has a `go test` covering it directly; see `docs/TRACEABILITY.md`.

Build harnesses in Python, not shell. Nested JSON inside shell quoting
produced false PASSes twice — a call that never ran looks identical to a call
that changed nothing. Assert against the disk (`shasum`, `xattr`, `ls -le`),
never against fsMCP's own reported values, and assert that the operation
actually succeeded before asserting what it preserved.
