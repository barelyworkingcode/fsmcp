import { createInterface } from 'readline';
import { ToolRegistry } from './registry';
import { ToolContext } from './types';
import { parseAllowedDirs, narrowAllowedDirs } from './security';
import { registerRead } from './tools/read';
import { registerWrite } from './tools/write';
import { registerEdit } from './tools/edit';
import { registerGlob } from './tools/glob';
import { registerGrep } from './tools/grep';
import { registerList } from './tools/list';
import { registerFind } from './tools/find';
import { registerMkdir } from './tools/mkdir';
import { registerMove } from './tools/move';
import { registerDelete } from './tools/delete';

const registry = new ToolRegistry();
registerRead(registry);
registerWrite(registry);
registerEdit(registry);
registerGlob(registry);
registerGrep(registry);
registerList(registry);
registerFind(registry);
registerMkdir(registry);
registerMove(registry);
registerDelete(registry);

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
          // v2 scope schema (issue #5, Part 2). This is the field relay's
          // discovery decodes to decide what kind of grant fsmcp can accept
          // at all -- get any of it wrong and relay either can't offer a
          // remote grant for fsmcp, or offers one it does not actually
          // enforce.
          //
          //  - `contextSchemaVersion: 2` opts in to v2 parsing. Absent, relay
          //    reads this whole block as v1: it looks for a field literally
          //    named `allowed_dirs` and derives it from the project path --
          //    which a remote access profile does not have, so a v1 fsmcp
          //    cannot be granted to one at all
          //    (`TestApplyProjectCreate_RemoteRejectsPathScopedGrant`).
          //  - `source: "operator"`, not `"project_path"`. This is the
          //    entire fix for the above: a remote profile has no project
          //    path for relay to derive a value from, so `project_path`
          //    reproduces the exact same refusal under v2 that v1 gives
          //    today. An operator types the roots instead.
          //  - `scope: "restrict"` tells relay this field is a fail-closed
          //    restriction (empty means deny, not "unrestricted"), which is
          //    also just true of how fsmcp itself behaves (validatePath).
          //  - `applies_to: ["fs_*"]` is matched with anchored path.Match
          //    against every tool name; every tool this server publishes is
          //    `fs_`-prefixed, so this governs all of them. Left absent or
          //    empty this also governs everything, but by accident rather
          //    than by a statement relay (or a human reading this file) can
          //    check.
          //  - `enumerable: false`: fsmcp cannot offer relay a list of
          //    candidate directories without listing the host's filesystem
          //    to whatever UI relay renders, which is disclosure with no
          //    natural bound. Relay falls back to a plain text field.
          //  - No `ui` key -- relay's v2 parsing ignores it, and it was
          //    stale even under v1.
          serverInfo: {
            name: 'fsmcp',
            version: '2.0.0',
            contextSchemaVersion: 2,
            contextSchema: {
              allowed_dirs: {
                type: 'array',
                items: { type: 'string' },
                description: 'Directories this client may read, search and modify within',
                scope: 'restrict',
                source: 'operator',
                applies_to: ['fs_*'],
                enumerable: false,
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

      // C1: `_meta` may only ever narrow what --allowed-dir already granted,
      // never widen it -- see narrowAllowedDirs in security.ts for the full
      // four-row table and why a plain union (what this used to do) was a
      // one-line sandbox escape. `meta?.allowed_dirs` is read as `undefined`
      // when the key is genuinely absent (no _meta at all, or _meta without
      // an allowed_dirs field) and as a real, possibly-empty array when the
      // caller supplied one -- that distinction is what tells "no opinion,
      // defer to the CLI grant" apart from "asserting a scope", and
      // collapsing it with `?? []` (what this also used to do) is exactly
      // what would silently break the "CLI set, _meta absent" row.
      const meta = params._meta as Record<string, unknown> | undefined;
      const metaDirs = meta?.allowed_dirs as string[] | undefined;
      const { allowedDirs, droppedMetaDirs } = narrowAllowedDirs(cliAllowedDirs, metaDirs);
      const ctx: ToolContext = { allowedDirs };

      const result = registry.call(name, args, ctx);

      // A dropped _meta dir is reported on the result, not swallowed: an
      // operator (or an agent reading the reply) should be able to see that
      // part of what relay sent was refused for widening the grant, rather
      // than the call quietly running with a narrower scope than the caller
      // thought it asked for.
      if (droppedMetaDirs.length > 0) {
        result.content = [
          ...result.content,
          {
            type: 'text',
            text:
              `[fsmcp: _meta.allowed_dirs entries were dropped because they are not contained ` +
              `within any --allowed-dir root: ${droppedMetaDirs.join(', ')}]`,
          },
        ];
      }

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
