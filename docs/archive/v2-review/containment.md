# fsMCP review — containment lens (client `ws2`, grant `/d0` = `<host>/fsmcp-review/ws2`)

Scope of this review: can the client read, write, create, move, or delete
anything outside the granted tree, or learn that something outside exists.
Everything below was run end to end through `relayremote --> relay --> fsmcp`
with the `ws2` enrolment. Ground truth for every attempt is `relay audit` plus
the host disk, not the tool's own reply.

Environment used for every repro:

    export RELAY_REMOTE_ADDR=127.0.0.1:9910
    export RELAY_REMOTE_BUNDLE="$HOME/Library/Application Support/relay/enrolments/ws2"
    RELAY=/Applications/Relay.app/Contents/MacOS/relay

Both canaries survived every attempt (verified after each battery):

    SECRET-CANARY-9d3f1a2b   4ec676050b83b5aaca4ca5fab9a915e9871f62e6a2c82403d74cfb7c31ba9748  outside_secret/secret.txt
    SIBLING-CANARY-7c2e      199e62588a2544cd117158b52f1646b1384ca7bebb393b8bdc4565d63a5f855c  testfolder_sibling_canary.txt
    /etc/passwd              5676bbb620dfd6c54c49e86831ea2577aa8d9cbc7e6ad5ea1f6848e9bc4f69fa  (unchanged)

Neither canary string ever reached the client.

---

## F1: fs_write to the grant root writes the caller's bytes into the grant's PARENT directory

**Severity:** critical
**Component:** fsmcp

`fs_write` with `file_path` naming the granted root itself (`/d0`, or anything
that canonicalizes onto it) passes the containment check — a root is inside
itself — and then hands that path to `writeFileAtomic`, which derives its temp
file from `path.dirname(filePath)`. For the root, `dirname` is the directory
*above* the grant. The caller's full payload is written there, on disk, before
the `rename` fails.

fsmcp says so itself, in its own error text:

    $ relayremote call --tool fs_write --args '{"file_path":"/d0","content":"X"}' --json --quiet
    {"content":[{"type":"text","text":"EISDIR: illegal operation on a directory, rename '[fsmcp: path outside the granted directories -- redacted]' -> '/d0'"}],"isError":true}

    $ relayremote call --tool fs_write --args '{"file_path":"/d0/notes/..","content":"X"}' --json --quiet
    {"content":[{"type":"text","text":"EISDIR: illegal operation on a directory, rename '[fsmcp: path outside the granted directories -- redacted]' -> '/d0'"}],"isError":true}

`[fsmcp: path outside the granted directories -- redacted]` is `vpath.ts`'s
`REDACTED_PATH`, emitted when `hostToVirtual` cannot map a path under any
granted label. The source of the rename — the temp file fsmcp had just
finished writing — is outside the grant.

**Ground truth (disk).** A poller watching the grant's parent directory while a
5 MB `fs_write` to `/d0` ran, caught the file:

    # watcher: poll <host>/fsmcp-review/ for names starting ".ws2.fsmcp-tmp-"
    $ relayremote call --tool fs_write --args-file big.args.json --json --quiet
    {"content":[{"type":"text","text":"EISDIR: illegal operation on a directory, rename '[fsmcp: path outside the granted directories -- redacted]' -> '/d0'"}],"isError":true}

    CAUGHT OUTSIDE THE GRANT: ('.ws2.fsmcp-tmp-ba07f60e189b', 0,       b'CANARY-OUTSIDE-WRITE-ws2 CANARY-OUTSIDE-')
    CAUGHT OUTSIDE THE GRANT: ('.ws2.fsmcp-tmp-ba07f60e189b', 5000000, b'CANARY-OUTSIDE-WRITE-ws2 CANARY-OUTSIDE-')

i.e. `/Users/admin/source/barelyworkingcode/fsmcp-review/.ws2.fsmcp-tmp-ba07f60e189b`
— five million bytes of caller-chosen content, in a directory the client was
never granted. Reproduced 3/3 on a repeat run (`.ws2.fsmcp-tmp-b3808ac923ae`,
`.ws2.fsmcp-tmp-a0da6f3e7908`, `.ws2.fsmcp-tmp-806e4dcbbd4e`).

**Ground truth (audit).** Relay records this as an ordinary tool error, with no
scope violation at all:

    07:48:28  tool_error  WS2 Containment  fsmcp  fs_write  25  ws2  "{\"content\":\"CANARY-OUTSIDE-WRITE-ws2 ...

An operator reading the audit log sees "the tool broke", never "the sandbox was
crossed" — the exact distinction `_meta.scope_violation` exists to make.

**Mechanism** (`src/tools/write.ts` + `src/atomicWrite.ts`):

    const resolvedPath = canonicalizePath(filePath) ?? filePath;   // == the granted root
    const dir = path.dirname(resolvedPath);                        // == the PARENT of the grant
    fs.mkdirSync(dir, { recursive: true });                        // outside the grant
    ...
    const tmpPath = path.join(dir, `.${path.basename(filePath)}.fsmcp-tmp-${rand}`);
    fs.writeFileSync(tmpPath, data, ...);                          // outside the grant
    fs.renameSync(tmpPath, filePath);                              // EISDIR

`checkPathV` validated `filePath`. Nothing validated `path.dirname(filePath)`,
which is the path actually written. The `mkdirSync(dir, {recursive:true})` on
the line above is the same defect with a directory: it is a no-op here only
because the parent happens to exist.

In the happy path the temp file is removed by the `catch` in `writeFileAtomic`,
so the write is transient — but it is a best-effort `unlinkSync` inside an
exception handler. Anything that stops the process between `writeFileSync` and
`unlinkSync` (the fsmcp child being killed, which this stack has already been
observed to do under load) leaves a dot-prefixed, caller-controlled,
multi-megabyte file sitting permanently outside the grant.

**Why it matters in the real deployment:** the operator's promise is "this agent
can write inside this one folder." A single ordinary-looking call — `fs_write`
addressed at the folder itself, which an agent will do by mistake — puts the
agent's bytes in the folder's parent instead. If the operator granted
`~/Documents/ClientA`, the bytes land in `~/Documents`. The audit log shows
nothing but a generic error.

---

## F2: fs_glob's `pattern` is an unvalidated host path — it walks outside the grant, and confirms host paths

**Severity:** high
**Component:** fsmcp

Every path *argument* in fsmcp goes through `decodeInboundPath` and
`checkPathV`. `fs_glob`'s `pattern` does not — it is handed straight to
`globSync(pattern, { cwd: dir, absolute: true })`, and an absolute glob pattern
ignores `cwd` entirely. Matches that resolve outside the grant are filtered out
of the *output* (that part works), but the walk happens, and whether the result
is empty or not is a signal.

**(a) It is a working host-path oracle — the thing issue #7 exists to close.**

    $ relayremote call --tool fs_glob --args '{"pattern":"/Users/admin/source/barelyworkingcode/fsmcp-review/ws2/notes/*"}' --json --quiet
    {"content":[{"type":"text","text":"/d0/notes/todo.txt\n/d0/notes/meeting.md"}]}      <-- correct guess

    $ relayremote call --tool fs_glob --args '{"pattern":"/Users/admin/source/barelyworkingcode/fsmcp-review/ws1/notes/*"}' --json --quiet
    {"content":[{"type":"text","text":""}]}                                              <-- wrong guess

    $ relayremote call --tool fs_glob --args '{"pattern":"/home/admin/fsmcp-review/ws2/notes/*"}' --json --quiet
    {"content":[{"type":"text","text":""}]}                                              <-- wrong guess

Wildcards and character classes turn that into a search rather than a guess, so
the host path can be reconstructed component by component and character by
character:

    /Users/admin/source/barelyworkingcode/fsmcp-review/ws?/notes/todo.txt      -> /d0/notes/todo.txt
    /Users/admin/source/barelyworkingcode/fsmcp-review/w[s]2/notes/todo.txt    -> /d0/notes/todo.txt
    /Users/admin/source/barelyworkingcode/fsmcp-review/w[a-r]2/notes/todo.txt  -> ""
    /Users/admin/source/barelyworkingcode/fsmcp-rev*/ws2/notes/todo.txt        -> /d0/notes/todo.txt
    /Users/admin/source/barelyworkingcode/fsmcp-rex*/ws2/notes/todo.txt        -> ""
    /Users/admin/source/*/fsmcp-review/ws2/notes/todo.txt                      -> /d0/notes/todo.txt
    /*/admin/source/barelyworkingcode/fsmcp-review/ws2/notes/todo.txt          -> /d0/notes/todo.txt

The `path` argument — which *is* validated — does not bound the pattern:

    $ relayremote call --tool fs_glob --args '{"path":"/d0/notes","pattern":"/Users/admin/source/barelyworkingcode/fsmcp-review/ws2/data/*.csv"}' --json --quiet
    {"content":[{"type":"text","text":"/d0/data/inventory.csv"}]}

**(b) It really walks the host filesystem outside the grant.** Timed through
relay, three runs each:

    41ms   /Users/admin/source/barelyworkingcode/macMCP/**/*
    42ms   /Users/admin/source/barelyworkingcode/macMCPZZZ/**/*     (does not exist)
    18399ms  /System/Library/**/*

Reproduced against the same `glob` call fsmcp makes, showing what is being
enumerated and then discarded:

    $ node -e 'const {globSync}=require("glob"); ... '
    3ms 89 /Users/admin/source/barelyworkingcode/macMCP/**/*
    0ms 0 /Users/admin/source/barelyworkingcode/nosuchdir/**/*
    1ms 56 /etc/*
    5715ms 298961 /System/Library/**/*

**(c) It is head-of-line blocking on a process shared by every grant.** There is
one fsmcp child for all projects:

    $ ps aux | grep 'fsmcp/dist/main.js'
    40218 /opt/homebrew/bin/node /Users/admin/source/barelyworkingcode/fsmcp/dist/main.js

With a `/System/Library/**/*` glob in flight from `ws2`, a trivial `fs_read`
took 16.2 seconds:

    trivial fs_read during big glob: 16251ms -> {"content":[{"type":"text","text":"1  DONE: fix the parser
    trivial fs_read during big glob: 32ms
    trivial fs_read during big glob: 25ms

(A pattern rooted at `/` would be far worse — 298,961 paths were materialised
for `/System/Library` alone — but I did not run it, to avoid taking the shared
process down for the other reviewers. That extrapolation is inference, not a
measured result.)

**(d) A scope-violating pattern comes back as an empty SUCCESS, not a refusal.**

    $ relayremote call --tool fs_glob --args '{"pattern":"/etc/*"}' --json --quiet
    {"content":[{"type":"text","text":""}]}
    $ relayremote call --tool fs_glob --args '{"pattern":"../*"}' --json --quiet
    {"content":[{"type":"text","text":""}]}
    $ relayremote call --tool fs_glob --args '{"pattern":"/Users/admin/source/barelyworkingcode/outside_secret/*"}' --json --quiet
    {"content":[{"type":"text","text":""}]}

Audit ground truth for those three:

    07:51:07  ok  WS2 Containment  fsmcp  fs_glob  7  ws2  {"pattern":"/etc/*"}
    07:51:07  ok  WS2 Containment  fsmcp  fs_glob  5  ws2  {"pattern":"../*"}
    07:51:07  ok  WS2 Containment  fsmcp  fs_glob  4  ws2  {"pattern":"/Users/admin/source/barelyworkingcode/outside_secret/*"}

`ok`, no `scope_violation`. `fs_glob` is the only path-governed tool in the set
where naming somewhere out of scope produces an empty success instead of an
error. Every other tool refuses (see Verified working).

**Ground truth:** no name or byte from outside the grant was ever emitted — the
`validatePath` re-check on every hit does hold, so this is disclosure of *host
layout* and a resource channel, not of content. `outside_secret/` and
`ws2extra/` were never listed.

**Why it matters in the real deployment:** the whole point of the `/d0` virtual
path space is that a remote agent cannot learn where on the operator's disk its
folder lives. A dozen `fs_glob` calls recover it exactly. Separately, a single
`fs_glob` call from the least-privileged grant relay can issue (`fs_glob` is
`readOnlyHint: true`) can stall every other grant's tool calls for as long as it
takes to walk a directory tree the caller has no rights to.

---

## F3: an ordinary fs_glob can return fsmcp's internal "this is a bug" placeholder as a result line

**Severity:** medium
**Component:** fsmcp

This host has `/Users/runner -> /Users/admin` (a plain symlink, the shape a CI
image or a migrated home directory leaves behind). A glob whose pattern reaches
the grant through that alias produces four result lines for two files:

    $ relayremote call --tool fs_glob --args '{"pattern":"/Users/*/source/barelyworkingcode/fsmcp-review/ws2/notes/*"}' --json --quiet
    {"content":[{"type":"text","text":"[fsmcp: path outside the granted directories -- redacted]\n/d0/notes/todo.txt\n[fsmcp: path outside the granted directories -- redacted]\n/d0/notes/meeting.md"}]}

    $ relayremote call --tool fs_glob --args '{"path":"/d0/notes","pattern":"/Users/*/source/barelyworkingcode/fsmcp-review/ws2/data/inventory.csv"}' --json --quiet
    {"content":[{"type":"text","text":"[fsmcp: path outside the granted directories -- redacted]\n/d0/data/inventory.csv"}]}

The underlying host paths are `/Users/runner/.../notes/todo.txt` and
`/Users/admin/.../notes/todo.txt` — the same two files, twice. `validatePath`
canonicalizes and accepts both; `hostToVirtual` does a literal prefix match
against the label's host directory and cannot map the `runner` spelling, so it
emits `REDACTED_PATH`.

**Ground truth:** the two checks disagree by construction — one resolves
symlinks, the other compares strings. `vpath.ts` documents this branch as
"unreachable in practice… treating the unreachable case as the bug it would
be"; it is reachable from an ordinary call on an ordinary macOS host. Verified
against the same `glob` call directly:

    ['/Users/runner/source/.../ws2/notes/todo.txt',
     '/Users/runner/source/.../ws2/notes/meeting.md',
     '/Users/admin/source/.../ws2/notes/todo.txt',
     '/Users/admin/source/.../ws2/notes/meeting.md']

**Why it matters in the real deployment:** the redaction placeholder is fsmcp's
alarm for "a path escaped the check." Firing it on a correct, contained call
trains an operator (and an agent) to ignore it, and hands the client a result
that misstates its own scope — duplicate entries, half of them unnamed. It is
also a weak side channel: the line only appears when a second host path to the
grant exists.

---

## F4: a `..` that leaves the grant and lands back inside is accepted, and confirms directory names above the grant

**Severity:** low
**Component:** fsmcp

This is the documented, required behaviour (`..` is applied to the resolved
path, so a path that transits outside and comes back is legal), and it is the
correct security answer. It is worth naming because it is also a small oracle
that survives any fix to F2:

    /d0/../ws2/notes/todo.txt        -> 1  TODO: fix the parser ...        (ok)
    /d0/../WS2/notes/todo.txt        -> path ... is outside allowed directories
    /d0/../ws2extra/leak.txt         -> path ... is outside allowed directories
    /d0/../outside_secret/secret.txt -> path ... is outside allowed directories

and, through a symlink that leaves the grant:

    $ relayremote call --tool fs_read --args '{"file_path":"/d0/parent_link/../fsmcp-review/ws2/notes/todo.txt"}' --json --quiet
    {"content":[{"type":"text","text":"1\tTODO: fix the parser\n2\tTODO: ship the thing\n3\t"}]}

    $ relayremote call --tool fs_read --args '{"file_path":"/d0/parent_link/../../etc/passwd"}' --json --quiet
    {"content":[{"type":"text","text":"path /d0/parent_link/../../etc/passwd is outside allowed directories"}],"isError":true,"_meta":{"scope_violation":true}}

The second call proves the sandbox holds. The first proves the client can
confirm that the directory containing `parent_link`'s target also contains
`fsmcp-review/ws2` — i.e. it can test guesses about the layout above its grant,
one accepted/refused answer at a time. No content outside is readable this way.

**Why it matters in the real deployment:** nothing leaks by itself, but any
"the client never sees a host path" claim should be stated as "the client is
never *handed* a host path", because it can still test one.

---

## Verified working

Everything below was run through the real stack and behaved correctly. Unless
noted, "refused" means an `isError` result carrying `_meta.scope_violation:
true`, and relay's audit recorded `tool_error ... scope_violation: true`.

**Traversal, on every tool that takes a path** (`fs_read`, `fs_list`, `fs_glob`,
`fs_grep`, `fs_find`, `fs_write`, `fs_edit`, `fs_mkdir`, `fs_move`, `fs_delete`):

- `..` in every position and at every depth: `/d0/..`, `/d0/../..`,
  `/d0/../../..`, `/d0/notes/../..`, `/d0/../outside_secret/secret.txt`,
  `/d0/nonexistentdir/../../escape.txt`, `/d0/notes/todo.txt/../../../escape.txt`
  — all refused.
- `..` that lands back inside SUCCEEDS as required: `/d0/notes/../notes/todo.txt`,
  `/d0/notes/../notes/./../notes/todo.txt`,
  `/d0/deep/a/b/c/d/../../../../a/b/c/d/buried.txt`.
- Encoded/doubled forms are treated as literal filenames, not traversal:
  `/d0/....//outside_secret/secret.txt`, `/d0/..%2foutside_secret%2fsecret.txt`,
  `/d0/%2e%2e/outside_secret/secret.txt` all resolve to a real (non-existent)
  path inside the grant and return `file not found` — contained, correct.
- Absolute host paths as the argument (`/etc/passwd`,
  `/Users/admin/source/barelyworkingcode/outside_secret/secret.txt`, and even the
  grant's own true host path) are refused as "not a valid address", with
  `scope_violation: true`, and the refusal does not echo the argument back.
- Address-space edges: `""`, `/`, `//`, `notes/todo.txt`, `./notes/todo.txt`,
  `../outside_secret/secret.txt`, `/d00/...`, `/d1/...`, `/D0/...`, `/dz/x`,
  `d0/...`, `/d0extra`, `/d0extra/leak.txt` — every one refused. `/d0` exactly
  resolves to the root (`fs_list /d0` lists it; `fs_read /d0` returns "path is a
  directory, not a file"). For `fs_glob`/`fs_grep`/`fs_find`, an absent or empty
  `path` correctly defaults to the granted scope, not to a cwd.
- Non-string path arguments are refused cleanly (`file_path must be a string;
  received 123` / `null` / `["…"]` / `{"a":1}`) — no crash, process stayed up.

**Symlinks** (all four host-placed links out, plus the npm-shaped one, plus five
more I planted: a relative link in, an absolute link in, `self_link -> .`,
`root_link -> <the grant root>`, and `up_link -> ../../../../outside_secret`
four levels down):

- Read through a link out: `/d0/passwd_link`, `/d0/etc_link/passwd`,
  `/d0/parent_link/secret.txt`, `/d0/projects/alpha/node_modules/.bin/tool`,
  `/d0/dangling_link` — all refused.
- Write through a link out, including **writing through the dangling link**
  (`/d0/dangling_link`, `/d0/dangling_link/x.txt`) and **writing to a path whose
  parent is a link out** (`/d0/etc_link/fsmcp-escape-D.txt`,
  `/d0/parent_link/fsmcp-escape-E.txt`) — all refused, and `/nonexistent` still
  does not exist on the host afterwards.
- Overwriting through a link out: `fs_write /d0/passwd_link`,
  `fs_write /d0/parent_link/secret.txt`, `fs_edit` on the same — refused;
  `/etc/passwd` and `outside_secret/secret.txt` unchanged by sha256.
- `..` after a symlink component is applied to the *resolved* target, not
  collapsed lexically: `/d0/notes_link/../../outside_secret/secret.txt`,
  `/d0/data_abs_link/../../outside_secret/secret.txt`,
  `/d0/projects/alpha/up_link/../outside_secret/secret.txt`,
  `/d0/etc_link/../etc/passwd`, `/d0/etc_link/../../../etc/passwd`,
  `/d0/root_link/root_link/root_link/../outside_secret/secret.txt`,
  `/d0/self_link/self_link/self_link/parent_link/secret.txt` — all refused.
  In-scope links behave normally: `/d0/notes_link/todo.txt`,
  `/d0/data_abs_link/inventory.csv`, `/d0/notes_link/../data/inventory.csv`,
  `/d0/self_link/notes/todo.txt`, `/d0/root_link/notes/todo.txt` all read.
- Delete-through a link out is refused (`/d0/etc_link/passwd`,
  `/d0/etc_link/hosts`, `/d0/parent_link/secret.txt`,
  `/d0/parent_link` with `recursive:true` removes only the link). Deleting the
  link itself succeeds and leaves the target untouched — the C2 behaviour, and
  `outside_secret/` and `/etc` were byte-identical afterwards.
- Move with either endpoint a link out is refused (source `/d0/passwd_link`,
  `/d0/etc_link`, `/d0/parent_link`, `/d0/etc_link/passwd`,
  `/d0/parent_link/secret.txt`; destination `/d0/etc_link/…`,
  `/d0/parent_link/…`, `/d0/dangling_link`, `/d0/passwd_link` with
  `overwrite:true`).
- No search tool ever reported a path inside a symlinked-out directory. With
  `outside_secret/via_link.txt` planted: `fs_glob 'parent_link/*'` → empty,
  `fs_glob '**/*'` → 0 hits containing `via_link`, `fs_find via_link` → no
  matches, `fs_grep CANARY-ONLY-REACHABLE` → no matches. Same for the
  npm-shaped link: `fs_list /d0/projects/alpha/node_modules/.bin` shows
  `symlink … /d0/…/tool` and nothing about its target; `fs_grep` with that
  directory as `path` finds nothing.

**Search tools as a read oracle:** `fs_grep` for `SECRET-CANARY-9d3f1a2b`,
`SECRET-CANARY`, `SIBLING-CANARY-7c2e`, `SIBLING-PREFIX-CANARY` and `CANARY`
(both `files_with_matches` and `content` modes) — "No matches found" every time.
`fs_grep` with `path` set to any link out or any `..` path — refused with
`scope_violation`. `fs_grep`'s `glob` filter cannot add search roots
(`glob:"/etc/*"`, `glob:"../**"` → no matches). `fs_find` for `secret`,
`passwd`, `tool`, `canary`, `leak`, `/etc/passwd` — no matches; `fs_find` is
backed by `rg --files --no-follow`. `fs_glob '**/../**'` returns exactly the
in-scope file set.

**Sibling-prefix confusion:** I created a host directory `…/fsmcp-review/ws2extra`
(the grant's path plus a suffix) containing `SIBLING-PREFIX-CANARY-ws2extra`.
Refused or filtered everywhere: `fs_read /d0/../ws2extra/leak.txt`,
`fs_list /d0/../ws2extra`, `fs_find path:/d0/../ws2extra`,
`fs_edit /d0/../ws2extra/leak.txt`, `fs_write /d0/../ws2extra/…`,
`fs_delete /d0/../ws2extra`, `fs_move` to and from it, and
`fs_glob '/…/ws2extra/*'` → empty. The wildcard `'/…/ws2*/*'` matched both
directories on disk and returned only the `ws2` entries. The trailing-separator
prefix check in `isWithinAnyDir`/`hostToVirtual` holds.

**fs_move as an escape vector:** source inside / destination outside (six
variants), source outside / destination inside (five variants), absolute host
paths at either endpoint, moving the root (`/d0` → `/d0/../moved-root` refused;
`/d0` has no legal destination since any in-grant target is its own descendant),
moving a directory onto its own ancestor (`/d0/notes` → `/d0` with
`overwrite:true` → `refusing to overwrite an allowed_dir root`), and
`/d0/deep` → `/d0/deep/a/b/inner` → `cannot move a directory into itself`. A
legal in-grant move works normally.

**fs_delete as a destruction vector:** nothing outside was deleted or truncated.
`/d0` and `/d0/` refused (`refusing to delete an allowed_dir root`); `/d0/.`,
`/d0/..`, `/d0/notes/../..` refused (`does not name a removable entry`);
`/d0/../outside_secret` with `recursive:true` refused. After every attempt,
`outside_secret/secret.txt`, `outside_secret/tool` and `/etc/passwd` were
byte-identical to their pre-test sha256, and `/etc` still had 75 entries.

**macOS specifics:** APFS case-insensitivity does not defeat the check in the
dangerous direction — `/d0/NOTES/todo.txt`, `/d0/Notes/Todo.TXT`,
`/d0/notes/TODO.TXT` all read the in-grant file (contained), while
`/d0/../WS2/notes/todo.txt` fails closed because the prefix comparison is
case-sensitive. Unicode: a host file named NFC `café.txt` is readable by both
its NFC and NFD spellings, and both stay inside the grant. Trailing slash
(`/d0/`, `/d0/notes/`), doubled and tripled slashes (`/d0//notes//todo.txt`,
`/d0///notes///todo.txt`), `/d0/./notes`, `/d0/./././notes/todo.txt`,
`/d0/notes/./todo.txt`, and `.`/`..` as whole components all behave correctly.

**Depth:** subfolders are fully granted. `fs_read`, `fs_list`, `fs_glob`,
`fs_find` and `fs_grep` all work at `deep/a/b/c/d/buried.txt`, including
`/d0/deep/a/b/c/d/../../../../a/b/c/d/buried.txt`. Nothing about depth changed
any check. `fs_mkdir /d0/ok-subdir/a/b/c` created the whole chain in-grant.

**Pre-existing symlink at check time (the non-TOCTOU case):** every symlink in
these tests existed before the call was made, and every one was resolved and
judged correctly. I did not spend effort on the TOCTOU race, per the brief.

**Disk verification:** the outside world was manifested before and after every
mutating battery (`find` over `barelyworkingcode` depth 2, a listing of `/etc`,
`sha256` of `/etc/passwd` and both canaries, `ls /tmp`, `ls -a ~`). The only
diff attributable to my calls was F1's temp file. A sweep for
`fsmcp-escape*` and `*PWNED*` across `barelyworkingcode`, `/tmp` and
`/private/tmp` found nothing.

**Environmental note (not a finding):** several calls between ~14:44 and 14:47
UTC returned `relay error: external MCP call failed: read response: EOF`. Per
the review lead this was a shared-process outage caused by another lens, not a
refusal. Every affected call was re-run afterwards and the re-run result is what
is reported above. One first-call-after-restart `no allowed directories are
configured` was likewise discarded on the lead's instruction.
