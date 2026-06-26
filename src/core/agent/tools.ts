// MCP-shaped tool interface. We model tools on the MCP spec NOW so that real
// MCP servers drop in later with zero refactor: same name/description/schema
// shape, same call signature. Built-in tools and remote MCP tools both satisfy
// this contract and live side by side in one registry.

export interface JSONSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;                 // unique, e.g. "read_file" or "mcp__git__status"
  description: string;
  inputSchema: JSONSchema;       // MCP calls it inputSchema; we match that
}

export interface ToolResult {
  ok: boolean;
  content: string;              // text result surfaced back to the model
  isError?: boolean;
}

// A Tool pairs an MCP-style definition with a local executor. Remote MCP tools
// will wrap a transport call inside execute(); built-ins run directly.
export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  registerAll(tools: Tool[]): void {
    for (const t of tools) this.register(t);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, isError: true, content: `Unknown tool: ${name}` };
    try {
      return await tool.execute(args);
    } catch (err) {
      return { ok: false, isError: true, content: `Tool ${name} failed: ${String(err)}` };
    }
  }
}
