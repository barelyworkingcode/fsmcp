import { createInterface } from 'readline';
import { ToolRegistry } from './registry';
import { ToolContext } from './types';
import { parseAllowedDirs } from './security';
import { registerRead } from './tools/read';
import { registerWrite } from './tools/write';
import { registerEdit } from './tools/edit';
import { registerGlob } from './tools/glob';
import { registerGrep } from './tools/grep';
import { registerBash } from './tools/bash';

const registry = new ToolRegistry();
registerRead(registry);
registerWrite(registry);
registerEdit(registry);
registerGlob(registry);
registerGrep(registry);
registerBash(registry);

const cliAllowedDirs = parseAllowedDirs();

function respond(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line: string) => {
  if (!line.trim()) return;

  let req: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    req = JSON.parse(line);
  } catch {
    respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }

  const id = req.id;

  switch (req.method) {
    case 'initialize':
      respond({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'fsmcp',
            version: '1.0.0',
            contextSchema: {
              allowed_dirs: {
                type: 'array',
                items: { type: 'string' },
                description: 'Directories this server is allowed to access',
                ui: 'directory-list',
              },
            },
          },
        },
      });
      break;

    case 'notifications/initialized':
      // No response for notifications
      break;

    case 'tools/list':
      respond({
        jsonrpc: '2.0',
        id,
        result: { tools: registry.allTools() },
      });
      break;

    case 'tools/call': {
      const params = req.params ?? {};
      const name = (params.name as string) ?? '';
      const args = (params.arguments as Record<string, unknown>) ?? {};

      // Extract _meta.allowed_dirs from Relay context
      const meta = params._meta as Record<string, unknown> | undefined;
      const metaDirs = (meta?.allowed_dirs as string[]) ?? [];

      // Merge CLI and Relay-provided allowed dirs
      const allowedDirs = [...cliAllowedDirs, ...metaDirs];
      const ctx: ToolContext = { allowedDirs };

      const result = registry.call(name, args, ctx);
      respond({ jsonrpc: '2.0', id, result });
      break;
    }

    default:
      if (req.id !== undefined) {
        respond({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `method not found: ${req.method}` },
        });
      }
      break;
  }
});
