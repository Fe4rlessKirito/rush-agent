import { invoke } from "@tauri-apps/api/core";
import type { Tool } from "./tools";

export interface BackgroundJobSummary {
  id: string;
  command: string;
  shell: string;
  status: string;
  created_at: number;
}

export interface BackgroundReadResult {
  id: string;
  status: string;
  output: string;
}

export interface BackgroundBackend {
  start(args: { command: string; shell?: string }): Promise<BackgroundJobSummary>;
  read(id: string): Promise<BackgroundReadResult>;
  list(): Promise<BackgroundJobSummary[]>;
  stop(id: string): Promise<string>;
}

const tauriBackgroundBackend: BackgroundBackend = {
  start(args) {
    return invoke<BackgroundJobSummary>("background_start", args);
  },
  read(id) {
    return invoke<BackgroundReadResult>("background_read", { id });
  },
  list() {
    return invoke<BackgroundJobSummary[]>("background_list");
  },
  stop(id) {
    return invoke<string>("background_stop", { id });
  },
};

function commandArg(args: Record<string, unknown>): string {
  return String(args.command ?? "").trim();
}

function shellArg(args: Record<string, unknown>, fallback?: string): string | undefined {
  const value = String(args.shell ?? fallback ?? "").trim();
  return value || undefined;
}

function formatJob(job: BackgroundJobSummary): string {
  return `${job.id} [${job.status}] ${job.shell}: ${job.command}`;
}

function formatJobs(jobs: BackgroundJobSummary[]): string {
  return jobs.length ? jobs.map(formatJob).join("\n") : "No background jobs.";
}

function devUrl(value: unknown): string {
  const url = String(value ?? "http://localhost:5173").trim();
  return /^https?:\/\//i.test(url) ? url : `http://${url}`;
}

export function createBackgroundTools(backend: BackgroundBackend = tauriBackgroundBackend): Tool[] {
  return [
    {
      definition: {
        name: "background_start",
        description:
          "Start a command as a real background process in the active workspace. Use background_read to collect output and background_stop to terminate it.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Command to run." },
            shell: { type: "string", description: "Optional shell: powershell, pwsh, cmd, sh, bash." },
          },
          required: ["command"],
        },
      },
      async execute(args) {
        const command = commandArg(args);
        if (!command) return { ok: false, isError: true, content: "Missing command." };
        const job = await backend.start({ command, shell: shellArg(args) });
        return { ok: true, content: `Started ${formatJob(job)}` };
      },
    },
    {
      definition: {
        name: "dev_server_start",
        description:
          "Start a development server as a background job. Defaults to npm run dev and returns the job id.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Server command. Defaults to npm run dev." },
            shell: { type: "string", description: "Optional shell: powershell, pwsh, cmd, sh, bash." },
            url: { type: "string", description: "Expected server URL, defaults to http://localhost:5173." },
          },
        },
      },
      async execute(args) {
        const command = commandArg(args) || "npm run dev";
        const job = await backend.start({ command, shell: shellArg(args) });
        return {
          ok: true,
          content: [
            `Started dev server ${formatJob(job)}`,
            `Expected URL: ${devUrl(args.url)}`,
            "Use dev_server_status to check readiness.",
          ].join("\n"),
        };
      },
    },
    {
      definition: {
        name: "dev_server_status",
        description:
          "List dev-server background jobs and optionally check an expected local URL for a response.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "Optional URL to check, defaults to http://localhost:5173." },
          },
        },
      },
      async execute(args) {
        const jobs = (await backend.list()).filter((job) => /npm run dev|vite|next dev|dev server/i.test(job.command));
        const url = devUrl(args.url);
        let status = "";
        try {
          const res = await fetch(url, { method: "GET" });
          status = `URL ${url}: HTTP ${res.status}`;
        } catch (err) {
          status = `URL ${url}: not reachable (${String(err)})`;
        }
        return { ok: true, content: [`Jobs:\n${formatJobs(jobs)}`, status].join("\n\n") };
      },
    },
    {
      definition: {
        name: "background_read",
        description:
          "Read and clear buffered output from a background job. Also reports whether the job is still running, completed, failed, or cancelled.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", description: "Background job ID." } },
          required: ["id"],
        },
      },
      async execute(args) {
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, isError: true, content: "Missing id." };
        const result = await backend.read(id);
        return { ok: true, content: `${result.id} [${result.status}]\n${result.output}` };
      },
    },
    {
      definition: {
        name: "background_list",
        description: "List active and recently completed background jobs.",
        inputSchema: { type: "object", properties: {} },
      },
      async execute() {
        return { ok: true, content: formatJobs(await backend.list()) };
      },
    },
    {
      definition: {
        name: "background_stop",
        description: "Stop a running background job by ID.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", description: "Background job ID." } },
          required: ["id"],
        },
      },
      async execute(args) {
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, isError: true, content: "Missing id." };
        return { ok: true, content: await backend.stop(id) };
      },
    },
    {
      definition: {
        name: "Monitor",
        description:
          "Claude-compatible monitor tool. Starts a background command/watch and returns its job ID. Use background_read to react to output and background_stop to cancel it.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Command or polling script to run in the background." },
            shell: { type: "string", description: "Optional shell: powershell, pwsh, cmd, sh, bash." },
            description: { type: "string", description: "What this monitor watches." },
          },
          required: ["command"],
        },
      },
      async execute(args) {
        const command = commandArg(args);
        if (!command) return { ok: false, isError: true, content: "Missing command." };
        const job = await backend.start({ command, shell: shellArg(args) });
        return {
          ok: true,
          content: [
            `Monitor started: ${formatJob(job)}`,
            args.description ? `Description: ${String(args.description)}` : "",
            "Use background_read with this job ID to inspect new output.",
          ].filter(Boolean).join("\n"),
        };
      },
    },
  ];
}
