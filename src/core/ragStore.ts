import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface RagDocument {
  id: string;
  name: string;
  content: string;
  source: string;
  createdAt: number;
  updatedAt: number;
}

interface RagState {
  documents: RagDocument[];
  upsertDocument: (input: { name: string; content: string; source?: string }) => RagDocument;
  deleteDocument: (idOrName: string) => RagDocument | null;
  clearDocuments: () => void;
}

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface RagChunk {
  document: RagDocument;
  start: number;
  end: number;
  text: string;
  score: number;
}

export function chunkText(content: string, chunkChars = 1200): Array<{ start: number; end: number; text: string }> {
  const size = Math.max(200, Math.min(8000, Math.round(chunkChars) || 1200));
  const step = Math.max(100, Math.floor(size / 2));
  const chunks: Array<{ start: number; end: number; text: string }> = [];
  for (let start = 0; start < content.length; start += step) {
    const end = Math.min(content.length, start + size);
    const text = content.slice(start, end).trim();
    if (text) chunks.push({ start, end, text });
    if (end >= content.length) break;
  }
  return chunks;
}

function terms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((term) => term.length > 2))];
}

export function searchRagDocuments(documents: RagDocument[], query: string, maxChunks = 4, chunkChars = 1200): RagChunk[] {
  const queryTerms = terms(query);
  if (!queryTerms.length) return [];
  const results: RagChunk[] = [];
  for (const document of documents) {
    for (const chunk of chunkText(document.content, chunkChars)) {
      const lower = chunk.text.toLowerCase();
      const hits = queryTerms.filter((term) => lower.includes(term)).length;
      if (hits <= 0) continue;
      results.push({ document, ...chunk, score: hits / queryTerms.length });
    }
  }
  return results
    .sort((a, b) => b.score - a.score || b.document.updatedAt - a.document.updatedAt || a.start - b.start)
    .slice(0, Math.max(1, Math.min(20, Math.round(maxChunks) || 4)));
}

export const useRagStore = create<RagState>()(
  persist(
    (set) => ({
      documents: [],
      upsertDocument: (input) => {
        const now = Date.now();
        const name = clean(input.name) || "Untitled document";
        const key = normalizeName(name);
        const content = clean(input.content);
        let saved: RagDocument | null = null;
        set((state) => {
          const existing = state.documents.find((doc) => normalizeName(doc.name) === key);
          if (existing) {
            saved = { ...existing, name, content, source: clean(input.source) || existing.source, updatedAt: now };
            return { documents: state.documents.map((doc) => doc.id === existing.id ? saved! : doc) };
          }
          saved = { id: newId(), name, content, source: clean(input.source) || "tool", createdAt: now, updatedAt: now };
          return { documents: [saved, ...state.documents] };
        });
        return saved!;
      },
      deleteDocument: (idOrName) => {
        const key = normalizeName(idOrName);
        let removed: RagDocument | null = null;
        set((state) => ({
          documents: state.documents.filter((doc) => {
            const match = doc.id === idOrName || normalizeName(doc.name) === key;
            if (match) removed = doc;
            return !match;
          }),
        }));
        return removed;
      },
      clearDocuments: () => set({ documents: [] }),
    }),
    { name: "rush-rag-documents" },
  ),
);
