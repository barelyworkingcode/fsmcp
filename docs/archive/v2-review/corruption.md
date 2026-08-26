# fsMCP review — data corruption lens (client `ws1`, grant `/d0` = `…/fsmcp-review/ws1`)

Question asked: **can a normal agent doing normal work through these tools damage a
byte of the user's data?**

Answer: **yes, three ways.** One of them destroys a file outright on a completely
ordinary rename, one destroys a whole directory tree on an ordinary "move this file
into that folder", and one writes bytes to disk that are not the bytes the caller
asked for while reporting success.

The good news first, because it is a large fraction of what was tested: the byte-exact
path (`fs_read`/`fs_write` with `encoding: "base64"`) is a true identity on every file
in the fixture, `fs_edit` preserves BOMs, CRLF, missing final newlines and multi-byte
UTF-8 exactly, non-UTF-8 files are refused rather than mangled everywhere, concurrent
writes never tore a file, and no temp file was ever left behind. Details in
**Verified working** at the end.

All calls below went through `relayremote` → relay (mTLS 127.0.0.1:9910) → fsmcp.
Shell was used only for `shasum`/`xxd`/`stat`/`ls` verification and to plant fixtures.

    export RELAY_REMOTE_ADDR=127.0.0.1:9910
    export RELAY_REMOTE_BUNDLE="$HOME/Library/Application Support/relay/enrolments/ws1"
    W=/Users/admin/source/barelyworkingcode/fsmcp-review/ws1
    RELAY=/Applications/Relay.app/Contents/MacOS/relay

---

## F1: `fs_move` DESTROYS the source file whenever source and destination name the same file — including an ordinary case-only rename on macOS

**Severity:** critical
**Component:** fsmcp (`src/tools/move.ts`)

`fs_move`'s `overwrite: true` branch is `fs.rmSync(destination, {recursive:true,
force:true})` followed by `fs.renameSync(source, destination)`. When `destination`
resolves to the same directory entry as `source`, the `rmSync` deletes the data and
the `renameSync` then fails `ENOENT`. The tool reports a move failure. The file is
gone.

The most ordinary way to hit this is a **case-only rename on the default
case-insensitive APFS volume** — `meeting.md` → `Meeting.md`. `fs_move` reports
"destination already exists" (the case-insensitive lookup finds the source itself)
and tells the caller to pass `overwrite: true`. Doing exactly what the tool says
destroys the file.

**Repro** (clean fixture, `mkfixture.sh ws1` immediately before):

```
### disk before
7c8a53dc3138b938232a2a1b0e902c259e1e80cb80d93ce5fb0b2290738b113b  …/ws1/notes/meeting.md

### call 1 — an agent renames notes/meeting.md to notes/Meeting.md (capitalisation fix)
$ relayremote call --tool fs_move \
    --args '{"source":"/d0/notes/meeting.md","destination":"/d0/notes/Meeting.md"}'
destination already exists: /d0/notes/Meeting.md (pass overwrite: true to replace it)
[exit=1]

### call 2 — the agent does exactly what the tool told it to
$ relayremote call --tool fs_move \
    --args '{"source":"/d0/notes/meeting.md","destination":"/d0/notes/Meeting.md","overwrite":true}'
move failed: ENOENT: no such file or directory, rename '/d0/notes/meeting.md' -> '/d0/notes/Meeting.md'
[exit=1]

### disk after
$ ls -la $W/notes/
total 8
drwxr-xr-x   3 admin  staff   96 Aug 26 07:48 .
drwxr-xr-x  10 admin  staff  320 Aug 26 07:48 ..
-rw-r--r--   1 admin  staff   42 Aug 26 07:48 todo.txt
```

`meeting.md` is gone and `Meeting.md` was never created. Nothing on disk holds the
content any more.

Three more spellings of the same bug, each verified separately:

```
# (a) literal self-move of a file
$ relayremote call --tool fs_move --args '{"source":"/d0/mv/self.txt","destination":"/d0/mv/self.txt","overwrite":true}'
move failed: ENOENT: no such file or directory, rename '/d0/mv/self.txt' -> '/d0/mv/self.txt'
[exit=1]
$ ls -l $W/mv/self.txt
ls: …/ws1/mv/self.txt: No such file or directory        # 20 bytes destroyed

# (b) self-move of a DIRECTORY — recursive, takes the whole tree
$ find $W/mv/proj
<WS>/mv/proj  <WS>/mv/proj/README.md  <WS>/mv/proj/src  <WS>/mv/proj/src/a.txt
$ relayremote call --tool fs_move --args '{"source":"/d0/mv/proj","destination":"/d0/mv/proj","overwrite":true}'
move failed: ENOENT: no such file or directory, rename '/d0/mv/proj' -> '/d0/mv/proj'
[exit=1]
$ ls -la $W/mv
total 0
drwxr-xr-x   2 admin  staff   64 …  .
drwxr-xr-x  12 admin  staff  384 …  ..          # entire tree gone

# (c) same file addressed with a "." component
$ relayremote call --tool fs_move --args '{"source":"/d0/mv/alias.txt","destination":"/d0/mv/./alias.txt","overwrite":true}'
move failed: ENOENT: no such file or directory, rename '/d0/mv/alias.txt' -> '/d0/mv/./alias.txt'
$ ls -l $W/mv/alias.txt
ls: …/ws1/mv/alias.txt: No such file or directory
```

Control — every ordinary tool handles all of these without losing a byte:

```
$ /bin/mv $W/mvctl/Ctl.js $W/mvctl/ctl.js ; ls -l $W/mvctl ; cat $W/mvctl/ctl.js
[exit=0]  -rw-r--r--  1 admin  staff  13 …  ctl.js
control data
$ /bin/mv $W/mvctl/ctl.js $W/mvctl/ctl.js ; cat $W/mvctl/ctl.js
[exit=0]  control data
$ python3 -c "import os; os.rename('…/ctl.js','…/ctl.js')" ; cat …/ctl.js
rename(a,a) ok
control data
```

`rename(2)` is specified to be a no-op when both arguments refer to the same file.
fsmcp's unlink-first sequence turns that no-op into an unrecoverable delete.

**Ground truth:**

```
$ $RELAY audit --tail 6 | grep -E "TIME|ws1"
TIME      OUTCOME     PROJECT         MCP    TOOL     MS  CALLER  DETAIL
07:48:36  pending     WS1 Corruption  fsmcp  fs_move  0   ws1     {"destination":"/d0/notes/Meeting.md","source":"/d0/notes/meeting.md"}
07:48:36  tool_error  WS1 Corruption  fsmcp  fs_move  5   ws1     {"destination":"/d0/notes/Meeting.md","source":"/d0/notes/meeting.md"}
07:48:36  pending     WS1 Corruption  fsmcp  fs_move  0   ws1     {"destination":"/d0/notes/Meeting.md","overwrite":true,"source":"/d0/notes/meeting.md"}
07:48:36  tool_error  WS1 Corruption  fsmcp  fs_move  5   ws1     {"destination":"/d0/notes/Meeting.md","overwrite":true,"source":"/d0/notes/meeting.md"}
```

The operator's audit log records `tool_error` — "the move failed". There is nothing in
relay's record that says data was destroyed, so an operator reading the log after the
fact would conclude nothing happened.

**Why it matters in the real deployment:** renaming a file to fix its capitalisation is
routine agent work (a component file, a doc, a screenshot). On the default macOS
filesystem it silently deletes the file, the agent is told the move failed so it will
likely retry or move on, and the operator's audit says `tool_error`. This is
irreversible loss of a granted user file from one ordinary two-call sequence, and the
tool's own error message is what steers the caller into it.

**Fix shape:** compare the two endpoints (`fs.statSync(src).ino/dev` vs
`fs.statSync(dest).ino/dev`, after the existing canonicalisation) before the `rmSync`,
and either refuse or `renameSync` directly. `rename(2)` already replaces an existing
destination atomically — the `rmSync` is only needed for a destination *directory*,
and even then only after the same-file check.

---

## F2: `fs_move` with `overwrite: true` performs an unbounded recursive delete that has none of `fs_delete`'s guards, and its own error message invites it

**Severity:** high
**Component:** fsmcp (`src/tools/move.ts`)

`fs_delete` requires `recursive: true` before it will remove a non-empty directory and
refuses past 10,000 entries. `fs_move`'s `overwrite: true` makes the identical
`fs.rmSync(dest, {recursive:true, force:true})` call with **neither** guard. And the
refusal an agent gets first — "destination already exists: … (pass overwrite: true to
replace it)" — says nothing about a directory being removed recursively.

The natural trigger is POSIX `mv file dir/` semantics: an agent moving a file *into* a
folder.

**Repro:**

```
$ find $W/projects -type f
<WS>/projects/beta/notes.txt
<WS>/projects/beta/selfref.conf
<WS>/projects/alpha/README.md
<WS>/projects/alpha/src/index.js
<WS>/projects/alpha/src/config.js

$ relayremote call --tool fs_move --args '{"source":"/d0/notes/todo.txt","destination":"/d0/projects"}'
destination already exists: /d0/projects (pass overwrite: true to replace it)
[exit=1]

$ relayremote call --tool fs_move --args '{"source":"/d0/notes/todo.txt","destination":"/d0/projects","overwrite":true}'
Moved /d0/notes/todo.txt to /d0/projects
[exit=0]

$ find $W -type f -o -type l | sort
<WS>/dangling_link
<WS>/data/…                       (data/ untouched)
<WS>/deep/a/b/c/d/buried.txt
<WS>/etc_link
<WS>/notes/meeting.md
<WS>/parent_link
<WS>/passwd_link
<WS>/projects                     ← now a FILE. alpha/, beta/, 5 files: gone.
```

**Ground truth:**

```
$ $RELAY audit --tail 200 | grep ws1 | grep fs_move | tail -2
07:42:14  pending  WS1 Corruption  fsmcp  fs_move  0  ws1  {"destination":"/d0/projects","overwrite":true,"source":"/d0/notes/todo.txt"}
07:42:14  ok       WS1 Corruption  fsmcp  fs_move  6  ws1  {"destination":"/d0/projects","overwrite":true,"source":"/d0/notes/todo.txt"}
```

`ok`. Five files deleted, one `fs_move` call, no `recursive` flag anywhere in the
request, no entry cap consulted.

**Why it matters in the real deployment:** every other destructive path in this tool
surface is deliberately gated — `fs_delete` needs `recursive: true`, caps at 10,000
entries and refuses the grant root; `fs_move` refuses moving a directory into its own
child. This one call bypasses the whole scheme, and the mental model an agent brings
from `mv` ("moving onto a directory puts it inside") is the one that triggers it.

---

## F3: the documented lone-surrogate refusal never fires through relay — the write succeeds and lands U+FFFD on disk

**Severity:** high
**Component:** relay / relayRemote (Go `encoding/json`), defeating a guard in fsmcp

`src/encoding.ts` and both `fs_write` and `fs_edit` refuse a lone (unpaired) UTF-16
surrogate in `content`/`new_string` "unconditionally, with no acknowledgement flag",
precisely because Node would otherwise silently substitute U+FFFD — the exact
silent-corruption shape issue #11 exists to close. Over the relay path the guard never
runs: Go's `encoding/json` replaces the unpaired surrogate with U+FFFD during
unmarshal, so fsmcp receives an already-substituted string, sees nothing wrong, and
writes it.

**Repro** — the arguments carry a literal `\ud800`, sent via `--args-file` so nothing
in the shell can touch it:

```
$ printf '%s' '{"file_path":"/d0/q9/sur.txt","content":"a\ud800b"}' > q.json
$ relayremote call --tool fs_write --args-file q.json
Wrote 5 bytes to /d0/q9/sur.txt
[exit=0]
$ xxd $W/q9/sur.txt
00000000: 61ef bfbd 62                             a...b
```

`61 EF BF BD 62` — "a", U+FFFD, "b". The caller asked for a two-code-unit string; five
bytes were written; the tool reported success.

Same through `fs_edit`:

```
$ printf 'keep TOKEN here\n' > $W/q9/ed.txt
$ printf '%s' '{"file_path":"/d0/q9/ed.txt","old_string":"TOKEN","new_string":"x\ud83dy"}' > q.json
$ relayremote call --tool fs_edit --args-file q.json
Replaced 1 occurrence(s) in /d0/q9/ed.txt
[exit=0]
$ xxd $W/q9/ed.txt
00000000: 6b65 6570 2078 efbf bd79 2068 6572 650a  keep x...y here.
```

fsmcp's own guard is intact — it is simply unreachable. Over bare stdio, the identical
argument is refused and no file is created:

```
$ printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"fs_write",
     "arguments":{"file_path":"/d0/sur_direct.txt","content":"a\ud800b"},
     "_meta":{"allowed_dirs":["/tmp/…/direct"]}}}' \
  | node …/fsmcp/dist/main.js | tail -1
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"content contains a lone
(unpaired) UTF-16 surrogate, which has no valid UTF-8 encoding -- writing it would silently
substitute U+FFFD for it. …"}],"isError":true}}
$ ls -l /tmp/…/direct
total 0
```

**Ground truth** — relay's own audit shows the substitution has already happened by the
time relay logs the call, i.e. upstream of fsmcp:

```
$ $RELAY audit --tail 60 | grep "sur.txt" | head -1 | xxd | head -3
00000040: 3120 2020 2020 2020 7b22 636f 6e74 656e  1       {"conten
00000050: 7422 3a22 61ef bfbd 6222 2c22 6669 6c65  t":"a...b","file
```

Mechanism confirmed with a two-line Go control:

```
$ go run sur.go
Go decoded bytes: 61 ef bf bd 62
Go re-encoded: {"content":"a<U+FFFD>b"}
```

**Why it matters in the real deployment:** a lone surrogate is what an agent produces
when it slices a string by UTF-16 index and lands in the middle of an emoji or any
astral character — chunking a large file for a series of `fs_write` calls is the
obvious way to get one. fsMCP's design decision was that this must always be a refusal
because the information is already lost. Through relay it is instead a silent success
with different bytes on disk, which is the precise failure the guard was written to
prevent, one layer higher up.

---

## F4: `fs_write`/`fs_edit` silently strip permission bits that the process umask masks — the claimed mode preservation is only half implemented

**Severity:** medium
**Component:** fsmcp (`src/atomicWrite.ts`)

`writeFileAtomic` passes the old file's mode to `fs.writeFileSync(tmpPath, data,
{mode})`. That mode is the *creation* mode of a fresh file, so the kernel applies the
process umask to it. Under the default `umask 022` every group-write and other-write
bit is dropped on every write and every edit. The code comment says this exists so that
"a shell script edited with fs_edit would [not] lose its execute bit on every single
edit" — the execute bit survives; the group/other write bits do not.

**Repro** (measured `umask` was `022`):

```
chmod 0664: before=-rw-rw-r-- 664   after fs_write=-rw-r--r-- 644   after fs_edit=-rw-r--r-- 644   *** MODE CHANGED ***
chmod 0666: before=-rw-rw-rw- 666   after fs_write=-rw-r--r-- 644   after fs_edit=-rw-r--r-- 644   *** MODE CHANGED ***
chmod 0777: before=-rwxrwxrwx 777   after fs_write=-rwxr-xr-x 755   after fs_edit=-rwxr-xr-x 755   *** MODE CHANGED ***
chmod 0775: before=-rwxrwxr-x 775   after fs_write=-rwxr-xr-x 755   after fs_edit=-rwxr-xr-x 755   *** MODE CHANGED ***
chmod 0640: before=-rw-r----- 640   after fs_write=-rw-r----- 640   after fs_edit=-rw-r----- 640   OK
chmod 0600: before=-rw------- 600   after fs_write=-rw------- 600   after fs_edit=-rw------- 600   OK
```

Single-call demonstration on the fixture:

```
$ chmod 0664 $W/notes/todo.txt ; ls -l $W/notes/todo.txt
-rw-rw-r--  1 admin  staff  42 …  todo.txt
$ relayremote call --tool fs_edit --args '{"file_path":"/d0/notes/todo.txt","old_string":"ship","new_string":"SHIP"}'
Replaced 1 occurrence(s) in /d0/notes/todo.txt
$ ls -l $W/notes/todo.txt
-rw-r--r--  1 admin  staff  42 …  todo.txt
```

**Ground truth:** `$RELAY audit` shows `ok` for the `fs_edit`; nothing in the result or
the audit mentions a permission change. This is *not* the ACL/xattr loss already
reported by the review lead — these are the base mode bits `atomicWrite.ts` explicitly
sets out to preserve, and it does so through a call that cannot preserve them.

**Why it matters in the real deployment:** a granted folder that is a shared team
directory or a group-writable checkout loses its group-write bit on the first agent
edit of each file, one file at a time, invisibly. The next colleague to touch that file
gets "permission denied", and nothing in the agent's transcript or the operator's audit
log explains why.

**Fix shape:** `fs.fchmodSync`/`fs.chmodSync` on the temp file after writing (or
`writeFileSync` then `chmodSync`), since `open(2)`'s mode argument can never express a
bit the umask clears.

---

## F5: `fs_write`/`fs_edit` overwrite a read-only (0444) file — the rename-based replace bypasses the file's own permission bits

**Severity:** medium
**Component:** fsmcp (`src/atomicWrite.ts`)

Because the new bytes go to a fresh temp file that is then `rename(2)`d over the
target, the target's own write permission is never consulted. Only the *directory* is.
A user who marks a file read-only to keep the agent off it gets no protection.

**Repro:**

```
$ chmod 0444 $W/notes/meeting.md ; ls -l $W/notes/meeting.md ; cat $W/notes/meeting.md
-r--r--r--  1 admin  staff  60 …  meeting.md
Meeting notes
Budget approved: 12000
Next review 2026-09-01

-- kernel refuses an ordinary write:
$ printf 'x\n' > $W/notes/meeting.md
permission denied: …/ws1/notes/meeting.md

-- fs_write does not:
$ relayremote call --tool fs_write --args '{"file_path":"/d0/notes/meeting.md","content":"gone\n"}'
Wrote 5 bytes to /d0/notes/meeting.md
[exit=0]
$ ls -l $W/notes/meeting.md ; cat $W/notes/meeting.md
-r--r--r--  1 admin  staff  5 …  meeting.md
gone
```

`fs_edit` behaves the same way (`Replaced 1 occurrence(s)` on a 0444 file).

The same mechanism also changes a file's **owner**. A root-owned file sitting in a
user-writable granted directory comes back owned by the agent's uid:

```
$ sudo chown root:wheel $W/atom/rootowned.txt ; sudo chmod 0664 … ; ls -l
-rw-rw-r--  1 root  wheel  14 …  rootowned.txt
$ relayremote call --tool fs_write --args '{"file_path":"/d0/atom/rootowned.txt","content":"rewritten by agent\n"}'
Wrote 19 bytes to /d0/atom/rootowned.txt
$ ls -l
-rw-r--r--  1 admin  staff  19 …  rootowned.txt
```

(setuid loss is separate and deliberate — `atomicWrite.ts` documents dropping it.)

**Ground truth:** `$RELAY audit` records `ok` for both calls; disk confirms the content
was replaced and the mode string kept while the protection it encoded did not hold.

**Why it matters in the real deployment:** "chmod the important files read-only before
you hand the folder to the agent" is the obvious defence an operator reaches for, and
it does not work here. It is worth either documenting loudly or honouring — a
`fs.accessSync(filePath, W_OK)` check before the temp write would restore ordinary
POSIX behaviour without touching the atomicity property.

---

## F6: `fs_edit` accepts `old_string: ""` and rewrites the file, reporting success

**Severity:** medium
**Component:** fsmcp (`src/tools/edit.ts`)

`content.split("")` splits into individual characters, so an empty `old_string` counts
`length - 1` "occurrences" and `join(new_string)` interleaves the replacement between
every character of the file.

```
$ printf 'hello\n' > $W/notes/empt.txt ; xxd $W/notes/empt.txt
00000000: 6865 6c6c 6f0a                           hello.

$ relayremote call --tool fs_edit --args '{"file_path":"/d0/notes/empt.txt","old_string":"","new_string":"X"}'
old_string found 5 times. Use replace_all or provide more context to make it unique.

$ relayremote call --tool fs_edit --args '{"file_path":"/d0/notes/empt.txt","old_string":"","new_string":"X","replace_all":true}'
Replaced 5 occurrence(s) in /d0/notes/empt.txt
$ xxd $W/notes/empt.txt
00000000: 6858 6558 6c58 6c58 6f58 0a              hXeXlXlXoX.
```

**Ground truth:** audit `ok`; the file on disk is interleaved garbage. Note that the
first refusal, as with F1 and F2, tells the caller which flag to add to make it happen.

**Why it matters in the real deployment:** this is what an agent produces when the
string it meant to search for came from a variable that was empty — a templated edit, a
value it failed to extract from a previous read. Every other ambiguity in this codebase
is refused (`fs_edit` on a non-unique match, `assignLabels` on a duplicate label,
`validatePath` on an empty scope); an empty `old_string` is the same shape of "this
operation has no meaning" and should refuse rather than produce `count` of them.

---

## F7: a file whose name is longer than 231 characters can never be written or edited, only read

**Severity:** low
**Component:** fsmcp (`src/atomicWrite.ts`)

`writeFileAtomic`'s temp name is `.` + basename + `.fsmcp-tmp-` + 12 hex characters —
25 characters of overhead against a 255-byte `NAME_MAX`. So the effective limit for any
name fsmcp can write is 231, not 255.

```
name len 228: fs_write -> 'Wrote 2 bytes to /d0/odd'
name len 229: fs_write -> 'Wrote 2 bytes to /d0/odd'
name len 230: fs_write -> 'Wrote 2 bytes to /d0/odd'
name len 231: fs_write -> 'Wrote 2 bytes to /d0/odd'
name len 232: fs_write -> 'ENAMETOOLONG: name too l'
name len 255: fs_write -> 'ENAMETOOLONG: name too l'
```

An existing 250-character-named file created by the host user is readable but
permanently uneditable:

```
$ printf 'user data in a long-named file\n' > "$W/odd/$(python3 -c "print('z'*250)")"
$ relayremote call --tool fs_read  --args '{"file_path":"/d0/odd/zzz…"}'
1	user data in a long-named file
$ relayremote call --tool fs_edit  --args '{"file_path":"/d0/odd/zzz…","old_string":"user","new_string":"USER"}'
ENAMETOOLONG: name too long, open '/d0/odd/.zzz…zzz.fsmcp-tmp-a23936d5abd5'
$ cat "$W/odd/zzz…"
user data in a long-named file          # unchanged — fails closed, no corruption
```

It fails closed and destroys nothing, which is why this is low. It is worth fixing
because the failure is silent about its real cause (the message names an internal temp
file the caller never asked for) and because the fix is a shorter suffix or a temp name
derived from a hash rather than the full basename.

---

## F8: `fs_list` emits a raw newline inside its one-line-per-entry format when a filename contains a newline

**Severity:** low
**Component:** fsmcp (`src/tools/list.ts`)

```
$ relayremote call --tool fs_list --args '{"path":"/d0/odd"}'
…
file	28	2026-08-26T14:45:44.175Z	/d0/odd/two
lines.txt
…
```

The entry `two\nlines.txt` becomes two output lines, the second of which
(`lines.txt`) parses as a malformed entry. No data is harmed — `fs_read`, `fs_write`
and `fs_edit` all handle the name correctly (see Verified working) — but a caller that
splits `fs_list` output on newlines gets a phantom entry and a truncated real one.
A newline in a filename is rare but entirely legal, and a downloads folder or an
extracted archive is a plausible source.

---

# Verified working

Everything below was exercised end to end through `relayremote` on the ws1 grant, with
`shasum -a 256` / `xxd` / `stat` on the real files as ground truth, and
`manifest.sh` diffed against a freshly built fixture after each destructive phase.

**Round-trip fidelity (the headline guarantee — holds)**

- `fs_read(base64)` → `fs_write(base64)`, payload passed back verbatim with no editing
  step: **byte identity on all 16 files in the fixture, 0 differing.** Verified on
  `data/random.bin` (4096 random bytes), `data/pixel.png`, `data/utf16.txt`
  (UTF-16LE + BOM), `data/latin1.txt` (invalid UTF-8), `data/bom-crlf.txt`
  (UTF-8 BOM + CRLF), `data/no-trailing-newline.txt`, `data/emoji.txt`, and every
  text file. Mode preserved (`0644→0644`), inode changed every time (confirming the
  temp-file-and-rename path really ran), and `manifest.sh` before/after diff was empty.
- `fs_read(base64)` returns a bare base64 payload with no header and no trailing
  newline, so it *is* valid `fs_write` input as documented. Byte count arrives in
  `_meta.bytes` (`{"_meta": {"bytes": 69}}` for the PNG), and `_meta` survives the
  relay hop intact (visible with `relayremote call --json`).
- Text mode **refuses** rather than mangles every non-UTF-8 file — `latin1.txt`,
  `utf16.txt`, `random.bin`, `pixel.png` — naming `encoding: "base64"` as the fix, and
  leaves the file untouched (`shasum` identical before and after each refusal).
- `projects/beta/selfref.conf`, whose *content* is the sandbox's own host path, came
  back through `fs_read` byte-exact and round-tripped byte-exact — the PR #10
  content-rewriting corruption has not regressed.
- Text-mode `fs_write` is byte-faithful for every valid UTF-8 input tried: astral
  planes, ZWJ emoji sequences, combining marks, bidi controls, an embedded U+FEFF, NUL
  bytes mid-content, bare CR, CRLF, no final newline, tabs, C0 control bytes, U+10FFFF.
  12/12 byte-exact.

**`fs_edit`**

- Replace-once, `replace_all` (2 occurrences), 0 matches (refused, file untouched),
  >1 match without `replace_all` (refused with a count, file untouched, shasum
  unchanged) — all correct.
- `old_string` containing a newline: matched and replaced correctly.
- Multi-byte UTF-8: `🌍` → `🌎` changed exactly the four bytes `f0 9f 8c 8d` →
  `f0 9f 8c 8e`, nothing else.
- **BOM preserved** on a UTF-8-BOM file (`efbbbf` still leading after an unrelated
  edit) and **CRLF preserved** (`0d0a` intact on both lines) — `ignoreBOM: true` is
  doing what its comment claims.
- No-trailing-newline file stayed without a trailing newline after an edit.
- Edit that produces an empty file produced a 0-byte file, cleanly.
- Refuses to edit non-UTF-8 content (`latin1.txt`, `pixel.png`) with the correct
  message and leaves the bytes identical.
- `new_string` containing `old_string` (`a` → `aa`, `replace_all`) terminated correctly
  at 3 replacements — no runaway.

**Atomicity**

- Inode changes on every `fs_write`/`fs_edit`, confirming temp-file + rename.
- Execute bit preserved: `0755` script survived both `fs_write` and `fs_edit` as
  `-rwxr-xr-x`. (Group/other write bits do not — F4.)
- **Read-only parent directory (0555):** clean refusal, original untouched,
  **no leftover temp file** — `EACCES: permission denied, open
  '/d0/atom/rodir/.f.txt.fsmcp-tmp-325458681f54'`, and `ls -a` on the directory showed
  only `f.txt`.
- `fs_write` onto an existing directory: `EISDIR` on the rename, directory and its
  contents intact, temp cleaned up.
- `fs_write` where a parent component is a file: `EEXIST … mkdir`, target file
  untouched.
- A whole-workspace `find -name '*fsmcp-tmp*'` after every destructive phase found
  **nothing**. No temp file was ever left behind, including after failures.
- **Symlink inside the grant:** `fs_write` and `fs_edit` on `link.txt -> real.txt`
  wrote *through* the link — `real.txt` got the new content (new inode), `link.txt` is
  still a symlink pointing at `real.txt`. `fs_read` through the link returns the target
  content. This is the correct behaviour and the one the source comments say used to be
  broken.

**Concurrency (real interleaved calls, not theory)**

- Two `fs_write` calls racing the same file with 2,000,001 bytes of `A` vs `B`, 8
  rounds: every round left a file of exactly 2,000,001 bytes that was **entirely one
  letter**. Never a mixed or short file.
- Read racing two writes, 6 rounds: every `fs_read(base64)` decoded to exactly
  2,000,001 homogeneous bytes matching one of the two writers' shasums. No torn read.
- Two `fs_edit` calls touching different strings in the same file, 6 rounds: **both**
  edits present every time (`ALPHA|beta|GAMMA`), both reporting success. relay drives a
  single synchronous fsmcp child (`pgrep -f fsmcp/dist/main.js` → one pid), so
  read-modify-write cycles serialise and there is no lost-update window.

**`fs_move`** (beyond F1/F2)

- Cross-tree move preserved bytes, inode and mode exactly: sha
  `0ea47148…` → `0ea47148…`, ino `2877369` → `2877369`, mode `751` → `751`, source gone.
- Refuses an existing destination without `overwrite`; replaces it with `overwrite`.
- Refuses moving a directory into its own descendant, by name:
  `cannot move a directory into itself: /d0/mv/parent -> /d0/mv/parent/child/parent`,
  tree intact.
- Refuses `overwrite: true` onto the grant root under all four spellings tried
  (`/d0`, `/d0/`, `/d0/.`, `/d0/projects/..`) — `refusing to overwrite an allowed_dir
  root`, workspace intact each time.
- Moves an in-grant symlink as a link (`ilink -> tgt.txt` arrived as
  `ilink2 -> tgt.txt`, target untouched); refuses to move a symlink whose target is
  outside the grant (`path /d0/mv/plink is outside allowed directories`).

**`fs_delete`**

- **Deletes the LINK, never the target**, for all five fixture symlinks
  (`passwd_link`, `etc_link`, `parent_link`, `dangling_link`,
  `projects/alpha/node_modules/.bin/tool`). Ground truth after all five:
  `/etc` still has 75 entries, `/etc/passwd` sha unchanged
  (`5676bbb620dfd6c5…` before and after, 9344 bytes), and
  `outside_secret/` still contains `secret.txt` and `tool` with `tool` still reading
  `canary tool`.
- Refuses a non-empty directory without `recursive`, naming the entry count; tree intact.
- Refuses the grant root: `refusing to delete an allowed_dir root: /d0` (and `/d0/`),
  and `/d0/.` and `/d0/projects/..` are refused as "does not name a removable entry".
  Workspace present and complete after all four.
- Recursive delete of a subtree worked and removed exactly that subtree.

**Size and truncation**

- `fs_read` refuses at exactly the documented boundary: 10,485,759 and 10,485,760 bytes
  read fine; 10,485,761 gives
  `… is 10485761 bytes, over fs_read's 10485760-byte limit …`.
- A file with a 3,000-character line came back truncated at 2,000 with an inline
  `... [truncated]` marker **and** `_meta: {'truncated': True}` on the result.
- A 2,500-line file read with no `limit` came back with
  `[fsmcp: showing lines 1-2000 of 2501; pass offset: 2001 to continue reading]`
  **and** `_meta: {'truncated': True}`. Both signals survive the relay hop. A caller
  cannot mistake either truncation for a complete read, in either output mode
  (the inline markers are present in relayremote's default text output; `_meta`
  requires `--json`).
- `fs_write` of 9,000,000 bytes succeeded and wrote exactly 9,000,000 bytes. Requests
  larger than relay's 10 MiB wire cap are refused cleanly
  (`error: malformed request: message exceeds maximum size of 10485760 bytes`) with
  nothing created on disk. (Very large requests — 27 MB — instead surface as
  `relay unreachable … broken pipe`, which is a misleading message for a size refusal,
  but it still fails closed and the stack survives.)

**base64 input validation (the write-side escape hatch)** — every malformed payload was
refused with `content is not valid base64 …` and **no file was created**:
non-base64 text (`"hello world"`), line-wrapped base64 (the classic agent mistake),
base64 truncated by one character, and base64 with a space substituted mid-payload while
keeping length a multiple of 4. None of these produced "some" bytes.

**Odd but real filenames** — created through `fs_write`, then `fs_read`, `fs_edit` and
`fs_list` against each. All round-tripped byte-exact with nothing silently renamed or
lost: `file with spaces.txt`, `héllo—🌍.txt`, `-rf.txt` (leading dash),
`trailing ` (trailing space), `two\nlines.txt` (embedded newline), `.hidden`,
`..weird`, `he said "hi".txt`, `100%done.txt`, `a#b?c&d.txt`, and a 200-character name.
(The only wrinkle is F8's `fs_list` output framing; the file itself was fine.)

**U+FFFD in text content** is written verbatim as documented
(`61 efbfbd 62 0a`), not second-guessed — correct, and the reason F3 is a relay-layer
finding rather than an fsmcp one.

---

## Note on out-of-scope material

Not reported here because the review lead confirmed they are already covered: extended
attributes and ACLs dropped by the atomic replace, hardlinks broken by the same,
recursive `fs_glob` on a symlinked grant root, and the >7.9 MB `fs_read(base64)` that
tears down the shared fsmcp child. F4 (base mode bits lost to umask) is a distinct
mechanism from the xattr/ACL loss and is reported above on its own terms.
