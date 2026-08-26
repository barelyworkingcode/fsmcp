# relay ↔ fsMCP — is the grant the operator authored the grant the client gets?

Lens: the five grant layers, runtime grant changes, budgets, and audit fidelity.
Client id `ws4`, two granted roots (`/d0` = `fsmcp-review/ws4`, `/d1` = `fsmcp-review/ws4b`).

Everything below was run end to end against the installed stack
(`relayremote` → mTLS 127.0.0.1:9910 → `/Applications/Relay.app/Contents/MacOS/relay`
→ `/Users/admin/.local/bin/fsmcp`). Ground truth is `relay audit` and the disk.

**Headline:** the four layers relay enforces on a *single* MCP (tools, operations,
outbound, resource presence) hold under everything I threw at them, including
runtime edits and revocation. What does not hold is (a) *which* MCP a bare tool
name resolves to, (b) what happens to the operator's resource scope when the
MCP's schema does not declare it, and (c) the audit log's ability to answer
"which client did this" and "why did this fail".

---

## F1: A bare tool name is not resolved inside the grant — colliding names are served at random, and an unrelated grant gets calls routed to an MCP it never granted

**Severity:** high
**Component:** relay

`docs/access-profiles.md` states the rule plainly:

> A candidate is an MCP that this profile allows AND on which this profile
> allows this tool … If exactly one candidate remains, it serves. If **two** do,
> the call is refused and the error names both … **A colliding name is withheld
> from `tools/list` and from generated skills.**

The installed binary does neither.

### Repro A — two MCPs, one profile, two different resource scopes

Registered a second copy of the same fsmcp binary as `fsmcp2`, and a profile
`WS4-Collide` that grants both, deliberately with *different* `allowed_dirs`:

```
{"name": "WS4-Collide", "allowed_mcp_ids": ["fsmcp", "fsmcp2"],
 "allowed_tools": {"fsmcp": ["fs_*"], "fsmcp2": ["fs_*"]},
 "context": {"fsmcp":  {"allowed_dirs": [".../fsmcp-review/ws4"]},
             "fsmcp2": {"allowed_dirs": [".../fsmcp-review/ws4b"]}}}
```

The colliding names are **not** withheld — every name is advertised twice:

```
$ relayremote list
FILE SYSTEM (20)
  fs_delete  Delete a file or directory. …
  fs_delete  Delete a file or directory. …
  fs_edit    Perform exact string replacement in a file. …
  fs_edit    Perform exact string replacement in a file. …
  …
20 tools in 1 category · relay 127.0.0.1:9910 · enrolment ws4-collide
```

And the call is **not** refused. The same call, fourteen times, returned two
different directories:

```
$ for i in $(seq 1 14); do relayremote call --tool fs_list --args '{"path":"/d0"}' | head -1; done | sort | uniq -c
   3 directory	96	2026-08-26T14:33:17.638Z	/d0/sub               <- this is ws4b
  11 symlink	20	2026-08-26T14:33:17.633Z	/d0/dangling_link     <- this is ws4
```

**Ground truth** — `relay audit` names the MCP and the scope each call actually
ran under, and confirms the split:

```
$ relay audit --tail 40 --kind remote --json | (group by mcp_id, outcome, scope)
12 ('fsmcp',  'ok', '{"allowed_dirs": [".../fsmcp-review/ws4"]}')
 3 ('fsmcp2', 'ok', '{"allowed_dirs": [".../fsmcp-review/ws4b"]}')
```

`/d0` means two different host directories on successive calls, chosen by Go's
map seed. A write the operator believed was going to one granted tree lands in
the other, silently, some fraction of the time.

### Repro B — collateral: an unrelated grant that names exactly one MCP

The `ws4` profile grants **only** `fsmcp`. With `fsmcp2` and `fsmcp-bare`
registered (and granted to nobody but their own WS4- profiles), `ws4`'s own
calls started being routed to MCPs it does not grant:

```
$ for i in $(seq 1 20); do relayremote call --tool fs_read --args '{"file_path":"/d0/notes/todo.txt"}' | head -1; done | sort | uniq -c
  17 1	TODO: fix the parser
   1 error: access denied: MCP 'fsmcp-bare' is disabled for this token
   2 error: access denied: MCP 'fsmcp2' is disabled for this token
```

**Ground truth:**

```
$ relay audit --tail 40 --kind remote --json | (group by mcp_id, outcome, for client_id=ws4)
('fsmcp', 'ok') 17
('fsmcp2', 'denied') 2
('fsmcp-bare', 'denied') 1
```

This is not confined to my own profiles — the shipped, untouched `hermes-files`
enrolment was hit too while the extra MCPs were registered:

```
$ relay audit --tail 200 --kind remote --json | (records whose mcp_id is fsmcp2 or fsmcp-bare)
('hermes-files', 'denied') 2
('ws4', 'denied') 15
```

Removing the extra MCPs restores correctness completely — 480 calls across four
relay restarts, eight parallel clients, zero misroutes:

```
$ ./race2.sh   # kill relay, relaunch, 8 workers × 30 calls
 158 1	TODO: fix the parser
  82 error: relay unreachable: … connection refused        (listener not yet bound)
```

### Why the installed build behaves this way

The fix exists in the repo but not in the running binary. `relay/router.go` at
HEAD contains `resolveToolOwner`, whose refusal string is
`"is exposed by more than one MCP this grant allows"`. That string is absent
from the shipped binary:

```
$ strings -a /Applications/Relay.app/Contents/MacOS/relay | grep -c "is exposed by more than one MCP this grant allows"
0
$ strings -a /Applications/Relay.app/Contents/MacOS/relay | grep -c "is not in the allowed tools for MCP"
1
$ ls -l /Applications/Relay.app/Contents/MacOS/relay
-rwxr-xr-x  1 admin  wheel  13781280 Aug 25 21:08 …/relay
$ git -C ~/source/barelyworkingcode/relay log --oneline -1
10327fe Resolve a tool name inside the calling grant, not against the map seed (#37)
```

So: `#37` is written and unreleased, and `docs/access-profiles.md` documents it
as current behaviour. Everything above was measured on the build an operator
actually has.

**Why it matters in the real deployment:** the moment a host has two filesystem
MCPs — a second fsmcp scoped to a different folder, or any other server exposing
an `fs_read` — every path a client names becomes a coin flip between two
resource scopes, with no error and nothing in the client's view to suggest it.
And registering that second MCP silently degrades every *existing* grant that
names only the first one, turning a fraction of its calls into denials that
blame an MCP the operator never granted.

*(This is the item STATUS.md lists as "observed in passing during another
agent's ambiguity test — awaiting that agent's report". It was my test; this is
the report.)*

---

## F2: When an MCP's live schema does not declare the scope field, relay silently DROPS the operator's `allowed_dirs`, dispatches the call unconfined, and the audit says `scope=(none declared)`

**Severity:** medium (fail-open in relay; contained only because fsmcp itself fails closed)
**Component:** relay

This is the mechanism behind the "no allowed directories are configured"
symptom the review lead saw in passing.

`router.go` filters the injected `_meta` down to fields the **live** schema
declares (`filterKnownContextFields`), and then `checkScopePresence` only
requires a value for fields the live schema declares. If the schema declares
*nothing*, both pass: the operator's value is thrown away and the call goes to
the MCP with no scope at all.

**Repro.** A proxy in front of the real fsmcp, registered as `fsmcp-noschema`,
that changes exactly two things: it reports `contextSchemaVersion: 2` with an
empty `contextSchema: {}`, and it renames its tools `fs_*` → `zfs_*` so it
cannot collide with the real fsmcp (F1). The profile carries a perfectly good
grant:

```
"context": {"fsmcp-noschema": {"allowed_dirs": ["…/fsmcp-review/ws4"]}}
```

```
$ relayremote call --tool zfs_read --args '{"file_path":"/d0/notes/todo.txt"}'
no allowed directories are configured; refusing all path access. Start fsmcp with --allowed-dir <path>, or pass allowed_dirs via _meta.
```

**Ground truth:**

```
$ relay audit --tail 2 --kind remote --authority
08:04:39  pending     WS4-NoSchema  fsmcp-noschema  zfs_read  0   ws4-noschema  {"file_path":"/d0/notes/todo.txt"}
                                                                  authority: access=write  outbound=blocked  scope=(none declared)
08:04:39  tool_error  WS4-NoSchema  fsmcp-noschema  zfs_read  10  ws4-noschema  scope_violation: true  {"file_path":"/d0/notes/todo.txt"}
                                                                  authority: access=write  outbound=blocked  scope=(none declared)
```

Three separate problems on that one record:

1. **Relay's layer 5 failed open.** It did not refuse; it stripped the
   confinement and dispatched. The only thing that stopped an unconfined
   filesystem call was fsmcp's own `validatePath`. Relay's own source comment
   on the guard immediately above says exactly why that matters: *"for a v1
   filesystem-scoped MCP an ABSENT allowed_dirs is what fsMCP reads as
   unrestricted, so removing the value and letting the call through would turn
   a forged confinement into no confinement."* The guard fires when the
   **grant** is empty and not when the **schema** is.
2. **The audit is wrong.** `docs/access-profiles.md` is explicit that
   `scope=(none declared)` means "this MCP has no scope concept" and
   `scope=(declared, none injected)` means "there was one and the grant supplied
   nothing". Neither is what happened: the operator supplied one and relay threw
   it away. There is no rendering for that, so the record reports the reassuring
   version of the two.
3. **The client is told the wrong thing.** "no allowed directories are
   configured" reads as *you were granted nothing*. The operator granted a
   directory; relay dropped it.

Control, same shim with the schema simply **absent** (v1 compatibility branch)
rather than empty-v2 — here the value is *not* dropped and the call is confined
correctly, which is what narrows the failure to the empty-v2/renamed-field case:

```
$ relayremote call --tool zfs_read --args '{"file_path":"/d0/notes/todo.txt"}'
1	TODO: fix the parser
2	TODO: ship the thing
```

**On the lead's startup observation specifically:** I could not reproduce it on
a clean single-fsmcp install — 4 relay restarts, 600 calls, 8 parallel workers,
zero occurrences (calls either got `connection refused` because the listener was
not yet bound, or succeeded correctly). Relay binds the remote listener *after*
"MCP connected", which closes most of the window. The mechanism above is the one
shape that produces that exact message with a populated grant, so it is the
thing to fix; whether a transient handshake state can hit it is a hypothesis I
could not confirm.

**Why it matters in the real deployment:** an MCP author who renames a scope
field, ships a typo in `contextSchema`, or is mid-rollout turns every existing
grant on that MCP into no grant at all — silently, with the audit log stating
that no scope was ever declared. For any filesystem MCP less strict than this
one, that is an unconfined filesystem.

---

## F3: `relay audit --grep` does not match the caller, so the documented way to investigate one client returns "no matching tool calls"

**Severity:** medium
**Component:** relay

```
$ relay audit --help
  -grep string
    	substring match over tool, MCP, error, project / access profile, caller, args
```

It does not include the caller. `AuditQuery.matches` (audit.go:821) builds its
haystack from `ev.Tool, ev.McpID, ev.Error, ev.Actor.ProjectName, ev.Actor.Proc,
ev.Actor.Parent, ev.Args` — `Actor.ClientID`, which is what the CALLER column
renders, is not in it. `Proc`/`Parent` are the *local* caller fields and are
empty for every remote actor.

**Repro** — two records exist with `CALLER = ws4-ghost`:

```
$ relay audit --tail 200 --kind remote | grep ws4-ghost
07:48:55  pending     WS4 Relay  fsmcp  fs_read  0  ws4-ghost  {"file_path":"/d0/notes/todo.txt"}
07:48:55  ok          WS4 Relay  fsmcp  fs_read  6  ws4-ghost  {"file_path":"/d0/notes/todo.txt"}

$ relay audit --tail 200 --grep ws4-ghost
no matching tool calls

$ relay audit --tail 200 --grep "WS4 Relay" | grep ws4-ghost
07:48:55  pending     WS4 Relay  fsmcp  fs_read  0  ws4-ghost  {"file_path":"/d0/notes/todo.txt"}
07:48:55  ok          WS4 Relay  fsmcp  fs_read  6  ws4-ghost  {"file_path":"/d0/notes/todo.txt"}
```

The profile name matched; the client id never does. (`--grep ws4` appears to
work only because the *profile* is called "WS4 Relay".)

There is also no `--client-id` flag, and `--project` is 1:N by design — the docs
call several enrolments sharing one profile "the expected shape". So for the
recommended deployment there is **no way from the CLI to select one client's
calls**, and the filter that looks like it does silently answers "nothing
happened".

**Why it matters in the real deployment:** "which of my three agents read that
file" is the first question after an incident, and the answer the tool gives is
an empty result rather than an error.

---

## F4: Refusals that happen before dispatch are absent from the audit log entirely

**Severity:** medium
**Component:** relay

`relay audit` is named throughout the docs as the operator's ground truth. Two
classes of refusal never reach it.

**A revoked or unenrolled certificate.** Created `ws4-ghost`, kept a copy of its
bundle, revoked it, and used the retained certificate:

```
$ relay enrol revoke --client-id ws4-ghost
revoked enrolment "ws4-ghost"
  fingerprint: sha256:95c0554150e907640d5fc78f08e890164fdaa09eabe2e73ccaf5709bfd119d70

$ RELAY_REMOTE_BUNDLE=<retained copy> relayremote list
error: relay unreachable: … relay closed the connection without answering (EOF); this is also
what relay does when a client certificate is not enrolled or has been revoked …
list exit=8
```

The refusal is correct and the containment is right. The record is not:

```
$ relay audit --tail 200 --outcome unauthorized
no matching tool calls
$ relay audit --tail 200 --kind unknown
no matching tool calls
$ relay audit --tail 500 --grep ghost
no matching tool calls
```

Only `relay.log` has it, at WARN:

```
time=2026-08-26T07:48:55.543-07:00 level=WARN msg="remote: closing connection, certificate is not enrolled" fingerprint=sha256:95c05541… remote_addr=127.0.0.1:64290
```

**An oversized frame.** An 11 MiB `fs_write` is refused at the wire boundary:

```
$ relayremote call --tool fs_write --args-file arg_11.json
error: malformed request: message exceeds maximum size of 10485760 bytes
```

```
$ relay audit --tail 8 --kind remote      # nothing for it
$ tail relay.log
time=2026-08-26T08:02:47.519-07:00 level=WARN msg="remote: dropping connection, message exceeds size limit" max_bytes=10485760
```

Note the log line carries no client id, so even the WARN cannot be attributed.

**Why it matters in the real deployment:** a stolen credential being retried
after revocation, and a client hammering the listener, are exactly the events an
operator would set an alert on — and `relay audit --outcome unauthorized`, which
exists and is documented, is empty for both.

---

## F5: `fs_write`'s file content is copied verbatim into the audit log; and past 4 KiB the record no longer says which file was written

**Severity:** medium
**Component:** relay

`docs/audit-log.md` explains why *results* are not stored:

> Tool results carry file contents, mail bodies, and calendar entries; storing
> them by default would make this the most sensitive file on the machine.

Arguments are stored, with redaction keyed on credential-*like key names*
(`token`, `secret`, `password`, …). fsmcp's payload key is `content`, so file
contents go in raw. The stated rationale for not storing results argues equally
against storing these.

```
$ relayremote call --tool fs_write --args '{"file_path":"/d0/creds.txt","content":"AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\npatient MRN 4471: HIV+ ,  do not disclose"}'
Wrote 104 bytes to /d0/creds.txt

$ relay audit --tail 6 --kind remote
07:52:33  ok  WS4 Relay  fsmcp  fs_write  12  ws4  {"content":"AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\npatient MRN 4471: HIV+ , do not disclose","…

$ relay audit --tail 6 --kind remote --json | (args)
fs_write args_bytes= 147 truncated= None
   args= {"content": "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\npatient MRN 4471: HIV+ ,  do not disclose", "file_path": "/d0/creds.txt"}
```

The second half is worse. Over `max_arg_bytes` (4 KiB default) the args become a
**truncated string** rather than an object, and because keys serialise in sorted
order, `content` consumes the whole budget and `file_path` falls off the end:

```
$ relayremote call --tool fs_write --args-file bigarg.json     # 9000-byte content
Wrote 9000 bytes to /d0/bigarg.txt

$ relay audit --tail 4 --kind remote --json | (inspect)
fs_write args_bytes= 9043 truncated= True
args is a STRING of len 4096
  contains file_path? False
  tail: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
```

So for **every `fs_write` larger than ~4 KiB the audit log does not record which
file was written**, and `relay audit --grep <filename>` cannot find it.

**Why it matters in the real deployment:** the log is 0600 and rotated at ~160
MiB, so an agent writing into the granted folder is also silently mirroring up
to 4 KiB of every file it writes into a second on-disk copy the operator did not
ask for — and the writes big enough to actually matter are the ones whose target
path the log loses.

---

## F6: The result-volume budget cannot bound a single call — a 1024-byte cap allowed one call to draw 2.7 MB

**Severity:** medium
**Component:** relay (behaviour is deliberate; the operator-facing description is not)

`docs/access-profiles.md`: *"Exceeding either is refused with its own audit
outcome, `throttled`."* Volume is in fact charged **after** the call returns
(`router.go`: "Volume is charged after the fact because a result's size is not
knowable before the MCP answers"), so the call that exceeds the cap completes
and delivers its bytes; only the *next* one is refused. The overshoot is not
bounded by the budget at all — it is bounded by fsmcp's own 10 MiB per-file
limit (≈13.6 MiB as base64).

```
$ relay enrol create --client-id ws4-onecall --grant <WS4 Relay> --window-seconds 120 --max-calls 100000 --max-result-bytes 1024
  budget:      100000 calls / 1024 bytes per 120s

$ python3 -c "open('…/ws4/big.bin','wb').write(bytes(2*1024*1024))"

$ relayremote call --tool fs_read --args '{"file_path":"/d0/big.bin","encoding":"base64"}'
exit=0  bytes returned to the client: 2796204

$ relayremote call --tool fs_read --args '{"file_path":"/d0/data/inventory.csv"}'
error: throttled: enrolment "ws4-onecall" has drawn 2796269 of 1024 result bytes in the last 120s
```

**Ground truth:**

```
pending  result_bytes= None
ok       result_bytes= 2796269
throttled result_bytes= None  throttled: enrolment "ws4-onecall" has drawn 2796269 of 1024 result bytes in the last 120s
```

2,730× the cap, on the first call, recorded honestly as `ok`.

**Why it matters in the real deployment:** an operator who sets
`--max-result-bytes` low, reading the docs as "this enrolment cannot draw more
than N bytes per window", has actually set "this enrolment cannot draw more than
N bytes per window *plus one arbitrary file*". The budget is a sustained-drain
control only, and nothing says so.

---

## F7: An `allowed_dirs` entry containing `..` produces a half-working grant — reads succeed, `fs_list`/`fs_glob` redact every path, `fs_grep`/`fs_find` do not, all logged `ok`

**Severity:** medium
**Component:** fsmcp (relay passes the entry through unnormalised)

`…/ws4/notes/../../ws4` canonicalises to exactly `…/ws4` — the same directory
the working grant names. Relay injects the literal string; `assignLabels` stores
it as the label's `hostDir` verbatim, while `validatePath` canonicalises the
*file* path. Inbound concatenation therefore still resolves (the kernel applies
the `..`), but the outbound `hostToVirtual` prefix match fails, so results are
redacted instead of translated.

```
### grant = .../ws4/notes/../../ws4   (canonically exactly .../ws4)
$ relayremote call --tool fs_read --args '{"file_path":"/d0/notes/todo.txt"}'
1	TODO: fix the parser
2	TODO: ship the thing

$ relayremote call --tool fs_list --args '{"path":"/d0"}'
symlink	20	2026-08-26T14:33:17.633Z	[fsmcp: path outside the granted directories -- redacted]
directory	320	2026-08-26T14:33:17.627Z	[fsmcp: path outside the granted directories -- redacted]
directory	96	2026-08-26T14:33:17.598Z	[fsmcp: path outside the granted directories -- redacted]

$ relayremote call --tool fs_glob --args '{"pattern":"**/*.md"}'
[fsmcp: path outside the granted directories -- redacted]
[fsmcp: path outside the granted directories -- redacted]

$ relayremote call --tool fs_grep --args '{"pattern":"Budget"}'
/d0/notes/meeting.md

$ relayremote call --tool fs_find --args '{"pattern":"meeting"}'
/d0/notes/meeting.md
```

**Ground truth** — every one of these is a success:

```
$ relay audit --tail 6 --kind remote
08:06:16  ok  WS4 Relay  fsmcp  fs_glob  9   ws4  {"pattern":"**/*.md"}
08:06:16  ok  WS4 Relay  fsmcp  fs_grep  10  ws4  {"pattern":"Budget"}
08:06:16  ok  WS4 Relay  fsmcp  fs_find  11  ws4  {"pattern":"meeting"}
```

Four tools, one grant, one directory, and they disagree about whether a file is
inside it — two say "outside the granted directories", two return its path, and
none of them errors.

**Why it matters in the real deployment:** an operator who pastes a path with a
`..` in it (from a shell `cd`, a script variable, a `realpath` they didn't run)
gets a grant that reads fine but where the agent cannot discover a single
filename — and the audit log shows a clean run of successes, so nothing points
at the grant.

---

## F8: `fs_move` can move a granted root out of existence; `fs_delete` explicitly refuses the same thing

**Severity:** medium
**Component:** fsmcp

`fs_delete` has a root guard. `fs_move` does not, so a client with two roots can
relocate one of them into the other and the operator's directory ceases to exist
at the path they granted.

```
$ relayremote call --tool fs_delete --args '{"path":"/d1"}'
refusing to delete an allowed_dir root: /d1

$ ls -d …/fsmcp-review/ws4b ; find …/fsmcp-review/ws4b
…/fsmcp-review/ws4b
…/fsmcp-review/ws4b
…/fsmcp-review/ws4b/sub
…/fsmcp-review/ws4b/sub/other.txt

$ relayremote call --tool fs_move --args '{"source":"/d1","destination":"/d0/stolen_root"}'
Moved /d1 to /d0/stolen_root

$ ls -d …/fsmcp-review/ws4b
ls: …/fsmcp-review/ws4b: No such file or directory
$ find …/fsmcp-review/ws4/stolen_root
…/fsmcp-review/ws4/stolen_root
…/fsmcp-review/ws4/stolen_root/sub
…/fsmcp-review/ws4/stolen_root/sub/other.txt
```

**Ground truth:**

```
$ relay audit --tail 4 --grep "WS4 Relay"
07:39:55  ok  WS4 Relay  fsmcp  fs_move  6  ws4  {"destination":"/d0/stolen_root","source":"/d1"}
```

Bytes stay inside the union of the grant, so this is not an escape. What it
destroys is the grant itself: `/d1` now resolves to a path that does not exist,
and every subsequent call on that label answers `directory not found: /d1` with
no indication that the client did it.

The same works with a single root granted as a *file*:

```
$ relayremote call --tool fs_move --args '{"source":"/d1","destination":"/d0/moved.txt"}'
Moved /d1 to /d0/moved.txt
```

**Why it matters in the real deployment:** grant `~/Documents/ProjectA` and
`~/Documents/ProjectB` to one agent — the plainly reasonable two-folder grant —
and one `fs_move` relocates ProjectB inside ProjectA. Nothing that references
ProjectB by path (git, an editor, a backup, Finder) works afterwards, and the
audit says `ok`. Adjacent to fsmcp #23 but a different mechanism; #23's repairs
do not cover a root as the *source*.

---

## F9: A dead MCP is invisible everywhere an operator would look, and the tool list still advertises it

**Severity:** low (the outage half is already filed as relay #39; this is the visibility half)
**Component:** relay

Confirming and extending #39. Killing the fsmcp child once takes down every
grant that names it, permanently:

```
$ pkill -f "fsmcp/dist/main.js"
$ for i in $(seq 1 25); do relayremote call --tool fs_read --args '{"file_path":"/d0/notes/todo.txt"}' | head -1; done
try1..try25: error: relay error: external MCP call failed: read response: EOF
$ pgrep -f "fsmcp/dist/main.js" | wc -l
       0
```

What an operator can see, minutes later, with the process still dead:

- **`relay.log`: nothing.** "MCP connected" is logged; the child exiting is not.
  `tail -20 relay.log` after the kill is empty of any MCP line.
- **Tray icon and tray menu: nothing.** The menu is `Settings…` / `Exit`, no
  status, no badge.
- **Settings → MCP Servers: still shows `fsMCP … 10 tools`,** with no error
  state, while every call fails.
- **`relayremote list`: still advertises all 10 tools** to the client.
- Only `relay audit` shows it, as a stream of `error` rows whose DETAIL reads
  `external MCP call failed: read response: EOF` — which reads like a transient
  hiccup, not a permanent outage.

**The inbound direction is safe**, which was the open question. An oversized
`fs_write` is refused at relay's wire boundary and the MCP is untouched:

```
$ relayremote call --tool fs_write --args-file arg_8.json     # 8 MiB
Wrote 8388608 bytes to /d0/inbound_8.txt        ← succeeds, MCP alive
$ relayremote call --tool fs_write --args-file arg_11.json    # 11 MiB
error: malformed request: message exceeds maximum size of 10485760 bytes
   on disk: (no file)     fsmcp alive: 1     follow-up small call: 1	TODO: fix the parser
$ relayremote call --tool fs_write --args-file arg_16.json    # 16 MiB
error: relay unreachable: … write: broken pipe
   on disk: (no file)     fsmcp alive: 1     follow-up small call: 1	TODO: fix the parser
```

So the 10 MiB frame cap only tears down the child on the **outbound** (child
stdout) path. Inbound is bounded at the listener and fails the client, not the
server.

**Why it matters in the real deployment:** an agent that says "the filesystem
isn't responding" and a host whose Settings pane says "fsMCP, 10 tools" is a
support call that goes nowhere. Whatever #39 does about respawning, the dead
state needs to be visible.

---

## F10: `/` as a resource scope is indistinguishable from a narrow one on every surface

**Severity:** low
**Component:** relay (Settings UI + the client-facing scope note)

The Settings UI is otherwise unusually honest about layer 5 — the editor says
*"An empty value is not 'no restriction' — it refuses every tool the field
governs. There is no wildcard: to allow everything, list everything"*, and shows
a live red *"No value: every tool this field governs is denied at call time."*

But for a filesystem MCP `/` **is** the wildcard, and nothing treats it
differently. Authored entirely through the UI (Access profile → grant fsMCP →
tools `fs_*` → `allowed_dirs` = `/` → Create), with no warning at any point:

```
{"name": "WS4-UIProbe", "kind": "remote", "allowed_mcp_ids": ["fsmcp"],
 "context": {"fsmcp": {"allowed_dirs": ["/"]}}, "allowed_tools": {"fsmcp": ["fs_*"]}}
```

The profile card in the list renders it as one short line, formatted exactly
like every other profile:

```
WS4-UIProbe  ACCESS PROFILE
fsmcp  READ  LOCAL ONLY  fs_*  allowed_dirs: /
```

And the check `docs/access-profiles.md` tells the operator to run first — *"What
can it see? `relayremote list`"* — reports the grant as **confining**:

```
$ relayremote list --schema | grep -o 'Scope: [^"]*' | head -1
Scope: Directories this client may read, search and modify within — confined to 1 value.
```

The client is correspondingly unconfined:

```
$ relayremote call --tool fs_read --args '{"file_path":"/d0/etc/passwd"}'
  1	##
  2	# User Database

$ relayremote call --tool fs_read --args '{"file_path":"/d0/Users/admin/source/barelyworkingcode/outside_secret/secret.txt"}'
1	SECRET-CANARY-9d3f1a2b: this must never be read by the agent

$ relayremote call --tool fs_read --args '{"file_path":"/d0/Users/admin/source/barelyworkingcode/testfolder_sibling_canary.txt"}'
1	SIBLING-CANARY-7c2e: not granted
```

To relay's credit, `relay audit --authority` is truthful about it —
`scope=allowed_dirs=["/"]` on every record — so ground truth is intact. It is
the two *authoring and verification* surfaces that are not.

**Why it matters in the real deployment:** `/` is one keystroke, it is what a
tired operator types to "just make it work for now", and the confirmation loop
the docs prescribe (`relayremote list`) answers "confined". `disclose: "count"`
is the right call for the agent; it is the wrong answer for the operator running
the verification step.

---

## Verified working

Everything below was exercised end to end and behaved correctly. This list is
the point of the exercise as much as the findings are.

**Layer 3 — read/write split.** A profile with `access: {fsmcp: "read"}` admits
*exactly* the five `readOnlyHint: true` tools and refuses the other five, in
both `tools/list` and at call time, with relay's own layer-naming message:

```
$ relayremote list        # access: read
FILE SYSTEM (5)
  fs_find  fs_glob  fs_grep  fs_list  fs_read
$ relayremote call --tool fs_write …
error: access denied: tool 'fs_write' is not annotated read-only and this grant is read-only for MCP 'fsmcp'
```
…and the same sentence for `fs_edit`, `fs_delete`, `fs_mkdir`, `fs_move`. Audit
outcome `denied` on all five, `authority: access=read outbound=blocked scope=…`
on every row, and `ls` confirms nothing on disk changed. Annotations read off
the live wire agree exactly: `fs_find/glob/grep/list/read` are
`readOnlyHint: true`, the other five `false`, and **all ten** carry
`openWorldHint: false` — no fsmcp tool is unannotated.

**Layer 3 defaults.** `access` key removed entirely → 5 tools (defaults to
`read` for a profile, as documented). `access: "readwrite"` (a plausible
hand-edit typo) → 5 tools; anything that is not exactly `write` narrows.

**Layer 2 — `allowed_tools`.** Every shape fails in the safe direction, and
`relayremote list` always matched what was callable:

| value | tools listed | fs_read | fs_write |
|---|---|---|---|
| `["fs_read"]` | 1 | ok | denied |
| `["fs_read","fs_write"]` | 2 | ok | ok |
| `["fs_re*"]` | 1 | ok | denied |
| `["fs_*"]` | 10 | ok | ok |
| `[]` | 0 | denied | denied |
| key removed | 0 | denied | denied |
| `["fs_teleport"]` (no such tool) | 0 | denied | denied |
| `["s_read"]` (substring of `fs_read`) | 0 | denied | denied |
| `["*"]` | 0 | denied | denied |
| `["**"]` | 0 | denied | denied |
| `["*_*"]` | 0 | denied | denied |
| `["[a-z]*"]` | 0 | denied | denied |
| `["*e*"]` | 0 | denied | denied |

Anchoring holds (`s_read` matches nothing), and the shape-pattern refusal is
enforced by the *matcher*, not just by UI validation — hand-writing `*` or `**`
straight into settings.json yields zero tools, not all of them.

**Layer 5 — resource scope presence.** Every one of these produced
`access denied: MCP 'fsmcp' scopes tool 'fs_read' by "allowed_dirs" and this
grant supplies no value for it`, outcome `denied`, before fsmcp was reached:
`context.fsmcp = {}`, `context = {}`, `allowed_dirs = []`. Empty never read as
"everything". The tool's own description says why, in the client's own view:
*"…no value is set for \"allowed_dirs\", so every call to this tool is
refused."*

**Layer 5 — odd values.** All contained:

| grant | result |
|---|---|
| nonexistent path as `/d1` | `directory not found: /d1`; `/d0` unaffected; `fs_glob` did not error |
| a **file** as `/d1` | readable/writable as `/d1` (and also as `/d0/notes/todo.txt`); `fs_delete /d1` refused as a root |
| a **symlink to ws4** as `/d1` | resolves; same tree addressable two ways; results render as `/d0` |
| **relative** path | fails closed — `path must be absolute`, `none of the allowed directories exist` |
| **trailing slash** | works, single label, no duplicate |
| **duplicate identical** entries | two labels, same directory, results render `/d0`; harmless |
| **duplicate differing only by trailing slash** | same — `stripTrailingSep` means one directory is not stored two ways |
| **nested** (`ws4` and `ws4/notes`) | most-specific label wins (`/d0/notes` renders as `/d1`); the same file is addressable both ways and both work; `fs_find` returns it twice |
| `label=/abs/path` | works: `/docs`, `/work`; `/d0` correctly rejected with `path is not a valid address: … (/docs, /work)` |

**Layer 5 — label collisions fail closed on the whole call**, both shapes,
exactly as documented:

```
# two entries with the SAME explicit label
fsmcp: this server's configuration is ambiguous -- the label "docs" is claimed by two different
allowed directories, so an address beginning "/docs/" does not identify one file. Refusing every
call rather than silently resolving it to one of them. …

# an explicit label colliding with another entry's auto-assigned d<N>
… the label "d1" is claimed by two different allowed directories …
… the label "d0" is claimed by two different allowed directories …
```

Every tool refused, not just the ambiguous path; audited as `tool_error` (not
`scope_violation`, correctly — it is a misconfiguration, not a boundary probe).

**Layer 4 — `allow_external`.** `false`, unset, and `true` all yield all 10
tools, because every fsmcp tool is explicitly `openWorldHint: false` — the
fail-closed default costs this MCP nothing. The documented trap reproduces
exactly on a shim with annotations stripped:

| unannotated MCP | tools |
|---|---|
| `access: write`, `allow_external: false` | **0** |
| `access: write`, `allow_external: true` | 10 |
| `access: read`, `allow_external: true` | **0** |

Both layers fail closed on a missing annotation, in opposite directions, as
`readOnlyHintTrue` / `toolIsOpenWorld` intend.

**Runtime grant changes — no restart, no stale cache.** Driven over a single
persistent `relayremote serve` session, editing `settings.json` between calls:

```
[A] write / fs_* / 2 dirs   → 10 tools; fs_read ok; fs_list /d1 ok
[B] drop ws4b               → fs_list /d1 → "path is not a valid address: … (/d0)"; /d0 still ok
[C] allowed_tools=[fs_read] → tools: ['fs_read']; fs_list → denied; fs_read ok
[D] fs_* + access=read      → 5 tools; fs_write → denied (layer 3); fs_read ok
[E] access=write            → fs_write → ok, same connection
```

Narrowing and widening both took effect on the very next call, and `tools/list`
re-rendered each time.

**Revocation cuts a live session.** Mid-session `relay enrol revoke` on the
connection's own certificate:

```
fs_read (pre-revoke)  → ok
REVOKE → revoked enrolment "ws4-live"
fs_read (post-revoke, SAME live session) → access denied: this certificate is no longer enrolled
tools/list (post-revoke)                 → access denied: this certificate is no longer enrolled
```

A retained copy of a revoked certificate is refused at the TLS layer on a fresh
process (see F4 for the audit gap).

**Budgets.** Both caps fire, `throttled` is distinct from `denied`, and a
throttled call does not reach the disk:

```
$ relay enrol create --client-id ws4-budget … --window-seconds 60 --max-calls 5 --max-result-bytes 1024
call 1..5: exit=0 :: Wrote 2 bytes to /d0/budget_N.txt
call 6:    exit=4 :: error: throttled: enrolment "ws4-budget" has used 5 of 5 calls in the last 60s
call 7:    exit=4 :: (same)
$ ls …/ws4/budget_*.txt
budget_1.txt budget_2.txt budget_3.txt budget_4.txt budget_5.txt      # 6 and 7 never touched disk
```

Byte cap, separately: 11 reads × 99 bytes = 1089, and the 12th is refused —
`throttled: enrolment "ws4-bytes" has drawn 1089 of 1024 result bytes in the
last 120s`. Throttled records carry the full reason, the authority line, and no
`pending` intent record (nothing was dispatched). See F6 for the single-call
overshoot.

**Audit outcome matrix.** One of each, all correct:

```
07:51:50  ok          WS4 Relay  fsmcp  fs_read      9  ws4  {"file_path":"/d0/notes/todo.txt"}
07:51:50  tool_error  WS4 Relay  fsmcp  fs_read      6  ws4  {"file_path":"/d0/no_such_file.txt"}
07:51:50  tool_error  WS4 Relay  fsmcp  fs_read      5  ws4  scope_violation: true  {"file_path":"/d0/passwd_link"}
07:51:50  tool_error  WS4 Relay  fsmcp  fs_read      5  ws4  scope_violation: true  {"file_path":"/etc/passwd"}
07:51:50  error       WS4 Relay  -      fs_teleport  0  ws4  unknown tool: fs_teleport
07:49:59  throttled   WS4 Relay  fsmcp  fs_write     0  ws4-budget  throttled: enrolment "ws4-budget" has used 5 of 5 calls in the last 60s
07:37:46  denied      WS4 Relay  fsmcp  fs_write     0  ws4  access denied: tool 'fs_write' is not annotated read-only and this grant is read-only for MCP 'fsmcp'
```

The `scope_violation` marker is set for a symlink escape **and** for a raw
host-path probe, and is *not* set for an ordinary missing-file `tool_error` —
verified in the JSON, not just the table:

```
ok         scope_violation=None  result_is_error=None
tool_error scope_violation=None  result_is_error=True     # file not found
tool_error scope_violation=True  result_is_error=True     # /d0/passwd_link
tool_error scope_violation=True  result_is_error=True     # /etc/passwd
error      scope_violation=None                           error='unknown tool: fs_teleport'
```

Tool name, project, caller, MCP id and `authority: access=… outbound=… scope=…`
were correct on every record I checked, including on `denied` and `throttled`
rows where no MCP ran.

**One documented limitation worth stating, not a finding:** a `tool_error`
record carries `result_is_error: true` and `result_bytes` but **no error text**,
in the table or the JSON, because results are deliberately not stored. So a
duplicate-label misconfiguration, a missing file, and a non-UTF-8 refusal all
appear as the same row. That is `docs/audit-log.md`'s stated design
(`max_result_preview_bytes: 0`), and the only way to get the reason is to turn
on a preview that would also capture file contents.

**Also not a finding, for the record:** `relayremote list` / `list_tools` events
are not audited at all by default (`log_lists: false`), so "what tool surface
was this credential shown" is unanswerable unless an operator turns it on. This
is documented and defended in `docs/audit-log.md`.

---

## Configuration restored

Backed up before the first edit:

```
$ shasum <backup of settings.json taken before any change>
fe3cc923c3fe3f2edfcb9beca7f976375878cde8  settings.json.BACKUP
```

Final state, diffed object by object against that backup:

```
  SAME  profile Hermes Mail
  SAME  profile Hermes Files
  SAME  profile Hermes Files (read-only)
  SAME  profile WS1 Corruption
  SAME  profile WS2 Containment
  SAME  profile WS3 Leak
  SAME  enrolment hermes
  SAME  enrolment hermes-files
  SAME  enrolment hermes-files-ro
  SAME  enrolment ws1
  SAME  enrolment ws2
  SAME  enrolment ws3
  external_mcps identical: True
  admin_secret identical: True
  remote block identical: True
  services identical: True
  WS4 Relay identical to backup: True
ALL PROTECTED OBJECTS UNCHANGED: True
```

Every WS4- object I created is gone:

```
$ (settings.json)
mcps:        ['macmcp', 'fsmcp']
projects:    ['Hermes Mail', 'Hermes Files', 'Hermes Files (read-only)', 'WS1 Corruption',
              'WS2 Containment', 'WS3 Leak', 'WS4 Relay', 'TCC Probe', 'Symlinked Root']
enrolments:  ['hermes', 'hermes-files', 'hermes-files-ro', 'ws1', 'ws2', 'ws3',
              'tccprobe', 'symroot', 'ws4']
```

(`TCC Probe` / `Symlinked Root` / `tccprobe` / `symroot` are another reviewer's
and were present before I finished; I did not touch them.)

The two shim MCPs (`fsmcp2`, `fsmcp-bare`, `fsmcp-noschema`) are unregistered
and their processes gone; their scripts live only in my scratch directory. The
`ws4_link_ws4` symlink I created in `fsmcp-review/` is removed.

**One thing I could not restore exactly, stated plainly.** My first
live-session test driver escaped into the background and ran its final step,
`relay enrol revoke --client-id ws4`, against my own enrolment. Revocation
deletes the bundle and the private key, so the certificate could not be put
back. I re-created the enrolment with the identical grant and the identical
budget:

```
$ relay enrol create --client-id ws4 --grant 91238ace-… --window-seconds 3600 --max-calls 200000 --max-result-bytes 4294967296
```

The only two fields that differ from the backup are the ones a new certificate
necessarily changes:

```
  ws4 enrolment identical to backup: False
     field created_at   old 2026-08-26T14:33:32Z  new 2026-08-26T14:48:46Z
     field fingerprint  old sha256:a00a1b5ff834…  new sha256:467f13e7e6fe…
```

Grant, budget, window and client id are unchanged, and the bundle at
`enrolments/ws4` works. No other enrolment was affected — the second, logged
attempt shows `ws4` was already gone by then
(`error: no enrolment found with client id "ws4"`), which is how I traced it to
my own driver rather than to relay.

**Workspace.** `manifest.sh ws4` differs from `baseline.manifest` only in the
four entries that are per-workspace by construction — `data/random.bin` (random
per fixture), `projects/beta/selfref.conf` (contains its own workspace path),
and the two symlinks that this build wrote as absolute rather than relative.
Every other hash matches, including `notes/todo.txt`, which I overwrote and
restored byte-for-byte during the file-as-a-root test. `ws4b` is intact
(`ws4b/sub/other.txt`) after the F8 root-move test. Files I created
(`budget_*.txt`, `live_probe.txt`, `tools_probe.txt`, `creds.txt`,
`bigarg.txt`, `big.bin`, `inbound_*.txt`, `x.txt`) are all removed.

**Health check after restore:**

```
$ relayremote list | tail -1
10 tools in 1 category · relay 127.0.0.1:9910 · enrolment ws4 (relay's default grant)
$ relayremote call --tool fs_read --args '{"file_path":"/d0/notes/todo.txt"}'
1	TODO: fix the parser
2	TODO: ship the thing
$ pgrep -f "fsmcp/dist/main.js" | wc -l
       1
```
