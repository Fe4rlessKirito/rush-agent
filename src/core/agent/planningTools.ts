import type { Tool } from "./tools";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export interface PlanningState {
  inPlanMode: boolean;
  lastPlan: string;
  pendingQuestion: string;
  todos: TodoItem[];
}

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function todoStatus(value: unknown): TodoStatus {
  const status = text(value);
  return status === "completed" || status === "in_progress" ? status : "pending";
}

function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return "No todos.";
  return todos
    .map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content} (${todo.id})`)
    .join("\n");
}

function parseTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const item = raw as Record<string, unknown>;
    return {
      id: text(item.id) || id("todo"),
      content: text(item.content ?? item.text ?? item.title) || "Untitled todo",
      status: todoStatus(item.status),
    };
  });
}

function formatChoices(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "";
  return value
    .map((raw, index) => {
      const item = raw as Record<string, unknown>;
      const label = text(item.label ?? item.value ?? item);
      const description = text(item.description);
      return `${index + 1}. ${label}${description ? ` - ${description}` : ""}`;
    })
    .join("\n");
}

export class PlanningStore {
  private state: PlanningState = {
    inPlanMode: false,
    lastPlan: "",
    pendingQuestion: "",
    todos: [],
  };

  enterPlanMode(): PlanningState {
    this.state = { ...this.state, inPlanMode: true };
    return this.snapshot();
  }

  exitPlanMode(plan: string): PlanningState {
    this.state = { ...this.state, inPlanMode: false, lastPlan: plan };
    return this.snapshot();
  }

  ask(question: string): PlanningState {
    this.state = { ...this.state, pendingQuestion: question };
    return this.snapshot();
  }

  writeTodos(todos: TodoItem[]): PlanningState {
    this.state = { ...this.state, todos };
    return this.snapshot();
  }

  snapshot(): PlanningState {
    return {
      ...this.state,
      todos: this.state.todos.map((todo) => ({ ...todo })),
    };
  }

  clear(): void {
    this.state = {
      inPlanMode: false,
      lastPlan: "",
      pendingQuestion: "",
      todos: [],
    };
  }
}

export const planningStore = new PlanningStore();

export function createPlanningTools(store: PlanningStore = planningStore): Tool[] {
  return [
    {
      definition: {
        name: "EnterPlanMode",
        description:
          "Switch into planning mode for a complex or ambiguous task. Use this before presenting a plan instead of editing files immediately.",
        inputSchema: {
          type: "object",
          properties: {
            reason: { type: "string", description: "Why planning is needed." },
          },
        },
      },
      async execute(args) {
        store.enterPlanMode();
        const reason = text(args.reason);
        return {
          ok: true,
          content: `Plan mode entered.${reason ? `\nReason: ${reason}` : ""}`,
        };
      },
    },
    {
      definition: {
        name: "ExitPlanMode",
        description:
          "Present the implementation plan and leave planning mode. This records the plan for the current session.",
        inputSchema: {
          type: "object",
          properties: {
            plan: { type: "string", description: "The plan to present." },
          },
          required: ["plan"],
        },
      },
      async execute(args) {
        const plan = text(args.plan);
        if (!plan) return { ok: false, isError: true, content: "Missing plan." };
        store.exitPlanMode(plan);
        return { ok: true, content: `Plan recorded:\n${plan}` };
      },
    },
    {
      definition: {
        name: "AskUserQuestion",
        description:
          "Ask the user a bounded clarification question. The assistant should stop after using this tool and wait for the user answer.",
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string", description: "Question to ask the user." },
            choices: { type: "array", items: { type: "object" }, description: "Optional multiple-choice options." },
          },
          required: ["question"],
        },
      },
      async execute(args) {
        const question = text(args.question);
        if (!question) return { ok: false, isError: true, content: "Missing question." };
        const choices = formatChoices(args.choices);
        const prompt = choices ? `${question}\n\n${choices}` : question;
        store.ask(prompt);
        return {
          ok: true,
          content: `Question for user:\n${prompt}\n\nStop and wait for the user's answer before continuing.`,
        };
      },
    },
    {
      definition: {
        name: "TodoWrite",
        description:
          "Replace the current session todo checklist. Use this to keep multi-step work visible and update statuses as work progresses.",
        inputSchema: {
          type: "object",
          properties: {
            todos: {
              type: "array",
              items: { type: "object" },
              description: "Items with content/title/text and status pending, in_progress, or completed.",
            },
          },
          required: ["todos"],
        },
      },
      async execute(args) {
        const todos = parseTodos(args.todos);
        store.writeTodos(todos);
        return { ok: true, content: `Todo checklist updated:\n${formatTodos(todos)}` };
      },
    },
  ];
}
