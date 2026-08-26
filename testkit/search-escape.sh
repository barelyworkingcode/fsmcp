#!/bin/bash
# ripgrep runs as a subprocess, outside os.Root's openat protection. This is
# the battery that proves the walk still cannot leave the root.
# usage: search-escape.sh <binary> <root> <outside-dir>
BIN="$1"; ROOT="$2"; OUTSIDE="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"

payload() { python3 -c '
import sys, json
raw = sys.stdin.read().strip()
try:
    d = json.loads(json.loads(raw)["result"]["content"][0]["text"])
except Exception:
    print("UNPARSEABLE:", raw[:100]); sys.exit()
if d.get("ok"):
    hits = d.get("paths", d.get("matches", []))
    print("OK    ", len(hits), "hit(s):", json.dumps(hits)[:110])
else:
    print("REFUSE", d["error"]["code"], "|", d["error"]["message"][:80])
'; }

t() { printf '%-46s %s\n' "$1" "$("$HERE/call.sh" "$BIN" "$ROOT" "$2" "$3" | payload)"; }

echo "── can the walk reach the canary outside the root? ──"
t "glob **/secret.txt"          fs_glob '{"pattern":"**/secret.txt"}'
t "glob through escaping symlink" fs_glob '{"pattern":"link-out-dir/**"}'
t "grep for the canary text"     fs_grep '{"pattern":"TOP SECRET"}'
t "grep with path=escaping link" fs_grep '{"pattern":".","path":"link-out-dir"}'
t "grep with path=../outside"    fs_grep '{"pattern":".","path":"../outside"}'

echo
echo "── pattern/argument injection ──"
rm -f /tmp/pwned_search
t "command substitution"         fs_grep '{"pattern":"$(touch /tmp/pwned_search)"}'
t "backticks"                    fs_grep '{"pattern":"`touch /tmp/pwned_search`"}'
t "semicolon + redirect"         fs_grep '{"pattern":"x; touch /tmp/pwned_search"}'
t "pattern that looks like a flag" fs_grep '{"pattern":"-l"}'
t "glob pattern that looks like a flag" fs_glob '{"pattern":"--follow"}'
printf '%-46s %s\n' "no file created by any of the above" \
  "$([ -e /tmp/pwned_search ] && echo "FAIL: /tmp/pwned_search exists" || echo PASS)"

echo
echo "── the search DIRECTORY cannot be a flag ──"
# The caller supplies a path, and fs_mkdir will create a directory under any
# name — so the argument is caller-controlled in a way the pattern is not.
# These names are created here rather than by mkfixture.sh, because "an agent
# can manufacture its own" is the half of the hazard worth showing.
rm -f /tmp/pwned_pre
t "mkdir a dir named --follow"   fs_mkdir '{"path":"--follow"}'
t "grep with path=--follow"      fs_grep '{"pattern":"TOP SECRET","path":"--follow"}'
t "glob with path=--follow"      fs_glob '{"pattern":"*","path":"--follow"}'
"$HERE/call.sh" "$BIN" "$ROOT" fs_write \
  '{"path":"_payload.txt","content":"touch /tmp/pwned_pre\n","if_sha256":null}' >/dev/null
t "mkdir a dir named --pre=/bin/sh" fs_mkdir '{"path":"--pre=/bin/sh"}'
t "grep with path=--pre=/bin/sh" fs_grep '{"pattern":"x","path":"--pre=/bin/sh"}'
printf '%-46s %s\n' "rg executed nothing" \
  "$([ -e /tmp/pwned_pre ] && echo "FAIL: /tmp/pwned_pre exists" || echo PASS)"
rm -f /tmp/pwned_pre

echo
echo "── RIPGREP_CONFIG_PATH cannot smuggle in --follow ──"
cat > /tmp/_rgcfg <<'EOF'
--follow
EOF
out=$(RIPGREP_CONFIG_PATH=/tmp/_rgcfg "$HERE/call.sh" "$BIN" "$ROOT" fs_grep '{"pattern":"TOP SECRET"}' | payload)
printf '%-46s %s\n' "grep for canary with --follow injected" "$out"
out=$(RIPGREP_CONFIG_PATH=/tmp/_rgcfg "$HERE/call.sh" "$BIN" "$ROOT" fs_glob '{"pattern":"**/secret.txt"}' | payload)
printf '%-46s %s\n' "glob for canary with --follow injected" "$out"
rm -f /tmp/_rgcfg

echo
echo "── host paths in output? ──"
n=$(for p in '{"pattern":"**/*"}' '{"pattern":"/etc/*"}' '{"pattern":"../*"}'; do
      "$HERE/call.sh" "$BIN" "$ROOT" fs_glob "$p"; done 2>&1 | grep -cF "$ROOT")
m=$(for p in '{"pattern":"."}' '{"pattern":".","path":"nope"}'; do
      "$HERE/call.sh" "$BIN" "$ROOT" fs_grep "$p"; done 2>&1 | grep -cF "$OUTSIDE")
printf 'root path occurrences: %s   outside path occurrences: %s\n' "$n" "$m"

echo
echo "── the vector this defends against, proven live ──"
printf -- '--follow\n' > /tmp/_rgcfg
raw=$(cd "$ROOT" && RIPGREP_CONFIG_PATH=/tmp/_rgcfg rg "TOP SECRET" 2>/dev/null | wc -l | tr -d ' ')
safe=$(cd "$ROOT" && RIPGREP_CONFIG_PATH=/tmp/_rgcfg rg --no-config "TOP SECRET" 2>/dev/null | wc -l | tr -d ' ')
printf 'raw rg with config injected : %s out-of-root hit(s)\n' "$raw"
printf 'same rg with --no-config    : %s out-of-root hit(s)\n' "$safe"
[ "$raw" -gt 0 ] && [ "$safe" -eq 0 ] && echo "PASS: --no-config is load-bearing" || echo "CHECK: vector no longer reproduces"
rm -f /tmp/_rgcfg
