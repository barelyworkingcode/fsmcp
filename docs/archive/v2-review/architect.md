# Architect lens — findings

Run against the live stack (relayremote -> relay 127.0.0.1:9910 -> fsmcp -> disk).

## F1: fs_edit / fs_write silently destroy extended attributes and ACLs

**Severity:** high (silent metadata loss on a success result, on the platform the product ships to)
**Component:** fsmcp (`src/atomicWrite.ts`)

`writeFileAtomic` writes a temp file and `rename()`s it over the target. That
replaces the inode. It carefully preserves the permission bits (`mode`), and
nothing else: **extended attributes and ACLs are gone**, with a success result
and no warning.

On macOS xattrs are not exotic. Finder tags, Finder comments, Spotlight
metadata, the quarantine flag, and app-specific state all live there.

**Repro**

```
$ cd testfolder
$ printf 'original content\nline two\n' > meta/tagged.txt
$ xattr -w com.apple.metadata:_kMDItemUserTags 'bplist-tag' meta/tagged.txt
$ xattr -w user.custom 'important-xattr-value' meta/tagged.txt
$ chmod 0754 meta/tagged.txt
$ xattr -l meta/tagged.txt
com.apple.metadata:_kMDItemUserTags     10
user.custom     21

$ relayremote call --tool fs_edit --args '{"file_path":"/d0/meta/tagged.txt",
    "old_string":"original content","new_string":"edited content"}'
Replaced 1 occurrence(s) in /d0/meta/tagged.txt

$ xattr -l meta/tagged.txt
                        <-- nothing. Both attributes destroyed.
$ stat -f '%N mode=%p' meta/tagged.txt
meta/tagged.txt mode=100754      <-- mode WAS preserved
```

Same for ACLs:

```
$ printf 'acl file\n' > meta/acl.txt
$ chmod +a "staff allow read,write" meta/acl.txt
$ ls -le meta/acl.txt
-rw-r--r--+ 1 admin staff 9 ... meta/acl.txt
 0: group:staff allow read,write

$ relayremote call --tool fs_edit --args '{"file_path":"/d0/meta/acl.txt",
    "old_string":"acl file","new_string":"acl edited"}'
Replaced 1 occurrence(s) in /d0/meta/acl.txt

$ ls -le meta/acl.txt
-rw-r--r--  1 admin staff 11 ... meta/acl.txt      <-- the "+" and the ACL are gone
```

**Ground truth:** audit shows `ok` for both calls. The file content is correct;
the metadata is destroyed.

**Why it matters in the real deployment:** the user's stated first priority is
"no file corruption." A user who tags files in Finder, or whose org sets ACLs on
a shared folder, loses that on every single edit the agent makes, silently, with
the audit log recording a clean `ok`. `atomicWrite.ts`'s doc comment reasons
carefully about exactly this class of loss for the mode bit ("trading one silent
corruption for another") and then stops one field short.

## F2: a "deny delete" ACL turns an ordinary edit into a confusing EACCES

**Severity:** low
**Component:** fsmcp (`src/atomicWrite.ts`)

With `chmod +a "everyone deny delete"` on the target, `rename()` fails and the
client is told:

```
EACCES: permission denied, rename '/d0/meta/.tagged.txt.fsmcp-tmp-50270de08576'
  -> '/d0/meta/tagged.txt'
```

Correct failure (the file was not touched, no temp file left behind, paths
correctly virtualised), but the message describes fsmcp's internal temp-file
mechanism rather than the caller's problem, and the caller cannot act on it.
A direct `writeFileSync` would have succeeded here.

## F3: recursive fs_glob returns an EMPTY SUCCESS when the granted root is a symlink

**Severity:** high (an empty result where a refusal or an answer belongs — the
one failure mode the runbook singles out as "something else is broken")
**Component:** fsmcp (`src/tools/glob.ts`)

If the operator grants a directory that is reached through a symlink, `fs_glob`
with a recursive pattern returns nothing at all, while every other search tool
works correctly. The client is told, on a success result, that the folder is
empty.

**Repro** — grant `fsmcp-review/symlinked_root`, a symlink to `real_target`,
which contains `sub/file.txt`:

```
$ relayremote call --json --tool fs_glob --args '{"pattern":"**/*.txt"}'
{"content":[{"type":"text","text":""}]}

$ relayremote call --json --tool fs_glob --args '{"pattern":"**/*.txt","path":"/d0"}'
{"content":[{"type":"text","text":""}]}

$ relayremote call --json --tool fs_glob --args '{"pattern":"sub/*.txt"}'
{"content":[{"type":"text","text":"/d0/sub/new.txt\n/d0/sub/file.txt"}]}   <-- works

$ relayremote call --tool fs_find --args '{"pattern":"file"}'
/d0/sub/file.txt                                                          <-- works
$ relayremote call --tool fs_grep --args '{"pattern":"behind"}'
/d0/sub/file.txt                                                          <-- works
$ relayremote call --tool fs_list --args '{"path":"/d0/sub"}'
file    24      ...     /d0/sub/file.txt                                  <-- works
```

**Cause**, isolated against the `glob` package directly:

```
$ node -e "const {globSync}=require('glob'); ...
symlinked_root  '**/*' -> []
real_target     '**/*' -> ['.../real_target/sub/new.txt','.../real_target/sub/file.txt']
```

`glob.ts` passes `{ cwd: dir }` with the default `follow: false`, and `dir` is
itself the symlink, so `**` never descends. A literal first component
(`sub/*.txt`) sidesteps the `**` walk and works, which is why the failure looks
intermittent.

The obvious fix — canonicalise the search directory before handing it to
`globSync` — is not sufficient on its own: `hostToVirtual` (`src/vpath.ts:310`)
maps outbound paths by a plain string prefix against the **unresolved**
`hostDir`, so hits under the resolved path would then all come back as the
redaction placeholder instead. Both halves have to move together.

**Why it matters in the real deployment:** on macOS a granted path can go
through a symlink without the operator thinking about it — `/tmp`, a relocated
home directory, a folder on an external volume reached through a link, a
Dropbox/iCloud alias. The agent then reports the folder is empty and acts on
that, and the operator has no signal: the audit log says `ok`.

## Verified working

- Full stack up: fsmcp registered with relay, two access profiles (`write` /
  `read`), enrolments issued, remote mTLS listener serving `relayremote`.
- `access: read` admits exactly the 5 `readOnlyHint: true` tools; `access:
  write` admits all 10.
- Relay honours `disclose: "count"` — every one of the 10 tool descriptions
  renders `Scope: ... — confined to 1 value.` with no host path, on both
  `relayremote list` and `list --schema`.
- Real hermes agent, driven end to end against the grant: normal read work
  succeeded; a deliberate 18-vector escape attempt (symlinks, `..`, absolute
  host paths, URL-encoded traversal, search tools as a read oracle) produced
  zero successes. **Ground truth confirmed independently:** every out-of-scope
  call is `tool_error` in `relay audit`, every `ok` row is an in-scope path, the
  out-of-tree canaries' checksums are unchanged, and `/etc/passwd` is unchanged.
- Symlinks pointing *within* the grant work correctly and consistently: read,
  list and write through `notes_link -> notes` all land on the real directory,
  and `fs_grep` reports the canonical in-scope name.
- Permission bits, including the execute bit on a shell script, survive
  `fs_edit` (mode 100755 preserved).
- No temp file is left behind after either a successful or a failed atomic
  write.
- A TCC-protected location (`~/Documents`) is readable and writable through the
  grant on this host, with no consent prompt raised at call time.
- Hardlinks are broken by `fs_write`/`fs_edit` (new inode, sibling keeps the old
  content). This is the documented and correct trade for atomic replace, noted
  here as expected behaviour rather than a finding — but it belongs in the
  README's atomic-write paragraph, which currently discusses only disk headroom.

## F4 (CRITICAL): reading a file larger than ~7.9 MB permanently kills fsMCP for every client until relay is restarted

**Severity:** critical (self-inflicted, permanent denial of the whole capability, triggered by an ordinary agent action, affecting every grant at once)
**Component:** relay (`external_mcp.go` readLoop) + fsmcp (`src/tools/read.ts`) — the two disagree about a limit

fsMCP will read and return any file up to **10 MiB** (`MAX_READ_BYTES = 10 * 1024 * 1024`, `src/tools/read.ts:26`).
Relay reads a stdio MCP's stdout with a scanner capped at **10 MiB per line**
(`bridge.MaxMessageSize`, `bridge/types.go:13`, used at `external_mcp.go:844`).

Base64 inflates by 4/3, so a file over ~7.86 MB produces a response line over
relay's cap. fsMCP writes it happily; relay's scanner returns `bufio.ErrTooLong`,
`readLoop` exits, `readerErr` is set — **and nothing respawns the child.** Every
later call, on every profile, from every enrolled client, fails with the same
error until an operator restarts relay. fsMCP's own 10 MiB refusal can never fire
in a relay deployment; the transport breaks first.

**Repro** (each row: the big read, then an ordinary small read to test survival):

```
  1000000 -> 1333401 bytes returned OK      survives? 1  TODO: fix the parser
  2000000 -> 2666733 bytes returned OK      survives? 1  TODO: fix the parser
  4000000 -> 5333401 bytes returned OK      survives? 1  TODO: fix the parser
  6000000 -> 8000065 bytes returned OK      survives? 1  TODO: fix the parser
  8000000 -> error: relay error: external MCP call failed: read response:
            survives? error: relay error: external MCP call failed:
                      read response: bufio.Scanner: token too long
```

And the poisoning is global, not per-client. After one 9 MB read on the
`hermes-files` grant, four unrelated enrolments on four unrelated profiles all
went down together:

```
$ for c in ws1 ws2 ws3 ws4; do relayremote call --tool fs_list --args '{}'; done
ws1 -> error: relay error: external MCP call failed: read response: EOF
ws2 -> error: relay error: external MCP call failed: read response: EOF
ws3 -> error: relay error: external MCP call failed: read response: EOF
ws4 -> error: relay error: external MCP call failed: read response: EOF
```

Recovery required killing and relaunching Relay.app. There is no lighter remedy
and no automatic one.

**Ground truth:** `relay audit` records the call; the child process is gone from
`ps`; nothing in the tray reports a dead MCP.

**Why it matters in the real deployment:** "read this PDF", "read this image",
"read this log" are ordinary requests, and 8 MB is an ordinary file. The agent
does nothing wrong and gets no usable error. The operator's filesystem grant —
and any other grant served by the same MCP — is dead until they notice and
restart the tray app. This is also a trivially reachable denial-of-service for a
semi-trusted agent that wants one: write an 8 MB file, read it back.

Three separate defects sit behind it, and all three want fixing:

1. **fsMCP emits a payload it cannot know the transport will carry.** Its limit
   is on the *file*, not on the *response*; base64's 4/3 expansion is not
   accounted for anywhere.
2. **Relay does not treat an oversized frame as a recoverable condition.** It
   tears down the connection and leaves it torn down. A child that produced one
   over-long line is not necessarily broken, and even if it were, respawning is
   the obvious remedy.
3. **Relay does not respawn a dead external MCP child at all**, for any cause.
   One wedged child is a permanent outage for every grant that MCP serves.

## F5 (hypothesis, needs confirming): a call made immediately after relay starts is answered as though the grant were empty

**Severity:** medium if confirmed
**Component:** relay

Immediately after relaunching Relay.app, four of five clients got

    no allowed directories are configured; refusing all path access.
    Start fsmcp with --allowed-dir <path>, or pass allowed_dirs via _meta.

while one (`ws3`) got a correct listing. Three seconds later all five were
correct, with no configuration change in between. That reads like relay routing a
call before it has resolved the MCP's context schema, and injecting no
`_meta.allowed_dirs` as a result.

It fails in the safe direction — an empty scope denies rather than allows — but
the client is told, with a scope-violation result, that it has no grant at all,
which is a different and wrong statement. An agent that starts with the machine
would conclude it has no filesystem access.

Labelled a hypothesis because it was observed once, in passing, while recovering
from F4. It needs a deliberate restart-then-call-immediately reproduction before
it is reported as fact.
