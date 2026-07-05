import type { DurableMemoryFact } from "../durableMemoryStore";
import { scoreMemoryFacts, useDurableMemoryStore } from "../durableMemoryStore";
import type { Tool } from "./tools";

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function numberArg(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, num));
}

function formatFact(fact: DurableMemoryFact, score?: number): string {
  return [
    `${fact.id} [${fact.type}] ${fact.text}`,
    `Source: ${fact.source} | Used: ${fact.used}${score === undefined ? "" : ` | Score: ${score.toFixed(3)}`}`,
  ].join("\n");
}

export function createMemoryTools(): Tool[] {
  return [
    {
      definition: {
        name: "memory_save",
        description: "Save durable cross-session facts. Facts are normalized and deduplicated before storage.",
        inputSchema: {
          type: "object",
          properties: {
            facts: { type: "array", description: "Array of fact strings, or objects with text/type/source." },
            fact: { type: "string", description: "Single fact to save when facts is not provided." },
            type: { type: "string", description: "Optional memory type such as general, preference, project, or instruction." },
            source: { type: "string", description: "Optional source label." },
          },
        },
      },
      async execute(args) {
        const rawFacts = Array.isArray(args.facts) ? args.facts : [args.fact ?? args.text].filter(Boolean);
        const inputs = rawFacts.map((item) => {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            const record = item as Record<string, unknown>;
            return { text: text(record.text ?? record.fact), type: text(record.type ?? args.type), source: text(record.source ?? args.source) };
          }
          return { text: text(item), type: text(args.type), source: text(args.source) };
        }).filter((item) => item.text);
        if (!inputs.length) return { ok: false, isError: true, content: "No memory facts provided." };
        const result = useDurableMemoryStore.getState().saveFacts(inputs);
        return {
          ok: true,
          content: [
            `Saved ${result.saved.length} memor${result.saved.length === 1 ? "y" : "ies"}.`,
            result.saved.length ? result.saved.map((fact) => formatFact(fact)).join("\n\n") : "",
            result.skipped.length ? `Skipped duplicates:\n${result.skipped.join("\n")}` : "",
          ].filter(Boolean).join("\n\n"),
        };
      },
    },
    {
      definition: {
        name: "memory_retrieve",
        description: "Retrieve durable cross-session memories using TF-IDF relevance ranking.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query." },
            top_k: { type: "number", description: "Maximum facts to return, capped at 20." },
          },
          required: ["query"],
        },
      },
      async execute(args) {
        const query = text(args.query);
        if (!query) return { ok: false, isError: true, content: "Missing memory query." };
        const topK = numberArg(args.top_k ?? args.limit, 5, 1, 20);
        const ranked = scoreMemoryFacts(useDurableMemoryStore.getState().facts, query).slice(0, topK);
        useDurableMemoryStore.getState().markUsed(ranked.map((item) => item.fact.id));
        return {
          ok: true,
          content: ranked.length ? ranked.map((item) => formatFact(item.fact, item.score)).join("\n\n") : "No matching memories.",
        };
      },
    },
    {
      definition: {
        name: "memory_forget",
        description: "Forget durable memories whose text, type, or source contains the query.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Text/type/source substring to forget." },
          },
          required: ["query"],
        },
      },
      async execute(args) {
        const query = text(args.query);
        if (!query) return { ok: false, isError: true, content: "Missing forget query." };
        const removed = useDurableMemoryStore.getState().forgetFacts(query);
        return {
          ok: true,
          content: removed.length ? `Forgot ${removed.length} memor${removed.length === 1 ? "y" : "ies"}:\n${removed.map((fact) => formatFact(fact)).join("\n\n")}` : "No matching memories to forget.",
        };
      },
    },
  ];
}
