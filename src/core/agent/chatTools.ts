import type { BrainMemory, MemoryKind } from "../brainStore";
import type { Conversation } from "../store";
import type { ResearchRun } from "../researchStore";
import type { Tool } from "./tools";

export interface ChatToolOptions {
  getMemories: () => BrainMemory[];
  addMemory: (text: string, kind: MemoryKind) => void;
  getConversations: () => Conversation[];
  getResearchRuns: () => ResearchRun[];
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function words(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function score(haystack: string, query: string): number {
  const q = words(query);
  if (q.length === 0) return 1;
  const lower = haystack.toLowerCase();
  return q.reduce((sum, word) => sum + (lower.includes(word) ? 1 : 0), 0);
}

function limit(value: unknown, fallback = 5): number {
  return Math.max(1, Math.min(20, Number(value ?? fallback) || fallback));
}

function normalizeKind(value: unknown): MemoryKind {
  return value === "preference" || value === "instruction" || value === "note" ? value : "fact";
}

function conversationText(conversation: Conversation): string {
  return conversation.lines
    .filter((line) => line.role === "user" || line.role === "agent")
    .slice(-16)
    .map((line) => `${line.role === "user" ? "User" : "Assistant"}: ${line.text}`)
    .join("\n");
}

function researchText(run: ResearchRun): string {
  return [
    `Title: ${run.title}`,
    `Prompt: ${run.prompt}`,
    `Status: ${run.status}`,
    run.sources.length
      ? `Sources:\n${run.sources.map((source, index) => `${index + 1}. ${source.title} ${source.url ? `(${source.url})` : ""}\n${source.snippet}`).join("\n\n")}`
      : "",
    run.content ? `Report:\n${run.content}` : "",
    run.error ? `Error: ${run.error}` : "",
  ].filter(Boolean).join("\n\n");
}

export function createChatTools(options: ChatToolOptions): Tool[] {
  return [
    {
      definition: {
        name: "app_memory_search",
        description: "Search Rush Brain memories. Chat-only app context; does not access files or the terminal.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Memory search query." },
            limit: { type: "number", description: "Maximum results, capped at 20." },
          },
          required: ["query"],
        },
      },
      async execute(args) {
        const query = text(args.query);
        const results = options.getMemories()
          .map((memory) => ({ memory, score: score(`${memory.kind} ${memory.text}`, query) }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score || b.memory.createdAt - a.memory.createdAt)
          .slice(0, limit(args.limit));
        return {
          ok: true,
          content: results.length
            ? results.map(({ memory }) => `${memory.id} [${memory.kind}] ${memory.text}`).join("\n")
            : "No matching memories.",
        };
      },
    },
    {
      definition: {
        name: "app_memory_add",
        description: "Add a Rush Brain memory from Chat mode. Use only for facts/preferences the user wants remembered.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Memory text to save." },
            kind: { type: "string", description: "fact, preference, instruction, or note." },
          },
          required: ["text"],
        },
      },
      async execute(args) {
        const memory = text(args.text);
        if (!memory) return { ok: false, isError: true, content: "Missing memory text." };
        const kind = normalizeKind(args.kind);
        options.addMemory(memory, kind);
        return { ok: true, content: `Saved memory [${kind}]: ${memory}` };
      },
    },
    {
      definition: {
        name: "app_library_search",
        description: "Search saved Rush Library chats by title and message text.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Library chat search query." },
            limit: { type: "number", description: "Maximum results, capped at 20." },
          },
          required: ["query"],
        },
      },
      async execute(args) {
        const query = text(args.query);
        const results = options.getConversations()
          .map((conversation) => ({
            conversation,
            score: score(`${conversation.title}\n${conversationText(conversation)}`, query),
          }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score || b.conversation.createdAt - a.conversation.createdAt)
          .slice(0, limit(args.limit));
        return {
          ok: true,
          content: results.length
            ? results.map(({ conversation }) => `${conversation.id} [${conversation.mode}] ${conversation.title} (${conversation.lines.length} messages)`).join("\n")
            : "No matching Library chats.",
        };
      },
    },
    {
      definition: {
        name: "app_library_read",
        description: "Read one saved Rush Library chat by id.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Conversation id from app_library_search." },
            max_chars: { type: "number", description: "Maximum returned characters." },
          },
          required: ["id"],
        },
      },
      async execute(args) {
        const id = text(args.id);
        const conversation = options.getConversations().find((item) => item.id === id);
        if (!conversation) return { ok: false, isError: true, content: `Unknown Library chat: ${id}` };
        const max = Math.max(1000, Math.min(12000, Number(args.max_chars ?? 6000) || 6000));
        return {
          ok: true,
          content: [`${conversation.title} [${conversation.mode}]`, conversationText(conversation).slice(0, max)].join("\n\n"),
        };
      },
    },
    {
      definition: {
        name: "app_research_search",
        description: "Search saved Deep Research runs by title, prompt, source, and report text.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Deep Research search query." },
            limit: { type: "number", description: "Maximum results, capped at 20." },
          },
          required: ["query"],
        },
      },
      async execute(args) {
        const query = text(args.query);
        const results = options.getResearchRuns()
          .map((run) => ({ run, score: score(researchText(run), query) }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score || b.run.updatedAt - a.run.updatedAt)
          .slice(0, limit(args.limit));
        return {
          ok: true,
          content: results.length
            ? results.map(({ run }) => `${run.id} [${run.status}] ${run.title} (${run.sources.length} sources)`).join("\n")
            : "No matching Deep Research runs.",
        };
      },
    },
    {
      definition: {
        name: "app_research_read",
        description: "Read one saved Deep Research run by id.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Research run id from app_research_search." },
            max_chars: { type: "number", description: "Maximum returned characters." },
          },
          required: ["id"],
        },
      },
      async execute(args) {
        const id = text(args.id);
        const run = options.getResearchRuns().find((item) => item.id === id);
        if (!run) return { ok: false, isError: true, content: `Unknown Deep Research run: ${id}` };
        const max = Math.max(1000, Math.min(16000, Number(args.max_chars ?? 8000) || 8000));
        return { ok: true, content: researchText(run).slice(0, max) };
      },
    },
  ];
}
