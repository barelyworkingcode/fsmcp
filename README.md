# fsMCP

MCP server providing file system tools via stdio. Gives LLMs the ability to read, write, edit, create, move, delete, list and search the local file system -- all confined to a set of allowed directories, with no path out of the sandbox and no shell. A client addresses files in a virtual path space (`/d0/…`) rooted at its own grant; it never sees, and cannot supply, the real host path underneath (see "Virtual Path Space" below).

## Tools

### File System
| Tool | Read-only | Description |
|------|-----------|-------------|
| `fs_read` | yes | Read a file: a line-numbered UTF-8 text page (default), or exact bytes as base64 (whole file up to 256KiB, or a byte window of any file) |
| `fs_glob` | yes | Find files by glob pattern (relative patterns only -- see "A pattern is a pattern, not an address") |
| `fs_grep` | yes | Search file contents with regex (bounded result: at most 1000 lines / 1MiB, and it says when it is bounded) |
| `fs_list` | yes | List one directory's immediate contents (non-recursive): type, size, mtime, name -- one escaped line per entry |
| `fs_find` | yes | Fast fuzzy filename search (`rg --files` + in-process fuzzy ranking) |
| `fs_write` | no | Write or create files (UTF-8 text or exact bytes via base64) |
| `fs_edit` | no | Find-and-replace string editing (literal, UTF-8 text only) |
| `fs_mkdir` | no | Create a directory (recursive by default) |
| `fs_move` | no | Move or rename a file or directory (renames only -- it deletes nothing) |
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
  kind -- `offset`/`limit` are **line**-based and are meaningless against a
  byte dump, so they are **refused**, not silently ignored, if you pass them
  alongside `encoding: "base64"`. A byte range is selected with
  `byte_offset`/`byte_length` instead: deliberately a *different pair of
  names*, so a caller that switched encodings and left its arguments alone
  cannot silently get byte 40 where it meant line 40. `fs_write`'s
  `"base64"` mode decodes `content` as base64 and writes exactly those
  bytes, unmodified. This is the only way to read or write a file whose
  content is not valid UTF-8 text -- a PNG, a `.zip`, a UTF-16 file,
  anything. **A fidelity mode round-trips through itself:** `fs_read`'s
  whole-file `"base64"` reply can be passed straight into `fs_write`'s
  `content` with `encoding: "base64"`, unmodified, and that composition is
  an identity on the file's bytes -- no stripping, no reformatting, no
  pattern to reverse-engineer. (An earlier version of this
  prefixed a human-readable `"[base64: N bytes]\n"` header, which broke
  exactly that: `fs_read`'s own reply was not valid input to `fs_write`'s
  own base64 decoder. It failed closed rather than corrupting anything, but
  the obvious composition of the two calls simply didn't work, and a caller
  that "fixed" it by guessing at how to strip the header could just as
  easily strip it wrong and silently corrupt the bytes -- the same failure
  this feature exists to prevent, one level up.) Text mode makes no such
  promise -- it is a documented view, not a fidelity path, and says so.
  **A *windowed* base64 read makes no such promise either**, and the limits
  section below says why.

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

### Atomic replace: what it costs and what it carries

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
file intact instead of truncated. Two consequences follow from that, and
both are deliberate.

**Peak disk usage during the write is roughly the old file's size plus the
new one's**, so a volume sized with no headroom to spare for its largest
file can start seeing `ENOSPC` on writes that used to fit. On macOS the
replace also copies the old file's bytes once more, to seed the temp file
with the metadata described below; peak usage is unchanged by that, but the
I/O is.

**The replaced file is a new inode**, so everything the old inode carried is
lost unless fsMCP puts it back deliberately. It does put back:

- the **permission bits**, exactly -- including the ones a `umask` would
  strip, which is why this goes through `chmod(2)` and not through the mode
  argument of the `open(2)` that creates the temp file;
- **extended attributes** (macOS): Finder tags and comments, Spotlight
  metadata, `com.apple.quarantine`, and any application state hung off the
  file;
- the **ACL** (macOS).

It does not put back, each for a reason:

- **Hard links are broken.** `rename(2)` swings the name you wrote to at a
  new inode; a second name for the old inode still points at the old inode,
  holding the old content. This is what atomic replace *is* -- keeping the
  link would mean writing through the shared inode, which is the
  truncate-then-write that loses the file when it fails partway. If two
  names for one file matter to you, fsMCP is not the tool to edit it with.
- **setuid, setgid and the sticky bit are dropped.** Preserving an execute
  bit across an edit does not imply preserving setuid across a rewrite;
  fsMCP cannot produce a setuid file at all.
- **BSD file flags** (`uchg`, `hidden`, ...) are not carried.
- **Ownership and the old timestamps** are not restored. The replacement is
  owned by whoever runs fsMCP, with the mtime of the write that just
  happened -- which is correct: the file really was modified.

**On platforms other than macOS, the extended-attribute and ACL half of that
list is not implemented and those attributes are still lost.** The mechanism
is BSD `cp -p`'s documented guarantee to carry EAs and ACLs; GNU coreutils'
`cp -p` means something narrower and the Linux ACL model is a different
mechanism again, so rather than ship an argv that cannot be verified on the
platform it targets, non-macOS keeps the previous behaviour. The permission
bit fix is portable and applies everywhere.

If the target's attributes cannot be read at all (a file fsMCP can write but
not read), the write is **refused** rather than performed -- replacing it
would destroy metadata fsMCP cannot even enumerate, and the original is left
untouched.

That temp file is what makes the grant root itself an invalid target for a
write -- see "The grant root is not a writable target" below.

## Response Limits: fsMCP Bounds the Message, Not the File

Every result fsMCP returns is one line of JSON on stdout, and a host that
reads that line has a maximum length for it. Relay -- the deployment fsMCP is
built for -- reads a stdio MCP's stdout with a `bufio.Scanner` capped at
`bridge.MaxMessageSize` = **10 MiB**, and treats an over-long line as
**fatal**: the scanner returns `bufio.ErrTooLong`, the read loop exits, and
nothing respawns the child. That is not one failed call. **Every later call,
on every access profile, from every enrolled client, fails until an operator
relaunches Relay.app by hand.**

fsMCP used to bound the wrong things:

- `fs_read` refused a file over 10 MiB *on disk* and then emitted up to 4/3
  that size as base64. A perfectly ordinary 8 MB PDF produced a ~10.7 MB line
  and took the transport down. fsMCP's own limit could never fire, because
  the frame broke first.
- `fs_grep` in `output_mode: "content"` bounded **nothing at all** -- not a
  line count, not a byte count. A grep for a common word over a large granted
  repository produced a result bounded only by how much matching text was in
  the grant. Same permanent outage, reached without any unusual input. (The
  two failures do not even look alike from outside: in the `fs_read` case
  fsmcp died, in the grep case fsmcp stayed alive and relay's stdout reader
  died.)

So the rule now is a property of **every** result, not a check inside
whichever tool was found to break first:

| bound | default | what it protects |
|---|---|---|
| response bytes | **1 MiB** | the transport. ~10x under relay's 10 MiB frame cap. Applies to the encoded response, both encodings, and to `fs_write`'s inbound `content` -- a request line is a line too. |
| base64 file ceiling | **256 KiB** | your context, not the transport. Base64 tokenizes at roughly 3 chars/token, so 1 MiB of file is ~460K tokens: more than twice a standard 200K window. 256 KiB is ~115K tokens -- an icon, a config blob, a certificate, a small PDF. |
| `fs_read` allocation limit | **10 MiB** | the *process*. fsMCP is one synchronous loop; `readFileSync` of a huge file blocks and can kill the process every other caller is waiting on. Unchanged, and **not** made redundant by the two above: it answers a different question. |

Measured, not estimated. Base64 inflates by exactly 4/3; text mode adds line
numbers, a tab separator and truncation markers, and then **JSON escaping
multiplies what is left by anything from 1x (ASCII) to 6x (a C0 control byte,
which is valid UTF-8 and does appear in real files)**. 2000 lines of 2000
control characters -- inside every limit fsMCP checked before -- was a ~24 MB
line. Sizes are therefore computed with the same JSON encoder that will
actually serialise the reply, per line, rather than with a multiplier someone
guessed.

### What each tool does when it hits the bound

**Nothing is silently truncated.** A shortened result that looks complete is
the failure this codebase exists to avoid. Every tool either refuses, or
returns a bounded result that says so **twice** -- inline for a human,
`_meta.truncated: true` for a program:

- **`fs_read`, text mode: it pages.** The page ends at whichever comes first,
  the line limit (2000) or the byte budget, and the reply carries
  `[fsmcp: showing lines A-B of C ...; pass offset: D to continue reading]`
  plus `_meta.truncated`. If bytes ended the page rather than the line limit,
  the note says so, so a caller that asked for 2000 lines and got 700 can tell
  that from end-of-file. This is pagination, not truncation: it names the
  offset to resume from, and successive pages reassemble the file exactly.
- **`fs_read`, base64 mode: it refuses.** A base64 payload has nowhere to put
  a "there is more" marker without breaking the `fs_read` → `fs_write`
  identity, so a silent prefix would be undetectable from the content itself.
  A file over 256 KiB is refused whole and read with
  `byte_offset`/`byte_length` instead.
- **`fs_grep`, `fs_glob`, `fs_list`, `fs_find`: they cap and report.**
  `(showing X of Y ...)` inline, `_meta.truncated` structurally, with the real
  Y -- not the size of what survived. `fs_grep` content mode is capped at
  1000 result lines (matching `fs_glob`'s existing cap) as well as by bytes.
  Refusing is the wrong answer for a search: one that found too much has still
  done useful work, and `fs_grep` has never claimed to be a fidelity path the
  way `fs_read`'s base64 mode has.
- **Anything else:** a last-resort backstop in the registry replaces any
  result over the bound with an error naming the tool, and a second one at the
  stdout write ensures no line ever leaves this process over the frame limit.
  Reaching either is a bug in fsMCP, and the message says so.

### Reading a large binary in pieces

`byte_offset`/`byte_length` make the base64 ceiling honest -- without them, a
lower ceiling would turn "kills the server" into "flatly impossible":

```jsonc
// _meta.total_bytes tells you when to stop.
{"file_path": "/d0/scan.pdf", "encoding": "base64", "byte_offset": 0,      "byte_length": 262144}
{"file_path": "/d0/scan.pdf", "encoding": "base64", "byte_offset": 262144, "byte_length": 262144}
```

Each window is exact bytes, bare base64, with `_meta.bytes`,
`_meta.byte_offset` and `_meta.total_bytes`. Windowed reads work on a file of
any size, because they use a positional read and allocate the window rather
than the file.

**Windows are for reading, not for copying.** `fs_write` has no matching byte
offset and no append mode, so a windowed read cannot be reassembled into a
file through fsMCP. That is deliberate, not an oversight: every `fs_write` is
a single atomic replace (temp file + rename), and a file assembled across
several calls is by construction not atomic, so adding a positional write
would trade away the guarantee `fs_write` exists to make. Byte-exact
*movement* of a large file is a copy operation, and belongs in a tool that
never brings the bytes through fsMCP at all.

### These are defaults, not facts

None of the three numbers above is configurable yet. They are operator-side
sizing, like `--allowed-dir`, and they are the right shape for the flags
issue #16 proposes (`--max-read-bytes`, `--max-line-length`, `--max-lines`) --
a `--max-response-bytes` and a `--max-base64-bytes` would sit **alongside**
`--max-read-bytes`, never instead of it. Deliberately **not** exposed through
`_meta`: a caller must not be able to raise its own ceiling, because the
ceiling partly protects a transport shared with every other enrolment on the
same relay, which is precisely not the calling client's to spend.

fsMCP does not read relay's `MaxMessageSize` at runtime and does not pretend
to: relay does not advertise it in the handshake, and fsMCP is a plain stdio
MCP that also runs under other hosts with their own framing rules or none.
What it does instead is pick a default an order of magnitude under the
smallest cap it is known to run behind, and write the relationship down --
here, and in `src/limits.ts`.

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
is the right output for a bug of that shape, not the raw path. One granted
directory can be written more than one way -- the path the operator typed,
the same path with a `..` collapsed out of it, and the path it resolves to
when the grant is reached through a symlink -- and the outbound map treats
all of them as what they are: one directory. It matches the known spellings
first and, if none of them fit, resolves the path's parent directory and
asks the same containment question the security check asks. Neither step
makes anything new reachable: the spellings resolve to the same files by
construction, the resolving step is a *weaker* test than the one every hit
has already passed, and either way the hit went through the full containment
check before anything decided how to display it. See *A granted directory
has more than one name*, below. Refusing an
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

There was a second exception, unintended and now closed, and it is worth
stating plainly because of how ordinary the trigger was. `fs_grep`'s ripgrep
backend returned ripgrep's own stderr to the client verbatim, and ripgrep --
like essentially every Unix tool -- writes `<path>: <reason>`. So one
`fs_grep` against a granted folder an operator had renamed, or a drive that
was not mounted this morning, or a directory with awkward permissions,
answered with the host's real absolute path: the account name, the layout
above the grant, the lot. Nothing about the call was unusual; the second
trigger fires on a default-scope search with no `path` argument at all. The
generic backstop that was supposed to catch this did not, because its
path-boundary test accepted only `/`, a newline or end-of-string after a
granted directory -- and a colon is none of those, so naming the granted
**root** leaked while naming anything *inside* it did not. Both halves are
fixed (issue #22): the error path translates the search directories it
already knows, the way every other call site in fsmcp does, and the boundary
test now accepts the punctuation a diagnostic actually puts after a path.

The visible consequence is that `fs_grep` and `fs_find` answer like their
siblings now. A directory that does not exist is `directory not found:
/d0/nodir`, the same sentence `fs_glob` and `fs_list` give; one that cannot
be read is `directory not readable: /d1`. Previously the first of those
produced *"fsmcp: internal error -- ... This is a bug in fsmcp ... please
report it"* for a plain typo, which is what a backstop meant to fire once a
year looks like when it becomes a tool's normal error path. And because
ripgrep exits non-zero for *any* error it hit, including one it walked
straight past, a single unreadable file anywhere under a searched tree used
to discard every match found alongside it -- `fs_grep` now returns those
matches with an explicit note that they are a floor rather than a complete
answer, and `fs_find` does the same with its file listing instead of
answering `No matches found.` for a root it could not open.

Two residues, stated rather than assumed. A path in ripgrep's stderr that
lies under **no** granted directory (ripgrep naming its own config file, say)
has nothing to be translated against, so the last-resort branch that quotes
ripgrep can still surface one; and a granted root that is *missing* is still
dropped silently from a default-scope search by a check `fs_grep`,
`fs_glob`, `fs_find` and `fs_list` all share, so such a call answers as
though the scope were smaller rather than saying a root went away.

### The grant root is not a writable target

A path that resolves to an allowed directory *itself* -- rather than to
something inside it -- is refused by every tool that writes, creates or
replaces something at it: `fs_write`, `fs_edit`, `fs_mkdir`, and `fs_move`'s
destination. The refusal is a scope violation, flagged as such in the audit
log:

```
fs_write { "file_path": "/d0", "content": "..." }
-> refusing to write to an allowed_dir root: /d0
```

The check runs on the *resolved* path, so `/d0`, `/d0/`, `/d0/.`,
`/d0/notes/..` and an in-scope symlink pointing back at the root are all the
same case, not four near-misses of a string comparison.

This is not tidiness about a call that could not have worked anyway. The
containment check passes for a grant root -- a root is inside itself, which
is the right answer to the question it asks -- and the tools then derive a
*sibling* of the target, which for a root means the directory **above** the
sandbox:

- the atomic-write temp file described above is
  `<dirname of target>/.<basename>.fsmcp-tmp-<random>`;
- `fs_write` creates the target's parent directories before that;
- `fs_mkdir` creates every missing ancestor of its argument.

Pointed at the root, all three of those reach outside the grant. Measured on
the version before this rule existed: a single `fs_write` at the root put
5,000,000 bytes of caller-chosen content into the grant's parent directory,
with only the closing rename failing once the bytes were already on disk
there, and `fs_mkdir` at a not-yet-created root created the parent and
reported plain success. The temp file was usually unlinked on the way out,
which is not the same as never having been written: the cleanup does not run
if the process is killed, the size is the caller's choice, and on a real
machine the directory in question is something like `~/Documents`.

The deleting half of the same rule is older and still there: `fs_delete`
refuses to remove an allowed directory root, and so does `fs_move`'s
`overwrite`. It is worded identically ("refusing to delete an allowed_dir
root") but is *not* flagged as a scope violation, because removing the root
would only ever have removed something inside the grant -- that refusal is
"the sandbox must survive its occupant", not "you addressed something
outside your scope".

### A grant that does not exist is refused, not created

`fs_write` creates the parent directories of the file it is asked to write,
and `fs_mkdir` creates missing parents by default. Both are documented, both
are useful, and both are bounded at the granted directory -- **because the
granted directory is already there for the walk up to stop at.**

If it is not there, there is no bound. `fs.mkdirSync(dir, { recursive: true })`
climbs until it finds something that exists, and it knows nothing about
`allowed_dirs`: a missing grant root is just another missing component on the
way. So fsmcp refuses any call that would create a directory inside a granted
directory that does not exist on the host:

```
allowed_dir = <R>/level1/level2/level3/grant     # only <R> exists

fs_write { "file_path": "/d0/sub/file.txt", "content": "..." }
-> the granted directory /d0 does not exist on the host, so fsmcp will not
   write anything inside it. This is a problem with this server's
   configuration, not with the path you asked for [...]
```

Before this rule, that call answered `Wrote 31 bytes to /d0/sub/file.txt` and
created `<R>/level1`, `<R>/level1/level2` and `<R>/level1/level2/level3` --
three directories **above** the boundary -- along with the grant root and the
file. `fs_mkdir` did the same. Nothing errored, and `relay audit` recorded
`ok`.

**Why refuse rather than quietly create the missing directory?** Because the
only way to create it is to create its missing parents too, and those are
outside the grant by definition -- so "create just the root" is not available
in the case that matters. And a grant that does not describe anything on the
host is a mistake worth seeing:

- **A typo in the profile.** `~/Documnets/project` gets created, the agent
  works in it happily, and the operator never looks there.
- **A volume that is not mounted.** Granting `/Volumes/Work/project` with the
  drive unplugged creates that path on the *boot disk*. It then shadows the
  mount point, so when the real volume is plugged in macOS mounts it as
  `/Volumes/Work 1`. The agent's data and yours end up in two places with
  confusingly similar names, and nothing reported an error at any point.

**The refusal is about the grant, not about your path**, and says so at
length on purpose. An agent told "no such file or directory" for
`/d0/sub/file.txt` concludes it got the path wrong and tries again -- and
nothing it can do from the client side will ever make the operator's grant
exist. It is told the granted directory is missing, that retrying will not
help, and that an operator has to fix it, so that it stops and surfaces the
problem instead of looping.

**It is not flagged as a scope violation.** `_meta.scope_violation` means
"the client addressed something outside its scope", and here the client did
not: the path was inside the grant, and the grant is what points at nothing.
This is an operator configuration error and it comes back as an ordinary tool
error, so that the audit log's one containment signal keeps meaning only
containment. The trade-off is real -- an operator currently sees a generic
`tool_error` rather than "your grant points at nothing" -- and the fix for
that belongs in relay, as a signal of its own, not in borrowing this one.

A grant that resolves to a regular file, or to a dangling symlink, is the
same mistake and gets the same refusal. A grant that is a symlink to a real
directory is an ordinary configuration and keeps working. With nested
grants, one existing granted root anywhere above the path is enough: the
create stops there, and everything it made is still inside something you
granted.

`fs_edit` and `fs_move` were checked for the same shape and do not have it --
neither creates directories (`fs_edit` requires the file to exist,
`renameSync` never creates parents), so against a missing grant they create
nothing. They do still answer `file not found` / `source not found`, which is
the retry-inducing message this rule exists to avoid; that is a wording
defect, not a containment one.

Writing *inside* the root is unaffected, including when the grant's parent
directory is not writable at all.

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

## `fs_move` Renames. It Does Not Delete.

`fs_move` makes exactly one mutating syscall, `rename(2)`, and no removal
syscall at all. That is a guarantee about the tool, not a description of the
common case, and it is worth stating plainly because the tool used to work
the other way and destroyed people's files doing it.

`overwrite: true` was once implemented as "unlink the destination, then
rename onto the hole". Deleting before knowing what is being deleted produced
three separate ways to lose data:

- **A case-only rename destroyed the file.** macOS ships APFS
  **case-insensitive** by default, so `meeting.md` and `Meeting.md` are one
  directory entry. The unlink took the source's own bytes and the rename then
  failed `ENOENT` with nothing left to move. Worse, fsMCP instructed the
  caller into it: the first attempt refused with *"destination already exists
  (pass overwrite: true to replace it)"*, and following that sentence was the
  call that lost the file. The audit line read `tool_error` -- which tells an
  operator the move failed, not that a file was destroyed. The same shape fired
  on a literal self-move, on a `.`-component alias of one path, and
  recursively when both names were the same directory.
- **`mv file dir/` erased the directory.** The POSIX idiom every agent knows
  was read as *replace* that directory, and a recursive delete obliged --
  logging `ok`.
- **A rename that failed after the unlink left the destination gone.** Most
  visibly across two filesystems, where `rename(2)` returns `EXDEV`: the
  destination file had already been deleted, and the caller got an error
  message for it.

### What it does now

**A case-only rename simply works, with no flag.** `meeting.md` ->
`Meeting.md` succeeds on the first call. Before any decision is made, the two
endpoints are compared on `{dev, ino}` -- the filesystem's own answer to "are
these one entry?" -- rather than by comparing the resolved path strings, which
cannot know the volume is case-insensitive and never will. One inode
comparison settles the case-only rename, the self-move and the `.`-alias at
once, and a rename of one entry never touches `overwrite` at all. When the two
names also resolve to the same string the reply says `nothing to move` rather
than claiming a move that did not happen.

**An existing directory destination is refused, and `overwrite: true` is not
a way around it.** The refusal names the call you almost certainly meant:

```
$ fs_move {"source":"/d0/notes/todo.txt","destination":"/d0/projects","overwrite":true}
destination is an existing directory: /d0/projects (3 entries). fs_move does not
replace a directory, and overwrite: true does not either. To move
/d0/notes/todo.txt INTO this directory, name the full destination path:
/d0/projects/todo.txt. To replace the directory itself, delete it with fs_delete
first.
```

The POSIX reading -- silently move *into* the directory -- was considered and
rejected. It would make the meaning of `destination` depend on the state of the
filesystem at the moment of the call: "the new name" usually, "the parent of
the new name" when something happens to be a directory there. The audit log
would then record an argument that is not where the data went, and
`overwrite: true` would govern a path the caller never named. Refusing costs
one corrected call, and the message writes that call out.

No `replace_directory` flag was added either, mirroring `fs_delete`'s
`recursive`. Destroying a directory tree is `fs_delete`'s job: it already
requires the explicit `recursive: true`, already caps a recursive delete at
10,000 entries, and already reports the act as a deletion. Spelling the
destruction as a delete is what makes the audit log say *deleted* when
something was deleted, instead of a line that says only "Moved". It is also
why `fs_delete`'s entry cap has no counterpart in `fs_move`: a cap bounds a
recursive walk about to be removed, and `fs_move` has no recursive delete to
bound. It removes zero directory entries and creates one. The single directory
destination it will accept is an **empty** one being replaced by another
directory, which `rename(2)` does atomically and which destroys nothing.

**A move that fails leaves both endpoints exactly as they were.** `rename(2)`
replaces an existing file atomically all by itself, so the old unlink bought
nothing it did not also break.

**There is no copy-and-delete fallback across filesystems.** A grant can span
two volumes, and `rename(2)` cannot cross that boundary; `fs_move` names the
`EXDEV` case explicitly and says that nothing was changed:

```
cannot move /d0/f.txt to /d1/g.txt: they are on different filesystems, and
fs_move only renames -- it has no copy-and-delete fallback, so nothing was
changed. Copy the bytes with fs_read (encoding: "base64") and fs_write
(encoding: "base64"), then remove the original with fs_delete.
```

A fallback would be a different operation wearing rename's name: not atomic,
unable to preserve for free what a rename preserves (inode, hard links,
extended attributes, permissions), liable to leave a half-copied file behind
when it fails partway -- and it would put a delete back inside `fs_move`,
which is the thing this whole section exists to rule out. The composition that
does work is spelled out in the message, and every step of it is audited on
its own.

### Neither end of a move may be a granted root

`fs_move` refuses a `source` or a `destination` that resolves to one of the
granted directories itself, in any spelling (`/d0`, `/d0/`, `/d0/.`,
`/d0/notes/..`, or a symlink inside the grant that points at the grant).

The two ends are refused for different reasons. A **destination** that is a root
would have `fs_move` create a name at the sandbox root -- the same rule
`fs_write` and `fs_mkdir` follow, and a scope violation. A **source** that is a
root would move the granted folder out of existence, which is the rule
`fs_delete` already enforces: the sandbox must survive its occupant. An agent
may do as it likes inside the granted folder; the folder itself is the
operator's boundary object, not the agent's to remove.

Only the destination case is flagged `scope_violation` in the audit. Moving the
root away never reaches outside the grant, so calling it a scope violation would
put a boundary-object mistake in the same column an operator uses to spot a real
containment event.

### A pattern is a pattern, not an address

`fs_glob`'s `pattern` describes **names underneath** the directory being
searched. It cannot name the directory. A pattern that begins at the
filesystem root, or that contains a `..` component -- in any spelling, and
including one hidden inside a brace alternative, like `{sub,..}/*` or
`{[.][.],sub}/*` -- is refused as a scope violation before anything touches
the disk. The directory to search is the `path` argument, which is a virtual
address (`/d0/…`) and is validated like every other path in this server.

Separately, and this is the part that does not depend on recognising the
pattern at all: **the walk itself cannot leave the granted directories.**
fsMCP prunes the search as it descends, refusing to enter any directory that
is not inside the grant. A pattern nobody anticipated does not get a walk of
the host and a filtered result; it gets no walk.

**Why the refusal, rather than filtering the results.** The results were
already filtered: every hit has always been re-checked against the grant, so
no filename and no byte from outside it was ever returned. What leaked was
not data, it was *answers*. An absolute pattern naming the sandbox's own real
location came back with files; the same pattern with one character changed
came back empty. With `?`, `*` and `[a-r]` available, that difference is a
character-by-character search of the host's directory layout -- which is the
exact capability the virtual path space exists to remove, since a client is
not supposed to be able to confirm a host path it guessed. **Filtering the
output cannot close an oracle whose signal is the empty output.** The check
has to be on the way in.

**Why the pruned walk as well, rather than only the refusal.** The first
version of this refusal was a pattern-text rule, and it was escaped: `../*`
was refused while `[.][.]/*` and `\.\./*` -- which mean exactly the same
thing to the glob library -- were not, so the search really did walk the
filesystem above the granted folder, for as long as that took, on one call
from one client, with every other client of the same server waiting behind
it. Nothing escaped: the per-hit filter held, and the measured result was a
traversal and a denial of service rather than a disclosure. But a rule that
lists the ways a pattern can be written is a rule that will be escaped again,
so containment stopped being a property of the rule and became a property of
the walk. The refusal stayed, because *"you may not look there"* is a better
answer than a silent empty one, and because a pattern that climbs out of the
grant and back into it is invisible to the walk while remaining perfectly
visible to the parser.

Two more things follow from the same rule. Naming somewhere outside the grant
is a refusal carrying `_meta.scope_violation`, like every other tool's -- it
used to be an empty success, which quietly reported "you may not look there"
and "there is nothing there" as the same answer. And the refusal never
echoes the pattern back, because a refusal that changes with its input is the
same oracle one level up.

A `..` that survives into the search is refused even when it would have
stayed inside the grant. One that does not survive is not: `sub/../top.txt`
is reduced to `top.txt` by the glob library itself, before any searching
happens, so there is nothing left that could climb. Which of the two a given
pattern is depends only on how the pattern is written, never on what is on
disk -- `sub/../top.txt` and `nosuchdir/../top.txt` give the identical
answer -- so this is not a way to learn anything about the host. Every
directory in scope stays reachable by naming it with `path`.

**The walk is also bounded in wall-clock time**, sharing the search budget
`fs_grep` and `fs_find` already use. The 1000-result cap limits what is
returned, not what is walked: a pattern matching nothing used to walk every
directory it was pointed at and then report nothing, having done all the work
anyway. fsMCP is a single synchronous process and relay drives one shared
child, so one long walk stalls every other client of that server -- measured
at 18 seconds for one call, with an unrelated client's trivial read blocked
for 16 of them, and later at 44 seconds against a 30-second budget when the
work that runs *after* the walk turned out not to be under the budget at all.
Both the walk and the checking that follows it are under one deadline now. A
search that runs out of budget returns what it found and **says that it was
cut short**; it never returns a short answer that reads like a complete one.

### A granted directory has more than one name

An `allowed_dirs` entry is a string, and the same directory can be named by
more than one string: `/tmp/work` and `/private/tmp/work` on macOS,
`/Users/runner/app` and `/Users/admin/app` when a home directory was
migrated or a CI image left an alias behind, `/srv/projects/../projects/app`
and `/srv/projects/app` when someone pasted a path with a `..` still in it.
All of these are the same folder. fsMCP treats them that way, in both
directions, and reports the same files for each.

That is worth writing down because it was not always true, and because of
how it failed. Containment was never affected -- the security check has
always resolved a path before deciding, so all of these grants confined
correctly. What broke was the *naming* of results afterwards, which compared
strings. The failures were quiet and they were odd-looking:

- a grant reached through a symlink returned an empty list from `fs_glob`,
  on a success;
- a grant reached through an aliased ancestor returned each file twice, one
  copy named and one copy replaced by a placeholder;
- a grant written with a `..` in it returned that placeholder for **every**
  path from `fs_list` and `fs_glob`, while `fs_read`, `fs_grep` and
  `fs_find` worked normally on the same grant.

The placeholder in question -- `[fsmcp: path outside the granted directories
-- redacted]` -- is fsMCP's alarm for "a path reached the client from outside
the grant", which should be impossible and would be a bug in fsMCP if it
happened. Firing it on ordinary, correct calls is worse than the wrong
output it replaces: an alarm that goes off during normal use teaches
everyone who sees it, human and agent alike, to stop reading it. Getting it
to stop firing spuriously was as much the point of this fix as getting the
names right, and it still fires -- immediately -- for a path that really is
outside the grant.

If you are configuring fsMCP: any of these spellings works, and the plainest
one is still the best thing to type, because it is what appears in the audit
log and in the messages an operator reads.

### A granted root that is itself a symlink

An allowed directory reached *through* a symlink -- `/tmp` on macOS, a
relocated home directory, a folder on an external volume behind a link, a
cloud-storage alias -- works, and every tool reports the same files it would
report for the directory's real path. This is worth stating because it was
not always true, and because of the way it failed.

`fs_glob` is backed by the `glob` package, which by default will not walk
*through* a `cwd` that is a symlink. Given a granted root that was one, a
recursive pattern (`**/*.txt`) matched nothing and fsMCP returned **an empty
result on a success**: the client was told its folder was empty, and the
audit log recorded a normal call. A pattern whose first component is a
literal (`sub/*.txt`) does not go through that walk and worked, so the
failure looked intermittent rather than total, and `fs_find`, `fs_grep` and
`fs_list` were correct on the same grant the whole time -- which made the
grant itself look fine.

An empty answer where a real one exists is the worst shape a filesystem tool
can return. It is indistinguishable from the truth, so nothing downstream
can catch it: an agent reads "no such files" and acts on it, and neither the
client nor the operator gets any signal at all. fsMCP now hands the glob walk
the directory's resolved path, so the walk starts somewhere real.

**Enabling glob's "follow symlinks" option would not have fixed this, and
would have cost containment.** It does not resolve a symlinked starting
directory (measured), and it would additionally make the walk follow every
link *inside* the tree, including ones pointing out of the grant -- the exact
traversal the section above refuses. Resolving the root changes where the
walk begins and nothing about what it will walk through: links under the root
are still not followed, and every hit is still checked against the grant
before the client sees it. A symlink inside a symlinked root, pointing out of
it, is refused exactly as it is anywhere else.


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
