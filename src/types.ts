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
}

export interface ToolContext {
  allowedDirs: string[];
}

export function textResult(text: string): MCPCallResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(message: string): MCPCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
