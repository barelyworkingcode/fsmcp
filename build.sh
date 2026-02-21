#!/bin/bash
set -euo pipefail

INSTALL_DIR="$HOME/.local/bin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing dependencies..."
npm ci

echo "Building fsMCP..."
npx tsc

# Create launcher script
mkdir -p "$INSTALL_DIR"
cat > "$INSTALL_DIR/fsmcp" << SCRIPT
#!/bin/bash
exec node "$SCRIPT_DIR/dist/main.js" "\$@"
SCRIPT
chmod +x "$INSTALL_DIR/fsmcp"
echo "Installed: $INSTALL_DIR/fsmcp"

# Register with Relay (best-effort, relay may not be installed)
RELAY="/Applications/Relay.app/Contents/MacOS/relay"
if [ -x "$RELAY" ]; then
    "$RELAY" mcp register --name fsMCP --command "$INSTALL_DIR/fsmcp"
    echo "Registered with Relay"
else
    echo "Relay not found at $RELAY, skipping registration"
fi
