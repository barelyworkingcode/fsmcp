# fsMCP

MCP server providing file system tools via stdio. Gives LLMs the ability to read, write, edit, create, move, delete, list and search the local file system -- all confined to a set of allowed directories, with no path out of the sandbox and no shell. A client addresses files in a virtual path space (`/d0/…`) rooted at its own grant; it never sees, and cannot supply, the real host path underneath (see "Virtual Path Space" below).

## Tools

### File System
| Tool | Read-only | Description |
|------|-----------|-------------|
| `fs_read` | yes | Read a file: a line-numbered UTF-8 text view (default), or exact bytes as base64 |
| `fs_glob` | yes | Find files by glob pattern |
| `fs_grep` | yes | Search file contents with regex |
| `fs_list` | yes | List one directory's immediate contents (non-recursive): type, size, mtime, name -- one escaped line per entry (see "`fs_list`'s line format" below) |
| `fs_find` | yes | Fast fuzzy filename search (`rg --files` + in-process fuzzy ranking) |
| `fs_write` | no | Write or create files (UTF-8 text or exact bytes via base64) |
| `fs_edit` | no | Find-and-replace string editing (literal, UTF-8 text only) |
| `fs_mkdir` | no | Create a directory (recursive by default) |
| `fs_move` | no | Move or rename a file or directory |
| `fs_delete` | no | Delete a file, symlink, or directory |

An `access: read` grant in relay admits only the five `readOnlyHint: true` tools above; `access: write` admits all ten.

There used to be an eleventh tool, `fs_bash` (execute a shell command). It has been removed, not fixed: `allowed_dirs` was never a boundary for an arbitrary shell -- a command reaches any path with or without a `cd` -- so every containment guarantee below was void while it was registered. A sandbox with a shell in it is not a sandbox.

## Requirements

- Node.js 22+
- Optional: ripgrep (`rg`) for fast `fs_grep`/`fs_find` (both fall back to a pure Node.js implementation)

## Build & Install

```bash
./build.sh    # builds, installs to ~/.local/bin/fsmcp, registers with Relay
```

### Code signing (note)

fsMCP isn't codesigned because it runs as `node dist/main.js` via a shell launcher — the Mach-O process at runtime is `node` itself, not anything fsMCP ships. macOS TCC keys file-access prompts off the node binary's cdhash, so a node upgrade can trigger a one-time re-prompt for Files & Folders access. Bundling fsMCP into its own .app would be the only way to make those grants permanently rebuild-stable.

## Directory Scoping

fsMCP restricts every tool above to allowed directories. Two sources:

1. **Relay per-token context** -- Relay discovers fsMCP's `contextSchema` during handshake and renders directory configuration in the Settings UI per token. Configured directories are injected as `_meta.allowed_dirs` on each tool call.
2. **CLI flags** -- `--allowed-dir /path` (repeatable) for standalone mode.

If neither is configured, every tool call is refused. Emptiness is never read as "unrestricted" -- an absent or empty scope means deny, on both the CLI and the `_meta` side. Running `fsmcp` with no `--allowed-dir` and no Relay context is therefore a server that answers every call with an error, not one with the run of the filesystem.

```bash
# Standalone with directory restriction
fsmcp --allowed-dir /Users/me/projects/myapp

# Standalone, deliberately unrestricted (must be spelled out explicitly --
# there is no flag or default that means "no restriction")
fsmcp --allowed-dir /
```

### `_meta` may only narrow the CLI grant, never widen it

When fsmcp is run with `--allowed-dir` **and** a caller supplies `_meta.allowed_dirs` on a call, the effective scope is their **intersection**: each `_meta` directory is kept only if it resolves inside one of the `--allowed-dir` roots, and any that don't are dropped (and reported back on the result, not silently -- as a count to the client, with the entries themselves on stderr for the operator). `_meta.allowed_dirs` is treated as caller-supplied input, the same as any other argument on the wire -- fsmcp does not assume anything upstream of it (relay, or whatever configured relay) has already enforced a boundary, so it never lets `_meta` grant more than the operator already typed on the command line:

| `--allowed-dir` (CLI) | `_meta.allowed_dirs` | effective scope |
|---|---|---|
| set | set | intersection (narrowed CLI grant) |
| set | absent | CLI dirs, unchanged |
| absent | set | `_meta` dirs (relay-mediated mode -- the whole grant lives in relay's context) |
| absent | absent | empty, i.e. deny all |

`--allowed-dir /` combined with a caller-supplied `_meta.allowed_dirs: ["/"]` therefore stays confined to whatever narrower scope was actually intersected in -- `_meta` cannot use a `/` (or any other directory outside the CLI grant) to escape it.

## File Encoding: `fs_read`/`fs_write` Are a Pass-Through, Not a Guesser

`fs_read` and `fs_write` take an `encoding` argument, `"text"` (default) or
`"base64"`. fsMCP does not decide what a file's bytes *mean* -- it decides
whether the encoding you asked for can represent those bytes losslessly:

- **`encoding: "text"`** decodes the file as UTF-8 and returns a
  line-numbered view (`cat -n` format, `offset`/`limit` line selection,
  lines over 2000 characters truncated with a marker). This view is **not
  byte-faithful**, even for a file that is perfectly clean UTF-8 -- it is
  decoded, line-split and possibly truncated before it reaches you. If the
  file's bytes are **not** valid UTF-8, `fs_read` refuses outright rather
  than silently substituting U+FFFD for the bad bytes (the bug this
  behaviour replaces: substituting U+FFFD is lossy and irreversible, and
  writing the substituted text back corrupts the file with no warning).
  `fs_write`'s `"text"` mode writes the UTF-8 encoding of `content`
  verbatim -- no normalisation, no newline translation, and no
  second-guessing of the content: if `content` itself contains U+FFFD,
  that is written as-is, because it may be exactly what you mean.
- **`encoding: "base64"`** is the byte-exact path: `fs_read` returns the
  file's exact bytes as a **bare base64 string -- no header, no trailing
  newline, no other text** (the byte count is in `_meta.bytes` instead, not
  in prose), with no line numbers, no truncation, and no decoding of any
  kind -- `offset`/`limit` are meaningless against a byte dump and are
  **refused**, not silently ignored, if you pass them alongside
  `encoding: "base64"`. `fs_write`'s `"base64"` mode decodes `content` as
  base64 and writes exactly those bytes, unmodified. This is the only way
  to read or write a file whose content is not valid UTF-8 text -- a PNG, a
  `.zip`, a UTF-16 file, anything. **A fidelity mode round-trips through
  itself:** `fs_read`'s `"base64"` reply can be passed straight into
  `fs_write`'s `content` with `encoding: "base64"`, unmodified, and that
  composition is an identity on the file's bytes -- no stripping, no
  reformatting, no pattern to reverse-engineer. (An earlier version of this
  prefixed a human-readable `"[base64: N bytes]\n"` header, which broke
  exactly that: `fs_read`'s own reply was not valid input to `fs_write`'s
  own base64 decoder. It failed closed rather than corrupting anything, but
  the obvious composition of the two calls simply didn't work, and a caller
  that "fixed" it by guessing at how to strip the header could just as
  easily strip it wrong and silently corrupt the bytes -- the same failure
  this feature exists to prevent, one level up.) Text mode makes no such
  promise -- it is a documented view, not a fidelity path, and says so.

**Behaviour change:** earlier versions of `fs_read` auto-detected a fixed
list of image extensions (`.png`, `.jpg`, `.gif`, …) and returned those as
base64 automatically. That has been removed. Deciding a file is "an image"
from its **name** is exactly the kind of content judgement this tool no
longer makes -- two files with identical bytes and different extensions
must behave identically, and every other binary format (anything not on
that fixed list) still took the lossy text path under the old behaviour.
Read an image (or any other binary file) with `encoding: "base64"`
explicitly instead.

`fs_edit` remains text-only: it is defined over UTF-8 text (find a literal
string, replace it), so it refuses to operate on a file whose bytes are not
valid UTF-8 at all, rather than rewriting it as corrupted UTF-8. There is no
base64 mode for `fs_edit` -- a byte-level splice is not a string
replacement.

### `fs_edit` refuses an edit that has no meaning, rather than performing one

`fs_edit` matches literally, with `content.split(old).join(new)`. That is
exact and cheap for a real search string, and silently meaningless for two
arguments a caller reaches without trying.

**An empty `old_string` is refused**, before the file is read.
`"hello".split("")` splits into individual *characters*, so the occurrence
count was `length - 1` and the join interleaved the replacement between every
character: `hello` was written back to disk as `hXeXlXlXoX`, reported as
`Replaced 5 occurrence(s)`, on a success result, with relay's audit recording
`ok`. There is no such thing as "the place where the empty string occurs" --
the count of 5 was an artefact of `split`, not a fact about the file.

The un-flagged path was the worse half. Without `replace_all`, the reply was
`old_string found 5 times. Use replace_all or provide more context to make it
unique` -- a sensible sentence about a real string, a nonsense one about an
empty one, and a refusal whose own suggested remedy is the flag that destroys
the file. So the refusal is on the emptiness, not on the count.

The realistic trigger is not a caller typing `""`. It is an agent whose search
string came from a variable that resolved empty -- a templated edit, or a
value it failed to extract from a previous `fs_read`. It believes it is making
a targeted replacement. `old_string` also carries `minLength: 1` in the
published schema, so a caller that validates before sending sees the
constraint without having to make the call to learn it.

**`old_string` identical to `new_string` is refused too**, rather than let
through and reported as a no-op. It is not a no-op on disk: `fs_edit` rewrites
through a temp file and a rename, so an identical-strings "edit" still
replaces the file (new inode, any hard link to it broken, mtime moved) with
byte-for-byte the content it already had -- a real mutation with nothing to
show for it, announced as `Replaced N occurrence(s)`, which reads as a change
that happened. A refusal is what makes a caller look at its own strings; a
`0 changes` success would still be counted as a completed step by anything
branching on `isError`.

**An empty `new_string` is legitimate and unaffected** -- that is a deletion,
and it still works.

### `fs_list`'s line format

`fs_list` emits one line per entry, tab-separated, `type\tsize\tmtime\tpath`.
Two things about that record are worth knowing before parsing it.

**The path field is backslash-escaped.** A literal backslash is written `\\`, a
newline `\n`, a carriage return `\r`, a tab `\t`. Nothing else is escaped, and
no other field is. Decode by scanning left to right and consuming a backslash
together with the character after it -- *not* by running the four
replacements independently, which turns `\\n` (an escaped backslash followed by
the letter n) into a newline that was never in the name.

A filename containing a newline is legal on every POSIX filesystem, APFS
included, and creatable through fsMCP's own `fs_write` and `fs_move`. Emitted
raw, one entry became two lines: a phantom record with no type and no size,
and a real record truncated at the newline. Nothing errored -- the format
silently stopped being the format, and the failure landed in the caller's
parser rather than here. The alternative of skipping such an entry was
rejected: it would make a real, reachable file invisible to the one tool whose
job is to say what is there, while every other tool still operated on it by
name. `fs_glob`, `fs_find` and `fs_grep` join their results with `\n` too and
do **not** escape yet.

**A symlink's size is always `0`.** `fs_list` uses `lstat`, never `stat` -- it
must not follow the link -- and `st_size` for a symlink is the byte length of
the *target path string*. So the size column used to be an exact measurement
of a path the client is not allowed to know exists, on the one entry type
every other surface refuses to say anything about at all (`fs_read` of that
same link is "outside allowed directories"). A `latest ->
/Volumes/Backup/2026-08-26-nightly` link is ordinary in a real tree, and its
length confirms or eliminates a guessed host path in a single call. A link's
own size is not the size of anything a caller can read, so there is nothing to
lose by reporting zero.

`fs_write` and `fs_edit` replace a file by writing the new content to a
temp file in the same directory and renaming it into place, so a write that
fails partway (a full disk, the process being killed) leaves the *original*
file intact instead of truncated -- the tradeoff is that peak disk usage
during the write is roughly the old file's size plus the new one's, so a
volume sized with no headroom to spare for its largest file can start
seeing `ENOSPC` on writes that used to fit.

## Virtual Path Space

A client never sees a host path, in either direction. It addresses files in a
virtual space rooted at its own grant:

```
    client says            fsmcp acts on
    /d0/notes/a.txt   ->   /Users/admin/projects/myapp/notes/a.txt
    /proj/README.md   ->   /Users/admin/projects/myapp/README.md   (explicit label)
    /d1/README.md     ->   /Volumes/Work/docs/README.md
```

**Why.** Before this, `fs_list`, `fs_glob`/`fs_find`/`fs_grep`, every success
message ("Wrote 2 bytes to /Users/admin/…") and every raw syscall error
("`ENOTEMPTY: directory not empty, rmdir '/Users/…'`") handed a client the
absolute host path of its own sandbox -- which discloses the account name and
the host's directory layout above the root to a client that, in the
deployment this was found in, sits on a different machine and cannot even
reach that path. It was never a containment hole (`allowed_dirs` held either
way), but it was free reconnaissance a client had no reason to be given.

**Labels.** Every allowed directory gets a label, and a path is always
`/<label>/…` -- including when there is only one root, so that adding a
second one later never silently reshapes every path a client has already
learned or stored. Two ways a directory gets its label:

1. An `allowed_dirs` entry (a `--allowed-dir` flag, or an entry of relay's
   per-token `_meta.allowed_dirs`) written `label=/abs/path` uses `label`
   explicitly. This is still a plain string, so it needs no schema change on
   either the CLI or relay's `_meta` side.
2. Otherwise, the label is `d<N>` by position in that call's *effective*
   scope (after CLI/`_meta` narrowing, C1) -- `d0`, `d1`, ... Positional
   labels move if an operator reorders `allowed_dirs` or a per-call `_meta`
   narrows it into a different order, which renames a client's paths.
   **Use an explicit label for anything a client is expected to remember
   across calls or sessions.**

**Inbound and outbound are asymmetric, on purpose.** A path argument
(`file_path`, `path`, `source`, `destination`) must be `/<label>/…` --
fsmcp does **not** also accept an absolute host path as a convenience
alongside the virtual form, because that would hand back exactly the probe
oracle this feature exists to close: a client that can guess a host path
could otherwise use fsmcp to confirm it. Decoding a virtual address is a
*translation* layer on top of the existing containment check, never a
replacement for it -- the decoded host path still runs through the same
`validatePath`/`validatePathNoFollowFinal` every argument has always run
through (symlinks, `..`, dangling links, canonicalisation, all unchanged).
Outbound, every path in every result and every error is translated back to
its virtual form; a host path that cannot be mapped back to any granted
label is **redacted, not emitted** -- that case means something reached the
client from outside the grant, which would be a bug, and a redacted string
is the right output for a bug of that shape, not the raw path. Refusing an
argument that is not a valid `/<label>/…` address never echoes the argument
back, either: an earlier version of this did, and because that echo was
translated the same way everything else was, a *correct* host-path guess
came back rewritten to its label while a *wrong* one came back verbatim --
telling a client, one refusal at a time, whether it had just guessed the
real sandbox root. The fix is that the refusal names the granted labels and
nothing else.

Outbound translation happens where a path is produced, never as a scan over
a finished result. **A file's own content -- what `fs_read` returns, or a
matched line in `fs_grep`'s content mode -- is never a candidate for
translation, under any circumstance,** even if it happens to contain text
that reads like the sandbox's own path (a config file, a log, a script
naming its own location): that content must reach the client byte for byte,
and a whole-result scan cannot tell "this is a path" from "this is a file's
bytes that happen to look like one" -- confirmed in review by a write-then-
read round trip that came back silently altered under an earlier version of
this feature that scanned everything.

**Deliberately unchanged.** `--allowed-dir` and `_meta.allowed_dirs`
themselves keep taking absolute **host** paths -- those are operator/relay
side, and the operator (or whatever configured relay) knows where its own
disk is. Relay's audit log also keeps absolute host paths: it is relay's
ground truth, read by the operator, not the client, and redacting it would
undermine the very thing an operator uses it to verify.

**The other half of this lives in relay, and fsmcp now asks for it.** Relay
appends a scope note built from `allowed_dirs` into every governed tool's
*description* at `tools/list` time, so a client that never sees a host path in
any fsmcp *result* could still read one out of the tool *description* handed to
it before it called anything -- a live Hermes run reported `/d0` mapping to the
sandbox's absolute path, unprompted, having read it there. fsmcp's context
schema therefore declares `disclose: "count"` (relay#33, fsmcp#15) and a
relay that understands the keyword renders

```
Scope: Directories this client may read, search and modify within — confined to 1 value.
```

"count", not "none": the client is still told that it is confined and to how
many roots, which is the boundary without the coordinates. An agent that cannot
see its own limits behaves worse, not better.

**What fsmcp can and cannot promise here.** The note is rendered by relay, not
by fsmcp, and `disclose` is a request. A relay older than relay#33 ignores the
keyword entirely and renders the value -- fsmcp cannot detect which relay it is
speaking to, cannot fail closed on the answer, and does not claim to. The
guarantee fsmcp keeps is the one it can: **no host path in any tool result,
error, or search hit fsmcp emits.**

That guarantee used to have one documented exception, and it no longer does.
When a call's `_meta.allowed_dirs` contains an entry that is not inside any
`--allowed-dir` root, fsmcp appends a report saying so -- and that report used
to name the dropped entries as raw host paths, on a SUCCESS result, outside
the virtual path space. It was reachable in a relay deployment whose
registration carries `--allowed-dir` args *and* whose profile grants a
directory outside them: the two disagree, and the client was told which
operator-configured entry was discarded. `disclose` does not reach that
surface, and neither could a backstop -- a dropped directory is by
construction not one of the granted roots, so there is no label to translate
it to.

It is now split the way a duplicate-label refusal already was: **the entries
go to stderr, where the operator reads them, and the client is told the fact
and the count** ("N entries were dropped, your effective scope is narrower
than the one you were sent"). The client is still told it is confined --
an agent that cannot see its own limits behaves worse, not better -- but not
where. It stays a note rather than a refusal because, unlike a duplicate
label, the narrowing has exactly one correct reading and is already the
fail-closed one; refusing every call would turn an operator's over-tight CLI
floor into an outage of a grant that is still valid.

Whether the description relay writes carries a scope note is a property of the
relay in front of it, and is worth checking with `relayremote list --schema`
on the deployment you actually run (plain `list` truncates the description,
which is where the note lives).

### A symlink out of the sandbox is refused, even one a human placed

A symlink that lives inside an allowed directory but resolves outside it is
refused -- on read, on write, and in the output of every search tool. This
holds whoever created the link and however deliberately.

The tempting reading is that a link someone put there by hand is an
intentional grant, and should be followed. It is not treated as one, for two
reasons.

**Symlinks appear in a directory tree without anyone deciding.** `npm install`
creates them throughout `node_modules/.bin`, git checkouts carry them,
extracting a tarball restores them. "A human put it there" describes far less
of the real population of links in a working directory than it sounds like it
does, and nothing distinguishes the deliberate ones at the point the traversal
is checked.

**It would cost `allowed_dirs` its meaning.** Right now that field is the
complete answer to *what can this client reach* -- an operator can read a
grant and know. Following links makes the answer the transitive closure over
whatever links happen to exist, which changes underneath the operator without
any edit to the grant. Relay's own rule is that injecting a scope an MCP does
not enforce is worse than no scope at all, because the UI then asserts a
confinement that does not exist.

So there is no flag for it, and adding one would need to answer both points
above. The capability people actually want here -- *that other directory
should be reachable too* -- is already spelled `allowed_dirs`: list the target
directory alongside the first. That is reviewable in the profile, visible in
the audit log, enforced by the same code path, and it cannot drift when a
package manager creates a link.

fsMCP also cannot *create* a symlink: its entire mutating syscall surface is
`writeFileSync`, `mkdirSync`, `unlinkSync`, `renameSync` and `rmSync`, which
`tests/no-link-primitive.test.js` asserts against the source tree. A client
therefore cannot plant its own escape hatch and then walk through it --
every hop of which would have been correctly validated on the way out.

## Configuration

### With Relay (recommended)

`build.sh` handles registration. Manual:

```bash
relay mcp register --name fsMCP --command ~/.local/bin/fsmcp
```

fsMCP declares a **v2** relay context schema (`contextSchemaVersion: 2`, `source: "operator"`, `scope: "restrict"`, `applies_to: ["fs_*"]`, `enumerable: false`, `disclose: "count"`) so relay can offer `allowed_dirs` as an operator-typed field on both local and **remote** access profiles -- a v1 schema (the old `allowed_dirs` field with no version and a directory-list `ui` hint) only works for a local project, because v1 derives the value from a project path a remote profile does not have. Configure per-token directory access in Relay's Settings > Security > Token Permissions.

### Standalone

Add to your MCP client config:

```json
{
  "mcpServers": {
    "fsmcp": {
      "command": "~/.local/bin/fsmcp",
      "args": ["--allowed-dir", "/path/to/project"]
    }
  }
}
```

## Related Projects

- **[macMCP](../macMCP)** -- MCP server for macOS-native tools (calendar, contacts, mail, etc.)
- **[Relay](../relay)** -- MCP orchestrator with per-token security and directory scoping
- **[Eve](../eve)** -- Multi-provider LLM web interface
