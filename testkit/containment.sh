#!/bin/bash
# Layer-1 containment battery (ACCEPTANCE.md section A), driven over real stdio.
# usage: containment.sh <binary> <root>
BIN="$1"; ROOT="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"

fmt() {
  python3 -c '
import sys, json
raw = sys.stdin.read().strip()
if not raw:
    print("NO REPLY"); sys.exit()
try:
    d = json.loads(json.loads(raw)["result"]["content"][0]["text"])
except Exception as e:
    print("UNPARSEABLE:", raw[:120]); sys.exit()
if d.get("ok"):
    print("OK    ", {k: d[k] for k in ("path","type","size") if k in d})
else:
    e = d.get("error", {})
    print("REFUSE", e.get("code"), "|", e.get("message"))
'
}

run() { printf '%-32s %s\n' "$1" "$("$HERE/call.sh" "$BIN" "$ROOT" fs_stat "$2" | fmt)"; }

echo "──── containment ────"
run "A1  absolute /etc/passwd"    '{"path":"/etc/passwd"}'
run "A2  ../.. traversal"         '{"path":"../../outside/secret.txt"}'
run "A2b deep traversal"          '{"path":"notes/../../outside/secret.txt"}'
run "A3  symlink -> file outside" '{"path":"link-out-file"}'
run "A3b THROUGH symlinked dir"   '{"path":"link-out-dir/c.txt"}'
run "A4  dangling symlink"        '{"path":"link-out-dangling"}'
run "A5  symlink -> /etc"         '{"path":"link-etc/passwd"}'
run "A6  symlink cycle"           '{"path":"cycle-a"}'
run "A7  NUL byte in path"        "$(printf '{"path":"notes/con\\u0000fig.txt"}')"
run "A8  legit inside symlink"    '{"path":"link-in-dir/config.txt"}'
run "A9  root as ."               '{"path":"."}'
run "A9b root as empty string"    '{"path":""}'

echo "──── ordinary ────"
run "plain file"                  '{"path":"notes/config.txt"}'
run "leading slash, inside root"  '{"path":"/notes/config.txt"}'
run "newline in filename"         '{"path":"notes/we\nird.txt"}'
run "tab in filename"             '{"path":"notes/ta\tb.txt"}'
run "quote in filename"           '{"path":"notes/qu\"ote.txt"}'
run "non-utf8 file"               '{"path":"notes/latin1.txt"}'
run "missing file"                '{"path":"notes/nope.txt"}'
run "directory"                   '{"path":"notes"}'
