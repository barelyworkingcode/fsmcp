#!/bin/bash
# Drive fsmcp over stdio. usage: call.sh <binary> <root> <tool> <args-json>
# Prints only the tool result payload. Exit 1 if the result isError.
set -uo pipefail
BIN="$1"; ROOT="$2"; TOOL="$3"; ARGS="${4:-{\}}"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"%s","arguments":%s}}\n' "$TOOL" "$ARGS"
} | "$BIN" --root "$ROOT" 2>/dev/null | awk 'NR>1' | tail -1
