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
  denied?: boolean;             // true when a destructive call was refused by the user
}

// Risk tiers drive the confirmation policy. `read` runs silently; `write`
// mutates but runs; `destructive` requires explicit user confirmation before it
// is allowed to execute.
export type ToolRisk = "read" | "write" | "destructive";

export interface ConfirmRequest {
  tool: string;
  args: Record<string, unknown>;
  risk: ToolRisk;
  summary: string;              // short human-readable description of the action
}

export type Confirmer = (req: ConfirmRequest) => Promise<boolean>;

// Tools that only read state — always safe to auto-run.
const READ_TOOLS = new Set([
  "read_file",
  "list_dir",
  "glob_files",
  "grep_search",
  "git_status",
  "git_diff",
  "git_log",
  "git_branch",
  "git_current_branch",
  "terminal_read",
  "terminal_wait_for_output",
  "code_find_symbol",
  "code_find_definition",
  "npm_scripts",
  "winget_search",
]);

// Tools that are always destructive regardless of args.
const DESTRUCTIVE_TOOLS = new Set([
  "delete_file",
  "move_file",
  "git_push",
  "git_pull",
  "terminal_interrupt",
  "terminal_stop",
  "npm_install",
  "npm_ci",
  "pip_install",
]);

// Classify a tool call into a risk tier. A few tools are arg-sensitive:
// git_reset is only destructive on a hard reset; running a terminal command or
// committing/installing mutates real state and warrants confirmation.
export function riskOf(name: string, args: Record<string, unknown>): ToolRisk {
  if (READ_TOOLS.has(name)) return "read";
  if (DESTRUCTIVE_TOOLS.has(name)) return "destructive";
  if (name === "git_reset") {
    return String(args.mode ?? "").toLowerCase() === "hard" ? "destructive" : "write";
  }
  // Executing terminal commands and committing run real side effects.
  if (
    name === "terminal_send_line" ||
    name === "terminal_start" ||
    name === "git_commit" ||
    name === "npm_run_script" ||
    name === "cargo_build" ||
    name === "cargo_test"
  ) {
    return "destructive";
  }
  return "write";
}

// A compact, human-readable summary of what a call will do, shown in the prompt.
export function summarize(name: string, args: Record<string, unknown>): string {
  const a = args as Record<string, string>;
  switch (name) {
    case "delete_file":
      return `Delete ${a.path}`;
    case "move_file":
      return `Move ${a.src ?? a.from} \u2192 ${a.dst ?? a.to}`;
    case "git_push":
      return "Push commits to the remote";
    case "git_pull":
      return "Pull from the remote";
    case "git_commit":
      return `Commit: ${a.message ?? "(no message)"}`;
    case "terminal_send_line":
      return `Run in terminal: ${a.line ?? a.text ?? ""}`;
    case "npm_install":
    case "npm_ci":
      return "Install npm dependencies";
    case "pip_install":
      return `pip install ${a.package ?? a.packages ?? ""}`;
    default:
      return `${name}(${Object.keys(args).join(", ")})`;
  }
}

// A Tool pairs an MCP-style definition with a local executor. Remote MCP tools
// will wrap a transport call inside execute(); built-ins run directly.
export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private confirmer: Confirmer | null = null;

  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  registerAll(tools: Tool[]): void {
    for (const t of tools) this.register(t);
  }

  // Install the confirmation handler (provided by the UI). When set, destructive
  // tool calls are gated behind it. When unset, destructive calls fail closed.
  setConfirmer(confirmer: Confirmer | null): void {
    this.confirmer = confirmer;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, isError: true, content: `Unknown tool: ${name}` };

    // Safety gate: destructive actions require explicit user confirmation. The
    // registry is the single chokepoint every built-in and future MCP tool
    // passes through, so the policy lives here rather than in ad hoc UI checks.
    if (riskOf(name, args) === "destructive") {
      if (!this.confirmer) {
        return {
          ok: false,
          isError: true,
          denied: true,
          content: `Blocked: ${name} is a destructive action and requires confirmation, but no confirmer is configured.`,
        };
      }
      const approved = await this.confirmer({
        tool: name,
        args,
        risk: "destructive",
        summary: summarize(name, args),
      });
      if (!approved) {
        return { ok: false, denied: true, content: `User denied ${name}.` };
      }
    }

    try {
      return await tool.execute(args);
    } catch (err) {
      return { ok: false, isError: true, content: `Tool ${name} failed: ${String(err)}` };
    }
  }
}
