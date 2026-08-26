# fsMCP

MCP server providing file system tools via stdio. Gives LLMs the ability to read, write, edit, create, move, delete, list and search the local file system -- all confined to a set of allowed directories, with no path out of the sandbox and no shell. A client addresses files in a virtual path space (`/d0/…`) rooted at its own grant; it never sees, and cannot supply, the real host path underneath (see "Virtual Path Space" below).

## Tools

### File System
| Tool | Read-only | Description |
|------|-----------|-------------|
| `fs_read` | yes | Read a file: a line-numbered UTF-8 text view (default), or exact bytes as base64 |
| `fs_glob` | yes | Find files by glob pattern (relative patterns only -- see "A pattern is a pattern, not an address") |
| `fs_grep` | yes | Search file contents with regex |
| `fs_list` | yes | List one directory's immediate contents (non-recursive): name, type, size, mtime |
| `fs_find` | yes | Fast fuzzy filename search (`rg --files` + in-process fuzzy ranking) |
| `fs_write` | no | Write or create files (UTF-8 text or exact bytes via base64) |
| `fs_edit` | no | Find-and-replace string editing |
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

When fsmcp is run with `--allowed-dir` **and** a caller supplies `_meta.allowed_dirs` on a call, the effective scope is their **intersection**: each `_meta` directory is kept only if it resolves inside one of the `--allowed-dir` roots, and any that don't are dropped (and reported back on the result, not silently). `_meta.allowed_dirs` is treated as caller-supplied input, the same as any other argument on the wire -- fsmcp does not assume anything upstream of it (relay, or whatever configured relay) has already enforced a boundary, so it never lets `_meta` grant more than the operator already typed on the command line:

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

`fs_write` and `fs_edit` replace a file by writing the new content to a
temp file in the same directory and renaming it into place, so a write that
fails partway (a full disk, the process being killed) leaves the *original*
file intact instead of truncated -- the tradeoff is that peak disk usage
during the write is roughly the old file's size plus the new one's, so a
volume sized with no headroom to spare for its largest file can start
seeing `ENOSPC` on writes that used to fit.

That temp file is what makes the grant root itself an invalid target for a
write -- see "The grant root is not a writable target" below.


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
directory can be spelled two ways -- the path the operator wrote, and the
path it resolves to when the grant is reached through a symlink -- and the
outbound map recognises both, because a tool that resolves a path before it
emits it produces the second one. Recognising it makes nothing new
reachable: the two spellings resolve to the same files by construction, and
either way the hit has already been through the same containment check
before anything decides how to display it. See *A granted root that is
itself a symlink*, below. Refusing an
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

That guarantee has one documented exception, and it predates this change: when
a call's `_meta.allowed_dirs` contains an entry that is not inside any
`--allowed-dir` root, fsmcp appends a report naming the dropped entries as raw
host paths, on a SUCCESS result, outside the virtual path space. It is
reachable in a relay deployment whose registration carries `--allowed-dir`
args *and* whose profile grants a directory outside them — the two disagree,
and the client is told which entry was discarded. `disclose` does not reach
that surface; see the note in CLAUDE.md. Whether the description relay writes carries one
is a property of the relay in front of it, and is worth checking with
`relayremote list --schema` on the deployment you actually run (plain
`list` truncates the description, which is where the note lives).

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

### A pattern is a pattern, not an address

`fs_glob`'s `pattern` describes **names underneath** the directory being
searched. It cannot name the directory. A pattern that begins at the
filesystem root, or that contains a `..` component -- including one hidden
inside a brace alternative, like `{sub,..}/*` -- is refused as a scope
violation before anything touches the disk. The directory to search is the
`path` argument, which is a virtual address (`/d0/…`) and is validated like
every other path in this server.

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

Two more things follow from the same rule. Naming somewhere outside the grant
is now a refusal carrying `_meta.scope_violation`, like every other tool's --
it used to be an empty success, which quietly reported "you may not look
there" and "there is nothing there" as the same answer. And the refusal never
echoes the pattern back, because a refusal that changes with its input is the
same oracle one level up.

A `..` that would have stayed inside the grant (`sub/../top.txt`) is refused
too. That is deliberate: a path *argument* containing `..` is resolved and
checked, but a pattern with a wildcard in front of the `..` does not resolve
to any single path, so there is nothing to check. Rather than resolve some
patterns and not others -- and leave a boundary between the two rules for a
caller to probe -- every `..` in a pattern is refused, and every directory in
scope stays reachable by naming it with `path`.

**The walk is also bounded in wall-clock time**, sharing the search budget
`fs_grep` and `fs_find` already use. The 1000-result cap limits what is
returned, not what is walked: a pattern matching nothing used to walk every
directory it was pointed at and then report nothing, having done all the work
anyway. fsMCP is a single synchronous process and relay drives one shared
child, so one long walk stalls every other client of that server -- measured
at 18 seconds for one call, with an unrelated client's trivial read blocked
for 16 of them. A walk that runs out of budget returns what it found and
**says that it was cut short**; it never returns a short answer that reads
like a complete one.

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
