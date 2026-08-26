# fsMCP v3 — design contract

fsMCP exposes **one directory** to an MCP client as a rooted filesystem. The
client addresses everything relative to that directory. It never learns, and
cannot express, a host path.

This document is the contract. Implementations conform to it; where an
implementation and this document disagree, this document is wrong and must be
changed deliberately.

## Principles

1. **The kernel enforces containment, not fsMCP.** Every filesystem operation
   goes through a `*os.Root` opened once at startup. `os.Root` resolves each
   path component with `openat`, so `..`, absolute paths and symlinks that
   leave the root are refused by the standard library, without a TOCTOU
   window. fsMCP performs no path canonicalisation of its own.
2. **A host path never enters the process's API surface.** Tools take relative
   paths. Nothing translates, and therefore nothing can leak.
3. **fsMCP does not interpret content.** It transports bytes and reports
   objective, checkable facts about them (length, hash, whether they are valid
   UTF-8). What the bytes *mean* is the client's problem.
4. **Every mutation states a precondition.** No blind writes.
5. **One way to do each thing.** No dual implementations, no fallbacks that can
   disagree with each other, no modes the caller must arbitrate between.

## Configuration

```
fsmcp --root <dir> [--read-only] [--max-response-bytes N]
```

- `--root` is **required**. fsMCP refuses to start without it, and refuses to
  start if it does not resolve to an existing directory. There is no default
  and no "unrestricted" mode.
- `--read-only` registers only the tools annotated `readOnlyHint: true`.
- `--max-response-bytes` defaults to `8388608` (8 MiB). Relay's bridge frame
  limit is 10 MiB; the operator sets this so the two are coordinated rather
  than independently guessed.
- **`ripgrep` is a hard requirement.** fsMCP resolves `rg` at startup and
  refuses to start without it. There is no pure-Go fallback: two search
  implementations that can disagree is a bug generator, and the previous
  version spent ~1,400 lines on exactly that.

There is **no `_meta.allowed_dirs`**, no per-call scope negotiation, and no
`contextSchema`. Scope is fixed at spawn. A deployment that needs two
directories runs two fsMCP processes.

## Path rules

- Paths are **relative to the root**. `.` and `""` both name the root.
- A single leading `/` is stripped: `/notes/x.md` means `notes/x.md`. With
  exactly one root there is no ambiguity, and refusing it only burns turns.
- Paths that escape the root are refused with `outside_root`.
- A NUL byte is `invalid_argument`, not `outside_root` — it is malformed input,
  not a containment event, and conflating the two makes `outside_root` useless
  as a signal that something tried to leave.
- Paths in **results** are always canonical: relative, no `./` prefix, `.` for
  the root itself.

### Absolute symlinks are unreachable, deliberately

`os.Root` refuses to traverse an **absolute** symlink even when its target is
inside the root. Verified: `link -> notes` works, `link -> /abs/path/to/root/notes`
is refused, and the second is an ordinary thing to find in a real folder.

This is accepted, not worked around. Resolving it would mean canonicalising
paths in userspace and re-deriving containment from the result, which is
precisely the design that made v2 leak and race. A file that is unreachable is
a usability cost; a containment check we wrote ourselves is a security cost.

Because the refusal is **not** actually "outside the root" in this case, the
message must not say it is. One message covers both honestly:

> path is not reachable within the root — it either leaves the root, or
> traverses an absolute symlink, which is refused even when the target is
> inside

### A search directory is a directory, never a symlink to one

`fs_grep` and `fs_glob` refuse a `path` that names a symlink with `not_a_dir`,
**including a relative one that resolves inside the root** — the shape A8a
otherwise says is reachable. The other tools do not: `fs_list` on that same
symlink lists the target's entries and `fs_read` through one returns the
target's bytes, so this is an asymmetry between the search tools and the rest
of the surface, and it is stated here rather than left for a caller to discover.

It is a usability cost, not a containment one. Containment does not rest on
this refusal: `os.Root` resolves the search path before rg is ever spawned and
refuses a symlink that leaves the root on its own. What the refusal buys is
that ripgrep is never handed a symlink at all — rg follows one given as an
explicit path argument even without `--follow`, so its resolution would
otherwise have to be trusted to agree with `os.Root`'s, and "two resolvers that
must agree" is the shape this design exists to avoid.

**The refusal costs a signal, and that is the part worth knowing.** A symlink
that escapes the root, used as a search `path`, is reported `not_a_dir` — not
`outside_root` — because it fails the directory test before anything examines
where it leads. So it carries no `_meta.scope_violation` marker, and relay's
audit records an ordinary tool failure rather than a containment event. Every
other route out of the root still reports `outside_root` and still marks it;
this one does not. An operator reading `relay audit` for boundary probes will
not see this one.

### A `not_found` for an absolute-looking path says why

Stripping the leading `/` means `/etc/passwd` becomes `etc/passwd` and comes
back `not_found`. On its own that teaches an agent the wrong thing — that the
host file is absent rather than that it is addressing a different namespace,
and an agent that cannot see it is confined behaves worse, not better.

When the input began with `/` and the result is `not_found`, say so:
`paths are relative to the root; "/etc/passwd" was read as "etc/passwd"`. Costs
nothing when the path exists, and corrects the model at the moment it is wrong.

### Symlink metadata

`fs_stat` on a symlink reports `type: "symlink"` and **`size: 0`**. Lstat's
size for a symlink is the byte length of its target path, which measures a host
path the client is not allowed to know — a `latest -> /Volumes/Backup/2026-08-26-nightly`
shape is ordinary, and its length confirms or eliminates a guess in one call.
A link's own size is not the size of anything the caller can read, so zero
costs nothing.

**No tool ever returns a symlink's target.** There is no `readlink` in the
published surface.

## Result envelope

Every tool returns exactly one `text` content block whose text is a JSON
document. There is no line-oriented format, no field separators, no escaping
convention and no trailer rule — a JSON parser is the only thing a caller
needs.

Success:

```json
{"ok": true, "...tool-specific fields": "..."}
```

Failure (`isError: true` on the MCP result):

```json
{"ok": false, "error": {"code": "not_found", "message": "no such file", "path": "notes/x.md"}}
```

### Error codes

`invalid_argument` · `outside_root` · `not_found` · `exists` · `not_a_file` ·
`not_a_dir` · `precondition_failed` · `no_match` · `ambiguous_match` ·
`too_large` · `read_only` · `integrity_failed` · `io_error`

**Never wrap a raw Go error into a message.** Map it to a code and write the
message yourself. This single rule replaces the previous version's
`redactLeakedHostPaths` backstop: an unwrapped `*os.PathError` is the only way
a root path could reach a caller, so not wrapping is the whole defence. An
acceptance test greps every emitted byte for the root path.

## Preconditions

`if_sha256` is **required** on `fs_write` and `fs_replace`, with exactly three
legal shapes:

| value | meaning |
|---|---|
| `"<64 lowercase hex>"` | the file must currently hash to this |
| `null` | the file must not exist (this is how you create one) |
| absent | schema violation — refused |

There is no default, so an agent cannot blind-write by omission. `fs_stat`
returns `sha256` for regular files, so a caller can obtain a precondition
**without reading the file** — which is what makes editing a 50 MB file
possible without transferring it.

## Tools

Ten tools. `readOnlyHint: true` on the first five; `--read-only` registers only
those. `openWorldHint: false` on all ten.

### `fs_stat` (read-only)
`{path}` → `{ok, path, type, size, mtime, mode, sha256?}`
`type` is `"file" | "dir" | "symlink" | "other"`. `sha256` is present for
regular files only.

### `fs_list` (read-only)
`{path}` → `{ok, path, entries: [{name, type, size, mtime}], truncated}`
Non-recursive. **Never hashes** — hashing a 5,000-entry directory is not a
listing. `name` is a bare filename, never a path.

### `fs_read` (read-only)
`{path, offset?, length?}` → `{ok, path, size, offset, length, eof, encoding, content, range_sha256, sha256?}`

- `offset`/`length` are **bytes**. One addressing scheme, no modes, no line
  numbers, no `cat -n`, no truncation of long lines.
- `length` defaults to whatever fits the response budget.
- `encoding` is `"utf8"` when the **returned range** is valid UTF-8 and
  `"base64"` otherwise. This is the only judgement fsMCP makes about content,
  it is objective, and it is stated in the reply rather than requested by the
  caller. A range that splits a multi-byte rune is therefore reported as
  `base64` — that is honest, and snapping to a rune boundary would silently
  return something other than what was asked for.
- `range_sha256` always covers the returned bytes. `sha256` (whole file) is
  present only when the read covered the whole file, so that chunked reads do
  not rehash the file once per chunk.

### `fs_glob` (read-only)
`{pattern, path?}` → `{ok, paths: [...], truncated}`
`rg --files --null -g <pattern>`. Relative patterns only. Output is split on
the NUL terminator, never on a newline — a filename may legally contain one.

**cwd is always the root.** A `path` argument is validated through the `Root`
and then passed as rg's positional search directory. It is never used as the
working directory: cwd-at-the-root is what makes rg's output root-relative with
no translation step, which is the property that removes the entire class of
host-path leaks.

### ripgrep runs outside the boundary, so its invocation is part of it

`rg` is a subprocess. `os.Root`'s openat resolution does not protect it, so
five things about how it is invoked are load-bearing and must not be
simplified away:

- **`--no-config`, on every invocation.** `RIPGREP_CONFIG_PATH` names a file of
  default arguments, and `--follow` in that file makes rg traverse symlinks out
  of the root. Verified: with it set, `rg "TOP SECRET"` from the root returns
  the content of a file outside the root; with `--no-config`, nothing. This is
  an environment variable, not an argument — nothing on the wire and nothing in
  fsMCP's own argv defends against it.
- **`-e <pattern>`, never a positional pattern.** A pattern beginning with `-`
  would otherwise be parsed as a flag.
- **`--` before the search directory, always.** The same hazard as `-e`, from
  the other end, and worse: the caller supplies a *path*, and `fs_mkdir` will
  create a directory under any name, so the caller can manufacture an argument
  that begins with `-`. Verified against a real binary: a directory named
  `--follow` made `fs_grep` return the contents of a file outside the root
  under a root-relative path, and one named `--pre=/bin/sh` made rg execute a
  file `fs_write` had just written. fsMCP publishes no tool that runs anything;
  without the `--` it lends ripgrep's.
- **`--hidden` and `--no-ignore`, on every invocation.** rg's defaults skip
  dotfiles and anything an ignore file excludes, and it reads ignore files from
  *above* the root as well as inside it. Verified: a `.gitignore` outside the
  root removed an in-root file from `fs_grep`'s results while `fs_list` still
  showed it. That is `RIPGREP_CONFIG_PATH`'s hazard reached through a file
  instead of an environment variable — something outside the boundary deciding
  what may be seen inside it — and it is reported as a complete result, because
  there is no `truncated` that can describe an omission the tool did not know
  it made.
- **argv array, never a shell string**, and **never `-L`/`--follow`.**

The absence of `--follow` is what keeps the walk inside the root. `--no-config`
is what stops the environment putting it back, and `--` is what stops the
caller putting it back.

`fs_glob` passes `-g <pattern>` on every call, and an explicit glob overrides
rg's hidden/ignore filtering on its own — so `--hidden --no-ignore` changes
nothing for it. They are stated as invariants of the invocation rather than of
one tool precisely so that `fs_grep`, which has no mandatory `-g`, cannot drift
away from `fs_glob` and `fs_list` about which files exist.

### `fs_grep` (read-only)
`{pattern, path?, glob?, max_matches?}` → `{ok, matches: [{path, line, text}], truncated}`
`rg --json`, parsed. `max_matches` defaults to 200.

### `fs_write`
`{path, content, encoding?, if_sha256}` → `{ok, path, sha256, bytes}`
`encoding` is `"utf8"` (default) or `"base64"`, describing `content`. Atomic
replace — see below.

### `fs_replace`
`{path, if_sha256, edits: [{find, replace, all?}]}` → `{ok, path, sha256, bytes, counts: [...]}`

The whole primitive:

```go
func apply(src []byte, edits []Edit) ([]byte, []int, error) {
    out, counts := src, make([]int, len(edits))
    for i, e := range edits {
        if len(e.Find) == 0                { return nil, nil, errEmptyFind }
        if bytes.Equal(e.Find, e.Replace)  { return nil, nil, errIdentical }
        n := bytes.Count(out, e.Find)
        if n == 0                          { return nil, nil, errNoMatch }
        if n > 1 && !e.All                 { return nil, nil, errAmbiguous(n) }
        out, counts[i] = bytes.ReplaceAll(out, e.Find, e.Replace), n
    }
    return out, counts, nil
}
```

- **Bytes, not runes.** It edits files that are not valid UTF-8 — the previous
  version refused those outright. A stray Latin-1 byte 400 lines away no longer
  makes a file uneditable.
- **Ambiguity is an error, never a policy.** Zero matches and multiple matches
  both refuse. `all: true` is the caller stating precise intent; with a
  non-empty needle `ReplaceAll` is exact and deterministic. The old
  `replace_all` bug was the empty needle, not the flag.
- **BOM, CRLF and a missing final newline survive**, because nothing decodes,
  splits or re-joins.
- **Batches are all-or-nothing.** The full result is computed in memory, then
  written once. A failing edit 4 leaves edits 1–3 unapplied.

To splice arbitrary non-UTF-8 bytes, use `fs_write` — `find`/`replace` are JSON
strings.

### `fs_mkdir`
`{path}` → `{ok, path, created: [...]}` — recursive.

### `fs_move`
`{source, destination}` → `{ok, source, destination}`

**There is no `overwrite`.** Move never destroys. An existing destination is
`exists`. Replacing one is `fs_delete` then `fs_move`, said out loud.

Before any operation, compare `(dev, ino)` of source and destination. Equal
means they are the same entry — refuse with `invalid_argument`. This is the
case-insensitive-APFS bug (review finding F1): `meeting.md` → `Meeting.md` told
the caller to pass `overwrite: true`, and doing so deleted the file. Refusing
the root as either operand.

### `fs_delete`
`{path, recursive?, if_sha256?}` → `{ok, path, deleted}`
`recursive` defaults false and is required for a non-empty directory.
`if_sha256` is an optional precondition for a regular file. The root is
refused.

### Arguments are decoded strictly

Every tool decodes its arguments with `DisallowUnknownFields`, and a required
content field is a pointer so that **absent** and **explicitly empty** stay
distinguishable.

This is not tidiness. Go ignores a field it does not recognise and leaves the
intended one at its zero value — and for a content field that zero value is the
empty string, which destroys data while the call reports success. Measured
before the check existed:

| call | result |
|---|---|
| `fs_write` with `contents` instead of `content` | file truncated to 0 bytes, `ok` |
| `fs_write` with no `content` at all | file truncated to 0 bytes, `ok` |
| `fs_replace` with `replacement` instead of `replace` | matched bytes deleted, `ok` |

A real agent produced the third of these unprompted on its first attempt at an
edit. The published schema already said `"required": ["find", "replace"]`; a
schema is a promise to the caller, not a check on it.

The refusal names the offending field (`json: unknown field "contents"`), which
is what lets a caller correct itself. An explicit `""` remains legal in both
tools — that is a request to write nothing, and a deletion, respectively.

## Atomic replace

`fs_write` and `fs_replace` both commit through a temp file in the same
directory followed by `rename`.

**Invariant to satisfy, mechanism left to the implementation:** across a
replace, the file's **mode, extended attributes and ACL are preserved
exactly**, and `umask` does not eat mode bits. If they cannot be preserved,
the write is **refused** and the file left unchanged — never silently dropped.
This is review issue #20; prove it with a test that asserts `ls -le` and
`xattr -l` output is identical before and after.

Clean up the temp file on every failure path.

## Integrity across the hop: `_meta.args_sha256`

Relay's ADR-013 says relay forwards a call's arguments verbatim. It was written
because relay's decode/re-encode round trip was substituting U+FFFD for lone
surrogates, sorting object keys, reformatting numbers and collapsing escapes —
and fsMCP's refusal never fired through relay for months. ADR-013 states the
policy; nothing enforces it.

- `relayremote` computes `sha256` over the **exact argument bytes it was
  handed**, before any decode, and sends it as `_meta.args_sha256`.
- fsMCP computes `sha256` over the exact bytes it received for
  `params.arguments` (held as `json.RawMessage`, never decoded first) and
  compares.
- Mismatch → `integrity_failed`, nothing executed.

Any re-serialisation between the two ends becomes a loud refusal instead of
silent corruption reported as success.

**Verified when present, not required.** This is an integrity check against
bugs, not an authentication check — a hostile client could send whatever bytes
it liked anyway, so nothing is gained by demanding it, and bare-stdio callers
stay supported.

This also dissolves the lone-surrogate problem rather than defending it: a
mangled `find` needle simply fails to match, and a mangled `replace` fails the
hash. Fails closed both ways, with no surrogate check anywhere.

## Response budget

One cap, not three. `--max-response-bytes` bounds the serialised JSON-RPC line.
Each tool bounds its own payload against it and reports `truncated` (search) or
`eof` (read) so a caller can tell a bounded answer from a complete one. Base64
expands 4/3; a read's default `length` accounts for that.

## Comments

Two kinds of comment are worth writing:

- **This is subtle** — a careful reader would misread the code.
- **This is deliberate** — the code looks wrong, redundant or slow, and someone
  will "fix" it back into a bug. Name the constraint.

`fs_move`'s `(dev, ino)` comparison is the canonical second case: it looks like
over-engineering until you know a case-only rename on APFS is indistinguishable
from a self-move by path. One line naming that is what stops it being
simplified back into a data-destruction bug.

Everything else is a naming or layout failure. If the urge is to explain *what*
the code does, rename something or extract a function.

No history, no issue numbers, no accounts of what a previous version did wrong.
This document holds the reasoning; the code holds the code, in the present
tense.
