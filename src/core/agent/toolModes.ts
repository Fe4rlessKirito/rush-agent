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
  "app_research_run",
  "app_research_read",
  "website_environment",
  "suggest_mode_switch",
]);

export const TOOL_CATALOG: ToolCatalogItem[] = [
  {
    id: "chat-app",
    label: "Chat app context",
    category: "Chat",
    description: "Search Brain memories, Library chats, and saved or newly-run Deep Research from Chat mode.",
    tools: [...CHAT_APP_TOOLS].filter((name) => name !== "suggest_mode_switch"),
  },
  {
    id: "mode-switch",
    label: "Suggest mode switch",
    category: "Chat",
    description: "Propose switching the conversation between Chat and Code mode. Switching to Code mode can auto-apply when permissions are Full access; otherwise it requires confirmation.",
    tools: ["suggest_mode_switch"],
  },
  {
    id: "files-read",
    label: "Read files",
    category: "Files",
    description: "Read workspace files and Claude-compatible Read calls.",
    tools: ["read_file", "read_file_range", "read_many_files", "file_info", "project_files_summary", "Read"],
  },
  {
    id: "files-write",
    label: "Write files",
    category: "Files",
    description: "Create or overwrite workspace files.",
    tools: ["write_file", "write_many_files", "create_dir", "delete_file", "move_file", "Write"],
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
    tools: ["list_dir", "list_tree", "glob_files", "grep_search", "search_replace", "Glob", "Grep"],
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
    tools: ["git_status", "git_diff", "git_log", "git_show", "git_blame", "git_branch", "git_current_branch", "git_commit", "git_push", "git_pull", "git_reset"],
  },
  {
    id: "packages",
    label: "Package managers",
    category: "Code",
    description: "Inspect and run package manager commands.",
    tools: ["npm_scripts", "npm_run_script", "npm_install", "npm_ci", "run_tests", "diagnostics", "format_files", "lint", "dependency_audit", "pip_install", "cargo_check", "cargo_test", "cargo_build", "winget_search"],
  },
  {
    id: "terminal",
    label: "Terminal",
    category: "Runtime",
    description: "Start, read, write to, interrupt, and stop terminal sessions.",
    tools: ["terminal_start", "terminal_write", "terminal_send_line", "terminal_read", "terminal_wait_for_output", "terminal_interrupt", "terminal_stop", "Bash", "PowerShell"],
  },
  {
    id: "background",
    label: "Background jobs",
    category: "Runtime",
    description: "Run and manage background commands and monitors.",
    tools: ["background_start", "background_read", "background_list", "background_stop", "dev_server_start", "dev_server_status", "Monitor"],
  },
  {
    id: "web",
    label: "Web search and fetch",
    category: "Research",
    description: "Search the web and fetch pages.",
    tools: ["WebSearch", "WebFetch", "deep_research_search", "website_environment", "ui_inspect", "screenshot_url"],
  },
  {
    id: "durable-memory",
    label: "Durable memory",
    category: "Research",
    description: "Save, retrieve, and forget deduped cross-session facts with lexical relevance ranking.",
    tools: ["memory_save", "memory_retrieve", "memory_forget"],
  },
  {
    id: "rag-documents",
    label: "RAG documents",
    category: "Research",
    description: "Add, list, and search a chunked document corpus outside the project codebase.",
    tools: ["rag_add", "rag_search", "rag_list"],
  },
  {
    id: "document-readers",
    label: "Document readers",
    category: "Research",
    description: "Read CSV, Office, PDF, and image OCR inputs, and write spreadsheet-compatible CSV data.",
    tools: ["read_docx", "read_pptx", "read_excel", "write_excel", "read_csv", "read_pdf", "ocr_image"],
  },
  {
    id: "parallel-reasoning",
    label: "Parallel reasoning",
    category: "Coordination",
    description: "Fan out one question across multiple analytical perspectives and synthesize the findings.",
    tools: ["split_up"],
  },
  {
    id: "github-rest",
    label: "GitHub REST",
    category: "Code",
    description: "Use token-based GitHub API calls for remote repositories, files, branches, and issues without cloning.",
    tools: ["github_whoami", "github_list_repos", "github_get_repo", "github_list_branches", "github_get_file", "github_put_file", "github_list_issues", "github_create_issue", "github_search_repos"],
  },
  {
    id: "browser-automation",
    label: "Browser automation",
    category: "Runtime",
    description: "Open and control a persistent browser session for UI debugging and website inspection.",
    tools: ["browser_open", "browser_navigate", "browser_click", "browser_fill", "browser_press", "browser_get_text", "browser_get_html", "browser_eval", "browser_screenshot", "browser_links", "browser_close"],
  },
  {
    id: "project-context",
    label: "Project context",
    category: "Code",
    description: "Inspect active Rush project context and open URLs.",
    tools: ["project_context", "open_url"],
  },
  {
    id: "release",
    label: "Release checks",
    category: "Code",
    description: "Verify local and published release metadata.",
    tools: ["release_prepare", "release_verify"],
  },
  {
    id: "mcp",
    label: "MCP tools",
    category: "Extensions",
    description: "Configure MCP servers and call discovered MCP tools.",
    tools: ["McpServerConfigure", "McpServerConnect", "McpServerDisconnect", "McpServerList", "McpServerRemove", "McpToolCall", "ListMcpResourcesTool", "ReadMcpResourceTool", "ToolSearch", "WaitForMcpServers"],
  },
  {
    id: "skills",
    label: "Skills",
    category: "Extensions",
    description: "List and run Rush skills.",
    tools: ["Skill", "SkillList"],
  },
  {
    id: "packs",
    label: "Packs",
    category: "Extensions",
    description: "List and read imported Rush pack skills, commands, rules, and manifests.",
    tools: ["PackList", "PackRead"],
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
  if (mode === "code") return !FLOW_COORDINATION_TOOLS.has(name) || name === "Agent";
  return true;
}

export function isFlowCoordinationTool(name: string): boolean {
  return FLOW_COORDINATION_TOOLS.has(name);
}
