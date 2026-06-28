import { invoke } from "@tauri-apps/api/core";
import type { Tool } from "./tools";

async function callGit(command: string, args: Record<string, unknown> = {}) {
  try {
    const content = await invoke<string>(command, args);
    return { ok: true, content: content || "Done." };
  } catch (err) {
    return { ok: false, isError: true, content: String(err) };
  }
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function createGitTools(): Tool[] {
  return [
    {
      definition: {
        name: "git_status",
        description:
          "Show the current Git branch and working tree status for the active workspace. " +
          "Use this instead of running git status through a terminal.",
        inputSchema: { type: "object", properties: {} },
      },
      execute: () => callGit("git_status"),
    },
    {
      definition: {
        name: "git_diff",
        description:
          "Show a Git diff for the active workspace. Use staged=true for the staged diff, " +
          "or provide a workspace-relative path to inspect one file.",
        inputSchema: {
          type: "object",
          properties: {
            staged: { type: "boolean", description: "Whether to show the staged diff." },
            path: { type: "string", description: "Optional workspace-relative file path." },
          },
        },
      },
      execute: (args) =>
        callGit("git_diff", {
          staged: Boolean(args.staged),
          path: optionalString(args.path),
        }),
    },
    {
      definition: {
        name: "git_branch",
        description:
          "List local and remote Git branches for the active workspace. Use this instead " +
          "of running git branch through a terminal.",
        inputSchema: { type: "object", properties: {} },
      },
      execute: () => callGit("git_branch"),
    },
    {
      definition: {
        name: "git_current_branch",
        description: "Show only the current Git branch name for the active workspace.",
        inputSchema: { type: "object", properties: {} },
      },
      execute: () => callGit("git_current_branch"),
    },
    {
      definition: {
        name: "git_log",
        description:
          "Show recent Git commits for the active workspace. Use this instead of running git log through a terminal.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Maximum number of commits to show. Defaults to 10." },
          },
        },
      },
      execute: (args) =>
        callGit("git_log", {
          limit: typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : undefined,
        }),
    },
    {
      definition: {
        name: "git_show",
        description:
          "Show a Git commit, tag, branch, or file-at-revision with stat and patch output.",
        inputSchema: {
          type: "object",
          properties: {
            rev: { type: "string", description: "Revision to show. Defaults to HEAD." },
            path: { type: "string", description: "Optional workspace-relative path to limit output." },
          },
        },
      },
      execute: (args) =>
        callGit("git_show", {
          rev: optionalString(args.rev),
          path: optionalString(args.path),
        }),
    },
    {
      definition: {
        name: "git_blame",
        description:
          "Show Git blame for a workspace file, optionally limited to a line range.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path." },
            start_line: { type: "number", description: "Optional first one-based line number." },
            end_line: { type: "number", description: "Optional last one-based line number." },
          },
          required: ["path"],
        },
      },
      execute: (args) =>
        callGit("git_blame", {
          path: String(args.path ?? ""),
          startLine: typeof args.start_line === "number" ? args.start_line : undefined,
          endLine: typeof args.end_line === "number" ? args.end_line : undefined,
        }),
    },
    {
      definition: {
        name: "git_commit",
        description:
          "Create a Git commit in the active workspace. Set all=true to stage all changes " +
          "before committing; otherwise this commits only already-staged changes.",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string", description: "Commit message." },
            all: { type: "boolean", description: "Stage all changes before committing." },
          },
          required: ["message"],
        },
      },
      execute: (args) =>
        callGit("git_commit", {
          message: String(args.message ?? ""),
          all: Boolean(args.all),
        }),
    },
    {
      definition: {
        name: "git_push",
        description:
          "Push the active workspace's current branch to a Git remote. Defaults to origin " +
          "when no remote is provided.",
        inputSchema: {
          type: "object",
          properties: {
            remote: { type: "string", description: "Remote name, usually origin." },
            branch: { type: "string", description: "Optional branch name." },
          },
        },
      },
      execute: (args) =>
        callGit("git_push", {
          remote: optionalString(args.remote),
          branch: optionalString(args.branch),
        }),
    },
    {
      definition: {
        name: "git_pull",
        description:
          "Pull from a Git remote into the active workspace. Defaults to origin when no " +
          "remote is provided.",
        inputSchema: {
          type: "object",
          properties: {
            remote: { type: "string", description: "Remote name, usually origin." },
            branch: { type: "string", description: "Optional branch name." },
          },
        },
      },
      execute: (args) =>
        callGit("git_pull", {
          remote: optionalString(args.remote),
          branch: optionalString(args.branch),
        }),
    },
    {
      definition: {
        name: "git_reset",
        description:
          "Run git reset in the active workspace. mode may be soft, mixed, or hard. Hard reset is destructive and requires confirmation.",
        inputSchema: {
          type: "object",
          properties: {
            mode: { type: "string", description: "Reset mode: soft, mixed, or hard. Defaults to mixed." },
            ref: { type: "string", description: "Optional target ref. Defaults to HEAD." },
            target: { type: "string", description: "Alias for ref." },
          },
        },
      },
      execute: (args) =>
        callGit("git_reset", {
          mode: optionalString(args.mode),
          target: optionalString(args.ref) ?? optionalString(args.target),
        }),
    },
  ];
}
