# fsMCP

An MCP server that exposes **one directory** to a client as a rooted
filesystem. The client addresses everything relative to that directory. It
never learns, and cannot express, a host path.

Containment is enforced by the kernel. Every filesystem operation goes through
a `*os.Root` opened once at startup, which resolves each path component with
`openat` — so `..`, absolute paths and symlinks leaving the root are refused by
the standard library, without a TOCTOU window. fsMCP performs no path
canonicalisation of its own.

## Tools

| Tool | Read-only | Description |
|---|---|---|
| `fs_stat` | yes | type, size, mtime, mode, and `sha256` for a regular file |
| `fs_list` | yes | one directory's immediate contents; never hashes |
| `fs_read` | yes | a byte range; encoding reported, not requested |
| `fs_glob` | yes | `rg --files -g <pattern>` |
| `fs_grep` | yes | `rg --json`, parsed structurally |
| `fs_write` | no | replace a file atomically |
| `fs_replace` | no | byte-level find/replace, atomically |
| `fs_mkdir` | no | create a directory, recursively |
| `fs_move` | no | rename; never destroys |
| `fs_delete` | no | remove a file, symlink or directory |

`--read-only` registers only the five read tools — they are absent from
`tools/list`, not merely refused.

## Requirements

- Go 1.25+ to build (`os.Root`'s mutation surface landed in 1.25)
- **ripgrep on PATH.** fsMCP refuses to start without it. There is no pure-Go
  fallback: two search implementations that can disagree is a bug generator.

## Build

```bash
./build.sh          # builds, installs to ~/.local/bin/fsmcp, ad-hoc signs
```

## Running

```bash
fsmcp --root <dir> [--read-only] [--max-response-bytes N]
```

`--root` is required. fsMCP refuses to start without it, and refuses to start
if it does not resolve to an existing directory. There is no default and no
unrestricted mode.

Scope is fixed at spawn. There is no per-call scope negotiation and no
`contextSchema`; a deployment needing two directories runs two processes. With
Relay, register one MCP per granted directory and grant it by MCP id.

## Addressing

Paths are relative to the root. `.` and `""` name the root. A single leading
`/` is stripped, so `/notes/x.md` means `notes/x.md` — with one root there is
no ambiguity, and refusing it only costs a turn.

An **absolute symlink is refused even when it points inside the root.** This is
`os.Root`'s behaviour and it is accepted rather than worked around: resolving
it would mean canonicalising paths in userspace and re-deriving containment
from the result, which is the design this version exists to replace.

## Results

Every tool returns one text block containing a JSON document. There is no
line-oriented format, no field separators and no escaping convention — a JSON
parser is all a caller needs.

```json
{"ok": true,  "path": "notes/config.txt", "size": 12, ...}
{"ok": false, "error": {"code": "not_found", "message": "...", "path": "..."}}
```

An `outside_root` refusal also carries `_meta.scope_violation: true`, which is
what lets Relay's audit log tell a containment refusal apart from an ordinary
tool failure.

## Content

fsMCP transports bytes and reports checkable facts about them — length, hash,
and whether they are valid UTF-8. What the bytes *mean* is the client's
problem. There is no line concept: no line numbers, no long-line truncation,
no pagination by line.

`fs_read` takes a byte `offset`/`length` and reports `encoding` as `"utf8"`
when the returned range is valid UTF-8 and `"base64"` otherwise. That is the
only judgement fsMCP makes about content, it is objective, and it is stated in
the reply rather than asked for. A range that splits a multi-byte rune is
therefore reported as base64 — honest, rather than silently repaired.

## Preconditions

`if_sha256` is **required** on `fs_write` and `fs_replace`:

| value | meaning |
|---|---|
| `"<64 hex>"` | the file must currently hash to this |
| `null` | the file must not exist — this is how you create one |
| absent | refused |

No default, so a caller cannot blind-write by omission. `fs_stat` returns
`sha256`, so a precondition is available **without reading the file** — which
is what makes editing a large file possible without transferring it.

## Editing

`fs_replace` applies byte-level find/replace, atomically:

- ambiguity is an error, never a policy — zero matches and multiple matches
  both refuse, and `all: true` is the caller stating intent
- it operates on **bytes**, so it edits files that are not valid UTF-8
- BOM, CRLF and a missing final newline survive, because nothing decodes,
  splits or re-joins
- batches are all-or-nothing: a failing edit 4 leaves edits 1–3 unapplied

## Atomic replace

`fs_write` and `fs_replace` commit through a temp file in the same directory
followed by `rename`. Mode, extended attributes and ACL are preserved exactly;
`umask` does not eat mode bits. If they cannot be preserved, the write is
refused and the file left unchanged.

Two consequences, both deliberate:

- A replace **breaks a hard link** to the target (new inode). The alternative
  is in-place truncation, which is not crash-safe.
- A file whose ACL **denies delete** cannot be written. That entry exists to
  stop the inode being replaced, so stripping it to force the write through
  would defeat the protection it enforces. The refusal says so.

## Integrity across a hop

If a caller supplies `_meta.args_sha256`, fsMCP hashes the exact bytes it
received for `params.arguments` and refuses on mismatch. Any re-serialisation
between the two ends becomes a loud refusal rather than silent corruption
reported as success. Verified when present, not required.

## Documents

| | |
|---|---|
| `docs/DESIGN.md` | the contract, and why each decision is what it is |
| `docs/ACCEPTANCE.md` | the hazard battery, and which expectations v2 inverted |
| `docs/INTEGRATION.md` | Relay and relayRemote |
| `docs/TRACEABILITY.md` | which test covers which hazard |
