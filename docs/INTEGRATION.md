# Layers 2 and 3 — relay, relayRemote, hermes

Layer 1 is fsMCP alone over stdio. This document specifies what changes in the
two repos around it. Both are on branch `go-rewrite`, matching fsMCP.

Nothing here changes the bridge wire protocol. Byte-range reads make chunked
transfer a client-side loop, and single-frame writes fit the existing 10 MiB
budget; inventing a streaming frame type across three repos before a real
workload demands it is the speculative complexity this rewrite exists to
remove. If Layer 3 produces evidence that a real hermes workload needs it, that
becomes its own change with its own justification.

---

## relay

### R1 — MCPs are registered per directory, not granted one

v3 fsMCP takes `--root` at spawn and publishes **no `contextSchema`**. Scope no
longer travels per call. An operator registers `fsmcp-documents`,
`fsmcp-projects` and so on, each with its own `--root`, and a token's grant
names the **MCP**, not a directory. Access control moves from a field value to
relay's existing per-MCP permission model.

`derivedScopeFields` returns nil for a schema-less MCP, so
`unsatisfiableScopeField` is false and the tools stay listed and callable for a
remote access profile. **Verify this empirically** — the reading is good
evidence, not proof, and getting it wrong reproduces exactly the refusal the v2
context schema was invented to work around.

### R2 — the audit log must not lose the directory

Consequence of R1: relay would record `scope: null` for every fsMCP call,
because the MCP declares no scope field. An operator auditing *which directory
did this touch* would get nothing, and ADR-011 decision 7 requires the log to
answer "what was attempted with what authority" on its own.

Stamp the resolved `--root` on the audit record for any MCP relay spawned with
one. Relay knows it — it wrote the args.

### R3 — oversized frames: already fixed, needs a regression test

Review issue #39 (an over-long line hit `bufio.ErrTooLong`, relay dropped the
connection, and the MCP was never respawned) is **already repaired on main**.
`readMcpFrame` in `external_mcp.go` replaced `bufio.Scanner` precisely because a
scanner cannot resync: it now discards an oversized frame as it reads and stays
aligned on the next newline.

No new work. But v3 raises payload sizes from 64 KiB toward the frame budget, so
this path goes from rare to routine — add a Layer-2 regression test that an
oversized fsMCP response is one failed call followed by a **healthy** connection
that serves the next call normally.

### R4 — one coordinated size budget

Relay passes `--max-response-bytes` to fsMCP, derived from
`bridge.MaxMessageSize` with headroom for the JSON-RPC envelope. Today fsMCP
guesses 64 KiB while the wire allows 10 MiB — three caps set independently,
none of them the real constraint.

### R6 — an ungranted tool name must be diagnosed against the grant

Measured on the live stack. A profile granting only `fsmcpB` (read-only, root
`/tmp/rootB`) asked for `fs_write`:

```
error: access denied: MCP 'fsmcp' is disabled for this token
```

`fsmcp` is neither the granted MCP nor the one that would have served the call.
Relay resolved an unrecognised tool name by scanning every registered MCP and
reported the first that publishes it.

**The outcome is correct** — the call was denied and nothing was written to the
other root, confirmed by checking both roots afterwards. Two things are still
wrong:

- The operator is pointed at the wrong MCP and at a grant that is not the
  problem. The true answer is "the MCP your token grants does not publish
  `fs_write`".
- The client learns the id of an MCP it was never granted.

This was seen once during the v2 review and never filed, because with one
`fsmcp` it looked like a curiosity. Under v3 it is the normal case: one MCP per
directory means every registered fsMCP publishes the same ten `fs_*` names, so
name collisions across MCPs stop being an edge case.

Resolve a tool name against the profile's granted MCPs first, and when it is
not there, say so without naming an MCP outside the grant.

### R5 — spawn fsMCP under seatbelt

Defence in depth. `os.Root` is the primary boundary and holds on its own; this
covers a bug in fsMCP, in `rg`, or in Go.

`Command` becomes `/usr/bin/sandbox-exec` and `Args` are prefixed with
`-f <profile> -D GRANT=<resolved-root> <real-fsmcp-path>`. The root is passed as
a **`-D` parameter, never interpolated into the profile text** — the profile is
a static file, so a directory name containing a quote or a backslash cannot
break its syntax. (Test a root containing `"` and a space anyway.)

Profile, verified working on macOS 26.4 arm64 with Node and with `rg`:

```
(version 1)
(import "bsd.sb")
(allow process-exec*)
(allow process-fork)
(deny file-read* file-write*)
(allow file-read* file-map-executable
  (subpath "/usr") (subpath "/System") (subpath "/Library") (subpath "/bin")
  (subpath "/sbin") (subpath "/opt/homebrew") (subpath "/private/var/db")
  (subpath "/dev")
  (literal "/") (literal "/private") (literal "/private/tmp") (literal "/tmp"))
(allow file-write-data (subpath "/dev"))
(allow file-read* file-write* (subpath (param "GRANT")))
```

A read-only grant drops `file-write*` from the last line.

Resolve the root through symlinks before passing it — seatbelt matches real
paths. Atomic-replace temp files live in the target's own directory, inside the
grant, so no writable temp directory is needed.

**Fail closed.** If `sandbox-exec` is missing or the spawn fails, relay refuses
to start that MCP. It must never fall back to spawning it unsandboxed, which
would be a silent downgrade of the boundary.

---

## relayRemote

### C1 — the argument integrity hash

Compute `sha256` over the **exact argument bytes as received**, before any
decode or re-marshal, and send it as a top-level `args_sha256` field on
`RemoteRequest`. Relay **forwards** that value into the downstream
`tools/call` as `_meta.args_sha256`; fsMCP hashes the bytes it received for
`params.arguments` and compares.

The remote wire carries **no `_meta` channel**, so this is a coordinated field
on `RemoteRequest` rather than metadata riding beside it, and relay decodes
that struct with `DisallowUnknownFields` — both ends deploy together, which
ADR-010 decision 4 already requires. (An earlier draft of this document said
relayremote sends `_meta.args_sha256` directly. There is nowhere for it to
go.)

Relay forwards rather than recomputes: a hash relay derives from arguments
relay has decoded validates relay against itself and detects nothing. Relay is
a courier here, never a verifier, and never fails a call over this field.

This makes ADR-013 enforceable rather than aspirational. The ADR was written
because relay's decode/re-encode round trip substituted U+FFFD for lone
surrogates, sorted object keys, reformatted numbers and collapsed escapes — and
fsMCP's refusal never fired through relay for months. The ADR states the
policy; this check proves it held on every call.

The hash must cover the bytes as they arrived on `--args`. A test must assert
that a round trip through `relayremote` → relay → a recording stub yields
byte-identical arguments, and that deliberately corrupting them mid-path is
caught.

### C2 — results are JSON documents

Every tool result is now one text block containing JSON. `relayremote call`
passes it through **unmodified** by default; pretty-printing is a flag. A CLI
that reformats a result recreates, one layer up, exactly the corruption the
hash in C1 exists to detect.

### C3 — regenerate skills

`relayremote skill` output describes the v2 surface: `/d0/...` addressing,
`encoding` arguments, `fs_edit`, `fs_find`. All wrong now. The generated
SKILL.md must teach: paths are relative to `.`, `if_sha256` is required on
mutations, `fs_stat` is where a precondition comes from without reading a file,
and ambiguity in `fs_replace` is an error to resolve with more context.

---

## Layer 3 — hermes

Run the escape battery from ACCEPTANCE.md sections A and B through a real
hermes agent against a real grant, and re-run the review's original end-to-end
escape attempts.

**Ground truth is `relay audit`, never the agent's own account of what it could
reach.** An agent reporting "I could not access that" is not evidence; an audit
record showing the call was refused is.
