#!/bin/bash
# The A10 leak test: run many failing and succeeding calls, assert the root's
# host path appears in no emitted byte.
set -uo pipefail
BIN="$1"; ROOT="$2"; OUT=$(mktemp)
while IFS='|' read -r tool args; do
  [ -z "$tool" ] && continue
  {
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
    printf '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"%s","arguments":%s}}\n' "$tool" "$args"
  } | "$BIN" --root "$ROOT" >>"$OUT" 2>>"$OUT"
done
if grep -qF "$ROOT" "$OUT"; then
  echo "LEAK: root path present in output"; grep -oF -m3 "$ROOT" "$OUT" | head -3; rm -f "$OUT"; exit 1
fi
echo "no leak across $(wc -l <"$OUT" | tr -d ' ') emitted lines"; rm -f "$OUT"
