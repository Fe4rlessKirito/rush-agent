import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_SEARCH_CONFIG, type SearchConfig, type SearchResult } from "./searchProviders";

export type ResearchRunStatus = "queued" | "running" | "completed" | "error";

export interface ResearchSettings {
  rounds: string;
  format: string;
  engine: string;
  endpoint: string;
  model: string;
}

export interface ResearchRun {
  id: string;
  title: string;
  prompt: string;
  status: ResearchRunStatus;
  settings: ResearchSettings;
  content: string;
  sources: SearchResult[];
  searchWarning?: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

interface CreateRunInput {
  prompt: string;
  settings: ResearchSettings;
  status?: ResearchRunStatus;
}

interface ResearchState {
  runs: ResearchRun[];
  searchConfig: SearchConfig;
  createRun: (input: CreateRunInput) => string;
  updateRun: (id: string, patch: Partial<Omit<ResearchRun, "id" | "createdAt">>) => void;
  deleteRun: (id: string) => void;
  clearRuns: () => void;
  setSearchConfig: (patch: Partial<SearchConfig>) => void;
}

function newId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function researchTitleFromPrompt(prompt: string): string {
  const title = prompt.trim().replace(/\s+/g, " ");
  if (!title) return "Untitled research";
  return title.length > 48 ? `${title.slice(0, 48)}...` : title;
}

export const useResearchStore = create<ResearchState>()(
  persist(
    (set) => ({
      runs: [],
      searchConfig: DEFAULT_SEARCH_CONFIG,
      createRun: (input) => {
        const now = Date.now();
        const id = newId();
        const run: ResearchRun = {
          id,
          title: researchTitleFromPrompt(input.prompt),
          prompt: input.prompt,
          status: input.status ?? "queued",
          settings: input.settings,
          content: "",
          sources: [],
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({ runs: [run, ...s.runs] }));
        return id;
      },
      updateRun: (id, patch) =>
        set((s) => ({
          runs: s.runs.map((run) =>
            run.id === id
              ? {
                  ...run,
                  ...patch,
                  updatedAt: Date.now(),
                }
              : run,
          ),
        })),
      deleteRun: (id) => set((s) => ({ runs: s.runs.filter((run) => run.id !== id) })),
      clearRuns: () => set({ runs: [] }),
      setSearchConfig: (patch) =>
        set((s) => ({
          searchConfig: {
            ...s.searchConfig,
            ...patch,
          },
        })),
    }),
    {
      name: "rush-research-runs",
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.searchConfig = { ...DEFAULT_SEARCH_CONFIG, ...(state.searchConfig ?? {}) };
        state.runs = state.runs.map((run) => ({ ...run, sources: run.sources ?? [] }));
      },
    },
  ),
);
