# fsMCP review — lens: information disclosure (ws3, two-root grant)

Client id `ws3`, granted two roots:

    /d0 = /Users/admin/source/barelyworkingcode/fsmcp-review/ws3
    /d1 = /Users/admin/source/barelyworkingcode/fsmcp-review/ws3b

All calls made as a remote client:

    export RELAY_REMOTE_ADDR=127.0.0.1:9910
    export RELAY_REMOTE_BUNDLE="$HOME/Library/Application Support/relay/enrolments/ws3"

Every finding below was produced by running the real stack end to end. Nothing
here is derived only from reading source.

---

## F1: fs_grep hands the client ripgrep's raw stderr, and the outbound backstop's path-boundary test misses the granted root's own path

**Severity:** high
**Component:** fsmcp

`fs_grep`'s ripgrep path returns rg's stderr verbatim
(`src/tools/grep.ts:406` — `errorResult(\`grep error: ${detail}\`)`), with no
path translation at all. The only thing standing between that and the wire is
the `isError` backstop `redactLeakedHostPaths` (`src/vpath.ts:491`):

    const re = new RegExp(`${escapeRegExp(hostDir)}(?=[/\n]|$)`);

The lookahead accepts a granted directory only when it is followed by `/`, a
newline, or end-of-string. Every Unix tool that appends a diagnostic to a path
— rg included — writes `<path>: <reason>`. A colon is not in that character
class, so a message naming a granted **root** (as opposed to something under
it) sails straight through untouched.

Two triggers, neither of which needs any privilege on the host and neither of
which is exotic.

### Repro A — a granted root that no longer exists (renamed, moved, unmounted volume)

Host side (an operator renaming a granted folder, or an external disk not
mounted):

    $ mv /Users/admin/source/barelyworkingcode/fsmcp-review/ws3b \
         /Users/admin/source/barelyworkingcode/fsmcp-review/ws3b.away

Client side, one ordinary call:

    $ relayremote call --tool fs_grep --args '{"pattern":"anything","path":"/d1"}'
    grep error: rg: /Users/admin/source/barelyworkingcode/fsmcp-review/ws3b: IO error for operation on /Users/admin/source/barelyworkingcode/fsmcp-review/ws3b: No such file or directory (os error 2)
    [exit=1]

Raw JSON as received by the client:

    {"content":[{"type":"text","text":"grep error: rg: /Users/admin/source/barelyworkingcode/fsmcp-review/ws3b: IO error for operation on /Users/admin/source/barelyworkingcode/fsmcp-review/ws3b: No such file or directory (os error 2)"}],"isError":true}

Contrast — every other tool handles the identical condition correctly:

    fs_list : directory not found: /d1
    fs_glob : directory not found: /d1
    fs_find : directory not found: /d1

### Repro B — a granted root the server process cannot read

    $ chmod 000 /Users/admin/source/barelyworkingcode/fsmcp-review/ws3
    $ relayremote call --tool fs_grep --args '{"pattern":"anything"}'
    grep error: rg: /Users/admin/source/barelyworkingcode/fsmcp-review/ws3: Permission denied (os error 13)
    [exit=1]

This also fires with `path` omitted entirely, i.e. the default-scope search an
agent makes constantly.

### Control — the backstop *does* work one level down

An unreadable **sub**directory produces `.../ws3/sec: Permission denied`, where
the root is followed by `/`, so the lookahead matches and the backstop fires:

    $ chmod 000 .../ws3/sec
    $ relayremote call --tool fs_grep --args '{"pattern":"anything","path":"/d0/sec"}'
    fsmcp: internal error -- a result could not be produced without exposing a granted directory's real path. Refusing to return it. This is a bug in fsmcp, not a property of the request; please report it.

That is the difference: the same class of message leaks or does not leak purely
on whether the offending path is the root itself or something inside it.

**Ground truth:** `relay audit --tail 8 --grep ws3` records both leaking calls
as ordinary `tool_error` — no `scope_violation` flag, nothing to tell an
operator that a host path just crossed the boundary:

    07:48:25  tool_error  WS3 Leak  fsmcp  fs_grep  10  ws3     {"pattern":"anything"}

Disk was unchanged (read-only tool).

**Why it matters in the real deployment:** the whole product claim is that a
remote agent never learns the host's account name or the layout above its
grant. One `fs_grep`, on a folder the operator moved or on a drive that is not
mounted this morning, hands over `/Users/<account>/…/<full path>` — the account
name, the directory layout, and the exact real root. The trigger is a normal
operator action, not an attack, and the agent does not have to be trying.

---

## F2: the same untranslated-stderr path turns an ordinary "no such directory" from fs_grep into "this is a bug in fsmcp, please report it"

**Severity:** medium
**Component:** fsmcp

The other side of F1's root cause. Because `fs_grep` never translates rg's
stderr, the backstop is doing all the work — and when it fires it replaces the
entire message. The most common way to hit it is a typo:

    $ relayremote call --tool fs_grep --args '{"pattern":"a","path":"/d0/nodir"}'
    fsmcp: internal error -- a result could not be produced without exposing a granted directory's real path. Refusing to return it. This is a bug in fsmcp, not a property of the request; please report it.
    [exit=1]

`/d0/nodir` is simply a directory that does not exist inside the grant. Every
sibling tool answers it plainly:

    $ relayremote call --tool fs_find --args '{"pattern":"a","path":"/d0/nodir"}'
    directory not found: /d0/nodir
    $ relayremote call --tool fs_glob --args '{"pattern":"*","path":"/d0/nodir"}'
    directory not found: /d0/nodir

Same for an unreadable subdirectory anywhere under the grant (shown in F1's
control block).

**Ground truth:** `relay audit` shows `tool_error`, no `scope_violation`; disk
untouched.

**Why it matters in the real deployment:** an agent that mistypes a path is
told its filesystem server is broken and asked to file a bug, instead of being
told the directory is not there. It has no way to recover, and an operator
chasing the report finds nothing wrong. The fix for F1 (translate rg's stderr
at its construction site, the way `describeError` already does for Node's
`ErrnoException`) fixes this one too — the backstop should be an alarm that
never fires, not the routine error path for `fs_grep`.

---

## F3: a `--allowed-dir`/profile disagreement prints the dropped directory as a raw host path on every SUCCESS result

**Severity:** high
**Component:** fsmcp (config-triggered)

Verified live, as requested. In this deployment fsmcp is registered with no CLI
arguments, so the report never fires. Re-registering it with an `--allowed-dir`
that disagrees with the profile's grant reproduces it exactly.

**What an operator has to do to trigger it** — one command, and it is a
plausible one (tightening the server-wide floor without noticing a profile
still names a second root):

    $ /Applications/Relay.app/Contents/MacOS/relay mcp register \
        --id fsmcp --name fsMCP --command /Users/admin/.local/bin/fsmcp \
        --args --allowed-dir \
        --args /Users/admin/source/barelyworkingcode/fsmcp-review/ws3
    updated mcp "fsMCP" (fsmcp)

`relay mcp register` on an existing id sends a targeted reload, so fsmcp
respawns with the new argv immediately — no relay restart, no other operator
action. The WS3 profile still grants both `ws3` and `ws3b`; `ws3b` is not
inside the new CLI root, so it is dropped, and the drop is reported:

    $ relayremote call --tool fs_read --args '{"file_path":"/d0/notes/todo.txt"}'
    1	TODO: fix the parser
    2	TODO: ship the thing
    3	
    [fsmcp: _meta.allowed_dirs entries were dropped because they are not contained within any --allowed-dir root: /Users/admin/source/barelyworkingcode/fsmcp-review/ws3b]
    [exit=0]

Raw JSON — note there is no `isError`, so this is a **success** result and the
`redactLeakedHostPaths` backstop (which is `isError`-only by design) cannot see
it:

    {"content":[
      {"type":"text","text":"symlink\t20\t…\t/d0/dangling_link\n…"},
      {"type":"text","text":"[fsmcp: _meta.allowed_dirs entries were dropped because they are not contained within any --allowed-dir root: /Users/admin/source/barelyworkingcode/fsmcp-review/ws3b]"}
    ]}

It is appended to **every** call while the misconfiguration stands —
`fs_list`, `fs_read`, `fs_write` (`Wrote 1 bytes to /d0/probe.txt` + the note),
and even to refusals. Source: `src/main.ts:223`.

Note also that a dropped directory is by construction *not* in `ctx.labels`, so
even a corrected version of the F1 backstop would not catch this one: the
report has to stop naming the path, the way `assignLabels`' duplicate-label
refusal already sends the host paths to stderr and only the label to the
client.

**Secondary, same misconfiguration:** relay's appended scope note keeps
reporting the profile's count, not the effective one. With the CLI narrowing in
place, `/d1` is gone —

    $ relayremote call --tool fs_list --args '{"path":"/d1"}'
    path is not a valid address: every path must begin with one of this call's granted labels (/d0), …

— but all ten tool descriptions still said `confined to 2 values`. The one
surface that is supposed to tell an agent the shape of its own limits is wrong
in exactly the situation where the agent is confused.

**Restoration confirmed.** Re-registered with no `--args`:

    $ /Applications/Relay.app/Contents/MacOS/relay mcp register \
        --id fsmcp --name fsMCP --command /Users/admin/.local/bin/fsmcp
    updated mcp "fsMCP" (fsmcp)
    $ grep -A5 '"id": "fsmcp"' settings.json
          "command": "/Users/admin/.local/bin/fsmcp",
          "args": null,
          "env": null

and both roots are addressable again (`fs_list {}` returns `/d0/…` and
`/d1/…`, no drop note). The live process is
`node …/fsmcp/dist/main.js` with no arguments. (relay has since normalised the
stored value to `"args": []` on a later settings write of its own — the same
state the registration was in when I found it, and identical in effect: no CLI
`--allowed-dir`.)

**Why it matters in the real deployment:** this is a one-command
misconfiguration that turns every successful reply into a host-path
disclosure, on a surface the fail-closed backstop deliberately does not watch.

---

## F4: fs_list's size column for a symlink is the byte length of its target path, including targets outside the grant

**Severity:** low
**Component:** fsmcp

`listOneDir` uses `lstat` (correct — it must not follow) and prints
`st.size`. For a symlink on macOS/Linux, `st_size` *is* the length of the
target string. So the size column is a precise measurement of an out-of-grant
host path.

    $ relayremote call --tool fs_list --args '{"path":"/d0"}'
    symlink	20	2026-08-26T…	/d0/dangling_link
    symlink	4	2026-08-26T…	/d0/etc_link
    symlink	52	2026-08-26T…	/d0/parent_link
    symlink	11	2026-08-26T…	/d0/passwd_link

On disk:

    dangling_link -> /nonexistent/nowhere                                     (len=20)
    etc_link      -> /etc                                                      (len=4)
    passwd_link   -> /etc/passwd                                              (len=11)
    parent_link   -> /Users/admin/source/barelyworkingcode/outside_secret     (len=52)

52 is exactly `len("/Users/admin/source/barelyworkingcode/outside_secret")`.
Every other surface refuses to say anything about that link:

    $ relayremote call --tool fs_read --args '{"file_path":"/d0/parent_link"}'
    path /d0/parent_link is outside allowed directories

The size column is the only channel that says anything, and what it says is a
measurement of a path the client is not allowed to know exists.

The function's own doc comment (`src/tools/list.ts`, above `listOneDir`) states
the opposite of what the code does:

> "Reporting a symlink as `symlink`, with the size and mtime of the link
> itself, means an entry pointing outside the allowed directory is disclosed
> only as a name and a type"

It is disclosed as a name, a type, **and the exact length of its target**.

**Ground truth:** `stat -f %z` on each link matches the reported size byte for
byte; `relay audit` shows `ok`.

**Why it matters in the real deployment:** on its own this is a few bits. It
becomes worth something with a guessable prefix — a `latest -> /Volumes/Backup/
2026-08-26-nightly` style link, common in real trees, has a length that
confirms or eliminates a candidate host path in one call, and `fs_move`
lets a client rename links freely. Reporting `0` for symlinks would cost
nothing: the size of a link is not information any caller has a use for.

---

## F5: reordering the profile's allowed_dirs silently re-points every virtual path a client has stored — a read returns another file's bytes and a write clobbers another file, both reporting success

**Severity:** medium
**Component:** fsmcp (labelling policy) / relay (profile edit)

Labels are positional (`d0`, `d1` by index in the effective scope) and relay
re-reads the profile with no restart, so an operator dragging two entries into
a different order in `settings.json` renames the client's whole address space
with no signal of any kind.

Planted one same-named file in each root:

    $ echo "ALPHA-ROOT-WS3"  > …/ws3/same.txt
    $ echo "BETA-ROOT-WS3B"  > …/ws3b/same.txt

With `allowed_dirs = [ws3b, ws3]`:

    $ relayremote call --tool fs_read --args '{"file_path":"/d0/same.txt"}'
    1	BETA-ROOT-WS3B

Operator reorders to `[ws3, ws3b]` (edit `settings.json`, no restart), same
client, same stored path:

    $ relayremote call --tool fs_read --args '{"file_path":"/d0/same.txt"}'
    1	ALPHA-ROOT-WS3

And the write side:

    $ relayremote call --tool fs_write --args '{"file_path":"/d0/same.txt","content":"OVERWRITTEN\n"}'
    Wrote 12 bytes to /d0/same.txt
    [exit=0]

**Ground truth**, on disk:

    …/ws3/same.txt   -> OVERWRITTEN
    …/ws3b/same.txt  -> BETA-ROOT-WS3B     (the file the client thought it had opened)

Where the two trees do not share a name, the same reorder gives a bare
`file not found: /d0/notes/todo.txt` for a path that worked a second earlier.

This is documented in fsmcp's README as the tradeoff of positional labelling,
and `assignLabels`' doc argues the case. It is recorded here because the
concrete outcome — a **success** message for a write that hit a different
file than the caller named — is exactly the shape the brief calls a finding,
and because the operator gesture that causes it (reordering a list in a
settings UI) does not look like a destructive one. Explicit `label=` entries
already exist and avoid it; nothing warns an operator to use them, and nothing
tells the client its address space just changed.

---

## F6: one client's oversized fs_grep result permanently wedges the shared fsmcp connection for every grant on the host

**Severity:** medium
**Component:** relay (with fsmcp contributing an uncapped output path)
**No host information is disclosed by this** — reported because the lead asked
for the boundary to be probed, and because the failure is sticky and crosses
grant boundaries. Distinct from the separately-covered ">7.9 MB `fs_read`
kills the MCP child": here fsmcp survives, and it is relay's stdout reader
that dies and never recovers.

`fs_grep` in `content` mode has no output cap (there is a 200/1000/5000 cap on
`fs_find`/`fs_glob`/`fs_list`, and a 10 MB input cap on `fs_read`, but nothing
bounds a content-mode grep result). relay reads the MCP's stdout with a 10 MiB
per-line `bufio.Scanner`.

    # 6 MiB of matching lines in the grant -> ~8 MB result, fine:
    $ relayremote call --tool fs_grep --args '{"pattern":"NEEDLEX","output_mode":"content"}' | wc -c
    7991583

    # 10 MiB of matching lines -> over the cap:
    $ relayremote call --tool fs_grep --args '{"pattern":"NEEDLEX","output_mode":"content"}'
    error: relay error: external MCP call failed: read response: bufio.Scanner: token too long

    # and it does not recover — every subsequent call, from any client:
    $ relayremote call --tool fs_read --args '{"file_path":"/d0/notes/meeting.md"}'
    error: relay error: external MCP call failed: read response: bufio.Scanner: token too long
    $ sleep 2; relayremote call --tool fs_read --args '{"file_path":"/d0/notes/meeting.md"}'
    error: relay error: external MCP call failed: read response: bufio.Scanner: token too long

    $ ps -Ao pid,ppid,command | grep fsmcp/dist
    40218 40216 /opt/homebrew/bin/node …/fsmcp/dist/main.js      # still alive

Recovery required an operator action on the host:

    $ relay mcp register --id fsmcp --name fsMCP --command /Users/admin/.local/bin/fsmcp
    updated mcp "fsMCP" (fsmcp)      # targeted reload; service restored

The failure text discloses nothing about the host — no paths, no account name.

**Why it matters in the real deployment:** fsmcp is a single shared process
behind every grant. A grep for a common word over a large granted folder — not
an attack, just a big repo — takes filesystem access away from every other
agent on the host until a human notices and reloads the MCP.

---

## Verified working

Everything below was exercised end to end against the live stack and behaved
correctly. This is the list an operator can rely on.

**Tool list and descriptions (`relayremote list`, `list --schema`)**
- All 10 descriptions and all 18 parameter descriptions are free of `/Users`,
  `admin`, `barelyworkingcode`, `fsmcp-review` and `ws3`
  (`grep -nEi '/Users|admin|barelyworkingcode|fsmcp-review|ws3'` over the full
  `--schema` JSON: no match).
- `disclose: "count"` renders correctly with a two-root grant: all 10 tools
  carry `Scope: Directories this client may read, search and modify within —
  confined to 2 values`. No root paths anywhere.
- Re-checked at other cardinalities: a one-root grant renders
  `confined to 1 value` (correct singular); an empty grant renders
  `no value is set for …` and relay denies every call before fsmcp runs
  (`access denied: MCP 'fsmcp' scopes tool 'fs_read' by "allowed_dirs" and this
  grant supplies no value for it`) — fail-closed, no host detail.
- Path-argument descriptions correctly use the `"<label>"` placeholder and
  explicitly tell a caller not to assume `d0`.
- `relayremote skill` output is clean: the only absolute paths in the generated
  SKILL.md are the *client's own* relayremote binary and bundle directory,
  composed locally by relayremote, never received from relay.

**Success results — every tool, grepped for `/Users`, `admin`,
`barelyworkingcode`, `fsmcp-review`, `ws3`: no match**
- `fs_list` (default scope, `/d0`, `/d1`), `fs_glob`, `fs_find`, `fs_grep` in
  all three output modes (`files_with_matches`, `content`, `count`),
  `fs_read` text and base64, `fs_write` text and base64, `fs_edit`, `fs_mkdir`,
  `fs_move`, `fs_delete`.
- Cross-root operations render both labels correctly:
  `Moved /d0/tmpwork/c.txt to /d1/c.txt`.
- `/d1` is addressable in every tool; a file in one root never rendered with
  the other root's label in any of ~200 calls.
- `fs_list` of the default scope shows only the two granted roots — nothing
  about any other root, sibling, or parent.

**Content is NOT translated (the corruption trap) — verified byte for byte**
- `projects/beta/selfref.conf` contains the workspace's own host path.
  `fs_read` text mode returns it verbatim:
  `1	This config references /Users/admin/source/barelyworkingcode/fsmcp-review/ws3/notes in its text.`
- `fs_read` base64 of the same file is byte-identical to `base64 -i` on the
  host (`VGhpcyBjb25maWcgcmVmZXJlbmNlcyAvVXNlcnMv…` — identical strings), and
  `shasum -a 256` on disk unchanged.
- `fs_grep --output_mode content` over it returns the matched line untouched
  while translating only the path prefix:
  `/d0/projects/beta/selfref.conf:2:root=/Users/admin/source/barelyworkingcode/fsmcp-review/ws3`
- `fs_grep --output_mode files_with_matches` for the pattern
  `barelyworkingcode` correctly finds the file and reports it as
  `/d0/projects/beta/selfref.conf`.

**Error results — every distinct error I could force, all translated**
`file not found: /d0/nope.txt` · `path is a directory, not a file` ·
`not a directory: /d0/notes/meeting.md` · `directory not found: /d0/nodir` ·
`EACCES: permission denied, open '/d0/perm/locked.txt'` ·
`list error: EACCES: permission denied, scandir '/d0/permdir'` ·
`EACCES: permission denied, open '/d0/permdir/.new.txt.fsmcp-tmp-442137f3ae91'` ·
`mkdir failed: EACCES: permission denied, mkdir '/d0/permdir/newdir'` ·
`move failed: EACCES: permission denied, rename '/d0/notes/todo.txt' -> '/d0/permdir/todo.txt'` ·
`EACCES: permission denied, scandir '/d0/permdir'` (delete) ·
`mkdir failed: ENOENT: no such file or directory, mkdir '/d0/err/p1/p2'` ·
`mkdir failed: EEXIST: file already exists, mkdir '/d0/err/dup.txt'` ·
`/d0/data/latin1.txt's bytes are not valid UTF-8, …` (same for `utf16.txt`,
`random.bin`) · `/d0/err/big.txt is 11534336 bytes, over fs_read's
10485760-byte limit; …` · `old_string not found in file` · `old_string found 2
times. Use replace_all …` · `destination already exists: /d0/notes/todo.txt
(pass overwrite: true to replace it)` · `source not found: /d0/err/gone.txt` ·
`not found: /d0/err/gone` · `refusing to delete an allowed_dir root: /d0` ·
`content is not valid base64 (…)` · `encoding must be "text" or "base64";
received "utf16"` · `offset/limit are a line-based view and do not apply to
encoding: "base64" …` · `pattern is required` · `file_path is required` ·
`file_path must be a string; received 123` · `recursive must be true or false;
received "false"` · `new_string must be a string; received null` ·
`path must not contain a NUL byte` · `grep error: rg: regex parse error: …`
(bad regex) · `grep error: rg: error parsing glob '[[': …`.

Every one of these carries a `/d0/…` or `/d1/…` path, or no path at all.
Node's raw `ENOENT`/`EISDIR`/`ENOTDIR`/`EACCES`/`EEXIST` messages — which
embed the syscall's own path — are correctly rebuilt around the virtual form
via `describeError`'s `.path`/`.dest` reads. The only untranslated error
surface found is `fs_grep`'s rg-stderr passthrough (F1/F2).

**The oracle question — no oracle found**
- Real host path vs. fake host path, as the path argument to **all ten tools**
  (`/Users/admin/source/barelyworkingcode/fsmcp-review/ws3/notes/todo.txt` vs
  `/Users/admin/source/barelyworkingcode/fsmcp-review/ZZnope/qq.txt`): all 20
  replies md5-identical (`d2dedbba92b90bc8d54784379aa3d310`).
- 14 further candidates through `fs_read` — the exact grant root, a real file
  in it, the *other* grant root, another reviewer's root, the out-of-scope
  canary file, `/Users/admin`, `/Users/nobodyhere`, `/etc/passwd`, `/zzz/qqq`,
  `/d2/x`, `/d0x/y`, `d0/y`, `""`, `/` — produced **one** distinct reply across
  all 14 (`md5 | sort -u | wc -l` → `1`):
  `path is not a valid address: every path must begin with one of this call's
  granted labels (/d0, /d1), not an absolute host path — …`
  The refusal never echoes the caller's input, so the PR#10 "rewritten vs. not
  rewritten" oracle is genuinely closed.
- Exists-outside-the-grant vs. does-not-exist-at-all, through `..` and through
  symlinks, across `fs_read`/`fs_write`/`fs_edit`/`fs_mkdir`/`fs_move` (source
  *and* destination)/`fs_delete`/`fs_list`/`fs_grep`: every pair identical.
  `/d0/../ws1` ≡ `/d0/../ZZnope`; `/d0/../../outside_secret/secret.txt` ≡
  `/d0/../../outside_secret/NOPEZZ.txt`; `/d0/etc_link/passwd` ≡
  `/d0/etc_link/NOSUCHFILE`; `/d0/../../testfolder_sibling_canary.txt` ≡
  `/d0/../../ZZ_no_canary.txt`. All →
  `path <as sent> is outside allowed directories` with
  `_meta.scope_violation: true`, and `relay audit` records
  `tool_error … scope_violation: true` for each.
- Timing, 15 calls per candidate: 28.1–29.6 ms/call across existing-outside,
  nonexistent-outside, correct-host-path and wrong-host-path. No stable
  difference; process startup dominates.
- Error class does not vary either: every out-of-grant probe is
  `scope_violation`, never a plain error and never an empty success.

**Metadata**
- `fs_list` emits type, size, mtime, virtual path only. No inode, uid, gid,
  mode, nlink, device, atime, ctime or birthtime anywhere in fsmcp's output
  (`grep -rn '\.uid|\.gid|\.ino|\.mode|\.dev|\.nlink|birthtime|atime|ctime'
  src/` finds only two internal `statSync().mode` reads used to preserve
  permissions on atomic replace — never emitted).
- The only `_meta` fsmcp sets on a result is `{bytes: N}` on a base64 read and
  `{scope_violation: true}` on a scope refusal. Nothing else.
- `fs_list` of the default scope reveals nothing about any root the client was
  not told about — with `/d1`'s directory renamed away it silently listed only
  `/d0`, naming nothing.
- Symlink size is the exception — see F4.

**relay's own surfaces to the client**
- Unknown tool: `error: relay error: unknown tool: fs_bogus`.
- A tool belonging to a *different* MCP registered on the same host
  (`mail_list_messages`): the identical `unknown tool` message — relay does
  not disclose that macMCP exists or that its tools are ungranted.
- Malformed args: `error: invalid args JSON: {not json` (exit 2, never reaches
  relay).
- Wrong project: `error: access denied: enrolment "ws3" does not grant project
  "deadbeef"` — names only the client's own enrolment id.
- Throttled (budget temporarily set to `max_calls: 2`, then restored):
  `error: throttled: enrolment "ws3" has used 8 of 2 calls in the last 3600s`
  — no host detail.
- Unreachable relay: names only the address the client itself supplied.
- Unenrolled client cert, self-signed: rejected at the TLS handshake —
  `remote error: tls: certificate required`.
- Unenrolled client cert **signed by relay's own CA** (the revoked-enrolment
  shape, forged with `ca.key` from the host): relay closes the connection
  without answering, and relayremote says so plainly —
  `relay closed the connection without answering (EOF); this is also what relay
  does when a client certificate is not enrolled or has been revoked`.
  Nothing about the host is disclosed on any of these paths.

**Workspace / config state on completion**
- `ws3` fixture rebuilt with `mkfixture.sh`; `ws3b` intact
  (`sub/other.txt` = `second root file`).
- fsmcp registration restored to no CLI arguments and confirmed: live process
  is `node …/fsmcp/dist/main.js` with no argv, both roots addressable, no drop
  note on any result.
- WS3 profile back to both roots in original order; ws3 enrolment budget
  restored to `max_calls: 200000, max_result_bytes: 4294967296`.
- Final health check `fs_list {}` returns the full `/d0` tree plus `/d1/sub`.
