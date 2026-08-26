#!/usr/bin/env python3
"""ACCEPTANCE sections B, C, E, G — driven over real stdio, checked against disk."""
import os, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from drive import *  # noqa

section("B1: case-only rename on case-insensitive APFS")
before = disk_sha("notes/meeting.md")
show("meeting.md -> Meeting.md", call("fs_move", {"source": "notes/meeting.md", "destination": "notes/Meeting.md"}))
after = disk_sha("notes/Meeting.md")
check("content intact", before is not None and before == after, f"{str(before)[:12]} -> {str(after)[:12]}")
check("exactly one entry", sum(1 for f in os.listdir(ROOT + "/notes") if f.lower() == "meeting.md") == 1)

section("B3/B4/B5/B7: move never destroys")
for label, a in [("self-move", {"source": "notes/config.txt", "destination": "notes/config.txt"}),
                 ("onto existing file", {"source": "notes/config.txt", "destination": "notes/repeat.txt"}),
                 ("onto non-empty dir", {"source": "notes/config.txt", "destination": "src"}),
                 ("root as source", {"source": ".", "destination": "moved"})]:
    show(label, call("fs_move", a))
check("both files still present", os.path.exists(ROOT+"/notes/config.txt") and os.path.exists(ROOT+"/notes/repeat.txt"))

section("C1/C2/C3: xattr + ACL + mode survive a replace")
bx, ba = meta("src/attrs.txt"); bmode = os.stat(ROOT+"/src/attrs.txt").st_mode & 0o7777
r = show("replace attrs.txt", call("fs_replace", {"path": "src/attrs.txt", "if_sha256": stat_sha("src/attrs.txt"),
                                                  "edits": [{"find": "attrs", "replace": "ATTRS"}]}))
ax, aa = meta("src/attrs.txt")
check("replace actually ran", r.get("ok") is True)
check("xattr identical", bx == ax, "" if bx == ax else f"\n    {bx!r}\n    {ax!r}")
check("ACL identical", ba == aa, "" if ba == aa else f"\n    {ba!r}\n    {aa!r}")
check("mode identical", bmode == os.stat(ROOT+"/src/attrs.txt").st_mode & 0o7777, oct(bmode))
check("content changed on disk", open(ROOT+"/src/attrs.txt","rb").read() == b"ATTRS\n")

section("deny-delete target: refused, not worked around")
bg = disk_sha("src/guarded.txt"); _, bga = meta("src/guarded.txt")
r = show("replace guarded.txt", call("fs_replace", {"path": "src/guarded.txt", "if_sha256": stat_sha("src/guarded.txt"),
                                                    "edits": [{"find": "protected", "replace": "OVERWRITTEN"}]}))
check("refused", r.get("ok") is False)
check("content unchanged", bg == disk_sha("src/guarded.txt"))
check("its ACL still intact", bga == meta("src/guarded.txt")[1])
check("no temp litter", temp_leftovers() == [], str(temp_leftovers()))

section("D9 (inverted): editing a file that is NOT valid UTF-8")
raw_before = open(ROOT+"/notes/latin1.txt","rb").read()
r = show("ok=1 -> ok=2 in latin1.txt", call("fs_replace", {"path": "notes/latin1.txt", "if_sha256": stat_sha("notes/latin1.txt"),
                                                           "edits": [{"find": "ok=1", "replace": "ok=2"}]}))
raw_after = open(ROOT+"/notes/latin1.txt","rb").read()
check("succeeded", r.get("ok") is True)
check("edit applied", raw_after.startswith(b"ok=2"))
check("non-UTF-8 bytes untouched", b"\xff\xfe" in raw_after, repr(raw_after))

section("D2/D3/D4: BOM + CRLF + no-final-newline survive")
b = open(ROOT+"/notes/crlf-bom.txt","rb").read()
r = show("b=2 -> b=9", call("fs_replace", {"path": "notes/crlf-bom.txt", "if_sha256": stat_sha("notes/crlf-bom.txt"),
                                            "edits": [{"find": "CRLF", "replace": "crlf"}]}))
a = open(ROOT+"/notes/crlf-bom.txt","rb").read()
check("succeeded", r.get("ok") is True)
check("BOM preserved", a.startswith(b"\xef\xbb\xbf"))
check("CRLF preserved", b"\r\n" in a)
check("still no final newline", not a.endswith(b"\n"), repr(a[-12:]))

section("E4/E5/E7/E9/E10/E11: replace semantics")
h = stat_sha("notes/repeat.txt")
show("E4 ambiguous, no all", call("fs_replace", {"path":"notes/repeat.txt","if_sha256":h,"edits":[{"find":"x","replace":"y"}]}))
show("E5 all:true", call("fs_replace", {"path":"notes/repeat.txt","if_sha256":h,"edits":[{"find":"x","replace":"y","all":True}]}))
pre = disk_sha("notes/nofinalnl.txt")
show("E7 batch, 2nd edit fails", call("fs_replace", {"path":"notes/nofinalnl.txt","if_sha256":stat_sha("notes/nofinalnl.txt"),
     "edits":[{"find":"plain","replace":"PLAIN"},{"find":"zzz","replace":"Z"}]}))
check("E7 nothing written", pre == disk_sha("notes/nofinalnl.txt"))
show("E9 wrong if_sha256", call("fs_replace", {"path":"notes/utf8.txt","if_sha256":"0"*64,"edits":[{"find":"h","replace":"H"}]}))
show("E10 null on existing", call("fs_write", {"path":"notes/utf8.txt","content":"x","if_sha256":None}))
show("E11 absent if_sha256", call("fs_write", {"path":"notes/new.txt","content":"x"}))
show("create with null", call("fs_write", {"path":"notes/new.txt","content":"created","if_sha256":None}))

section("G1/G2/G3: deletion")
show("G1 delete root", call("fs_delete", {"path": "."}))
show("G2 non-empty, no flag", call("fs_delete", {"path": "notes"}))
canary = open(OUTSIDE+"/secret.txt","rb").read()
show("G3 recursive over symlink", call("fs_delete", {"path": "link-out-dir", "recursive": True}))
check("outside canary intact", open(OUTSIDE+"/secret.txt","rb").read() == canary)
check("outside/secretdir intact", os.path.isdir(OUTSIDE+"/secretdir"))

section("leftovers")
check("no temp files anywhere", temp_leftovers() == [], str(temp_leftovers()))

print("\n%d check(s) failed%s" % (len(FAILS), (": " + ", ".join(FAILS)) if FAILS else ""))
sys.exit(1 if FAILS else 0)
