import { invoke } from "@tauri-apps/api/core";
import type { Tool } from "./tools";

export interface WorktreeInfo {
  path: string;
  previous_root: string;
  branch: string;
}

export interface WorktreeBackend {
  enter(args: { name?: string; branch?: string; base?: string; path?: string }): Promise<WorktreeInfo>;
  exit(args: { remove?: boolean }): Promise<WorktreeInfo>;
}

const tauriWorktreeBackend: WorktreeBackend = {
  enter(args) {
    return invoke<WorktreeInfo>("enter_worktree", args);
  },
  exit(args) {
    return invoke<WorktreeInfo>("exit_worktree", args);
  },
};

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function formatEntered(info: WorktreeInfo): string {
  return [
    `Entered worktree: ${info.path}`,
    `Previous root: ${info.previous_root}`,
    info.branch ? `Branch: ${info.branch}` : "",
    "All filesystem, git, terminal, and agent tools now operate in this worktree.",
  ].filter(Boolean).join("\n");
}

function formatExited(info: WorktreeInfo): string {
  return [
    `Exited worktree. Active root: ${info.path}`,
    `Previous worktree: ${info.previous_root}`,
    info.branch ? `Worktree branch: ${info.branch}` : "",
  ].filter(Boolean).join("\n");
}

export function createWorktreeTools(backend: WorktreeBackend = tauriWorktreeBackend): Tool[] {
  return [
    {
      definition: {
        name: "EnterWorktree",
        description:
          "Create or enter an isolated Git worktree and switch Rush's active project root to it. Use for risky or parallel work.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Safe worktree directory name under .rush/worktrees." },
            branch: { type: "string", description: "Optional branch name. Defaults to rush/<name>." },
            base: { type: "string", description: "Optional base ref. Defaults to HEAD." },
            path: { type: "string", description: "Optional existing relative path under .rush/worktrees." },
          },
        },
      },
      async execute(args) {
        const info = await backend.enter({
          name: optionalText(args.name),
          branch: optionalText(args.branch),
          base: optionalText(args.base),
          path: optionalText(args.path),
        });
        return { ok: true, content: formatEntered(info) };
      },
    },
    {
      definition: {
        name: "ExitWorktree",
        description:
          "Exit the current Rush worktree and restore the previous project root. Set remove=true to request git worktree removal after switching back.",
        inputSchema: {
          type: "object",
          properties: {
            remove: { type: "boolean", description: "Remove the worktree after exiting." },
          },
        },
      },
      async execute(args) {
        const info = await backend.exit({ remove: args.remove === true });
        return { ok: true, content: formatExited(info) };
      },
    },
  ];
}
