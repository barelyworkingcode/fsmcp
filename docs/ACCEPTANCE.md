# fsMCP v3 — acceptance battery

Every hazard below was found by a review or a bug report against v2. They are
kept because they describe real ways this tool can damage a user's data or leak
a host path — not because the old tests existed. The old TypeScript tests are
being deleted; their *intent* lives here.

Three categories: **carried** (same hazard, same expectation), **inverted**
(v3 deliberately behaves differently — do not blindly port), and **dead**
(the design removed the hazard, so the test has nothing to assert).

---

## A. Containment

`os.Root` is the mechanism, but the guarantee still needs proving. Each of
these must be refused, and no refusal may contain the root's host path.

| # | case |
|---|---|
| A1 | absolute path (`/etc/passwd`) |
| A2 | `..` traversal (`../../etc/passwd`), at any depth |
| A3 | symlink inside the root pointing outside — target **exists** |
| A4 | same, target **does not exist** (dangling) |
| A5 | same, target is a **directory** (`/etc`) |
| A6 | symlink **cycle** — refused, does not hang |
| A7 | NUL byte in a path — refused by name, never reaches a syscall |
| A8a | a **relative** symlink that stays inside the root still works (not over-refused) — `fs_list` lists through it, `fs_read` reads through it |
| A8b | an **absolute** symlink, even one pointing inside the root, is refused |
| A8c | the same symlink as a **search directory** (`fs_grep`/`fs_glob` `path`) is refused `not_a_dir` — deliberate, and the one place A8a does not hold |
| A8d | an **escaping** symlink as a search directory reports `not_a_dir`, so unlike every other escape it carries no `scope_violation` marker |
| A9 | the root itself is addressable as `.` and as `""` |

A8b is a deliberate limitation, not a bug, and is pinned as a test so it stays
deliberate. `os.Root` refuses to traverse an absolute symlink whatever it points
at. Making it work would mean canonicalising paths in userspace and re-deriving
containment from the result — the v2 design that leaked and raced. The refusal
message must not claim the path is outside the root, because in this case it
is not; see DESIGN.md, "Absolute symlinks are unreachable, deliberately".

**A10 — the leak test.** Run every tool, with arguments chosen to make each
fail in several ways, and assert the root's absolute path appears in **no
emitted byte** across stdout. This is the one test that replaces v2's entire
`vpath.ts` redaction layer.

## B. Data destruction — `fs_move`

Finding F1 was rated critical: an ordinary capitalisation fix deleted the file.

| # | case | expectation |
|---|---|---|
| B1 | case-only rename `meeting.md` → `Meeting.md` on case-insensitive APFS | **succeeds**, content intact |
| B2 | case-only rename of a **directory** | succeeds, contents intact |
| B3 | literal self-move (`x` → `x`) | refused as `invalid_argument`, file intact |
| B4 | destination exists (file) | refused as `exists`, both intact |
| B5 | destination exists (non-empty directory) | refused as `exists`, tree intact |
| B6 | a move that fails for any reason | destination intact, source intact |
| B7 | root as source or destination | refused |

B1 is the case that made F1 critical, and it is the one v2 could not express at
all. Detect the same-entry case by comparing `(dev, ino)` — **not** by
comparing path strings, which is what made a case-only rename indistinguishable
from a self-move.

**Inverted:** v2 tests asserted a `overwrite: true` path. There is no
`overwrite` in v3. Any test mentioning it is dead.

## C. Corruption — atomic replace

| # | case | expectation |
|---|---|---|
| C1 | extended attributes preserved across a replace | asserted via `xattr -l`, identical before/after |
| C2 | ACL preserved across a replace | asserted via `ls -le`, identical before/after |
| C3 | **exact** mode bits preserved — `umask` does not eat them | 0644, 0600, 0755 all survive |
| C4 | a setuid file does not produce a setuid replacement | setuid bit dropped, deliberately |
| C5 | attributes cannot be preserved | write **refused**, file unchanged — never silently dropped |
| C6 | a write that fails partway | original intact, no temp file left |
| C7 | concurrent writes | never tear; a reader sees old or new, never half |
| C8 | no temp file survives any failure path | directory listing clean after each |

**Known and deliberate:** a replace breaks a hard link to the target (new
inode). Assert it rather than fix it — the alternative is in-place truncation,
which is not crash-safe.

## D. Byte fidelity

| # | case | expectation |
|---|---|---|
| D1 | a real PNG round-trips `fs_read` → `fs_write` | byte-identical |
| D2 | BOM preserved across `fs_replace` | present, unmoved |
| D3 | CRLF line endings preserved across `fs_replace` | unchanged |
| D4 | missing final newline preserved | still missing |
| D5 | multi-byte UTF-8 preserved | unchanged |
| D6 | a byte range that splits a multi-byte rune | reported as `encoding: "base64"`, not repaired |
| D7 | `range_sha256` matches the returned bytes, always | |
| D8 | whole-file `sha256` present only when the read covered the whole file | |

**INVERTED — D9.** v2 asserted *"`fs_edit` refuses a non-UTF-8 file rather than
rewriting it as corrupted UTF-8"*. v3 must **succeed**: `fs_replace` operates on
bytes, so editing an ASCII key in a file containing a stray Latin-1 byte
elsewhere works. Test the success, and assert the non-UTF-8 bytes elsewhere in
the file are untouched.

**INVERTED — D10.** v2 asserted *"a line over 2000 chars: text mode truncates
and flags it structurally"*. v3 has no line concept and no truncation. A long
line comes back whole, subject only to the byte range asked for.

## E. `fs_replace` semantics

| # | case | expectation |
|---|---|---|
| E1 | empty `find` | refused (`invalid_argument`) — never interleaved |
| E2 | `find` == `replace` | refused — a no-op still rewrites the inode, so it is not a no-op |
| E3 | `find` occurs zero times | refused (`no_match`) |
| E4 | `find` occurs twice, `all` unset | refused (`ambiguous_match`), count named |
| E5 | `find` occurs twice, `all: true` | both replaced, `counts: [2]` |
| E6 | empty `replace` | a deletion; works |
| E7 | batch where edit 2 fails | **nothing** written; edit 1 not applied |
| E8 | batch where all succeed | one atomic write, `counts` per edit |
| E9 | `if_sha256` does not match current file | refused (`precondition_failed`), nothing written |
| E10 | `if_sha256: null` on a file that exists | refused (`exists`) |
| E11 | `if_sha256` absent | schema violation |

## E2. Argument decoding

Found by a real agent on its first edit, not by review.

| # | case | expectation |
|---|---|---|
| E12 | `fs_write` with `contents` instead of `content` | refused, naming the unknown field; file untouched |
| E13 | `fs_write` with no `content` field | refused; file untouched |
| E14 | `fs_replace` with `replacement` instead of `replace` | refused, naming the field; file untouched |
| E15 | `fs_replace` with no `replace` in an edit | refused; file untouched |
| E16 | `fs_write` with an explicit `""` | succeeds — writing nothing is legitimate |
| E17 | `fs_replace` with an explicit `""` replacement | succeeds — that is a deletion |

E16 and E17 are why absent and empty must stay distinguishable rather than
both being refused.

## F. Search — injection and honesty

`rg` is invoked as an **argv array**, never a shell string.

| # | case | expectation |
|---|---|---|
| F1 | shell metacharacters in a grep pattern | matched literally as a pattern, no shell |
| F2 | command substitution (`$(...)`, backticks) in a pattern | text, not a subshell |
| F3 | a shell redirect in a pattern | writes no file |
| F4 | a newline in a pattern | one argv element, not two |
| F5 | a NUL byte in a pattern | clean refusal, not a panic |
| F6 | an absolute glob pattern | refused |
| F7 | a glob pattern aimed above the root (`../*`) | refused; does not walk what is up there |
| F8 | a brace alternative smuggling an absolute path | refused |
| F9 | a truncated search | says so (`truncated: true`) — never an unmarked partial |
| F10 | a search that matched nothing | an explicit empty result, never an error |
| F11 | a search that could not run at all | an error, never an empty success |
| F12 | `rg` times out | an error naming the timeout, never a silent partial |
| F13 | a file whose name contains a newline | one entry, intact — trivial now that results are JSON |
| F14 | a search directory whose **name begins with `-`** (`--follow`, `-L`) | searched as the directory it is; never parsed as a flag, never leaves the root |
| F15 | a search directory named `--pre=/bin/sh` | rg executes nothing; fsMCP lends no execution primitive it does not publish |
| F16 | a dotfile (`.env`) `fs_list` reports | `fs_grep` searches it too |
| F17 | an ignore file (`.gitignore`/`.ignore`) **inside** the root | does not filter the search; it is not an access control |
| F18 | an ignore file **above** the root | does not filter the search — nothing outside the boundary decides what is visible inside it |

## G. Deletion

| # | case | expectation |
|---|---|---|
| G1 | the root itself | refused |
| G2 | non-empty directory without `recursive` | refused |
| G3 | recursive delete encountering a symlink | **unlinks the symlink**, does not descend through it |
| G4 | `if_sha256` mismatch on a file | refused, file intact |

## H. Protocol surface

| # | case |
|---|---|
| H1 | every tool publishes `readOnlyHint` and `openWorldHint` as explicit booleans |
| H2 | `--read-only` registers exactly the five `readOnlyHint: true` tools, and a write tool is then not merely refused but **absent** from `tools/list` |
| H3 | a response over `--max-response-bytes` becomes a JSON-RPC error, never a truncated line |
| H4 | malformed JSON on stdin is a `-32700`, and the server stays up |
| H5 | an unknown method with an id gets `-32601`; a notification gets no reply |
| H6 | `_meta.args_sha256` mismatch → `integrity_failed`, nothing executed |
| H7 | `_meta.args_sha256` absent → the call proceeds normally |
| H8 | a call that panics anywhere is caught and returned as `io_error` — one bad call never takes the server down |

H8 matters: v2 had a live crash where a malformed `_meta` threw outside the
handler's `try` and killed the process.

---

## Dead — do not port

These assert behaviour v3 does not have. Listed so nobody re-adds them.

- The whole `_meta.allowed_dirs` / C1 narrowing table (four rows), the
  malformed-`_meta` handling, and the dropped-directory disclosure. Scope is
  fixed at spawn; `_meta.allowed_dirs` does not exist.
- Everything about labels: `label=` parsing, duplicate-label refusal, `/d0`
  addressing, "every spelling of one grant", nested-grant most-specific-label
  matching, symlinked-root spelling equivalence, `hostToVirtual` redaction
  placeholders. There is one root and no translation.
- `contextSchema` / `contextSchemaVersion` / `disclose: "count"` assertions.
  fsMCP publishes no context schema.
- `fs_edit`'s size caps (1 MiB / 10 MiB), `minLength` publication, and
  `new_string: null` handling — superseded by E1–E11 and one response budget.
- `fs_read`'s `offset`/`limit` vs `byte_offset`/`byte_length` distinction, and
  text-mode line numbering. One byte range.
- `fs_find` entirely.
- `_meta.scope_violation: true` — replaced by the `outside_root` error code.
