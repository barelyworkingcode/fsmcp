#!/bin/bash
set -euo pipefail

INSTALL_DIR="$HOME/.local/bin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="${1:-fsmcp}"

if ! command -v rg >/dev/null; then
    echo "Error: ripgrep (rg) not found on PATH. fsMCP requires it and refuses to start without it." >&2
    exit 1
fi

echo "Building fsMCP..."
cd "$SCRIPT_DIR"
go build -trimpath -o "$INSTALL_DIR/$BINARY" .

# A single static binary, so unlike the Node launcher this replaced there is a
# real Mach-O to sign. Ad-hoc is enough to give TCC a stable identity across
# rebuilds; without it a rebuild can re-prompt for Files & Folders access.
codesign --force --sign - "$INSTALL_DIR/$BINARY"

echo "Installed: $INSTALL_DIR/$BINARY"
echo
echo "Register with Relay as one MCP per granted directory, e.g."
echo "  command: $INSTALL_DIR/$BINARY"
echo "  args:    [\"--root\", \"/path/to/folder\"]"
echo "Add --read-only to publish only the five read tools."
