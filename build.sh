#!/bin/bash
set -euo pipefail

INSTALL_DIR="$HOME/.local/bin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing dependencies..."
npm ci

echo "Building fsMCP..."
npx tsc

# Resolve node path at build time (GUI apps like Relay don't have nvm in PATH)
NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
    echo "Error: node not found in PATH" >&2
    exit 1
fi

# Create launcher script
mkdir -p "$INSTALL_DIR"
cat > "$INSTALL_DIR/fsmcp" << SCRIPT
#!/bin/bash
exec "$NODE_BIN" "$SCRIPT_DIR/dist/main.js" "\$@"
SCRIPT
chmod +x "$INSTALL_DIR/fsmcp"
echo "Installed: $INSTALL_DIR/fsmcp"

# No codesign step: fsMCP runs as `node dist/main.js` via the launcher above.
# The Mach-O process is node itself, not anything we ship, so codesign has
# nothing meaningful to attach to. TCC will key any file-access prompts off
# whatever cdhash your node binary happens to have (re-prompts on node upgrade);
# bundling fsMCP into its own .app would be the only way to fix that.

# Register with Relay (best-effort, relay may not be installed)
RELAY="/Applications/Relay.app/Contents/MacOS/relay"
if [ -x "$RELAY" ]; then
    "$RELAY" mcp register --name fsMCP --command "$INSTALL_DIR/fsmcp"
    echo "Registered with Relay"
else
    echo "Relay not found at $RELAY, skipping registration"
fi
