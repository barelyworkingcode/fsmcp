import { MCPTool, MCPCallResult, ToolContext, errorResult } from './types';
import { describeError, redactLeakedHostPaths } from './vpath';

/**
 * Parse a boolean-shaped argument off the wire strictly: absent becomes
 * `def`, an actual JS `boolean` is itself, and anything else is a clean
 * refusal rather than a guess.
 *
 * Every mutating tool used to write `(args.foo as boolean) ?? def` --
 * `overwrite` in fs_move, `recursive` in fs_delete and fs_mkdir,
 * `replace_all` in fs_edit. The cast is a lie the moment a caller sends
 * something other than a real boolean, and `??` does not rescue it: `??`
 * only substitutes `def` for `null`/`undefined`, so any other value passes
 * straight through to `!recursive` or `if (overwrite)`, which coerce it by
 * JS truthiness. A caller (or a lossy layer somewhere upstream that
 * stringifies booleans) sending `recursive: "false"` -- a non-empty string,
 * therefore truthy -- silently became `recursive: true`. fs_delete's whole
 * point of defaulting `recursive` to `false` is that destroying a non-empty
 * directory requires an opt-in; a stringly-typed "false" opted in anyway,
 * with nothing in the response to say the argument had been misread.
 * (Confirmed: `fs_delete { path: <non-empty dir>, recursive: "false" }`
 * deleted it.) The same shape of mistake, with `overwrite: "false"`, made
 * fs_move overwrite a destination the caller's own value said not to.
 *
 * Refusing cleanly here, instead of coercing, means a caller finds out an
 * argument was the wrong type before anything is deleted, moved, replaced,
 * or created -- not after.
 */
export function parseBoolArg(value: unknown, argName: string, def: boolean): boolean | MCPCallResult {
  if (value === undefined) return def;
  if (typeof value === 'boolean') return value;
  return errorResult(`${argName} must be true or false; received ${JSON.stringify(value)}`);
}

/**
 * Require a string-typed argument off the wire, refusing cleanly rather
 * than trusting `args.foo as string` to have made the cast honest.
 *
 * That cast believes what TypeScript is told, not what a caller actually
 * sent. Two confirmed, independently-reproduced ways a missing or
 * wrong-typed required argument reaches this file's tools with no check at
 * all in between:
 *
 *   - fs_find called without `pattern` (e.g. a caller that sent `query`
 *     instead) reached `pattern.toLowerCase()` inside `fuzzyScore` with
 *     `pattern` still `undefined`, un-caught by anything upstream of
 *     registry.call's backstop try/catch. The result was
 *     `isError: true, "Cannot read properties of undefined (reading
 *     'toLowerCase')"` -- a refusal that names a JS internal instead of
 *     the missing parameter, giving whatever called it no way to learn it
 *     should have sent `pattern`.
 *   - fs_edit's `new_string` sent as JSON `null` (a plausible mistake --
 *     JSON has no "delete this" value other than an empty string, and
 *     `null` reads to a human as "nothing") reached
 *     `parts.join(newString)`. `Array.prototype.join` treats `undefined`
 *     as "use the default separator", but stringifies `null` to the four
 *     characters `"null"` -- so `fs_edit { old_string: "WORLD", new_string:
 *     null }` against "hello WORLD bye" silently wrote "hello null bye"
 *     and reported success. That is corruption, not a crash, and strictly
 *     worse than the TypeError the same mistake throws when `old_string`
 *     (fed to `content.split()`, which has no such special case) is the
 *     wrong type instead.
 *
 * Every required string argument gets this one check instead of each
 * callsite discovering its own way to mishandle a wrong-typed value --
 * some by throwing something unhelpful, at least one by writing something
 * wrong to disk without even raising an error.
 */
export function requireStringArg(args: Record<string, unknown>, argName: string): string | MCPCallResult {
  const value = args[argName];
  if (typeof value === 'string') return value;
  if (value === undefined) return errorResult(`${argName} is required`);
  return errorResult(`${argName} must be a string; received ${JSON.stringify(value)}`);
}

/**
 * Same check as requireStringArg, for a path/pattern argument the schema
 * marks optional (e.g. fs_grep/fs_glob/fs_list/fs_find's `path`, which
 * defaults to the allowed directories when omitted). `null` and
 * `undefined` both mean "omitted" here -- JSON has no other way to send
 * "no opinion" for an optional field, and the tools that call this already
 * treat an omitted `path` as "use the scope", not as an error.
 */
export function optionalStringArg(args: Record<string, unknown>, argName: string): string | undefined | MCPCallResult {
  const value = args[argName];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  return errorResult(`${argName} must be a string; received ${JSON.stringify(value)}`);
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => MCPCallResult;

export class ToolRegistry {
  private registrations = new Map<string, { tool: MCPTool; handler: ToolHandler }>();

  register(tool: MCPTool, handler: ToolHandler): void {
    this.registrations.set(tool.name, { tool, handler });
  }

  allTools(): MCPTool[] {
    return [...this.registrations.values()]
      .map(r => r.tool)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Issue #7 / PR #10 review: every ERROR result, whether a handler
  // returned it or this catch built it, passes through
  // redactLeakedHostPaths before it reaches the wire -- an alarm, not a
  // translation mechanism. Deliberate translation happens at each path's
  // own construction site now (decodeInboundPath, checkPathV/
  // checkPathNoFollowFinalV/refuseAllowedDirRootV, describeError,
  // hostToVirtualOrRedact in the search tools), specifically so a SUCCESS
  // result's file content (fs_read's bytes, fs_grep content mode's matched
  // lines) is never scanned or rewritten -- a whole-result rewrite here
  // used to do exactly that, and a write-then-read round trip in review
  // showed it silently corrupting any file whose content happened to
  // contain the sandbox's own host path. Restricting this backstop to
  // `isError` results is what keeps that from recurring: nothing in this
  // codebase returns raw file content on an error path.
  call(name: string, args: Record<string, unknown>, ctx: ToolContext): MCPCallResult {
    const reg = this.registrations.get(name);
    let result: MCPCallResult;
    if (!reg) {
      result = errorResult(`unknown tool: ${name}`);
    } else {
      try {
        result = reg.handler(args, ctx);
      } catch (err: unknown) {
        // describeError (vpath.ts): a tool handler that let an fs exception
        // escape uncaught is exactly the shape describeError exists for --
        // Node's ErrnoException carries the offending path as `.path`
        // (`.dest` too for a rename), which this translates before it ever
        // reaches the wire.
        result = errorResult(describeError(err, ctx.labels));
      }
    }
    return redactLeakedHostPaths(result, ctx.labels);
  }
}

// Schema helpers

export function schema(
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return { type: 'object', properties, required };
}

export function stringProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

export function intProp(description: string): Record<string, unknown> {
  return { type: 'integer', description };
}

export function boolProp(description: string): Record<string, unknown> {
  return { type: 'boolean', description };
}

export function enumProp(description: string, values: string[]): Record<string, unknown> {
  return { type: 'string', description, enum: values };
}
