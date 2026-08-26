import { createInterface } from 'readline';
import { ToolRegistry } from './registry';
import { ToolContext, MCPCallResult } from './types';
import { parseAllowedDirs, narrowAllowedDirs, sanitizeMetaAllowedDirs } from './security';
import { stripLabels, assignLabels } from './vpath';
import { MAX_FRAME_BYTES } from './limits';
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

// stripLabels (vpath.ts, issue #7) pulls an explicit `label=` prefix off a
// raw --allowed-dir value before anything security-relevant ever sees it:
// narrowAllowedDirs and validatePath both call path.isAbsolute() on every
// entry, and "label=/abs/path" is not absolute -- left unstripped it would
// not just fail to register a label, canonicalizePath would resolve it
// against fsmcp's own CWD instead of refusing it, silently corrupting the
// containment check for that entry. cliAllowedDirs (bare host paths) is the
// exact value this used to be; cliLabels is looked up again, per call,
// alongside whatever _meta supplies, when assigning this call's labels.
const { hostPaths: cliAllowedDirs, labelByHostPath: cliLabels } = stripLabels(parseAllowedDirs());

// Issue #19, the outermost bound: this is the ONE place fsmcp writes to
// stdout, so it is the one place that can measure the thing relay's scanner
// actually measures -- a whole line, envelope included, in bytes.
//
// ToolRegistry.call already bounds every tool RESULT (boundResultBytes), and
// every tool that can produce a large one bounds and reports its own before
// that. This layer exists because neither of those covers the whole line:
// `tools/list` and `initialize` are serialised here without passing through
// the registry at all, and `tools/call` appends its own advisory content
// blocks (the dropped/malformed `_meta.allowed_dirs` reports below) AFTER the
// registry has had its look -- and those are built from caller-supplied
// strings, so "small in practice" is not the same as bounded.
//
// A JSON-RPC error, not a tool result: by this point the shape of what was
// being sent is gone, and the only honest statement left is "this response
// could not be represented". -32001 is in the implementation-defined server
// error range. The replacement is a fixed short string, so this branch cannot
// itself produce an over-long line.
function respond(msg: unknown): void {
  const line = JSON.stringify(msg);
  const size = Buffer.byteLength(line);
  if (size > MAX_FRAME_BYTES) {
    const id = (msg as { id?: unknown } | null)?.id ?? null;
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32001,
          message:
            `fsmcp: a ${size}-byte response exceeded the ${MAX_FRAME_BYTES}-byte frame limit and ` +
            `was withheld rather than truncated. This is a bug in fsmcp -- every result is ` +
            `supposed to be bounded before it reaches this point.`,
        },
      }) + '\n'
    );
    return;
  }
  process.stdout.write(line + '\n');
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
          //  - `disclose: "count"` (relay#33, fsmcp#15) is the other half of
          //    the virtual path space. Relay appends a scope note built from
          //    this field into every governed tool's DESCRIPTION, so a client
          //    that never sees a host path in any fsmcp result could still
          //    read one out of its own tool list: a live Hermes run told
          //    its operator "/d0 maps to /private/tmp/.../sandbox_root". It
          //    is "count" and not "none" because an agent that cannot see its
          //    own limits behaves WORSE -- relay's docs/access-profiles.md
          //    records one concluding a mailbox was "accessible through every
          //    tool" having been refused every time. The note then reads
          //    "confined to N values", which is the boundary without the
          //    coordinates.
          //    The spelling is load-bearing in BOTH directions and neither
          //    direction announces itself: `"Count"` is a case near-miss that
          //    makes relay refuse the WHOLE schema, withholding every fsmcp
          //    tool from every grant, while an unrecognised word (`"hidden"`)
          //    is ignored and the value renders -- fail-open, silent, and it
          //    looks exactly like success from here.
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
                disclose: 'count',
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
      // `meta?.allowed_dirs as string[] | undefined` used to be handed
      // straight to narrowAllowedDirs. That cast changes what TypeScript
      // believes the value is, not what it is: a caller sending
      // `_meta.allowed_dirs: null` (or an object, a number, or an array
      // with a non-string entry) reached a `for...of` or a
      // `path.isAbsolute()` inside narrowAllowedDirs with something it
      // cannot accept, threw, and crashed this whole synchronous process --
      // outside registry.call's try/catch, which only wraps the tool
      // handler reached later. sanitizeMetaAllowedDirs (security.ts) checks
      // the value is actually an array of strings before narrowAllowedDirs
      // ever sees it, and treats anything else as the caller asserting an
      // empty scope -- fail closed, not a crash.
      const { metaDirs, malformed: metaDirsMalformed } = sanitizeMetaAllowedDirs(meta?.allowed_dirs);
      // Same label-stripping as the CLI side, for the same reason: a
      // caller-or-operator-supplied _meta.allowed_dirs entry may carry its
      // own "label=" prefix (relay's per-token Settings UI is exactly where
      // an operator would type one), and narrowAllowedDirs must see only
      // the bare host path underneath it. `metaDirs` (not yet stripped)
      // stays `undefined` exactly when the caller sent no _meta.allowed_dirs
      // at all -- narrowAllowedDirs's "absent vs empty" distinction (C1)
      // depends on that surviving this step unchanged, so stripLabels only
      // runs when metaDirs is genuinely present.
      const strippedMeta = metaDirs === undefined ? undefined : stripLabels(metaDirs);
      const { allowedDirs, droppedMetaDirs } = narrowAllowedDirs(cliAllowedDirs, strippedMeta?.hostPaths);
      // This call's virtual-space labels (issue #7): explicit labels from
      // either source, keyed by the exact bare host-path string they were
      // written against, then d<N> by position in the EFFECTIVE (already
      // narrowed) scope -- see vpath.ts's assignLabels for why position is
      // taken there and not in the operator's original CLI/_meta ordering.
      const labelsResult = assignLabels(
        allowedDirs,
        new Map([...cliLabels, ...(strippedMeta?.labelByHostPath ?? [])])
      );
      // A duplicate label (two directories claiming the same `/<label>/...`
      // address) makes the whole virtual address space for this call
      // ambiguous, not just one path in it -- vpath.ts's assignLabels
      // refuses outright rather than resolving it to whichever directory
      // happens to be enumerated first, the same "refuse the ambiguity"
      // stance fs_edit already takes for a non-unique old_string. That
      // refusal stands in for the tool's own result: nothing here can be
      // decoded against a label space that does not have a single meaning,
      // so no tool handler ever runs for this call.
      const result: MCPCallResult = Array.isArray(labelsResult)
        ? registry.call(name, args, { allowedDirs, labels: labelsResult })
        : labelsResult;

      // A dropped _meta dir is reported on the result, not swallowed: an
      // operator (or an agent reading the reply) should be able to see that
      // part of what relay sent was refused for widening the grant, rather
      // than the call quietly running with a narrower scope than the caller
      // thought it asked for.
      //
      // Issue #26: reported as a FACT AND A COUNT to the client, with the
      // entries themselves going to stderr for the operator. This used to
      // name the dropped entries as raw host paths, on a SUCCESS result --
      // the one shape nothing else in this server can catch:
      // `vpath.ts`'s translation is applied per known path at each
      // construction site and these paths belong to no site, `disclose:
      // "count"` governs a tool DESCRIPTION rather than a result payload,
      // and `redactLeakedHostPaths` is `isError`-scoped by design (PR #10,
      // so it can never scan fs_read/fs_grep success content). Widening
      // that backstop would not help either: a dropped directory is BY
      // CONSTRUCTION not in `ctx.labels` -- the redaction works by knowing
      // the granted roots, and this path is precisely one that is not
      // granted. There is nothing to translate it to. The only fix is to
      // stop naming it.
      //
      // It was reachable in the deployment this server exists for, not just
      // over bare stdio. Relay builds `_meta` server-side from stored
      // context, which was once read here as "a client cannot reach this";
      // server-side is not the same as in-scope. Register fsmcp with
      // `--args --allowed-dir /A` while the profile's allowed_dirs also
      // names `/B` and relay sends both: `/B` fails C1, and `/B` -- an
      // operator-configured host path the client was never granted -- was
      // echoed to a remote client on a successful result, appended to every
      // call (reads, writes, listings, and refusals alike) for as long as
      // the misconfiguration stood.
      //
      // The split follows `assignLabels`' duplicate-label refusal exactly,
      // for the same reasons in both directions. stderr gets the detail
      // because the operator is the only party who can fix the
      // configuration and the only one entitled to the paths; stderr is not
      // the protocol stream (stdout is), so it cannot corrupt a response,
      // and it is where a stdio MCP's host collects a child's diagnostics.
      // The client gets the fact and the count because an agent that cannot
      // see it is confined behaves WORSE, not better (the same reasoning
      // that made `disclose: "count"` "count" rather than "none") -- but
      // knowing its scope is narrower than its profile asks for requires no
      // knowledge of the host's directory layout. The client can do nothing
      // with the paths in any case: it cannot fix the configuration.
      //
      // Deliberately a note and not a refusal, unlike a duplicate label.
      // The two look similar and are not: a duplicate label leaves the
      // address space with NO correct reading (a `/<label>/...` path names
      // two different files, and picking one silently gives a caller the
      // wrong file's bytes), whereas this narrowing has exactly one, is
      // specified by C1's own table, and is already fail-closed -- the
      // effective scope is the intersection, which is the safe answer, not
      // a guess between two. Refusing every call would turn an operator's
      // over-tight CLI floor into a total outage of a capability whose
      // remaining grant is still valid, and it would fire on the ordinary,
      // intended shape of "the operator tightened the floor" rather than on
      // an ambiguity. If this ever needs to be louder, the levers are this
      // stderr line and relay's own scope note (which currently renders the
      // profile's count rather than the effective one -- filed against
      // relay), not a refusal fsmcp cannot distinguish from correct use.
      if (droppedMetaDirs.length > 0) {
        // The operator's copy, with the detail needed to fix it.
        process.stderr.write(
          `fsmcp: _meta.allowed_dirs entries were dropped because they are not contained within ` +
            `any --allowed-dir root: ${droppedMetaDirs.join(', ')}. The call ran with the ` +
            `narrowed scope. This server's --allowed-dir arguments and the allowed_dirs it was ` +
            `sent disagree; an operator must reconcile them.\n`
        );
        // The count, not the coordinates. The sentence a client can act on
        // is "your scope is narrower than the one your profile names, by N
        // entries"; the entries themselves tell it nothing it can use and
        // are exactly what it must not be told.
        result.content = [
          ...result.content,
          {
            type: 'text',
            text:
              `[fsmcp: _meta.allowed_dirs entries were dropped because they are not contained ` +
              `within any --allowed-dir root -- ${droppedMetaDirs.length} of them. This call's ` +
              `effective scope is that much narrower than the scope it was sent, and the ` +
              `dropped entries are not addressable from here. They are named in this server's ` +
              `stderr, for the operator, who is the party that can reconcile the two.]`,
          },
        ];
      }

      // Same visibility for a malformed _meta.allowed_dirs (not an array of
      // strings at all): the call ran with an empty scope rather than
      // crashing, and that should be as visible as a dropped entry is,
      // not a silent downgrade nobody can see happened.
      if (metaDirsMalformed) {
        result.content = [
          ...result.content,
          {
            type: 'text',
            text:
              `[fsmcp: _meta.allowed_dirs was not an array of strings; treated as an empty ` +
              `scope (deny all) for this call]`,
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
