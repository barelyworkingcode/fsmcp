import { MCPTool, MCPCallResult, ToolContext, errorResult } from './types';

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

  call(name: string, args: Record<string, unknown>, ctx: ToolContext): MCPCallResult {
    const reg = this.registrations.get(name);
    if (!reg) return errorResult(`unknown tool: ${name}`);
    try {
      return reg.handler(args, ctx);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(message);
    }
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
