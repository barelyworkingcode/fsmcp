#!/bin/bash
# ACCEPTANCE section D — byte fidelity, verified against the real binary over
# stdio and checked with shasum, not with fsMCP's own reported hashes.
# usage: fidelity.sh <binary> <root>
BIN="$1"; ROOT="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"

payload() { python3 -c '
import sys, json
print(json.dumps(json.loads(json.loads(sys.stdin.read())["result"]["content"][0]["text"])))
'; }

field() { python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',''))"; }

read_call() { "$HERE/call.sh" "$BIN" "$ROOT" fs_read "$1" | payload; }

echo "── D1: whole-file utf8 read, hash matches disk ──"
r=$(read_call '{"path":"notes/config.txt"}')
disk=$(shasum -a 256 "$ROOT/notes/config.txt" | cut -d' ' -f1)
printf 'encoding=%s eof=%s\nreported=%s\ndisk    =%s  %s\n' \
  "$(echo "$r" | field encoding)" "$(echo "$r" | field eof)" \
  "$(echo "$r" | field sha256)" "$disk" \
  "$([ "$(echo "$r" | field sha256)" = "$disk" ] && echo MATCH || echo MISMATCH)"

echo
echo "── D9-adjacent: non-UTF-8 file round-trips byte-exact via base64 ──"
r=$(read_call '{"path":"notes/latin1.txt"}')
echo "$r" | field content | base64 -d > /tmp/_fid_latin1
disk=$(shasum -a 256 "$ROOT/notes/latin1.txt" | cut -d' ' -f1)
got=$(shasum -a 256 /tmp/_fid_latin1 | cut -d' ' -f1)
printf 'encoding=%s\ndecoded =%s\ndisk    =%s  %s\n' \
  "$(echo "$r" | field encoding)" "$got" "$disk" \
  "$([ "$got" = "$disk" ] && echo MATCH || echo MISMATCH)"

echo
echo "── D6: a range splitting a multi-byte rune reports base64, not repaired ──"
r=$(read_call '{"path":"notes/utf8.txt","offset":1,"length":1}')
printf 'encoding=%s content=%s (0x%s)\n' \
  "$(echo "$r" | field encoding)" "$(echo "$r" | field content)" \
  "$(echo "$r" | field content | base64 -d | xxd -p)"

echo
echo "── D1/chunked: 300KB binary reassembles byte-identically ──"
: > /tmp/_fid_big
off=0
while :; do
  r=$(read_call "{\"path\":\"src/big.bin\",\"offset\":$off,\"length\":65536}")
  enc=$(echo "$r" | field encoding); len=$(echo "$r" | field length)
  if [ "$enc" = "base64" ]; then echo "$r" | field content | base64 -d >> /tmp/_fid_big
  else echo "$r" | field content | python3 -c 'import sys;sys.stdout.buffer.write(sys.stdin.read().encode())' >> /tmp/_fid_big; fi
  [ "$(echo "$r" | field eof)" = "True" ] && break
  off=$((off + len)); [ "$len" -eq 0 ] && break
done
disk=$(shasum -a 256 "$ROOT/src/big.bin" | cut -d' ' -f1)
got=$(shasum -a 256 /tmp/_fid_big | cut -d' ' -f1)
printf 'chunks reassembled: %s\ndisk              : %s  %s\n' "$got" "$disk" \
  "$([ "$got" = "$disk" ] && echo MATCH || echo MISMATCH)"

echo
echo "── D10 (inverted): a 5000-char line comes back whole, not truncated ──"
r=$(read_call '{"path":"src/longline.txt"}')
printf 'size=%s length=%s eof=%s\n' \
  "$(echo "$r" | field size)" "$(echo "$r" | field length)" "$(echo "$r" | field eof)"

echo
echo "── PNG round-trips byte-exact ──"
r=$(read_call '{"path":"src/pixel.png"}')
echo "$r" | field content | base64 -d > /tmp/_fid_png
printf 'encoding=%s  %s\n' "$(echo "$r" | field encoding)" \
  "$(cmp -s /tmp/_fid_png "$ROOT/src/pixel.png" && echo IDENTICAL || echo DIFFERS)"

echo
echo "── an over-budget explicit length is refused as too_large, not as a bug ──"
"$HERE/call.sh" "$BIN" "$ROOT" fs_read '{"path":"src/big.bin","length":99999999}' | payload

rm -f /tmp/_fid_latin1 /tmp/_fid_big /tmp/_fid_png
