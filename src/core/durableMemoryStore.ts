import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface DurableMemoryFact {
  id: string;
  text: string;
  textNorm: string;
  type: string;
  source: string;
  createdAt: number;
  used: number;
}

interface CreateFactInput {
  text: string;
  type?: string;
  source?: string;
}

interface MemoryState {
  facts: DurableMemoryFact[];
  saveFacts: (facts: CreateFactInput[]) => { saved: DurableMemoryFact[]; skipped: string[] };
  forgetFacts: (query: string) => DurableMemoryFact[];
  markUsed: (ids: string[]) => void;
  clearFacts: () => void;
}

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function normalizeMemoryText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "i", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "with", "you",
]);

export function memoryTokens(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const filtered = raw.filter((token) => token.length > 2 && !STOPWORDS.has(token));
  return filtered.length ? filtered : raw;
}

function termCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

export function scoreMemoryFacts(facts: DurableMemoryFact[], query: string): Array<{ fact: DurableMemoryFact; score: number }> {
  const queryTokens = memoryTokens(query);
  if (queryTokens.length === 0) return facts.map((fact) => ({ fact, score: 1 }));
  const documents = facts.map((fact) => ({ fact, tokens: memoryTokens(fact.text) }));
  const docCount = Math.max(1, documents.length);
  const docFreq = new Map<string, number>();
  for (const doc of documents) {
    for (const token of new Set(doc.tokens)) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
  }
  const queryCounts = termCounts(queryTokens);
  const querySet = new Set(queryTokens);

  function idf(token: string): number {
    return Math.log((docCount + 1) / ((docFreq.get(token) ?? 0) + 1)) + 1;
  }

  const queryVector = new Map([...queryCounts].map(([token, count]) => [token, count * idf(token)]));
  const queryNorm = Math.sqrt([...queryVector.values()].reduce((sum, value) => sum + value * value, 0)) || 1;

  return documents.map((doc) => {
    const counts = termCounts(doc.tokens);
    let dot = 0;
    let docNormSq = 0;
    for (const [token, count] of counts) {
      const weight = count * idf(token);
      docNormSq += weight * weight;
      dot += weight * (queryVector.get(token) ?? 0);
    }
    const cosine = dot / ((Math.sqrt(docNormSq) || 1) * queryNorm);
    const coverage = [...querySet].filter((token) => counts.has(token)).length / querySet.size;
    const recency = Math.min(0.05, Math.max(0, doc.fact.used) * 0.005);
    return { fact: doc.fact, score: cosine + coverage + recency };
  }).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.fact.createdAt - a.fact.createdAt);
}

export const useDurableMemoryStore = create<MemoryState>()(
  persist(
    (set) => ({
      facts: [],
      saveFacts: (inputs) => {
        const saved: DurableMemoryFact[] = [];
        const skipped: string[] = [];
        set((state) => {
          const seen = new Set(state.facts.map((fact) => fact.textNorm));
          const next = state.facts.slice();
          for (const input of inputs) {
            const text = clean(input.text);
            if (!text) continue;
            const textNorm = normalizeMemoryText(text);
            if (seen.has(textNorm)) {
              skipped.push(text);
              continue;
            }
            seen.add(textNorm);
            const fact: DurableMemoryFact = {
              id: newId(),
              text,
              textNorm,
              type: clean(input.type) || "general",
              source: clean(input.source) || "agent",
              createdAt: Date.now(),
              used: 0,
            };
            saved.push(fact);
            next.unshift(fact);
          }
          return { facts: next };
        });
        return { saved, skipped };
      },
      forgetFacts: (query) => {
        const needle = normalizeMemoryText(query);
        const removed: DurableMemoryFact[] = [];
        if (!needle) return removed;
        set((state) => {
          const kept = state.facts.filter((fact) => {
            const match = fact.textNorm.includes(needle) || fact.type.toLowerCase().includes(needle) || fact.source.toLowerCase().includes(needle);
            if (match) removed.push(fact);
            return !match;
          });
          return { facts: kept };
        });
        return removed;
      },
      markUsed: (ids) => {
        const setIds = new Set(ids);
        if (!setIds.size) return;
        set((state) => ({
          facts: state.facts.map((fact) => setIds.has(fact.id) ? { ...fact, used: fact.used + 1 } : fact),
        }));
      },
      clearFacts: () => set({ facts: [] }),
    }),
    { name: "rush-durable-memory" },
  ),
);
