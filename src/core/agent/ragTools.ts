import { searchRagDocuments, useRagStore } from "../ragStore";
import type { Tool } from "./tools";

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function numberArg(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, num));
}

export function createRagTools(): Tool[] {
  return [
    {
      definition: {
        name: "rag_add",
        description: "Add or update a plain-text document in Rush's lightweight RAG corpus.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Document name." },
            content: { type: "string", description: "Plain text document content." },
            source: { type: "string", description: "Optional source label." },
          },
          required: ["name", "content"],
        },
      },
      async execute(args) {
        const name = text(args.name);
        const content = text(args.content);
        if (!name) return { ok: false, isError: true, content: "Missing RAG document name." };
        if (!content) return { ok: false, isError: true, content: "Missing RAG document content." };
        const doc = useRagStore.getState().upsertDocument({ name, content, source: text(args.source) || "tool" });
        return { ok: true, content: `Saved RAG document ${doc.id}: ${doc.name} (${doc.content.length} chars).` };
      },
    },
    {
      definition: {
        name: "rag_search",
        description: "Search Rush's uploaded/document RAG corpus using overlapping text chunks, independent of the codebase.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query." },
            max_chunks: { type: "number", description: "Maximum chunks to return, capped at 20." },
            chunk_chars: { type: "number", description: "Chunk size in characters." },
          },
          required: ["query"],
        },
      },
      async execute(args) {
        const query = text(args.query);
        if (!query) return { ok: false, isError: true, content: "Missing RAG search query." };
        const docs = useRagStore.getState().documents;
        const results = searchRagDocuments(
          docs,
          query,
          numberArg(args.max_chunks, 4, 1, 20),
          numberArg(args.chunk_chars, 1200, 200, 8000),
        );
        return {
          ok: true,
          content: results.length
            ? results.map((result) => [`[${result.document.name}] score=${result.score.toFixed(3)} chars=${result.start}-${result.end}`, result.text].join("\n")).join("\n\n")
            : docs.length ? "No matching RAG chunks." : "No RAG documents have been added yet.",
        };
      },
    },
    {
      definition: {
        name: "rag_list",
        description: "List documents currently stored in Rush's lightweight RAG corpus.",
        inputSchema: { type: "object", properties: {} },
      },
      async execute() {
        const docs = useRagStore.getState().documents;
        return {
          ok: true,
          content: docs.length
            ? docs.map((doc) => `${doc.id} ${doc.name} (${doc.content.length} chars, source: ${doc.source})`).join("\n")
            : "No RAG documents have been added yet.",
        };
      },
    },
  ];
}
