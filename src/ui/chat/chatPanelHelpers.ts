import type { ChatLine } from "../../core/store";

export type PermissionPresetId = "ask" | "edit" | "plan" | "full";

export interface PermissionPreset {
  id: PermissionPresetId;
  label: string;
  description: string;
  allow: string[];
  ask: string[];
  deny: string[];
}

export const SENSITIVE_DENY_RULES = ["Read(secrets/**)", "Read(.env*)", "Read(**/*.key)"];

export const PERMISSION_PRESETS: PermissionPreset[] = [
  {
    id: "ask",
    label: "Ask before changes",
    description: "Ask before file changes.",
    allow: [],
    ask: ["Write(**)", "Edit(**)", "Bash(*)", "PowerShell(*)", "background_start(*)"],
    deny: SENSITIVE_DENY_RULES,
  },
  {
    id: "edit",
    label: "Edit automatically",
    description: "Edit files automatically.",
    allow: ["Write(**)", "Edit(**)", "create_dir(**)", "move_file(**)"],
    ask: ["delete_file(**)", "Bash(*)", "PowerShell(*)", "background_start(*)", "git_commit", "git_push", "git_pull", "git_reset"],
    deny: SENSITIVE_DENY_RULES,
  },
  {
    id: "plan",
    label: "Plan mode",
    description: "Plan before editing.",
    allow: [],
    ask: [],
    deny: [
      ...SENSITIVE_DENY_RULES,
      "Write(**)",
      "Edit(**)",
      "create_dir(**)",
      "delete_file(**)",
      "move_file(**)",
      "Bash(*)",
      "PowerShell(*)",
      "background_start(*)",
      "git_commit",
      "git_push",
      "git_pull",
      "git_reset",
      "npm_install",
      "pip_install",
    ],
  },
  {
    id: "full",
    label: "Full access",
    description: "Run with fewer confirmations.",
    allow: ["Write(**)", "Edit(**)", "create_dir(**)", "move_file(**)", "delete_file(**)", "Bash(*)", "PowerShell(*)", "background_start(*)", "git_commit", "git_push", "git_pull", "git_reset", "npm_install", "pip_install"],
    ask: [],
    deny: SENSITIVE_DENY_RULES,
  },
];

function sameRules(a: string[] | undefined, b: string[]): boolean {
  return JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...b].sort());
}

export function presetFromPermissions(permissions: { allow?: string[]; ask?: string[]; deny?: string[] }): PermissionPreset {
  return PERMISSION_PRESETS.find((preset) =>
    sameRules(permissions.allow, preset.allow) &&
    sameRules(permissions.ask, preset.ask) &&
    sameRules(permissions.deny, preset.deny)
  ) ?? PERMISSION_PRESETS[0];
}

export function modeSwitchResult(mode: "plain" | "agent", source: "auto" | "approved" | "dismissed"): string {
  const label = mode === "agent" ? "Code" : "Chat";
  if (source === "auto") return `Switched to ${label} mode automatically because permissions are Full access.`;
  if (source === "approved") return `Switched to ${label} mode after the user approved the request.`;
  return `Mode switch to ${label} mode was dismissed by the user.`;
}

export interface RenderedChatItem {
  type: "user" | "agent-run";
  startIndex: number;
  user?: ChatLine;
  lines?: Array<{ line: ChatLine; index: number }>;
}

export interface ToolActivityDisplay {
  kind: "explore" | "read" | "edit" | "run" | "web" | "mode" | "done" | "other";
  action: string;
  title: string;
  detail: string;
  badge: string;
}

export interface FileEditReviewItem {
  key: string;
  path: string;
  name: string;
  dir: string;
  ext: string;
  added: number;
  removed: number;
}

const FILE_EDIT_TOOLS = new Set([
  "write_file",
  "write_many_files",
  "edit_file",
  "Edit",
  "Write",
  "search_replace",
  "format_files",
  "write_excel",
  "github_put_file",
]);

function fileParts(value: string): { name: string; dir: string; ext: string } {
  const clean = value.trim().replace(/\\/g, "/");
  if (!clean) return { name: "", dir: "", ext: "" };
  const parts = clean.split("/").filter(Boolean);
  const name = parts.pop() ?? clean;
  const dir = parts.join("/");
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() ?? "" : "";
  return { name, dir: dir ? `${dir}/` : "", ext };
}

export function compactToolAction(text: string): ToolActivityDisplay {
  const trimmed = text.trim();
  const [, usingAction = "tool", rawTarget = ""] = trimmed.match(/^Using ([^:]+)(?::\s*(.*))?$/) ?? [];
  const [, finishedAction = ""] = trimmed.match(/^Finished (.+)$/) ?? [];
  const didNotComplete = trimmed.match(/^(.+) did not complete$/);
  if (trimmed.startsWith("Switched to ") || trimmed.startsWith("Mode switch to ")) {
    return { kind: "mode", action: "Mode", title: trimmed, detail: "", badge: "" };
  }
  if (finishedAction) {
    return { kind: "done", action: "Done", title: finishedAction, detail: "", badge: "" };
  }
  if (didNotComplete) {
    return { kind: "done", action: "Failed", title: didNotComplete[1], detail: "", badge: "" };
  }

  const target = rawTarget.trim();
  const file = fileParts(target);
  const action = usingAction.toLowerCase();
  if (action.includes("read") || action.includes("lines")) {
    return { kind: "read", action: "Read", title: file.name || target || usingAction, detail: file.dir, badge: file.ext || "file" };
  }
  if (action.includes("edit") || action.includes("write") || action.includes("format")) {
    return { kind: "edit", action: "Edited", title: file.name || target || usingAction, detail: file.dir, badge: file.ext || "file" };
  }
  if (action.includes("list") || action.includes("find") || action.includes("search") || action.includes("inspect project")) {
    return { kind: "explore", action: action.includes("search") ? "Search" : "Explore", title: target || usingAction, detail: "", badge: "" };
  }
  if (action.includes("command") || action.includes("terminal") || action.includes("test") || action.includes("lint")) {
    return { kind: "run", action: "Run", title: target || usingAction, detail: "", badge: "" };
  }
  if (action.includes("web") || action.includes("url") || action.includes("page")) {
    return { kind: "web", action: "Web", title: target || usingAction, detail: "", badge: "" };
  }
  return { kind: "other", action: "Tool", title: target || trimmed, detail: "", badge: file.ext };
}

export function activityGroupLabel(items: ToolActivityDisplay[]): { kind: ToolActivityDisplay["kind"]; action: string; count: string } {
  const meaningful = items.filter((item) => item.kind !== "done");
  const source = meaningful.length ? meaningful : items;
  const counts = new Map<string, number>();
  for (const item of source) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const [kind] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["other", 0];
  const action = kind === "explore" ? "Explore" : kind === "edit" ? "Edited" : kind === "read" ? "Read" : kind === "run" ? "Run" : kind === "web" ? "Web" : kind === "mode" ? "Mode" : "Tools";
  const uniqueTargets = new Set(source.map((item) => `${item.detail}${item.title}`).filter(Boolean));
  const unit = kind === "read" || kind === "edit" || kind === "explore" ? "file" : "tool";
  const count = `${Math.max(1, uniqueTargets.size || source.length)} ${unit}${Math.max(1, uniqueTargets.size || source.length) === 1 ? "" : "s"}`;
  return { kind: kind as ToolActivityDisplay["kind"], action, count };
}

function displayValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function toolTarget(args: Record<string, unknown> | undefined, keys: string[]): string {
  if (!args) return "";
  for (const key of keys) {
    const value = displayValue(args[key]);
    if (value) return value;
  }
  return "";
}

function pathFromToolArgs(args: Record<string, unknown> | undefined): string {
  return toolTarget(args, ["path", "file_path", "output_path", "filename", "owner", "repo"]);
}

function parseDiffStat(text: string | undefined): { added: number; removed: number } {
  const value = text ?? "";
  const compact = value.match(/\+(\d+)\s+-([0-9]+)/);
  if (compact) return { added: Number(compact[1]), removed: Number(compact[2]) };
  const added = value.match(/(\d+)\s+(?:insertions?|additions?|added)/i);
  const removed = value.match(/(\d+)\s+(?:deletions?|removals?|removed)/i);
  return { added: added ? Number(added[1]) : 0, removed: removed ? Number(removed[1]) : 0 };
}

export function fileEditReviewItems(lines: Array<{ line: ChatLine; index: number }>): FileEditReviewItem[] {
  const byPath = new Map<string, FileEditReviewItem>();
  for (const { line, index } of lines) {
    if (line.role !== "tool") continue;
    const toolName = line.meta?.toolName;
    const display = compactToolAction(line.text);
    const isEdit = display.kind === "edit" || FILE_EDIT_TOOLS.has(String(toolName));
    if (!isEdit) continue;

    const explicitPath = pathFromToolArgs(line.meta?.toolArgs);
    const fallbackPath = `${display.detail}${display.title}`.trim();
    const path = explicitPath || fallbackPath;
    if (!path) continue;

    const parts = fileParts(path);
    const stats = parseDiffStat(line.meta?.toolResult ?? line.text);
    const existing = byPath.get(path);
    byPath.set(path, {
      key: existing?.key ?? `${index}:${path}`,
      path,
      name: parts.name || display.title || path,
      dir: parts.dir || display.detail,
      ext: parts.ext || display.badge || "file",
      added: (existing?.added ?? 0) + stats.added,
      removed: (existing?.removed ?? 0) + stats.removed,
    });
  }
  return [...byPath.values()];
}

export function fileEditReviewSummary(items: FileEditReviewItem[]): { added: number; removed: number; label: string } {
  const added = items.reduce((sum, item) => sum + item.added, 0);
  const removed = items.reduce((sum, item) => sum + item.removed, 0);
  return { added, removed, label: `${items.length} file${items.length === 1 ? "" : "s"} changed` };
}

function friendlyToolName(name: string | undefined): string {
  switch (name) {
    case "list_dir": return "list folder";
    case "list_tree": return "show tree";
    case "read_file":
    case "Read": return "read file";
    case "read_file_range": return "read lines";
    case "read_many_files": return "read files";
    case "file_info": return "inspect file";
    case "project_files_summary": return "summarize files";
    case "write_file":
    case "Write": return "write file";
    case "write_many_files": return "write files";
    case "edit_file":
    case "Edit": return "edit file";
    case "create_dir": return "create folder";
    case "delete_file": return "delete file";
    case "move_file": return "move file";
    case "search_replace": return "search and replace";
    case "glob_files":
    case "Glob": return "find files";
    case "grep_search":
    case "Grep": return "search files";
    case "git_status": return "check Git status";
    case "git_diff": return "inspect Git diff";
    case "git_log": return "show Git history";
    case "git_show": return "show Git commit";
    case "git_blame": return "inspect Git blame";
    case "npm_scripts": return "inspect package scripts";
    case "run_tests": return "run tests";
    case "diagnostics": return "run diagnostics";
    case "format_files": return "format files";
    case "lint": return "run lint";
    case "dependency_audit": return "audit dependencies";
    case "PowerShell":
    case "Bash":
    case "terminal_start": return "run command";
    case "WebSearch": return "search the web";
    case "deep_research_search": return "research search";
    case "WebFetch": return "read web page";
    case "ui_inspect": return "inspect UI";
    case "screenshot_url": return "capture screenshot";
    case "project_context": return "inspect project";
    case "open_url": return "open URL";
    case "dev_server_start": return "start dev server";
    case "dev_server_status": return "check dev server";
    case "release_prepare": return "check release";
    case "release_verify": return "verify release";
    case "AskUserQuestion": return "ask user";
    case "SubagentMessage": return "continue subagent";
    default: return name ? name.replace(/_/g, " ") : "tool";
  }
}

export function describeToolCall(name: string | undefined, args: Record<string, unknown> | undefined): string {
  if (name === "Agent") {
    const task = toolTarget(args, ["task", "description"]);
    return task ? `Started subagent: ${task}` : "Started subagent";
  }
  if (name === "SubagentMessage") {
    const target = toolTarget(args, ["subagentId"]);
    return target ? `Continued subagent: ${target}` : "Continued subagent";
  }
  if (name === "AskUserQuestion") {
    const question = toolTarget(args, ["question"]);
    return question ? `Asked user: ${question}` : "Asked user";
  }
  const target =
    toolTarget(args, ["path", "file_path", "pattern", "query", "command", "url", "task", "description"]) ||
    toolTarget(args, ["src", "from", "dst", "to"]);
  const action = friendlyToolName(name);
  return target ? `Using ${action}: ${target}` : `Using ${action}`;
}

export function describeToolResult(name: string | undefined, result: string | undefined): string {
  if (name === "Agent") return "Finished subagent";
  if (name === "SubagentMessage") return "Finished subagent follow-up";
  const action = friendlyToolName(name);
  const text = result ?? "";
  if (/^(Tool .* failed:|Unknown tool:|Tool unavailable|Blocked:|Blocked by permission rule|User denied)/.test(text)) {
    return `${action} did not complete`;
  }
  return `Finished ${action}`;
}

export function groupRenderedChat(lines: ChatLine[], startIndex: number): RenderedChatItem[] {
  const items: RenderedChatItem[] = [];
  let current: RenderedChatItem | null = null;

  lines.forEach((line, relativeIndex) => {
    const index = startIndex + relativeIndex;
    if (line.role === "user") {
      current = null;
      items.push({ type: "user", startIndex: index, user: line });
      return;
    }

    if (!current) {
      current = { type: "agent-run", startIndex: index, lines: [] };
      items.push(current);
    }
    current.lines?.push({ line, index });
  });

  return items;
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function elapsedLabel(startedAt: number | undefined, completedAt: number | undefined, fallback: string): string {
  if (!startedAt || !completedAt || completedAt < startedAt) return fallback;
  return `Worked for ${formatElapsed(completedAt - startedAt)}`;
}
