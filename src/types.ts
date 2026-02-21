export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
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
