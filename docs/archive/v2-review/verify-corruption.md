# Verification — data-integrity lens (reviewer did not write these fixes)

**Build under test:** `~/.local/bin/fsmcp` → `/Users/admin/source/barelyworkingcode/fsmcp/dist/main.js`.
`dist/` was rebuilt **08:49** during this run (commits through `d300396`); my first
`fs_move` pass ran at 08:26–08:28 against the 08:21 build (`e1e5685`). **Every
`fs_move` and `fs_edit` result in this report was re-run after 09:02 against the
08:49 build** and is quoted from that re-run. The only behaviour that changed
between the two builds was the grant-root-as-source refusal (`#34`, `0f69367`),
noted in §23.

**Client:** enrolment `ws1`, grant `/Users/admin/source/barelyworkingcode/fsmcp-review/ws1`, virtual root `/d0`.

## Headline

| | |
|---|---|
| Acceptance gate | **passed 21, failed 2** — both failures are `#20` (mode bits, xattrs), known/in flight |
| Unit suite (`npm test`, scratch clone of `main`) | **307 passed, 0 failed** |
| Fixture byte manifest | **unchanged** across every destructive phase, and across a full `fs_move` round-trip of all 21 entries |
| Verdicts | **#23 HOLDS** · **#30 HOLDS** · **#28 HOLDS** · **#19 INCOMPLETE** · **#31 INCOMPLETE** |

Nothing I could do through the tool surface destroyed a byte. The two INCOMPLETE
verdicts are not data loss: one is a **false error message introduced by #19**
that an ordinary paging loop reaches, and one is a **fix applied to one of the
four tools the issue names**.

---

## #23: `fs_move` destroys data — **HOLDS**

### Original repro (verbatim from the issue)

**Defect 1, case-only rename.** The issue's two calls, in order, on a file with the
issue's own sha `98d902c9…`:

```
$ printf 'IRREPLACEABLE CONTENT\n' > movetest/meeting.md
$ shasum -a 256 movetest/meeting.md
98d902c98f87771f0cb2e926ea0bf1c7e4784004425edf7fb7a1ed7e472edceb  movetest/meeting.md

$ relayremote call --tool fs_move --args '{"source":"/d0/movetest/meeting.md","destination":"/d0/movetest/Meeting.md"}'
Moved /d0/movetest/meeting.md to /d0/movetest/Meeting.md      <-- no flag needed any more

$ relayremote call --tool fs_move --args '{"source":"/d0/movetest/meeting.md","destination":"/d0/movetest/Meeting.md","overwrite":true}'
Moved /d0/movetest/meeting.md to /d0/movetest/Meeting.md

$ ls -la movetest/
-rw-r--r--  1 admin  staff   22 Aug 26 08:25 Meeting.md
$ shasum -a 256 movetest/Meeting.md
98d902c98f87771f0cb2e926ea0bf1c7e4784004425edf7fb7a1ed7e472edceb  movetest/Meeting.md
```

Does not reproduce. The refusal that used to talk the caller into destruction is
gone, because the case-only rename now succeeds on the first call with no flag.

**Defect 2, `overwrite: true` onto a directory.**

```
$ find mv2 -type f
mv2/projects/alpha/one.txt  mv2/projects/beta/two.txt  mv2/projects/top.txt  mv2/todo.txt

$ relayremote call --tool fs_move --args '{"source":"/d0/mv2/todo.txt","destination":"/d0/mv2/projects","overwrite":true}'
destination is an existing directory: /d0/mv2/projects (3 entries). fs_move does not replace a
directory, and overwrite: true does not either. To move /d0/mv2/todo.txt INTO this directory, name
the full destination path: /d0/mv2/projects/todo.txt. To replace the directory itself, delete it
with fs_delete first.

$ find mv2 | sort
mv2  mv2/projects  mv2/projects/alpha  mv2/projects/alpha/one.txt  mv2/projects/beta
mv2/projects/beta/two.txt  mv2/projects/top.txt  mv2/todo.txt      <-- tree intact, source intact
```

Does not reproduce. I also checked the **remedy the refusal names actually works**
— which is the shape of this whole issue — and it does:
`fs_move {"source":"/d0/rem/todo.txt","destination":"/d0/rem/dir/todo.txt"}` →
`Moved`, file lands beside `existing.txt`, nothing else touched.

### Neighbours tested (disk checked every time, never the reply)

Every row below was verified against `ls -li` / `shasum` / `find`, not the message.

| case | result | disk |
|---|---|---|
| file → existing file, `overwrite:true` | `Moved` | dest = source bytes, source gone. Correct. |
| file → existing file, no `overwrite` | refused `destination already exists` | both intact |
| dest = in-grant symlink to an in-grant file, `overwrite` | `Moved` | **link replaced, link's TARGET untouched** (`c_target.txt` still `C-TARGET`) |
| dest = **dangling** in-grant symlink | refused w/o flag; `Moved` with it | link replaced by the file; nothing else |
| dest = **empty directory**, source = file | refused, `(0 entries)` | both intact |
| dest = empty directory, source = **directory with contents** | refused w/o flag; `Moved` with it | whole subtree arrives intact (`ed/s/f`) |
| dest = non-empty directory, source = directory | refused | tree intact |
| **directory → existing file** | `move failed: ENOTDIR` | source dir intact, victim file intact |
| dest **parent does not exist** | `move failed: ENOENT … rename '/d0/mt/l' -> '/d0/mt/nope/x'` | source intact, nothing created |
| **hardlinked pair** a↔b | `Moved` — see F3 | **both names still present, same inode, data intact** |
| source = in-grant symlink | `Moved` | the LINK moved, target file untouched |
| literal self-move / `.` alias / `sub/..` alias | `is already at …; nothing to move` | file intact |
| dest = `passwd_link` (symlink out) | `path /d0/passwd_link is outside allowed directories`, audit `scope_violation: true` | `/etc/passwd` untouched, link untouched |
| dest = `parent_link` and `parent_link/stolen.txt` | scope violation | `outside_secret/` unchanged |
| source = `passwd_link` / `dangling_link` | scope violation | nothing created |
| dest = grant root, all four spellings `/d0` `/d0/` `/d0/.` `/d0/mt/..` | `refusing to move onto an allowed_dir root` | root intact |
| source = grant root | `refusing to move an allowed_dir root: /d0` (this is `#34`, landed 08:49) | root intact |
| trailing slash on a directory dest | refused with the directory message | both intact |

**Cross-device (EXDEV).** I formatted a 10 MB HFS+ RAM disk and mounted it at
`ws1/mt/vol`, i.e. a real mount point *inside the grant* — the case the repair
agent said was the fourth data-loss path.

```
$ shasum -a 256 mt/vol/victim.txt mt/exdev_src.txt
0f2813dd…  mt/vol/victim.txt
8876c877…  mt/exdev_src.txt

$ relayremote call --tool fs_move --args '{"source":"/d0/mt/exdev_src.txt","destination":"/d0/mt/vol/victim.txt","overwrite":true}'
cannot move /d0/mt/exdev_src.txt to /d0/mt/vol/victim.txt: they are on different filesystems, and
fs_move only renames -- it has no copy-and-delete fallback, so nothing was changed. …

$ shasum -a 256 mt/vol/victim.txt mt/exdev_src.txt
0f2813dd…  mt/vol/victim.txt          <-- destination NOT deleted
8876c877…  mt/exdev_src.txt
```

Same for a **directory** across the boundary onto an empty directory: refused,
`mt/exdir/sub/f.txt` still there. This is the case that used to leave the
destination already deleted, and it is clean.

**Full round-trip sweep.** Every one of the 21 fixture entries was renamed →
case-flipped → renamed back through `fs_move`, then the byte manifest re-taken:

```
ALL 21 ENTRIES BYTE-IDENTICAL AFTER A FULL fs_move ROUND-TRIP
```

**Audit ground truth.** Scope refusals carry `scope_violation: true`; ordinary
refusals are plain `tool_error`; only real moves are `ok`. No destructive attempt
was ever recorded `ok`, and no refusal was recorded as an empty success.

### Regression test

`tests/move-destroys-data.test.js` at the pre-fix parent `f6baa96` vs the fix `c799779`:

```
-- at parent f6baa96 --   ℹ tests 13  ℹ pass  2  ℹ fail 11
-- at c799779       --   ℹ tests 13  ℹ pass 13  ℹ fail  0
```

Real. 11 of 13 genuinely fail on the pre-fix tree.

### Docs

`src/tools/move.ts` no longer contains `fs.rmSync` in any branch; the tool
description now says *"Deletes nothing: rename(2) is the only syscall this tool
makes"*, which matches the code. CLAUDE.md and README both describe the
directory-destination refusal and the deliberate rejection of the POSIX
move-into reading. Accurate.

### New problems

Only **F3** below (a misleading success on a hardlinked pair). No data problem.

---

## #30: `fs_edit` empty `old_string` — **HOLDS**

### Original repro (verbatim)

```
$ printf 'hello\n' > notes/empt.txt
$ xxd notes/empt.txt
00000000: 6865 6c6c 6f0a                           hello.

$ relayremote call --tool fs_edit --args '{"file_path":"/d0/notes/empt.txt","old_string":"","new_string":"X"}'
old_string must not be empty. An empty search string does not identify a location in the file --
fs_edit would interleave new_string between every character and report that as a successful
replacement. …

$ relayremote call --tool fs_edit --args '{"file_path":"/d0/notes/empt.txt","old_string":"","new_string":"X","replace_all":true}'
old_string must not be empty. …                          <-- replace_all does not unlock it

$ xxd notes/empt.txt
00000000: 6865 6c6c 6f0a                           hello.
```

Does not reproduce, in either spelling. `minLength: 1` is on the schema too.

### Neighbours tested

| case | result | bytes |
|---|---|---|
| whitespace-only `old_string` (`" "` → `"_"`, replace_all) | `Replaced 2` | `61 20 62 20 63 0a` → `61 5f 62 5f 63 0a` ✓ |
| `old_string` = a single newline (`"\n"` → `"|"`) | `Replaced 3` | `one.two.three.` → `one|two|three|` ✓ exact |
| `old_string` longer than the whole file | `old_string not found in file` | unchanged |
| match at the very **start and end** (`XmiddleX` → `YmiddleY`) | `Replaced 2` | 8 bytes → 8 bytes, **no newline added** ✓ |
| `new_string` empty (deletion) | `Replaced 1` | `keep-DELETEME-keep` → `keep--keep` ✓ |
| `old_string` === `new_string` | refused, with the temp-file-rename reasoning | unchanged ✓ |
| `old_string` = the entire file | `Replaced 1` | file becomes 0 bytes ✓ |

**Byte-level before/after on every `data/` fixture:**

```
data/bom-crlf.txt            efbbbf 'BOM first line' 0d0a 'second line' 0d0a
  fs_edit "second" -> "SECOND"
                             efbbbf 'BOM first line' 0d0a 'SECOND line' 0d0a     BOM kept, CRLF kept
data/no-trailing-newline.txt 'line one\nline two\nno trailing newline'   (37 B, no final \n)
  fs_edit "line two" -> "line TWO"
                             'line one\nline TWO\nno trailing newline'   (37 B, still no final \n)
data/emoji.txt               68 c3a9 6c6c6f 20 f09f8c8d 20 6e61 c3af 7665 …
  fs_edit "naïve" -> "naive"
                             68 c3a9 6c6c6f 20 f09f8c8d 20 6e616976 65 …          emoji + é + — intact
data/inventory.csv           edit ok
data/latin1.txt   data/utf16.txt   data/random.bin   data/pixel.png
  -> all four REFUSED: "…'s bytes are not valid UTF-8, so fs_edit cannot represent them as text
     to edit. Use fs_read with encoding: \"base64\" …"   sha256 identical before and after
```

BOM, CRLF and missing-final-newline all round-trip exactly. Non-UTF-8 files are
refused rather than mangled.

### Regression test

`tests/edit-degenerate-strings.test.js` + `tests/list-line-format.test.js` at
parent `c799779` vs fix `62056f6`:

```
-- at parent c799779 --  ℹ tests 11  ℹ pass  2  ℹ fail 9
-- at 62056f6        --  ℹ tests 11  ℹ pass 11  ℹ fail 0
```

Real.

### Docs

Tool description now states both refusals and that `new_string` may be empty.
CLAUDE.md's fidelity section matches. Accurate.

### New problems

**F4** below: `fs_edit` is the one write path with **no inbound wire bound**, so
it accepts content `fs_write` refuses. Not a #30 defect, but it is #19's inbound
half missing a tool.

---

## #28: `fs_list` symlink size — **HOLDS**

```
$ relayremote call --tool fs_list --args '{"path":"/d0"}'
symlink	0	2026-08-26T…	/d0/dangling_link      (target len 20)
symlink	0	2026-08-26T…	/d0/etc_link           (target len  4)
symlink	0	2026-08-26T…	/d0/parent_link        (target len 52)
symlink	0	2026-08-26T…	/d0/passwd_link        (target len 11)
```

All four report `0`. The 52 that used to identify
`/Users/admin/source/barelyworkingcode/outside_secret` by length is gone.
The doc comment above `listOneDir` (`src/tools/list.ts:73-80`) now says
*"a size of ZERO"* and explains that `st_size` **is** the target path length —
i.e. the comment that previously asserted a property the code did not have has
been corrected, which was half of what the issue asked for. The tool description
carries it too: *"size is bytes, and is always 0 for a symlink (a link's own size
measures its target path, which is not yours to read)"*.

---

## #19: bound the response, not the file — **INCOMPLETE**

The availability property is genuinely restored, the ceilings are exact, and
nothing is silently truncated. It is INCOMPLETE for two reasons: **F1**, a false
error message it introduced on an ordinary paging mistake, and **F4**, the
inbound bound that landed on `fs_write` and not on `fs_edit`.

### Original repro (verbatim table from the issue)

```
  1000000 bytes -> refused: over fs_read's 262144-byte per-call base64 ceiling …   survives? 1	TODO: fix the parser
  2000000 bytes -> refused …                                                       survives? 1	TODO: fix the parser
  4000000 bytes -> refused …                                                       survives? 1	TODO: fix the parser
  6000000 bytes -> refused …                                                       survives? 1	TODO: fix the parser
  8000000 bytes -> refused …                                                       survives? 1	TODO: fix the parser
```

The 8 MB row used to kill the MCP. It now refuses cleanly and the server lives.
The global-poisoning check from the issue, run immediately after the 8 MB read:

```
$ for c in ws1 ws2 ws3 ws4; do relayremote call --tool fs_list --args '{}'; done
ws1 -> directory	224	…	/d0/big
ws2 -> symlink	0	…	/d0/dangling_link
ws3 -> symlink	0	…	/d0/dangling_link
ws4 -> symlink	0	…	/d0/dangling_link
```

All four enrolments alive.

### Exact boundaries (measured, not read off the source)

```
base64 whole-file ceiling = 262144 bytes of FILE
  262143 B file -> payload returned
  262144 B file -> payload returned
  262145 B file -> "over fs_read's 262144-byte per-call base64 ceiling … would be 349528 bytes"

base64 byte_length ceiling = 262144 per call
  byte_length 262143 -> ok   262144 -> ok   262145 -> refused, names 262144 as the max

fs_write inbound wire ceiling = 1048576 bytes of `content` on the wire
  text   n=1048575 -> Wrote 1048575 bytes
  text   n=2000000 -> refused, "content is 2000000 bytes on the wire, over fs_write's 1048576-byte
                      message byte limit"                              nothing on disk
  text   200000 x U+0001 (6 wire bytes each) -> refused at 1200000 wire bytes   nothing on disk
  base64 n=786432  -> Wrote 786432 bytes       (= floor(1048576 * 3/4), exactly)
  base64 n=786433  -> refused at 1048580 wire bytes                     nothing on disk
```

Refusals, never truncation: in every over-ceiling case the file did not exist
afterwards. The escaping accounting is real — the control-byte case is refused at
6x, not 1x.

### Ordinary work still fits

**All 16 fixture files, both encodings, plus the whole-file base64 → `fs_write`
identity:**

```
FILE                               TEXT       B64        IDENTITY
data/bom-crlf.txt                  ok         ok         EXACT
data/emoji.txt                     ok         ok         EXACT
data/inventory.csv                 ok         ok         EXACT
data/latin1.txt                    refused    ok         EXACT
data/no-trailing-newline.txt       ok         ok         EXACT
data/pixel.png                     refused    ok         EXACT
data/random.bin                    refused    ok         EXACT
data/utf16.txt                     refused    ok         EXACT
deep/a/b/c/d/buried.txt            ok         ok         EXACT
notes/meeting.md                   ok         ok         EXACT
notes/todo.txt                     ok         ok         EXACT
projects/alpha/README.md           ok         ok         EXACT
projects/alpha/src/config.js       ok         ok         EXACT
projects/alpha/src/index.js        ok         ok         EXACT
projects/beta/notes.txt            ok         ok         EXACT
projects/beta/selfref.conf         ok         ok         EXACT
```

`refused` = text mode correctly declining non-UTF-8. `EXACT` = sha256 of
`fs_write(base64, fs_read(base64, f))` equals sha256 of `f`. The base64 payload
is also byte-identical to `base64 < f | tr -d '\n'` — no header, no framing.

**Text-mode paging reassembles losslessly.** A 3,770,000-byte file of 2,500
lines × 1,500 chars (chosen so the byte budget, not the line limit, ends each
page):

```
page 1: offset=1     bytes=1045637  [fsmcp: showing lines 1-691 of 2501; the page ended at
                                     fs_read's 1048576-byte response limit, before the line limit;
                                     pass offset: 692 to continue reading]
page 2: offset=692   bytes=1045641  … pass offset: 1383 …
page 3: offset=1383  bytes=1045642  … pass offset: 2074 …
page 4: offset=2074  bytes=646056   <none>

reassembled 3770000  orig 3770000  IDENTICAL
```

Pages are contiguous, the continuation offsets are right, and stripping the
`N\t` prefix and joining on `\n` reproduces the original file **byte for byte**.

**Base64 windowing round-trips a binary byte-for-byte.** A 1,000,000-byte random
file read in four 262,144-byte windows, each decoded and concatenated:

```
WINDOWED BASE64 ROUND-TRIP IS BYTE-EXACT
```

The tail window short-reads correctly (213,568 bytes at offset 786,432),
`byte_offset` == file size returns an empty success (correct loop terminator),
and `byte_offset` past that is a clean error naming `total_bytes`.

**Availability after a refusal and after a cap.** `fs_grep -o content` over the
3.77 MB file returned 1,043,433 bytes with
`(showing 682 of 2500 result lines, cut at fs_grep's 1048576-byte response limit)`;
the next `fs_read` succeeded. After a refused 8 MB base64 read, the next
`fs_list` succeeded. Also probed the big-listing path — 6,000 entries with
200-char names — and all four listing tools cap and say so
(`fs_list` 4096 of 6000 "cut at … response limit", `fs_glob` 1000 of 6000,
`fs_find` 200 of 6000), with an ordinary call working immediately afterwards.

### Regression test

`tests/response-limit.test.js` at parent `62056f6` vs fix `e1e5685`:

```
-- at parent 62056f6 --  ℹ tests 13  ℹ pass  2  ℹ fail 11
-- at e1e5685        --  ℹ tests 13  ℹ pass 13  ℹ fail  0
```

Real.

### Docs

CLAUDE.md and README both carry the numbers, the reasoning and the
per-tool behaviour, and they match what I measured. One imprecise sentence —
see **F5**.

### New problems

**F1** (regression) and **F4** (gap). Both below.

---

## #31: `fs_list` separator escaping — **INCOMPLETE**

`fs_list` is fixed, thoroughly, and its description documents the scheme
including the left-to-right decoding rule. The other three tools the issue names
are untouched. Details in **F2**.

---

# Findings

## F1: `fs_read` text mode answers an ordinary out-of-range `offset` (or `limit: 0`) with a false claim about the 1 MiB response limit — REGRESSION from #19

**Severity:** medium
**Component:** fsmcp (`src/tools/read.ts`, the `formatted.length === 0` branch)

**Repro** (`/d0/notes/meeting.md` is 60 bytes, 3 lines + trailing newline):

```
$ relayremote call --tool fs_read --args '{"file_path":"/d0/notes/meeting.md"}'
1	Meeting notes
2	Budget approved: 12000
3	Next review 2026-09-01
4	

$ relayremote call --tool fs_read --args '{"file_path":"/d0/notes/meeting.md","offset":4}'
4	                                                   <-- fine

$ relayremote call --tool fs_read --args '{"file_path":"/d0/notes/meeting.md","offset":5}'
line 5 of /d0/notes/meeting.md does not fit in fs_read's 1048576-byte response limit on its own,
so there is no page to return; read the file's bytes with encoding: "base64" and
byte_offset/byte_length instead

$ relayremote call --tool fs_read --args '{"file_path":"/d0/notes/meeting.md","limit":0}'
line 1 of /d0/notes/meeting.md does not fit in fs_read's 1048576-byte response limit on its own, …

$ : > ord/empty.txt
$ relayremote call --tool fs_read --args '{"file_path":"/d0/ord/empty.txt","offset":2}'
line 2 of /d0/ord/empty.txt does not fit in fs_read's 1048576-byte response limit on its own, …
```

A 60-byte file, and a 0-byte file, are both reported as not fitting in a
1,048,576-byte budget.

**Ground truth — this is new, and it is #19's:** built the parent commit
`e1e5685^` in a scratch clone and drove both builds over bare stdio with the
same argument:

```
PRE-#19 (e1e5685^) -> (None, '')                        empty success
LIVE main          -> (True, "line 99 of /d0/one.txt does not fit in fs_read's 1048576-byte
                              response limit on its own, so there is no page to return; …")
```

The source comment above that branch reads *"Not reachable with MAX_LINE_LENGTH
at 2000 — the widest a single rendered line can be is 2015 characters"*. That
reasoning is about a line being too wide; it misses that `lines` is **empty**
whenever `offset` exceeds the line count or `limit` is 0, and an empty `formatted`
takes the same exit.

**Why it matters in the real deployment:** an agent driving the new paging
contract, or one that guesses an offset, gets told the file's bytes are too big
for the transport and is directed to base64 windowing. It will then either burn
calls windowing a 60-byte text file or conclude the file is unreadable. It is a
diagnostic sending the caller in exactly the wrong direction, on the one path
#19 rewrote. The pre-#19 empty success was not good either; the fix should say
"offset N is past the end of this file, which has M lines".

## F2: #31 was applied to `fs_list` only — `fs_glob`, `fs_grep` and `fs_find` still emit raw `\n`, `\r` and `\t` inside paths

**Severity:** low
**Component:** fsmcp (`src/tools/glob.ts`, `grep.ts`, `find.ts`)

**Repro.** Host-created files (all legal on APFS, and creatable through fsMCP's
own `fs_write`/`fs_move`):

```
two<LF>lines.txt   tab<TAB>here.txt   cr<CR>here.txt   back\slash.txt   esc\nliteral.txt
```

`fs_list` — correct, escaped, one line per entry:

```
file	1	…	/d0/sep/back\\slash.txt
file	1	…	/d0/sep/cr\rhere.txt
file	1	…	/d0/sep/esc\\nliteral.txt
file	1	…	/d0/sep/tab\there.txt
file	1	…	/d0/sep/two\nlines.txt
```

`fs_glob` — raw, `od -c` of the reply:

```
0000000    /   d   0   /   s   e   p   /   e   s   c   \   n   l   i   t
0000020    e   r   a   l   .   t   x   t  \n   /   d   0   /   s   e   p
…
0000100    t  \n   /   d   0   /   s   e   p   /   c   r  \r   h   e   r
0000120    e   .   t   x   t  \n   /   d   0   /   s   e   p   /   t   a
0000140    b  \t   h   e   r   e   .   t   x   t  \n   /   d   0   /   s
0000160    e   p   /   t   w   o  \n   l   i   n   e   s   .   t   x   t
```

`fs_grep` (`files_with_matches`) is identical in shape. Note the ambiguity this
creates: `esc\nliteral.txt` (a real backslash and a real `n` in the name) and
`two<LF>lines.txt` are indistinguishable to any caller that unescapes, and the
tab file silently acquires a field separator. Neither tool's description mentions
escaping.

**Ground truth:** the files are on disk with those exact names (`ls -b`), and
`fs_list` renders all seven as seven lines while `fs_glob` renders six paths as
seven lines.

**Docs are honest about this** — CLAUDE.md says outright *"`fs_glob`, `fs_find`
and `fs_grep` have the same exposure and are NOT fixed"*, and README says they
*"do not escape yet"*. So this is not a doc/code mismatch. It is reported because
`STATUS.md`'s merge log lists #31 as landed, and the issue body asks for the
scheme to be applied *"consistently across all four tools"*. An operator reading
the merge log will believe path output is parseable; for three of the four tools
it is not.

**Why it matters in the real deployment:** `fs_glob` and `fs_grep` are the tools
an agent uses to enumerate a repo. One file with a newline in its name — which a
previous agent can create through `fs_write` — silently splits into two phantom
paths in the caller's parser, and the caller then addresses a path that does not
exist.

## F3: `fs_move` on a hardlinked pair reports "Moved", logs `ok`, and moves nothing

**Severity:** low
**Component:** fsmcp (`src/tools/move.ts`, the `isSameEntry` fall-through)

**Repro:**

```
$ printf 'HARDLINK-DATA\n' > hl/a.txt && ln hl/a.txt hl/b.txt
$ ls -li hl/
4153521 -rw-r--r--  2 admin  staff  14 … a.txt
4153521 -rw-r--r--  2 admin  staff  14 … b.txt

$ relayremote call --tool fs_move --args '{"source":"/d0/hl/a.txt","destination":"/d0/hl/b.txt"}'
Moved /d0/hl/a.txt to /d0/hl/b.txt

$ ls -li hl/
4153521 -rw-r--r--  2 admin  staff  14 … a.txt        <-- source still here
4153521 -rw-r--r--  2 admin  staff  14 … b.txt
```

**Ground truth:**

```
09:07:05  ok  WS1 Corruption  fsmcp  fs_move  5  ws1  {"destination":"/d0/hl/b.txt","source":"/d0/hl/a.txt"}
```

Both names present, same inode, data intact. Note also that **`overwrite` was not
passed** and the destination did exist as a distinct name — the
`destination already exists (pass overwrite: true)` guard is bypassed for a
hardlinked pair, because `isSameEntry` is consulted first.

**This is not a bug in the fix's safety property** — nothing is destroyed, and
`rename(2)` is specified to do exactly this. It is the "a success that did
something different from what it said" case the brief calls a finding: the reply
and the audit row both assert a move that did not happen. `/bin/mv` says nothing
either, but `/bin/mv` is not writing an operator's audit log. A caller that
believes `a.txt` is gone and later finds it will not know which of its own
assumptions to distrust. The right answer is the wording already used for the
self-move case: *"`a.txt` and `b.txt` are two names for the same file; nothing to
move"*.

## F4: `fs_edit` has no inbound wire bound, so it writes content `fs_write` refuses

**Severity:** low
**Component:** fsmcp (`src/tools/edit.ts`)

Issue #19 asks for `fs_write` to get the inbound audit. It got one
(`MAX_CONTENT_WIRE_BYTES`, measured with `wireBytes`). `fs_edit` — the other tool
that takes arbitrary caller content and puts it on disk — imports nothing from
`limits.ts` and bounds neither `old_string` nor `new_string`.

**Repro:**

```
fs_write, content = 2,000,000 bytes
  -> content is 2000000 bytes on the wire, over fs_write's 1048576-byte message byte limit …
  -> nothing on disk

fs_edit, new_string = 3,000,000 bytes (request line 3,000,074 bytes)
  -> Replaced 1 occurrence(s) in /d0/wb/target.txt
  -> disk size: 3000000
```

**Ground truth:** the 3 MB file exists on disk and reads back correctly; audit
records `ok`.

**Availability is currently saved by relay, not by fsmcp.** At 12,000,000 bytes:

```
error: malformed request: message exceeds maximum size of 10485760 bytes
```

and both `ws1` and `ws2` were alive immediately afterwards. So this is **not** a
live outage — relay's own 10 MiB inbound cap catches it. It is a consistency gap:
the effective inbound ceiling is 1 MiB via `fs_write` and ~10 MiB via `fs_edit`,
and fsMCP's stated rule ("fsMCP bounds what crosses the stdio transport, not just
what lands on disk") is only true of one of them. A standalone fsMCP, or one
behind a broker with a different frame cap, has no inbound bound on `fs_edit` at
all.

## F5: README claims text pages "reassemble the file exactly" without the long-line qualification

**Severity:** low
**Component:** fsmcp (README.md, "What each tool does when it hits the bound")

The bullet reads: *"This is pagination, not truncation: it names the offset to
resume from, and successive pages reassemble the file exactly."* That is true for
lines under `MAX_LINE_LENGTH` (I verified it on 3,770,000 bytes) and false for
any file with a longer line:

```
$ python3 -c "open(p,'w').write('short one\n' + 'A'*5000 + '\n' + 'short two\n')"   # 5021 bytes
$ relayremote call --tool fs_read --args '{"file_path":"/d0/page/longline.txt"}'
1	short one
2	AAAA…AAAA... [truncated]
3	short two
4	
    _meta = {"truncated": true}
reassembled 2036  orig 5021  NOT EQUAL
```

The mechanism is honest — the inline `... [truncated]` marker and
`_meta.truncated: true` both fire, and CLAUDE.md's fidelity section is explicit
that text mode is a view. Only this one sentence, in the section a reader goes to
for the paging contract, states an unconditional identity. Worth one clause,
because the surrounding paragraph is what a caller will build a reassembly loop
against.

## F6: relay still substitutes U+FFFD for a lone surrogate before fsMCP can refuse it — fsMCP's half verified intact

**Severity:** high (corruption, live in the shipped stack)
**Component:** relay (the installed `Relay.app`, pre-`#40`) — **not** fsmcp

Checked at the review lead's request. Both halves, separately.

**Through the deployed stack (relayremote → installed Relay.app → fsmcp):**

```
$ relayremote call --tool fs_write --args '{"file_path":"/d0/relaysur/a.txt","content":"a\ud800b"}'
Wrote 5 bytes to /d0/relaysur/a.txt
$ xxd relaysur/a.txt
00000000: 61ef bfbd 62                             a...b          <-- U+FFFD substituted

$ relayremote call --tool fs_edit --args '{"file_path":"/d0/relaysur/b.txt","old_string":"hello","new_string":"x\udc00y"}'
Replaced 1 occurrence(s) in /d0/relaysur/b.txt
$ xxd relaysur/b.txt
00000000: 78ef bfbd 79                             x...y
```

`relay audit` shows the substitution had already happened before relay logged the
call (`{"…","new_string":"x�y",…}`), and `relayRemote/cli.go:378` passes the
argument through as `json.RawMessage` without unmarshalling, so the rewrite is on
the relay side. Consistent with `#40`.

**fsMCP's own half, over bare stdio to `dist/main.js` with
`_meta.allowed_dirs` injected by hand — intact:**

```
id 1 isError True  -> content contains a lone (unpaired) UTF-16 surrogate, which has no valid UTF-8
                      encoding -- writing it would silently substitute U+FFFD for it. …
id 3 isError True  -> new_string contains a lone (unpaired) UTF-16 surrogate, …
id 4 isError None  -> Wrote 6 bytes to /d0/sur/c.txt     ("e🌍f" — a well-formed PAIR)
disk: sur/c.txt = 65 f09f8c8d 66                          the emoji, correct UTF-8
      sur/a.txt = does not exist                          nothing written on refusal
```

So the refusal fires on both `fs_write.content` and `fs_edit.new_string`, writes
nothing, and does not over-refuse a legitimate surrogate pair. **It will start
working end to end the moment relay is rebuilt.**

**The other relay rewrites, tested for byte impact on a file:**

| rewrite | effect on file bytes |
|---|---|
| `<` `>` `&` in `content` | **none.** Relay escapes them to `<` etc. in its audit, they decode back identically: disk = `3c61 3e20 2620 3c2f 613e` = `<a> & </a>` |
| a large integer inside a JSON **string** | **none.** `id=9007199254740993 big=123456789012345678901234567890` written verbatim, 54 bytes |
| a large integer as a JSON **number** argument | **rounded.** `byte_offset: 9007199254740993` reached fsmcp as `9007199254740992` (audit confirms). Harmless in practice — every numeric argument here (`offset`, `limit`, `byte_offset`, `byte_length`) is a file position, and 2^53 bytes is not a reachable file — but it is the float64 round-trip, observed live |
| duplicate keys | **last wins.** `{"file_path":"…/e1.txt","file_path":"…/e2.txt","content":"DUP"}` wrote `e2.txt`. The audit row also records `e2.txt`, so the log matches what happened — no audit divergence |

Only the surrogate case changes a byte. The others are worth knowing about but do
not corrupt content.

## F7: basenames over 231 characters still cannot be written or edited

**Severity:** low
**Component:** fsmcp (`src/atomicWrite.ts`)

Named in issue #31 as a related item, conditional on the temp naming being
touched. It was not, so it is still live — recording it so the operator knows the
#31 merge did not cover it:

```
$ relayremote call --tool fs_write --args '{"file_path":"/d0/longname/<240 a's>","content":"hello"}'
ENAMETOOLONG: name too long, open '/d0/longname/.aaaa…aaa.fsmcp-tmp-'

$ printf 'hello\n' > "longname/<240 a's>.host"      # host-created
$ relayremote call --tool fs_edit --args '{"file_path":"/d0/longname/<240 a's>.host","old_string":"hello","new_string":"world"}'
ENAMETOOLONG: name too long, open '/d0/longname/.aaaa…aaa.host.fsmcp'
$ cat "longname/<240 a's>.host"
hello                                               <-- unchanged, so at least nothing is lost

$ relayremote call --tool fs_write --args '{"file_path":"/d0/longname/<200 a's>","content":"ok"}'
Wrote 2 bytes …                                     <-- 200 is fine
```

The file is readable and listable but permanently unwritable. Fails safe (no
corruption), so low.

---

## Verified working

Everything in this list was exercised end to end through
`relayremote → relay → fsmcp → disk` and checked against the disk (`shasum`,
`xxd`, `ls -li`, `find`) and `relay audit`, never against the tool's reply.

**`fs_move` — data preservation (the whole point of #23)**
- Case-only rename works with no flag and preserves the file's sha256.
- Both of the issue's original repros are dead.
- File → existing file with `overwrite`: atomic replace, correct bytes, source gone.
- File or directory → **non-empty** directory: refused, tree intact, and the refusal names the correct call.
- Directory → **empty** directory with `overwrite`: succeeds, whole subtree arrives intact.
- Symlink destination (live and dangling): the link is replaced, the link's target is untouched.
- Symlink source: the link moves, its target is untouched.
- Directory → existing file, and destination parent missing: clean errors, nothing changed at either endpoint.
- Cross-device (real HFS+ RAM disk mounted inside the grant), file→existing-file and dir→empty-dir: EXDEV refusal, **destination not deleted**, source not deleted.
- Self-move and `.` / `..` aliases: reported as already-in-place, file intact.
- Symlinks out of the grant, as source or destination or as a path prefix: `scope_violation: true`, `/etc/passwd` and `outside_secret/` untouched.
- Grant root as destination (four spellings) and as source: refused.
- **Full round-trip of all 21 fixture entries through `fs_move`: byte manifest identical.**

**`fs_edit`**
- Empty `old_string` refused with and without `replace_all`; file unchanged.
- `old_string === new_string` refused; file unchanged.
- Whitespace-only, single-newline, whole-file, longer-than-file, start-and-end, and empty-`new_string` (deletion) cases all byte-correct.
- BOM+CRLF, missing-final-newline and multibyte-UTF-8 fixtures round-trip exactly through an edit.
- All four non-UTF-8 fixtures (`latin1`, `utf16`, `random.bin`, `pixel.png`) refused, sha256 unchanged.
- Lone UTF-16 surrogate in `new_string` refused at the fsMCP layer (bare stdio); a well-formed surrogate pair accepted and encoded correctly.

**`fs_read` / limits (#19)**
- 1/2/4/6/8 MB base64 reads all refuse cleanly; server survives every one; four unrelated enrolments alive afterwards.
- Ceilings are exact at 262,144 (base64 file and `byte_length`) and 1,048,576 (response, and `fs_write` inbound content wire bytes), with no off-by-one and no truncation on either side.
- All 16 fixture files read in both encodings; whole-file base64 → `fs_write` is a byte identity for every one.
- Base64 payload is bare — identical to `base64 | tr -d '\n'` — so the read→write composition works unmodified.
- Windowed base64 round-trips a 1,000,000-byte binary byte-for-byte in four windows; tail short-read, EOF and past-EOF all behave.
- Text paging reassembles a 3,770,000-byte file byte-for-byte across four byte-budget-terminated pages, with correct continuation offsets and a note that distinguishes the byte bound from the line bound.
- `fs_grep` content mode, and `fs_list`/`fs_glob`/`fs_find` on a 6,000-entry directory of 200-char names, all cap and report `(showing X of Y)` with the real Y.
- An ordinary call succeeds immediately after a refused large read and after a capped grep.
- Ordinary small cases unaffected: empty file (text and base64), `limit: 1`, `fs_write` with empty content.

**`fs_list` (#31/#28)**
- Symlink sizes all report 0; the target-length oracle is gone.
- Newline, CR, tab and literal-backslash filenames are escaped, one entry stays one line, and the description documents the scheme including decode order.

**Cross-cutting**
- Unit suite on current `main` (`d300396`), scratch clone: **307 passed, 0 failed**.
- All three repairs' regression tests genuinely fail on their pre-fix parent and pass on the fix (11/13, 9/11, 11/13 failures respectively).
- Acceptance gate: **21 passed, 2 failed**, both `#20`. Fixture byte manifest identical before and after the acceptance run.
- Audit classification is correct throughout: scope refusals carry `scope_violation: true`, ordinary refusals are `tool_error`, only real mutations are `ok`, and no refusal came back as an empty success.
