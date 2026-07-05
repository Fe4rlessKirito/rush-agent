import type { Provider, ChatMessage } from "../providers/types";
import { runAgent } from "./agentLoop";
import type { Tool, ToolRegistry } from "./tools";

export interface SplitUpOptions {
  getProvider: () => Provider;
  getModel: () => string;
  getTools: () => ToolRegistry;
  getProjectInstructions?: () => string;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function numberArg(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, num));
}

const PERSPECTIVES = [
  "Correctness: find logical errors, edge cases, and missing requirements.",
  "Security: identify unsafe assumptions, injection risks, permission issues, and data exposure.",
  "Performance: look for avoidable latency, memory, IO, and scaling problems.",
  "Alternatives: propose simpler or more maintainable approaches.",
  "Maintainability: inspect readability, testability, API boundaries, and future changes.",
  "Verification: focus on concrete tests and checks that prove the answer.",
];

async function runBranch(options: SplitUpOptions, task: string, perspective: string, maxTurns: number): Promise<string> {
  const messages: ChatMessage[] = [{ role: "user", content: [`Task:\n${task}`, "", `Perspective:\n${perspective}`, "", "Return concise findings. Do not call split_up recursively."].join("\n") }];
  const chunks: string[] = [];
  for await (const event of runAgent(
    options.getProvider(),
    options.getModel(),
    options.getTools(),
    messages,
    undefined,
    maxTurns,
    [
      options.getProjectInstructions?.() ?? "",
      "You are one branch in a Rush split_up parallel analysis. Stay focused on your assigned perspective. Do not call split_up. Be concise and concrete.",
    ].filter(Boolean).join("\n\n"),
    undefined,
    messages,
  )) {
    if (event.type === "text" && event.text) chunks.push(event.text);
    if (event.type === "error" && event.text) chunks.push(`Error: ${event.text}`);
  }
  return chunks.join("").trim() || "No findings.";
}

export function createSplitUpTools(options: SplitUpOptions): Tool[] {
  return [
    {
      definition: {
        name: "split_up",
        description: "Fan out the same task to several bounded model branches with different analytical perspectives, then return their findings. Use for multi-angle analysis, not independent implementation subtasks. Do not call recursively.",
        inputSchema: {
          type: "object",
          properties: {
            task: { type: "string", description: "Task or question for all branches to analyze." },
            branches: { type: "number", description: "Number of perspectives, 1-6." },
            max_turns: { type: "number", description: "Max turns per branch, capped at 4." },
          },
          required: ["task"],
        },
      },
      async execute(args) {
        const task = text(args.task);
        if (!task) return { ok: false, isError: true, content: "Missing split_up task." };
        const branches = numberArg(args.branches, 3, 1, 6);
        const maxTurns = numberArg(args.max_turns, 2, 1, 4);
        const perspectives = PERSPECTIVES.slice(0, branches);
        const tools = options.getTools();
        const originalList = tools.list.bind(tools);
        tools.list = () => originalList().filter((tool) => tool.name !== "split_up");
        try {
          const results = await Promise.all(perspectives.map(async (perspective) => ({
            perspective,
            content: await runBranch(options, task, perspective, maxTurns),
          })));
          return {
            ok: true,
            content: [
              `split_up analysis for: ${task}`,
              "",
              ...results.map((result, index) => [`## Branch ${index + 1}: ${result.perspective}`, result.content].join("\n\n")),
              "",
              "Synthesize these branch findings before making a final recommendation.",
            ].join("\n\n"),
          };
        } finally {
          tools.list = originalList;
        }
      },
    },
  ];
}
