export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // Both hints are required, not optional: the MCP spec defaults an absent
  // openWorldHint to true ("reaches outside") and relay reads an absent
  // readOnlyHint as "mutating". An omitted annotation on a tool defined here
  // is therefore not neutral -- it is a permission decision, made by whoever
  // forgot the field, that the caller cannot see was never made on purpose.
  // Every tool must set both explicitly so that decision is always visible
  // at the point a tool is defined, and a tool added later without them is a
  // type error rather than a silent default.
  annotations: { readOnlyHint: boolean; openWorldHint: boolean };
  category?: string;
}

export interface MCPContent {
  type: string;
  text: string;
}

export interface MCPCallResult {
  content: MCPContent[];
  isError?: boolean;
  // Optional, and rare: the only current use is `{ scope_violation: true }`
  // (see scopeViolationResult below) so relay's audit log can tell "the
  // sandbox refused this" apart from every other kind of tool_error without
  // parsing the human-readable message text. Nothing else in this codebase
  // sets it.
  _meta?: Record<string, unknown>;
}

/**
 * One allowed directory's virtual-space label (issue #7): `label` is what a
 * client addresses it as (always `/<label>/...`, never a bare `/`, even for
 * a single root -- see vpath.ts's assignLabels), `hostDir` is the real path
 * on disk it stands for. Lives here, not in vpath.ts, purely so
 * ToolContext below can reference it without vpath.ts and types.ts
 * importing each other.
 */
export interface LabelEntry {
  label: string;
  hostDir: string;
}

export interface ToolContext {
  allowedDirs: string[];
  // The virtual-space labels for this call's effective scope, one per entry
  // of allowedDirs, in the same order. A tool handler decodes every path
  // ARGUMENT it receives against this (vpath.ts's decodeInboundPath) before
  // it ever reaches allowedDirs/security.ts; the registry translates every
  // path in the RESULT back through it (vpath.ts's translateResultToVirtual)
  // on the way out. Computed once per call in main.ts, from the same
  // narrowing that produced allowedDirs -- never a second, independent scope
  // of its own.
  labels: LabelEntry[];
}

export function textResult(text: string): MCPCallResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(message: string): MCPCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * A refusal specifically because the requested path -- or the absence of any
 * configured scope at all -- falls outside allowed_dirs, as distinct from a
 * refusal for any other reason (invalid regex, file not found, a NUL byte in
 * a path). Relay's audit reads `_meta.scope_violation` (or the namespaced
 * `_meta["relay/scope_violation"]`) off a `tool_error` result and records it
 * as a field on that outcome, not a distinct outcome of its own
 * (`audit_call.go:261`, `audit_call.go:294-348`) -- so this is the one piece
 * of vocabulary that lets an operator's audit log tell "the sandbox held"
 * apart from "the tool broke." It must be set on every "you asked for
 * something outside your scope" refusal, and set on nothing else: a plain
 * "file not found" is still just `errorResult`.
 */
export function scopeViolationResult(message: string): MCPCallResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
    _meta: { scope_violation: true },
  };
}
