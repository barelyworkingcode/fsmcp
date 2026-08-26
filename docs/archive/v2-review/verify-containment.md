# Independent verification — containment and disclosure (ws2)

Reviewer: did not write any of these fixes. Everything below was run against the
live stack — `relayremote` → relay (mTLS 127.0.0.1:9910) → fsmcp (stdio,
`_meta.allowed_dirs`) → disk — except where a line explicitly says "stdio", which
means fsmcp driven directly against `dist/main.js` (used only where the condition
needed an environment variable relay does not pass, and for issue #24's own
verbatim repro, which is written that way in the issue).

**Session window:** 2026-08-26 08:25–08:43 PDT.
**Build at the end of the run:** `d300396` "Generalise the label map: canonical
containment, not an enumeration of spellings (#21, #35)", `dist/` compiled 08:36.
The tree moved under me three times during the run (`1826cfc` #33 at 08:26,
`0f69367` #34 / `2e0572f` `d300396` #35 by 08:36). **Every verdict below was
re-run on the 08:36 build before being written**; timestamps are given where the
answer changed.

---

## The gate

    ./acceptance.sh ws2 /Users/admin/source/barelyworkingcode/fsmcp-review/ws2

Run twice. 08:25, on the 08:21 build: **passed 21, failed 2**.
Re-run 08:41, on the 08:36 build: **passed 21, failed 2**.

Both failures are #20, which is known-unfixed:

      FAIL fs_edit changed the mode (fsmcp#20)      0664 -> 0644
      FAIL fs_edit destroyed extended attributes    0 xattrs remain

Audit section clean both times: `no out-of-scope path argument was recorded as ok`.

**Passing it is not sufficient, and this run is the proof: the gate passed 21/2
while `fs_glob` could still walk the host filesystem five directories above the
grant for 44 seconds (F1 below). The gate does not contain that case.**

---

## READ THIS FIRST — an environment fact that invalidates naive verification runs

`~/.local/bin/fsmcp` execs the main checkout's `dist/main.js`, but **relay keeps
one long-lived fsmcp child and does not respawn it when `dist/` is rebuilt.**

    08:21  child spawned            (dist/main.js mtime 08:21)
    08:26  #33 merged, dist rebuilt (dist/main.js mtime 08:26)
    08:28  I ran #33's repro through relay — IT STILL REPRODUCED

That was not a defect in the #33 fix. It was the 08:21 child still running. Proof:

    $ ps -o pid,lstart -p $(pgrep -f "fsmcp/dist/main.js")
      PID STARTED
    77248 Wed Aug 26 08:21:xx 2026        <- older than the dist it "runs"

The reload lever is `relay mcp register` on the existing id (a targeted reload;
same mechanism issue #26 documents):

    $ relay mcp register --id fsmcp --name fsMCP --command ~/.local/bin/fsmcp
    updated mcp "fsMCP" (fsmcp)
    $ ps -o pid,lstart -p $(pgrep -f "fsmcp/dist/main.js")
    22128 Wed Aug 26 08:30:21 2026

**Anyone running `acceptance.sh` after installing a new fsmcp build, without
restarting Relay.app or re-registering the MCP, is testing the old binary and
will be told it passed.** That is a shipping hazard, not just a test hazard — it
is exactly how a security fix gets "verified" against the build that lacks it.
Recorded as F7.

*(Side effect worth knowing: `relay mcp register` without `--args`/`--env`
rewrites those fields from `[]`/`{}` to `null`. Functionally identical, but I
restored them to `[]`/`{}` at cleanup so the file matches what it was.)*

---

## #24: fs_write at the grant root wrote OUTSIDE the grant — **HOLDS**

**Original repro** (the issue's own, verbatim, over stdio against `dist/main.js`,
grant `<R>/parent/grant`):

A — parent writable, target is the grant root:

    $ fs_write {"file_path":"/d0","content":"HELLO-OUTSIDE"}
    {"content":[{"type":"text","text":"refusing to write to an allowed_dir root: /d0"}],
     "isError":true,"_meta":{"scope_violation":true}}

    $ find <R>
    <R>/parent
    <R>/parent/grant
    <R>/parent/grant/inside.txt        <- nothing created in the parent

B — `chmod 0555 <R>/parent`, same call: byte-identical refusal. The failure no
longer moves to the `open`, because there is no `open`.

C — control, ordinary file inside the grant, parent still 0555:

    $ fs_write {"file_path":"/d0/newfile.txt","content":"HELLO-OUTSIDE"}
    Wrote 13 bytes to /d0/newfile.txt        <- and on disk, correct bytes

Does not reproduce. The redaction marker the issue relied on as its signal never
fires, because no path outside the grant is ever built.

**Neighbours tested** — every spelling that resolves to a root, against every
write-side tool, through relay, on ws2 (`selfroot -> <ws2>` and `dotself -> .`
planted by hand as a host user would):

| spelling | fs_write | fs_edit | fs_mkdir | fs_move dest | fs_move dest+overwrite | fs_delete |
|---|---|---|---|---|---|---|
| `/d0` | refused | refused | refused | refused | refused | refused |
| `/d0/` | refused | refused | refused | refused | refused | refused |
| `/d0/.` | refused | refused | refused | refused | refused | C2 refusal |
| `/d0/notes/..` | refused | refused | refused | refused | refused | C2 refusal |
| `/d0/selfroot` (symlink → the grant) | refused | refused | refused | refused | refused | refused |
| `/d0/dotself` (symlink → `.`) | refused | refused | refused | refused | refused | refused |
| `/d0/deep/a/b/c/../../../..` | refused | refused | refused | refused | refused | C2 refusal |
| `/d0/dotself/.` | refused | refused | refused | refused | refused | C2 refusal |

The refusal echoes the caller's own spelling (`refusing to write to an
allowed_dir root: /d0/notes/..`) rather than a normalised one, which is the
right call — the agent sees the argument it sent.

Two-root grant (`V2-tworoot`, roots `<ws2>` and a scratch dir): `/d1`, `/d1/`,
`/d1/.`, `/d1/../second`, and `/d0/otherroot` (a symlink in root 0 pointing at
root 1) — all refused by all five write-side tools.

**Ground truth.** `relay audit` records every write-side refusal as
`tool_error … scope_violation: true` and every `fs_delete` root refusal as a
plain `tool_error` with no flag — the asymmetry the code documents deliberately,
recorded correctly:

    08:26:27  tool_error  WS2 Containment  fsmcp  fs_write   4  ws2  scope_violation: true  {"content":"V2-PROBE","file_path":"/d0/selfroot"}
    08:26:27  tool_error  WS2 Containment  fsmcp  fs_delete  5  ws2                         {"path":"/d0/selfroot","recursive":true}

Disk: `manifest.sh ws2` byte-identical before and after the whole matrix;
`find /Users/admin/source/barelyworkingcode -maxdepth 2 -name "*fsmcp-tmp*"`
empty.

**Regression test.** Real. `tests/escape-matrix.test.js` at `28c1432`, run
against `28c1432^1` (`b5b4935`, the pre-fix main), fails 28 of 86 — and the
failures are exactly the right ones:

    ✖ fs_write /d0            ✖ fs_edit /d0             ✖ fs_mkdir /d0
    ✖ fs_move onto /d0        ✖ fs_move onto /d0 with overwrite: true
    ✖ fs_write /d0/           ✖ fs_write /d0/.          ✖ fs_write /d0/notes/..
    ✖ fs_write /d0/self       … (25 rows, five tools × five spellings)
    ✖ issue #24: every write-side tool refuses a target that resolves to the grant root, in every spelling
    ✖ issue #24: with the grant's parent read-only, a root-addressed write is refused by the sandbox, never attempted in the parent
    ✖ issue #24: fs_mkdir at a grant root that does not exist yet does not create the grant's parent

All pass on the merged build.

**Docs.** `security.ts`'s comment above `refuseAllowedDirRootWrite` describes the
mechanism, the measured evidence and the scope_violation-vs-errorResult
asymmetry accurately. No stale claim found.

**New problems:** none from this fix.

**#34 (fs_move renaming a grant root away), which my brief listed as unfixed:**
it was, at 08:27 — `fs_move {"source":"/d0","destination":"/d1/moved-root"}`
answered `Moved /d0 to /d1/moved-root` and my ws2 grant root ceased to exist
(I restored it by hand). It was fixed at `0f69367` during the run. Re-tested
08:41 on the current build: refused in every spelling, as a plain `errorResult`
with no `scope_violation`, which matches #34's requested classification:

    /d0            => refusing to move an allowed_dir root: /d0
    /d0/           => refusing to move an allowed_dir root: /d0/
    /d0/.          => refusing to move an allowed_dir root: /d0/.
    /d0/notes/..   => refusing to move an allowed_dir root: /d0/notes/..
    /d0/selfroot   => refusing to move an allowed_dir root: /d0/selfroot
    /d0/dotself    => refusing to move an allowed_dir root: /d0/dotself

---

## #33: recursive mkdir creates ancestors above a non-existent grant root — **HOLDS**

My brief said this was unfixed and asked me to characterise the blast radius. The
review lead corrected that mid-run: it landed at `1826cfc` (08:26). Verified as a
fix instead.

**Repro** (the issue's own shape: grant `<R>/l1/l2/l3/grant`, only `<R>` exists),
through relay, 08:41 on the 08:36 build:

    $ find <R>
    <R>                                       # nothing else

    $ fs_write {"file_path":"/d0/sub/f.txt","content":"x"}
    the granted directory /d0 does not exist on the host, so fsmcp will not write
    anything inside it. This is a problem with this server's configuration, not with
    the path you asked for: the path is inside the grant and is not the reason this
    failed. Retrying, or trying a different path, will not help […]

    $ fs_mkdir {"path":"/d0/sub"}
    the granted directory /d0 does not exist on the host, so fsmcp will not create
    anything inside it […]

    $ find <R>
    <R>                                       # unchanged. Nothing created, at any depth.

Three missing levels, nothing created. `relay audit` records it as a plain
`tool_error` with **no** `scope_violation` — correct, and matching the issue's own
requested classification.

**Neighbours tested** (all through relay, grant repointed per case):

| grant root shape | result |
|---|---|
| missing, 3 levels | refused; nothing created above or at the grant |
| missing, 1 level | refused; nothing created |
| **a plain file** | `fs_write`/`fs_mkdir` refused with "exists on the host but is not a directory"; nothing created |
| **a dangling symlink** | refused, same wording as missing; nothing created |
| **a symlink to a real directory** | **works** — list/read/write/mkdir/move/delete all normal. The fix does not over-refuse (it uses `statSync`, not `lstatSync`) |
| nested: `/d0` exists and CONTAINS the missing `/d1` | `fs_write /d1/bad.txt` succeeds and creates the intermediate dirs — **correct**, everything created is inside `/d0`, which is also granted |
| independent roots: `/d0` exists, `/d1` missing elsewhere | `/d0` works; `/d1` refused; `<d1's parent>` untouched |
| root exists but mode 000 | no leak; `fs_write` → `EACCES … open '/d0/.x.txt.fsmcp-tmp-…'` (virtual path, correctly translated), `fs_mkdir` → `mkdir failed: EACCES … '/d0/y'` |
| root deleted between two calls in the same session | call 1 lists it; call 2 refuses with the grant-does-not-exist message. No stale cache, no recreation |
| root on an unmounted volume path (`/Volumes/NoSuchVolumeV2/proj`) | refused; nothing created under `/Volumes` |

**Regression test.** Real. `tests/missing-grant-root.test.js` on `1826cfc^1`
(`e1e5685`): **3 pass / 5 fail**. Passes on the merged build.

**Docs.** CLAUDE.md's paragraph on `refuseMissingAllowedDirRoot()` is accurate,
including the "grant root existing IS the bound" reasoning, the file/dangling-link
cases, and the nested-grant rule. No stale claim.

**New problems:** F6 — the clear, actionable refusal exists only on `fs_write`
and `fs_mkdir`. See below.

---

## #22: fs_grep leaked the granted root as a raw host path — **HOLDS**

**Original repro A** (granted root renamed out from under a call, two-root grant):

    $ mv <G>/rootB <G>/rootB.away
    $ fs_grep {"pattern":"anything","path":"/d1"}
    directory not found: /d1

**Original repro B** (granted root at mode 000, default-scope search, no `path`):

    $ chmod 000 <G>/rootB
    $ fs_grep {"pattern":"probe"}
    [fsmcp: these results are a floor, not a complete answer -- directory not
     readable: /d1. Files that could not be read were not searched, and one of
     them may match.]

    $ fs_grep {"pattern":"probe","path":"/d1"}
    directory not readable: /d1

**The second half** (the backstop had become fs_grep's routine error path — a
mistyped directory answered "this is a bug in fsmcp […] please report it"):

    $ fs_grep {"pattern":"needle","path":"/d0/nodir"}
    {"content":[{"type":"text","text":"directory not found: /d0/nodir"}],"isError":true}

Same sentence `fs_glob`/`fs_find`/`fs_list` give. Neither half reproduces.

**Neighbours tested.** Every distinct ripgrep and Node error I could force, every
reply grepped for `/Users`, `admin`, `barelyworkingcode`, `fsmcp-review`, `ws2`,
`/private/tmp`, `claude-501`. Grant roots deliberately placed under the real host
path so a leak would carry the account name:

    fs_grep {"pattern":"[unclosed"}                 -> grep error: rg: regex parse error: … unclosed character class
    fs_grep {"pattern":"(?P<x>a)(?P<x>b)"}          -> grep error: rg: regex parse error: … duplicate capture group name
    fs_grep {"pattern":"needle","type":"nosuchtype"}-> grep error: rg: unrecognized file type: nosuchtype
    fs_grep {"pattern":"needle","type":"../../etc"} -> grep error: rg: unrecognized file type: ../../etc
    fs_grep {"pattern":"needle","glob":"[["}        -> grep error: rg: error parsing glob '[[': unclosed character class
    fs_grep {"pattern":"needle","path":"/d0/secret"}-> directory not readable: /d0/secret
    fs_grep {"pattern":"needle"} w/ unreadable subdir -> hits + generic floor note, no path named
    fs_grep {…,"output_mode":"content","context":3} -> hits + floor note

**Zero leak tokens in any reply.** The caller's own echoed pattern comes back byte
for byte on a regex error, which is right — it is the caller's input, not a host
path.

**Over-correction check** (the thing I was told to look for):

- A search that legitimately finds nothing still says so: `fs_grep {"pattern":"zzzznomatch"}` → `No matches found.` (not an error, not a floor note).
- A partial result IS reported as partial when a root is **unreadable**: `fs_grep` and `fs_find` both emit an explicit floor note naming the virtual root.
- A partial result is **NOT** reported as partial when a root is **missing** — see F3. This is a real gap, and CLAUDE.md already documents it as residue.
- `fs_glob` never reports partial at all, in either condition — see F4.

**Regression test.** Real. `tests/grep-error-leak.test.js` on `75d9437^1`
(`532bc81`): **0 pass / 7 fail**. Passes on the merged build.

**Docs.** CLAUDE.md's fs_grep paragraph is now honest about the old wrong claim
and re-derives the fix accurately. **One factual error remains** — see F5b: it
says the `RIPGREP_CONFIG_PATH` residue "exits 0 today, so it does not reach this
branch". I reached it.

**New problems:** F5b (the residue is reachable, and the doc says it is not).

---

## #21 / #35: symlinked root, aliased ancestor, `..` in allowed_dirs — **HOLDS**

**Original repro** (#21: recursive `fs_glob` returned an empty success under a
symlinked root). Fixture: `<ws2>/v2sym/real` (a full `mkfixture.sh` tree),
`<ws2>/v2sym/link -> …/real`, granted as the root.

Ran the same battery against **four spellings of the same directory**, on the
08:36 build (the label map was generalised at `d300396` during my run, so this
was re-run after):

1. `<ws2>/v2sym/link` (grant is a symlink)
2. `/Users/runner/source/…/v2sym/real` (aliased ancestor — `/Users/runner -> /Users/admin` on this host)
3. `<ws2>/v2sym/../v2sym/real` (issue #35's `..` entry)
4. `<ws2>/v2sym/real` (control)

Result: **all four byte-identical.**

      glob **/*.txt : /d0/data/emoji.txt|/d0/data/no-trailing-newline.txt|…|/d0/notes/todo.txt
      glob notes/*  : /d0/notes/todo.txt|/d0/notes/meeting.md
      find meeting  : /d0/notes/meeting.md
      grep Budget   : /d0/notes/meeting.md
      list /d0      : symlink 0 … /d0/dangling_link | directory 320 … /d0/data | …
      read meeting  : 1  Meeting notes | 2  Budget approved: 12000 | …
      write/mkdir/move/delete : all succeed

`fs_glob`, `fs_find`, `fs_grep`, `fs_list` and `fs_read` agree with each other in
every spelling. **The redaction placeholder appears zero times** across
`fs_glob **/*`, `fs_list /d0` and `fs_find` in all four (counted:
`grep -c 'redacted'` → 0 for each).

**#35 is therefore fixed** by the general mapping change, which my brief listed as
"may or may not be". So is the aliased-ancestor shape.

**Regression test.** Real. `tests/symlinked-root.test.js` on `532bc81^1`
(`28c1432`): **10 pass / 3 fail**. Passes on the merged build (12 named
symlinked-root assertions in the full-suite output).

**The alarm still works** — this was the specific thing I was told to check, and
it is the risk with any "make the map recognise more spellings" fix. Two ways:

*Live,* with the grant on the symlink and `<ws2>/v2sym/real/out -> …/realNEIGHBOUR`
(a directory outside the grant containing `NEIGHBOUR-CANARY-V2`):

    fs_read  {"file_path":"/d0/out/n.txt"}  -> path /d0/out/n.txt is outside allowed directories
    fs_list  {"path":"/d0/out"}             -> path /d0/out is outside allowed directories
    fs_write {"file_path":"/d0/out/z.txt"}  -> path /d0/out/z.txt is outside allowed directories
    fs_move  {…,"destination":"/d0/out/todo.txt"} -> path /d0/out/todo.txt is outside allowed directories
    fs_glob  {"pattern":"out/*"}            -> No matches found.
    fs_grep  {"pattern":"NEIGHBOUR-CANARY"} -> No matches found.

The canary never reached the client and `realNEIGHBOUR/` was unchanged on disk.

*Directly against the shipped `dist/`*, which is the code relay runs:

    $ node -e "v=require('./dist/vpath.js'); labels=v.assignLabels(['<ws2>/v2sym/link'], new Map()); …"
    labels = [{label:"d0", hostDir:"…/v2sym/link", realHostDir:"…/v2sym/real",
               spellings:["…/v2sym/link","…/v2sym/real"]}]

    …/v2sym/real/notes/x            -> /d0/notes/x
    …/v2sym/link/notes/x            -> /d0/notes/x
    …/v2sym/real                    -> /d0
    …/v2sym/realNEIGHBOUR/n.txt     -> [fsmcp: path outside the granted directories -- redacted]
    …/v2sym/real2/x                 -> [fsmcp: path outside the granted directories -- redacted]
    …/v2sym/linkX/y                 -> [fsmcp: path outside the granted directories -- redacted]
    …/v2sym                         -> [fsmcp: path outside the granted directories -- redacted]
    /etc/passwd                     -> [fsmcp: path outside the granted directories -- redacted]
    …/outside_secret/secret.txt     -> [fsmcp: path outside the granted directories -- redacted]

    (same, for the ".." spelling of the grant: identical results)

**The mapping change made nothing new mappable.** The prefix-sibling case
(`real2`, `linkX`, `realNEIGHBOUR` — names that share a prefix with a granted
spelling) is the one that would break a naive `startsWith`, and it redacts
correctly: the separator is consumed with the directory.

**Docs.** CLAUDE.md's `LabelEntry` paragraph now describes `hostDir` /
`realHostDir` / `spellings` and the two-stage `hostToVirtual` accurately, matching
what the shipped `dist/` actually does. The `follow: true` non-fix and the
"canonicalising the walk alone is actively worse" pairing are both recorded.

**New problems:** none from this fix. (F1 below is a `fs_glob` pattern-validation
problem, not a mapping problem.)

---

## #25: fs_glob's pattern is an unvalidated host path — **INCOMPLETE**

**Original repro.** All three of the issue's consequences are closed *for the
spellings the fix checks*:

*The oracle — SAMENESS test.* 15 absolute patterns, alternating correct guesses at
real host paths against wrong ones, byte-compared:

    /Users/admin/*                                            0.067s
    /Users/zzzznotreal/*                                      0.067s
    /Users/admin/source/barelyworkingcode/outside_secret/*     0.062s
    /Users/admin/source/barelyworkingcode/qqqqnope/*           0.058s
    /etc/*                                                    0.061s
    /nonexistent-xyz-abc/*                                    0.064s
    /Users/adm?n/*                                            0.061s
    /Users/zzz?n/*                                            0.059s
    /Users/[a-c]dmin/*                                        0.062s
    /Users/[x-z]dmin/*                                        0.063s
    /d0/../*     /private/tmp/*     /Volumes/*                0.055–0.063s

**All twelve absolute-pattern replies are byte-identical** (sha256 `9eef6496…`),
and the two `..` replies are byte-identical to each other (`2cce8b9e…`). The
pattern is not echoed. Timing spread is 0.055–0.067s with no correlation to
whether the guessed path exists. Both classes carry
`"_meta":{"scope_violation":true}` and `isError`. **The absolute-pattern oracle is
closed and the empty-success is now a refusal.**

*Ordinary glob work still functions* — I checked this specifically because a
containment fix that refuses legitimate patterns is not an improvement:

    **/*.txt              -> 13 hits          **/*.{js,md}        -> 4 hits (braces)
    projects/alpha/src/*.js -> 2 hits         data/[a-e]*         -> 2 hits (char class)
    data/?????.txt        -> 2 hits           {notes,data}/*.txt  -> 6 hits
    deep/**/buried.txt    -> 1 hit            projects/**/README.md -> 1 hit
    path=/d0/projects/alpha + "*"   -> /d0/projects/alpha/README.md
    path=/d0/deep/a/b      + "**/*" -> /d0/deep/a/b/c/d/buried.txt

All correct. No over-refusal found.

**Neighbours — and this is where it breaks. See F1.** The `..` refusal is a
regex over the raw pattern looking for a literal `..` component. `glob`'s own
matcher resolves `[.][.]` and `\.\.` to the same parent-directory component, and
the check does not see either. The walk climbs, arbitrarily far, and is not
effectively bounded.

**Regression test.** Real. `tests/glob-pattern-scope.test.js` on `532bc81^1`
(`28c1432`): **1 pass / 11 fail**. Passes on the merged build. It does not cover
the `[.][.]` spelling.

**Docs.** CLAUDE.md states a property the code does not have — see F5a. That
sentence is the reason the hole exists.

**New problems:** F1 (the bypass, with the DoS), F2, F4.

---

## #26: dropped-`_meta` report names host paths on a SUCCESS — **HOLDS**

Driven over stdio (this needs a `--allowed-dir` on fsmcp's argv, which would mean
re-registering the shared MCP with a narrowing flag and breaking every other
reviewer's grant):

    FSMCP_CLI_ARGS="--allowed-dir <G>" mcp.py '["<G>","/Users/admin/source/barelyworkingcode/outside_secret"]' \
        fs_read '{"file_path":"/d0/notes/todo.txt"}'

    {"content":[
      {"type":"text","text":"1\tTODO: fix the parser\n2\tTODO: ship the thing\n3\t"},
      {"type":"text","text":"[fsmcp: _meta.allowed_dirs entries were dropped because they are not
       contained within any --allowed-dir root -- 1 of them. This call's effective scope is that
       much narrower than the scope it was sent, and the dropped entries are not addressable from
       here. They are named in this server's stderr, for the operator, who is the party that can
       reconcile the two.]"}]}

    --- stderr ---
    fsmcp: _meta.allowed_dirs entries were dropped because they are not contained within any
    --allowed-dir root: /Users/admin/source/barelyworkingcode/outside_secret. …

The client gets the fact and the count; the operator gets the path, on stderr.
Exactly the split the issue asked for. Verified on `fs_read` and `fs_list`.

**Docs.** CLAUDE.md's paragraph on this is rewritten to describe the new
behaviour and keeps the disproved reasoning as history. Accurate.

---

## #28: fs_list reports a symlink's size as its target-path length — **HOLDS**

    $ fs_list {"path":"/d0"}
    symlink	0	2026-08-26T…	/d0/dangling_link
    symlink	0	2026-08-26T…	/d0/etc_link
    symlink	0	2026-08-26T…	/d0/parent_link
    symlink	0	2026-08-26T…	/d0/passwd_link

All zero. Previously 20 / 4 / 52 / 11 — the exact byte lengths of
`/nonexistent/nowhere`, `/etc`, `/Users/admin/source/barelyworkingcode/outside_secret`
and `/etc/passwd`. Observed on every `fs_list` in every battery above, across four
grant spellings.

---

# Findings

## F1: `fs_glob` still walks outside the grant, unbounded, via `[.][.]` — the `..` refusal is bypassable
**Severity:** high (disclosure-free but it is a filesystem walk outside `allowed_dirs`, an unbounded one, and a denial of service against every other client of the shared MCP)
**Component:** fsmcp
**Time:** first seen 08:30, re-confirmed 08:39 and 08:41 on build `d300396` / `dist` 08:36.

#25's `..` check is a conservative regex over the raw pattern string. `glob`
resolves a character-class or escaped spelling of `..` to the same path component,
and the regex does not see it:

    $ fs_glob {"pattern":"../*"}
    pattern must not contain a ".." path component (including inside a brace alternative) …
    [scope_violation: true]                                       <- refused

    $ fs_glob {"pattern":"[.][.]/*"}
    {"content":[{"type":"text","text":"No matches found."}]}      <- NOT refused. ok in the audit.

    $ fs_glob {"pattern":"\\.\\./*"}
    {"content":[{"type":"text","text":"No matches found."}]}      <- same

That the reply is empty is the per-hit `validatePath` filter doing its job, not
the check doing its job. The walk really happens. Against the shipped `glob` with
`cwd` = the ws2 grant:

    "[.][.]/*"                          -> 9 hits   ['…/fsmcp-review/symlinked_root', '…/fsmcp-review/mkfixture.sh', …]
    "[.][.]/[.][.]/*"                   -> 2 hits   ['…/barelyworkingcode/testfolder_sibling_canary.txt',
                                                     '…/barelyworkingcode/RUNBOOK-vm-stack.md']
    "[.][.]/[.][.]/[.][.]/*"            -> 1 hit    ['/Users/admin/source/prompt.md']
    "[.][.]/[.][.]/[.][.]/[.][.]/*"     -> 1 hit    ['/Users/admin/admin']
    "[.][.]/×5/*"                       -> 1 hit    ['/Users/runner']
    "[.][.]/[.][.]/relay/*"             -> 166 hits ['…/barelyworkingcode/relay/wire_json.go', …]
    "\\.\\./*"                          -> same as "[.][.]/*"

Two levels up it enumerates `testfolder_sibling_canary.txt`. Five levels up it is
at `/Users`.

**Through the live stack the walk is observable directly, because fsMCP's own
alarm fires on it:**

    $ fs_glob {"pattern":"[.][.]/[.][.]/[.][.]/**/*"}
    {"content":[{"type":"text","text":"glob error: EACCES: permission denied, readlink
      '[fsmcp: path outside the granted directories -- redacted]'"}],"isError":true}

`hostToVirtualOrRedact` returned the placeholder because the path it was handed
maps to **no granted directory in any spelling**. Per CLAUDE.md that placeholder
means "a path reached output from outside the grant", i.e. the alarm firing here is
itself the evidence that fsMCP touched a path outside `allowed_dirs`. It is
reachable by an unprivileged client with one argument.

**And the walk is not bounded.** `grepBudgetMs()` is 30 000 ms and is enforced
through glob's `ignore`/`childrenIgnored` hooks, which prune directories — they do
not stop the `readlink`/`stat` that eventually throws, so the graceful "cut short"
note never runs and the budget is overshot:

    $ time fs_glob {"pattern":"[.][.]/[.][.]/[.][.]/[.][.]/[.][.]/[.][.]/**/*"}
    elapsed 44.08s  (re-measured 45.01s and 44.17s on two earlier builds)
    -> glob error: EACCES … readlink '[fsmcp: path outside the granted directories -- redacted]'

**Head-of-line blocking, measured across two different grants:** that call issued
from `ws2`, and two seconds later a trivial `fs_read` from a *different enrolment
on a different granted directory*:

    READ(V2-tworoot, other grant)  42.17s -> 1	second-root-file
    GLOB(ws2)                      44.17s -> glob error: EACCES …

One `fs_glob` argument from one client stalls every client of the MCP for 42
seconds. That is #25's third consequence, unclosed, reached by a spelling the fix
does not check.

**Ground truth.** `relay audit` records every one of these as `ok` for the empty
cases (the audit correctly does not treat a pattern as a path argument — but that
also means an operator sees nothing). Disk unchanged; `outside_secret` manifest
byte-identical before and after; neither canary ever reached the client
(`[.][.]/[.][.]/testfolder_sibling_canary[.]txt` → `No matches found.`,
`fs_read /d0/../../outside_secret/secret.txt` → `path … is outside allowed directories`).

**Why it matters in the real deployment.** The product claim is that
`allowed_dirs` is the complete answer to what the client can reach. Today a client
can make the server walk the operator's entire home directory, and can hold the
shared MCP for the better part of a minute doing it — with a pattern that looks
like a filename filter. The output filter is holding, which is the only reason
this is not a disclosure bug; #25's own text says that filter "is the second line,
not the first".

**Suggested shape of a fix (not mine to write):** the `..` test is on the wrong
side of the abstraction. The refusal that actually holds is the one glob cannot
argue with — after the walk, `hostToVirtualOrRedact` already knows a hit is out of
scope; that condition should be a `scope_violation` refusal rather than a silently
dropped row, and the `ignore` hook already sees every directory glob is about to
descend, so it can refuse to descend one that is not inside a granted root. That
also bounds the walk for free.

---

## F2: `fs_glob` answers "No matches found." on an UNREADABLE granted root — an empty success where every sibling errors
**Severity:** high (per this review's own rule: a scope/access failure must be an error, never an empty result)
**Component:** fsmcp

    $ chmod 000 <grant>
    $ fs_glob {"pattern":"**/*"}
    {"content":[{"type":"text","text":"No matches found."}]}          <- no isError
    $ fs_glob {"pattern":"*","path":"/d0"}
    {"content":[{"type":"text","text":"No matches found."}]}          <- no isError
    $ fs_find {"pattern":"f"}
    {"content":[{"type":"text","text":"directory not readable: /d0"}],"isError":true}
    $ fs_list {"path":"/d0"}
    {"content":[{"type":"text","text":"list error: EACCES: permission denied, scandir '/d0'"}],"isError":true}
    $ fs_grep {"pattern":"hi"}
    [fsmcp: these results are a floor, not a complete answer -- directory not readable: /d0 …]

**Ground truth.** `relay audit`:

    08:30:12  ok          V2-probe  fsmcp  fs_glob  14  {"pattern":"**/*"}
    08:30:12  ok          V2-probe  fsmcp  fs_glob   9  {"path":"/d0","pattern":"*"}
    08:30:12  tool_error  V2-probe  fsmcp  fs_find  14  {"pattern":"f"}
    08:30:12  tool_error  V2-probe  fsmcp  fs_list   8  {"path":"/d0"}

Re-confirmed 08:41 on the current build.

**Why it matters.** This is the same shape as #21, in the tool #21 was about, one
condition over. A macOS TCC-protected folder (Desktop, Documents, Downloads) that
the fsmcp child has not been granted reads exactly like this. The agent is told
the folder is empty, and acts on it. `fs_grep`'s and `fs_find`'s diagnosis
(`unsearchableReason`) already exists and is the answer `fs_glob` should be giving.

---

## F3: a granted root that does not exist is silently dropped from a default-scope search
**Severity:** medium (a partial answer presented as a complete one; documented in CLAUDE.md as residue, but live and unsignalled to the client)
**Component:** fsmcp

Two-root grant, both roots populated, then `/d1`'s directory renamed away:

    both present:   grep/glob/find -> /d1/b.txt , /d0/a.txt
    /d1 MISSING:    grep -> /d0/a.txt          (no note)
                    glob -> /d0/a.txt          (no note)
                    find -> /d0/a.txt          (no note)
                    list /d1 -> directory not found: /d1   [isError]
    /d1 UNREADABLE: grep -> /d0/a.txt + floor note naming /d1
                    find -> /d0/a.txt + floor note naming /d1
                    glob -> /d0/a.txt          (no note — see F4)

Same behaviour for the realistic operator case, a granted root on an unmounted
volume (`/Volumes/NoSuchVolumeV2/proj`): `fs_grep` and `fs_glob` answer with the
other root's hits and say nothing.

**Ground truth.** `ok` in the audit. Disk unchanged (read-only tools).

**Why it matters.** This is #33's unplugged-drive scenario from the *search* side.
`fs_write` now refuses loudly and correctly when a grant points at nothing —
`fs_grep`/`fs_glob`/`fs_find` quietly answer as if the operator had granted less
than they did, and an agent concludes the missing half's contents do not exist.
CLAUDE.md names this residue in the fs_grep paragraph, so it is known, not
hidden — but it is a behaviour, not a comment, and the two halves of the same
condition now disagree about how loudly to complain.

---

## F4: `fs_glob` has no partial/floor reporting at all
**Severity:** medium
**Component:** fsmcp

`fs_grep` reports `[fsmcp: these results are a floor …]` and `fs_find` reports
`[fsmcp: the file walk did not cover every file in scope …]` when a root is
unreadable. `fs_glob` reports nothing, in that case or in the missing-root case
(F3), and returns a bare list on `ok`. CLAUDE.md line 114 says a cut-short
`fs_glob` walk "**says so**" — that is true for the wall-clock budget path and
false for the unsearchable-root path, which does not go through it.

Combined with F2 (empty success on an unreadable root) and F1 (an error result
from an out-of-grant `readlink` rather than a bounded partial), `fs_glob` is the
one search tool in the set with no honest way to say "this answer is incomplete".

---

## F5: two doc claims that assert properties the code does not have
**Severity:** low (docs) — but F5a is the direct cause of F1
**Component:** fsmcp

**F5a — CLAUDE.md, the `fs_glob` pattern-validation bullet:**

> "it deliberately does NOT try to catch a `..` produced by a magic component,
> because Node's `readdir` never reports `.` or `..` as entries, so only a literal
> `..` component can climb."

The premise is about `readdir`; the conclusion is about `glob`'s pattern matcher,
which is not the same thing. Measured against the shipped `glob`, `[.][.]/*` and
`\.\./*` both climb (F1). The paragraph immediately above it correctly says the
checks are "conservative regexes over the raw pattern, not an expansion of it" and
that they "over-refuse a couple of exotic literals … and fail in the safe
direction" — this sentence is the one place the file claims the *under*-refusal
direction is closed, and it is not. This is exactly the failure mode VERIFY-BRIEF
rule 5 names: a comment asserting a property the code does not have.

**F5b — CLAUDE.md, the fs_grep residue note:**

> "a path in `rg`'s stderr that is under no granted directory at all (ripgrep
> naming its own `RIPGREP_CONFIG_PATH` file, say -- **which exits 0 today, so it
> does not reach this branch**, but is the shape to watch)"

It does reach the branch. `--ignore-file=<missing>` exits 0, which is presumably
what was measured; `--file=<missing>` exits 2 with empty stdout, which is the
exact combination the last-resort branch requires. Driven over stdio (the env var
has to be in fsmcp's environment, which relay does not set — so this is
operator/host-environment reachable, **not** client-reachable):

    $ echo "--file=/Users/admin/source/barelyworkingcode/outside_secret/patterns.txt" > rgconf
    $ RIPGREP_CONFIG_PATH=rgconf mcp.py '["<grant>"]' fs_grep '{"pattern":"needle"}'
    {"content":[{"type":"text","text":"grep error: rg: /Users/admin/source/barelyworkingcode/
      outside_secret/patterns.txt: No such file or directory (os error 2)"}],"isError":true}

A raw host path naming a directory the client was never granted, with the account
name and the layout above the grant, delivered verbatim. The control confirms the
in-scope path handling is intact — with `--ignore-file=<same missing path>` (rg
exits 0) the reply is just `/d0/sub/hay.txt` and the stderr is discarded.

The residue is real and correctly identified as a residue; only the "does not
reach this branch" parenthetical is wrong, and it is the half that would make a
reader stop worrying about it. A host running fsmcp under a shell profile that
exports `RIPGREP_CONFIG_PATH` is not exotic.

---

## F6: #33's actionable refusal is only on `fs_write` and `fs_mkdir`; five other tools still say "not found"
**Severity:** medium (an agent loops)
**Component:** fsmcp

Same grant, root missing at three levels, all in one batch:

    fs_write -> the granted directory /d0 does not exist on the host … Retrying, or trying a
                different path, will not help — every write into that grant fails until an
                operator fixes it …
    fs_mkdir -> (same)
    fs_edit  -> file not found: /d0/sub/f.txt
    fs_move  -> source not found: /d0/a
    fs_read  -> file not found: /d0/a
    fs_list  -> directory not found: /d0
    fs_delete-> not found: /d0/sub
    fs_glob/find/grep -> none of the allowed directories exist

The three search tools are fine. The five above are not: `file not found:
/d0/sub/f.txt` reads to an agent as "I got the path wrong", and the agent's
correct response to that is to try another path — which is the loop #33's own text
asks the fix to prevent ("It should be told the granted directory does not exist
on the host, which is not something it can fix, so it stops rather than looping").
The repair agent flagged this itself and it was right to; I confirm it live, and
add that the read-side (`fs_read`, `fs_list`, `fs_delete`) has the same wording
problem, not just `fs_edit`/`fs_move`.

Nothing is created and nothing escapes — this is a message-quality bug, not a
containment one.

---

## F7: relay does not respawn fsmcp when `dist/` changes, so a verification run can silently test the old binary
**Severity:** medium (process/deployment; it defeats verification of every fix above)
**Component:** relay / deployment

See the environment note at the top for the measured evidence: a `dist/` rebuilt
at 08:26 was not live at 08:28, and #33's repro reproduced against the stale
child. `relay mcp register --id fsmcp …` forces the reload.

**Why it matters.** `INSTALL.md`/`STATUS.md` present `acceptance.sh` as the
artefact an operator runs after installing. If installing means "replace the
binary", the operator's first acceptance run tests the binary they just replaced
and reports a pass. Whatever ships needs either a documented restart step or, in
relay, an mtime/inode check on a stdio MCP's command before reusing the child.

---

## F8 (low, contained, judgement call): a grant root that is a plain file is readable as a file
**Severity:** low
**Component:** fsmcp

With `allowed_dirs = [<a regular file>]`:

    fs_read  {"file_path":"/d0"}  -> 1	iamafile
    fs_list  {"path":"/d0"}       -> not a directory: /d0
    fs_write/fs_mkdir             -> the granted directory /d0 exists on the host but is not a directory …
    fs_glob  {"pattern":"**/*"}   -> No matches found.

The write side refuses correctly (#33's fix). Reading the granted path itself is
arguably in scope — the operator did name it — and nothing outside is reachable.
Recording it only because it is an asymmetry a reader of `refuseMissingAllowedDirRoot`
would not predict: the same misconfiguration is a hard refusal for writes and a
working read.

---

# Verified working

Exercised end to end through relay and confirmed against disk and `relay audit`,
on build `d300396` / `dist` 08:36 unless noted:

- **#24 root-addressed writes**, 8 spellings × 6 tools (48 calls), single-root and
  two-root grants, including a symlink inside the grant pointing at the grant and
  a symlink pointing at the *other* root. All refused, all recorded as
  `scope_violation: true` in the audit for the write side and as plain
  `tool_error` for the delete side. Fixture manifest byte-identical afterwards; no
  `fsmcp-tmp` artefact anywhere in or above the review tree.
- **#34** fs_move refusing a grant root as its *source*, in six spellings, as a
  plain `errorResult`. (Fixed at `0f69367` during my run; it did destroy my grant
  root at 08:27 on the earlier build, which I restored by hand.)
- **#33** grant root missing at one and three levels, a grant that is a file, a
  grant that is a dangling symlink, a grant on an unmounted `/Volumes` path, a
  grant root deleted between two calls in one session, nested grants, and
  independent grants with one root missing. Nothing created above any boundary in
  any of them.
- **#33 does not over-refuse**: a grant that is a symlink to a real directory
  works completely (list/read/write/mkdir/move/delete), and a nested grant whose
  inner root is missing but whose outer root contains it still writes correctly.
- **#22** both original triggers (renamed root, mode-000 root), the mistyped-path
  trigger, and 11 forced ripgrep/Node error conditions (unclosed class, duplicate
  capture group, huge repetition, bad `--type`, `--type` with a traversal string,
  bad `--glob`, unreadable subdirectory, unreadable root, missing subdirectory,
  content mode with context, count mode). **Zero occurrences of `/Users`, `admin`,
  `barelyworkingcode`, `fsmcp-review`, `ws2`, `/private/tmp` or `claude-501` in any
  reply.** A search that finds nothing still says `No matches found.`; a search
  over an unreadable subtree returns its real hits plus an explicit floor note.
- **#25's absolute-pattern oracle**: 12 absolute patterns (correct host-path
  guesses, wrong guesses, wildcard-narrowed guesses, existing and non-existing) →
  12 byte-identical refusals, `scope_violation: true`, no echo of the pattern,
  0.055–0.067s with no timing correlation. 2 literal-`..` patterns → 2
  byte-identical refusals of the other class.
- **#25 did not over-correct**: 11 ordinary glob patterns (`**`, brace
  alternatives, character classes, `?` runs, literal-prefixed `sub/dir/*`,
  `deep/**/file`) and 6 `path`+pattern combinations all return correct hits.
- **#21 / #35 / aliased ancestor**: one fixture, four grant spellings (symlink,
  `/Users/runner` alias, `..`-containing entry, plain), five read tools plus four
  write tools each. All four spellings byte-identical. Redaction placeholder count
  zero on every correct call.
- **The alarm still fires** where it must: a symlink out of a symlinked root is
  refused by `fs_read`/`fs_list`/`fs_write`/`fs_move` and filtered by
  `fs_glob`/`fs_grep`; and against the shipped `dist/`, `hostToVirtual` redacts a
  prefix-sharing sibling of a granted directory (`real2`, `linkX`,
  `realNEIGHBOUR`), the grant's own parent, `/etc/passwd` and the canary path — in
  both the symlink and `..` grant spellings.
- **#26** dropped-`_meta` report: count to the client, path to stderr.
- **#28** symlink size reported as 0 on every `fs_list` in every battery.
- **Canaries.** `outside_secret/secret.txt` (SECRET-CANARY-9d3f1a2b) and
  `testfolder_sibling_canary.txt` (SIBLING-CANARY-7c2e) never reached the client
  in any of ~400 calls, including the `[.][.]` walk that enumerated the sibling
  canary's path inside glob. `manifest.sh outside_secret` byte-identical before
  (08:25) and after (08:42):

        ./secret.txt  4ec676050b83b5aaca4ca5fab9a915e9871f62e6a2c82403d74cfb7c31ba9748
        ./tool        6b665906a6748d6c4284fc793f58f3c6810a97f7c35528f43f85dff0bc34ff17

  Nothing created, moved or deleted outside the granted tree by any tool call.
- **Full suite** on a scratch copy of the merged build: `tests 307, pass 307,
  fail 0`.
- **Regression tests are real**, each run against its own pre-fix parent commit:

        #24  tests/escape-matrix.test.js       on b5b4935  ->  58 pass / 28 fail
        #25  tests/glob-pattern-scope.test.js  on 28c1432  ->   1 pass / 11 fail
        #21  tests/symlinked-root.test.js      on 28c1432  ->  10 pass /  3 fail
        #22  tests/grep-error-leak.test.js     on 532bc81  ->   0 pass /  7 fail
        #33  tests/missing-grant-root.test.js  on e1e5685  ->   3 pass /  5 fail

  All pass on the merged build. None of them passes on both, so none of them
  proves nothing.

# Housekeeping

- Backed up `~/Library/Application Support/relay/settings.json` before the first
  edit (scratchpad `V2-relay-settings.json.bak`).
- Created and then removed two access profiles (`V2-tworoot`, `V2-probe`) and
  their enrolments; `relay enrol revoke` on both, bundle directories deleted,
  profile records removed from `settings.json`. `relay enrol list` and the profile
  list are back to the nine that were there at 08:25. No profile or enrolment on
  the do-not-touch list was read from, written to, or otherwise altered.
- `relay mcp register` had rewritten fsmcp's `args`/`env` from `[]`/`{}` to
  `null`; restored to `[]`/`{}`.
- ws2 rebuilt with `mkfixture.sh`; diffed against a pristine sibling fixture, the
  only differences are `data/random.bin` (random per build) and
  `projects/beta/selfref.conf` (contains the workspace's own path by design).
- Verified after cleanup that `ws1`, `ws3`, `ws4` and `hermes-files` still resolve
  their grants and that ws2 still reads normally.
