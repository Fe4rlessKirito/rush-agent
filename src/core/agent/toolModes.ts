export type AgentToolMode = "chat" | "code" | "flow";

export interface ToolCatalogItem {
  id: string;
  label: string;
  category: string;
  description: string;
  tools: string[];
}

const FLOW_COORDINATION_TOOLS = new Set([
  "Agent",
  "TaskCreate",
  "TaskList",
  "TaskGet",
  "TaskUpdate",
  "TaskStop",
  "TaskOutput",
]);

const CHAT_APP_TOOLS = new Set([
  "app_memory_search",
  "app_memory_add",
  "app_library_search",
  "app_library_read",
  "app_research_search",
  "app_research_read",
]);

export const TOOL_CATALOG: ToolCatalogItem[] = [
  {
    id: "chat-app",
    label: "Chat app context",
    category: "Chat",
    description: "Search Brain memories, Library chats, and saved Deep Research from Chat mode.",
    tools: [...CHAT_APP_TOOLS],
  },
  {
    id: "files-read",
    label: "Read files",
    category: "Files",
    description: "Read workspace files and Claude-compatible Read calls.",
    tools: ["read_file", "Read"],
  },
  {
    id: "files-write",
    label: "Write files",
    category: "Files",
    description: "Create or overwrite workspace files.",
    tools: ["write_file", "Write"],
  },
  {
    id: "files-edit",
    label: "Edit files",
    category: "Files",
    description: "Patch existing files with exact string replacements.",
    tools: ["edit_file", "Edit"],
  },
  {
    id: "files-list-search",
    label: "List and search files",
    category: "Files",
    description: "List folders, glob files, and search text.",
    tools: ["list_dir", "glob_files", "grep_search", "Glob", "Grep"],
  },
  {
    id: "code-intel",
    label: "Code intelligence",
    category: "Code",
    description: "Find symbols, definitions, references, and LSP-backed code data.",
    tools: ["code_find_symbol", "code_find_definition", "lsp_start", "lsp_find_definition", "lsp_find_references", "lsp_prepare_rename", "lsp_stop"],
  },
  {
    id: "git",
    label: "Git tools",
    category: "Code",
    description: "Read Git state and run Git mutations such as commit, pull, and push.",
    tools: ["git_status", "git_diff", "git_log", "git_branch", "git_current_branch", "git_commit", "git_push", "git_pull", "git_reset"],
  },
  {
    id: "packages",
    label: "Package managers",
    category: "Code",
    description: "Inspect and run package manager commands.",
    tools: ["npm_scripts", "npm_run_script", "npm_install", "npm_ci", "pip_install", "cargo_build", "cargo_test", "winget_search"],
  },
  {
    id: "terminal",
    label: "Terminal",
    category: "Runtime",
    description: "Start, read, write to, interrupt, and stop terminal sessions.",
    tools: ["terminal_start", "terminal_send_line", "terminal_read", "terminal_wait_for_output", "terminal_interrupt", "terminal_stop", "Bash", "PowerShell"],
  },
  {
    id: "background",
    label: "Background jobs",
    category: "Runtime",
    description: "Run and manage background commands and monitors.",
    tools: ["background_start", "background_read", "background_list", "background_stop", "Monitor"],
  },
  {
    id: "web",
    label: "Web search and fetch",
    category: "Research",
    description: "Search the web and fetch pages.",
    tools: ["WebSearch", "WebFetch"],
  },
  {
    id: "mcp",
    label: "MCP tools",
    category: "Extensions",
    description: "Configure MCP servers and call discovered MCP tools.",
    tools: ["McpServerConfigure", "McpServerConnect", "McpServerDisconnect", "McpServerList", "McpServerRemove", "McpToolCall", "ListMcpResourcesTool", "ReadMcpResourceTool"],
  },
  {
    id: "skills",
    label: "Skills",
    category: "Extensions",
    description: "List and run Rush skills.",
    tools: ["Skill", "SkillList"],
  },
  {
    id: "planning",
    label: "Planning helpers",
    category: "Coordination",
    description: "Plan mode, user questions, and todo list helpers.",
    tools: ["EnterPlanMode", "ExitPlanMode", "AskUserQuestion", "TodoWrite"],
  },
  {
    id: "flow",
    label: "Flow agents",
    category: "Coordination",
    description: "Spawn Flow subagents and manage Flow task state.",
    tools: ["Agent", "TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskStop", "TaskOutput"],
  },
  {
    id: "worktrees",
    label: "Worktrees",
    category: "Code",
    description: "Create, enter, and exit isolated worktrees.",
    tools: ["EnterWorktree", "ExitWorktree"],
  },
];

export function isToolAvailableInMode(mode: AgentToolMode, name: string): boolean {
  if (mode === "chat") return CHAT_APP_TOOLS.has(name);
  if (mode === "code") return !FLOW_COORDINATION_TOOLS.has(name);
  return true;
}

export function isFlowCoordinationTool(name: string): boolean {
  return FLOW_COORDINATION_TOOLS.has(name);
}
