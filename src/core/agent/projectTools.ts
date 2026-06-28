import { invoke } from "@tauri-apps/api/core";
import type { Tool } from "./tools";

export interface ProjectContextInfo {
  mode: string;
  projectName?: string;
  projectPath?: string;
  activeProjectId?: string | null;
  instructions?: string;
}

export interface ProjectToolOptions {
  getContext: () => ProjectContextInfo;
}

function formatContext(context: ProjectContextInfo): string {
  return [
    `Mode: ${context.mode || "unknown"}`,
    `Active project ID: ${context.activeProjectId || "(none)"}`,
    `Project name: ${context.projectName || "(none)"}`,
    `Project path: ${context.projectPath || "(not set)"}`,
    context.instructions?.trim() ? `Project instructions:\n${context.instructions.trim()}` : "Project instructions: (none)",
  ].join("\n");
}

export function createProjectTools(options: ProjectToolOptions): Tool[] {
  return [
    {
      definition: {
        name: "project_context",
        description:
          "Show the active Rush mode and project identity/path/instructions. Use this before project-aware work when location or context is uncertain.",
        inputSchema: { type: "object", properties: {} },
      },
      async execute() {
        return { ok: true, content: formatContext(options.getContext()) };
      },
    },
    {
      definition: {
        name: "open_url",
        description:
          "Open an http or https URL in the system browser. Useful for local dev servers and release pages.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to open." },
          },
          required: ["url"],
        },
      },
      async execute(args) {
        const url = String(args.url ?? "").trim();
        if (!/^https?:\/\//i.test(url)) {
          return { ok: false, isError: true, content: `Only http/https URLs can be opened: ${url}` };
        }
        await invoke("open_url", { url });
        return { ok: true, content: `Opened ${url}.` };
      },
    },
  ];
}
