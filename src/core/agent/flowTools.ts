import type { Provider, ChatMessage } from "../providers/types";
import { runAgent, type AgentEvent } from "./agentLoop";
import type { Tool, ToolRegistry } from "./tools";

export type FlowTaskStatus = "pending" | "in_progress" | "completed" | "blocked" | "cancelled";

export interface FlowTask {
  id: string;
  title: string;
  details: string;
  status: FlowTaskStatus;
  dependencies: string[];
  output: string;
  createdAt: number;
  updatedAt: number;
}

export interface FlowToolOptions {
  getProvider: () => Provider;
  getModel: () => string;
  getTools: () => ToolRegistry;
  getProjectInstructions?: () => string;
  maxAgentTurns?: number;
  taskStore?: FlowTaskStore;
  getSubagents?: () => Array<{ id: string; title: string; task: string; status: string }>;
  getSubagentMessages?: (id: string) => ChatMessage[];
  onSubagentStart?: (meta: { task: string; title: string }) => string | undefined;
  onSubagentEvent?: (id: string, event: AgentEvent) => void;
  onSubagentMessages?: (id: string, messages: ChatMessage[]) => void;
  onSubagentDone?: (id: string, status: "completed" | "blocked" | "cancelled") => void;
}

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function list(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).filter(Boolean);
}

function now(): number {
  return Date.now();
}

function formatTask(task: FlowTask): string {
  return [
    `${task.id} [${task.status}] ${task.title}`,
    task.details ? `Details: ${task.details}` : "",
    task.dependencies.length ? `Dependencies: ${task.dependencies.join(", ")}` : "",
    task.output ? `Output: ${task.output}` : "",
  ].filter(Boolean).join("\n");
}

function formatSubagents(subagents: Array<{ id: string; title: string; task: string; status: string }>): string {
  return subagents.length
    ? subagents.map((run) => `${run.id} [${run.status}] ${run.title}\nTask: ${run.task}`).join("\n\n")
    : "No existing subagents.";
}

async function runSubagentThread(options: FlowToolOptions, id: string | undefined, messages: ChatMessage[], turns: number) {
  const provider = options.getProvider();
  const model = options.getModel();
  const childTools = options.getTools();
  const chunks: string[] = [];
  const toolEvents: string[] = [];
  let status: "completed" | "blocked" | "cancelled" = "completed";

  try {
    for await (const event of runAgent(
      provider,
      model,
      childTools,
      messages,
      undefined,
      turns,
      [
        options.getProjectInstructions?.() ?? "",
        "You are a Rush subagent. Work on only the assigned task and return a concise result for the parent agent. Do not ask the user questions. Do not broaden your scope beyond the task you were assigned.",
      ].filter(Boolean).join("\n\n"),
      undefined,
      messages,
    )) {
      options.onSubagentEvent?.(id ?? "", event);
      if (event.type === "text" && event.text) chunks.push(event.text);
      if (event.type === "tool_call" && event.toolName) toolEvents.push(`called ${event.toolName}`);
      if (event.type === "error" && event.text) {
        status = "blocked";
        chunks.push(`Error: ${event.text}`);
      }
    }
  } catch (err) {
    status = "blocked";
    chunks.push(`Error: ${String(err)}`);
  } finally {
    if (id) {
      options.onSubagentMessages?.(id, messages);
      options.onSubagentDone?.(id, status);
    }
  }

  return { content: chunks.join("").trim() || "Subagent finished without a text response.", status, toolEvents };
}

export class FlowTaskStore {
  private tasks = new Map<string, FlowTask>();

  create(args: { title: string; details?: string; dependencies?: string[] }): FlowTask {
    const time = now();
    const task: FlowTask = {
      id: id("task"),
      title: args.title || "Untitled task",
      details: args.details ?? "",
      status: "pending",
      dependencies: args.dependencies ?? [],
      output: "",
      createdAt: time,
      updatedAt: time,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  list(status?: string): FlowTask[] {
    const tasks = [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
    return status ? tasks.filter((task) => task.status === status) : tasks;
  }

  get(id: string): FlowTask | null {
    return this.tasks.get(id) ?? null;
  }

  update(id: string, patch: Partial<Pick<FlowTask, "title" | "details" | "status" | "dependencies" | "output">>): FlowTask | null {
    const task = this.tasks.get(id);
    if (!task) return null;
    const next: FlowTask = {
      ...task,
      ...patch,
      dependencies: patch.dependencies ?? task.dependencies,
      updatedAt: now(),
    };
    this.tasks.set(id, next);
    return next;
  }

  stop(id: string): FlowTask | null {
    return this.update(id, { status: "cancelled" });
  }

  clear(): void {
    this.tasks.clear();
  }
}

export const flowTaskStore = new FlowTaskStore();

export function createFlowTools(options: FlowToolOptions): Tool[] {
  const taskStore = options.taskStore ?? flowTaskStore;
  const maxAgentTurns = options.maxAgentTurns ?? 4;

  return [
    {
      definition: {
        name: "Agent",
        description:
          "Spawn a bounded Flow subagent for focused research, code inspection, implementation, or verification. In Flow mode, batch independent Agent calls with <tool_calls> so each subagent becomes its own worker lane.",
        inputSchema: {
          type: "object",
          properties: {
            task: { type: "string", description: "Concrete task for the subagent." },
            description: { type: "string", description: "Alias for task." },
            maxTurns: { type: "number", description: "Maximum subagent turns, capped by Rush." },
          },
          required: ["task"],
        },
      },
      async execute(args) {
        const task = text(args.task) || text(args.description);
        if (!task) return { ok: false, isError: true, content: "Missing task." };
        const turns = Math.max(1, Math.min(maxAgentTurns, Number(args.maxTurns ?? maxAgentTurns) || maxAgentTurns));
        const subagentId = options.onSubagentStart?.({
          task,
          title: task.length > 52 ? `${task.slice(0, 52)}...` : task,
        });
        const childMessages: ChatMessage[] = [{ role: "user", content: task }];
        const result = await runSubagentThread(options, subagentId, childMessages, turns);

        return {
          ok: true,
          content: [`Subagent ${subagentId ? `${subagentId} ` : ""}result for: ${task}`, result.toolEvents.length ? `Tools: ${result.toolEvents.join(", ")}` : "", "", result.content]
            .filter((part) => part !== "")
            .join("\n"),
        };
      },
    },
    {
      definition: {
        name: "SubagentMessage",
        description:
          "Continue an existing Rush subagent conversation by ID. Use this when a prior subagent needs a follow-up prompt instead of spawning a fresh subagent. Existing subagents are:\n" + formatSubagents(options.getSubagents?.() ?? []),
        inputSchema: {
          type: "object",
          properties: {
            subagentId: { type: "string", description: "ID of the existing subagent to continue." },
            message: { type: "string", description: "Follow-up prompt for the subagent." },
            maxTurns: { type: "number", description: "Maximum subagent turns, capped by Rush." },
          },
          required: ["subagentId", "message"],
        },
      },
      async execute(args) {
        const subagentId = text(args.subagentId);
        const message = text(args.message);
        if (!subagentId) return { ok: false, isError: true, content: "Missing subagentId." };
        if (!message) return { ok: false, isError: true, content: "Missing message." };
        const subagent = options.getSubagents?.().find((run) => run.id === subagentId);
        if (!subagent) return { ok: false, isError: true, content: `Unknown subagent: ${subagentId}\n\n${formatSubagents(options.getSubagents?.() ?? [])}` };
        const turns = Math.max(1, Math.min(maxAgentTurns, Number(args.maxTurns ?? maxAgentTurns) || maxAgentTurns));
        options.onSubagentEvent?.(subagentId, { type: "tool_call", toolName: "SubagentMessage", toolArgs: { message } });
        options.onSubagentEvent?.(subagentId, { type: "tool_result", toolName: "SubagentMessage", toolResult: "Follow-up from coordinator" });
        const childMessages: ChatMessage[] = [...(options.getSubagentMessages?.(subagentId) ?? []), { role: "user", content: message }];
        const result = await runSubagentThread(options, subagentId, childMessages, turns);

        return {
          ok: true,
          content: [`Continued subagent ${subagentId}: ${subagent.title}`, result.toolEvents.length ? `Tools: ${result.toolEvents.join(", ")}` : "", "", result.content]
            .filter((part) => part !== "")
            .join("\n"),
        };
      },
    },
    {
      definition: {
        name: "TaskCreate",
        description: "Create a Flow task in the current session task list.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short task title." },
            details: { type: "string", description: "Task details." },
            dependencies: { type: "array", items: { type: "string" }, description: "Task IDs this task depends on." },
          },
          required: ["title"],
        },
      },
      async execute(args) {
        const task = taskStore.create({
          title: text(args.title),
          details: text(args.details),
          dependencies: list(args.dependencies),
        });
        return { ok: true, content: formatTask(task) };
      },
    },
    {
      definition: {
        name: "TaskList",
        description: "List Flow tasks in the current session.",
        inputSchema: {
          type: "object",
          properties: {
            status: { type: "string", description: "Optional status filter." },
          },
        },
      },
      async execute(args) {
        const tasks = taskStore.list(text(args.status) || undefined);
        return { ok: true, content: tasks.length ? tasks.map(formatTask).join("\n\n") : "No tasks." };
      },
    },
    {
      definition: {
        name: "TaskGet",
        description: "Get full details for a Flow task by ID.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", description: "Task ID." } },
          required: ["id"],
        },
      },
      async execute(args) {
        const task = taskStore.get(text(args.id));
        return task ? { ok: true, content: formatTask(task) } : { ok: false, isError: true, content: `Unknown task: ${text(args.id)}` };
      },
    },
    {
      definition: {
        name: "TaskUpdate",
        description: "Update a Flow task status, title, details, dependencies, or output.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Task ID." },
            title: { type: "string" },
            details: { type: "string" },
            status: { type: "string", description: "pending, in_progress, completed, blocked, or cancelled." },
            dependencies: { type: "array", items: { type: "string" } },
            output: { type: "string" },
          },
          required: ["id"],
        },
      },
      async execute(args) {
        const patch: Partial<Pick<FlowTask, "title" | "details" | "status" | "dependencies" | "output">> = {};
        if ("title" in args) patch.title = text(args.title);
        if ("details" in args) patch.details = text(args.details);
        if ("status" in args) patch.status = text(args.status) as FlowTaskStatus;
        if ("dependencies" in args) patch.dependencies = list(args.dependencies);
        if ("output" in args) patch.output = String(args.output ?? "");
        const task = taskStore.update(text(args.id), patch);
        return task ? { ok: true, content: formatTask(task) } : { ok: false, isError: true, content: `Unknown task: ${text(args.id)}` };
      },
    },
    {
      definition: {
        name: "TaskStop",
        description: "Cancel a Flow task by ID.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", description: "Task ID." } },
          required: ["id"],
        },
      },
      async execute(args) {
        const task = taskStore.stop(text(args.id));
        return task ? { ok: true, content: formatTask(task) } : { ok: false, isError: true, content: `Unknown task: ${text(args.id)}` };
      },
    },
    {
      definition: {
        name: "TaskOutput",
        description: "Return the stored output for a Flow task by ID.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", description: "Task ID." } },
          required: ["id"],
        },
      },
      async execute(args) {
        const task = taskStore.get(text(args.id));
        if (!task) return { ok: false, isError: true, content: `Unknown task: ${text(args.id)}` };
        return { ok: true, content: task.output || "No output recorded." };
      },
    },
  ];
}
