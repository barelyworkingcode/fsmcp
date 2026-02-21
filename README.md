# fsMCP

MCP server providing file system tools via stdio. Gives LLMs the ability to read, write, edit, search, and execute commands on the local file system.

## Tools

### File System
| Tool | Description |
|------|-------------|
| `fs_read` | Read file contents with line numbers |
| `fs_write` | Write or create files |
| `fs_edit` | Find-and-replace string editing |
| `fs_glob` | Find files by glob pattern |
| `fs_grep` | Search file contents with regex |

### Shell
| Tool | Description |
|------|-------------|
| `fs_bash` | Execute shell commands |

## Requirements

- Node.js 22+
- Optional: ripgrep (`rg`) for fast grep (falls back to Node.js)

## Build & Install

```bash
./build.sh    # builds, installs to ~/.local/bin/fsmcp, registers with Relay
```

## Directory Scoping

fsMCP restricts file operations to allowed directories. Two sources:

1. **Relay per-token context** -- Relay discovers fsMCP's `contextSchema` during handshake and renders directory configuration in the Settings UI per token. Configured directories are injected as `_meta.allowed_dirs` in tool calls.
2. **CLI flags** -- `--allowed-dir /path` (repeatable) for standalone mode.

If neither is configured, all paths are allowed.

```bash
# Standalone with directory restriction
fsmcp --allowed-dir /Users/me/projects/myapp
```

## Configuration

### With Relay (recommended)

`build.sh` handles registration. Manual:

```bash
relay mcp register --name fsMCP --command ~/.local/bin/fsmcp
```

Configure per-token directory access in Relay's Settings > Security > Token Permissions.

### Standalone

Add to your MCP client config:

```json
{
  "mcpServers": {
    "fsmcp": {
      "command": "~/.local/bin/fsmcp",
      "args": ["--allowed-dir", "/path/to/project"]
    }
  }
}
```

## Related Projects

- **[macMCP](../macMCP)** -- MCP server for macOS-native tools (calendar, contacts, mail, etc.)
- **[Relay](../relay)** -- MCP orchestrator with per-token security and directory scoping
- **[Eve](../eve)** -- Multi-provider LLM web interface
