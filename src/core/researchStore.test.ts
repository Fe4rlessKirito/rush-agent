import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const store = new Map<string, string>();
  const mem: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    key: (i) => [...store.keys()][i] ?? null,
    removeItem: (k) => void store.delete(k),
    setItem: (k, v) => void store.set(k, String(v)),
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage = mem;
});

import { thinkingForEffort } from "./effort";
import { researchTitleFromPrompt, useResearchStore, type ResearchSettings } from "./researchStore";

const settings: ResearchSettings = {
  rounds: "Auto",
  format: "Auto",
  engine: "Default",
  endpoint: "Default",
  model: "Default",
};

describe("research store", () => {
  beforeEach(() => useResearchStore.setState({ runs: [] }));

  it("creates queued runs with derived titles", () => {
    const id = useResearchStore.getState().createRun({ prompt: "Explain encryption clearly", settings });
    const run = useResearchStore.getState().runs.find((r) => r.id === id);
    expect(run?.title).toBe("Explain encryption clearly");
    expect(run?.status).toBe("queued");
    expect(run?.sources).toEqual([]);
  });

  it("updates and deletes runs", () => {
    const id = useResearchStore.getState().createRun({ prompt: "Research topic", settings });
    useResearchStore.getState().updateRun(id, { status: "completed", content: "Done" });
    expect(useResearchStore.getState().runs[0].content).toBe("Done");
    expect(useResearchStore.getState().runs[0].status).toBe("completed");

    useResearchStore.getState().deleteRun(id);
    expect(useResearchStore.getState().runs).toEqual([]);
  });

  it("truncates long titles", () => {
    expect(researchTitleFromPrompt("x".repeat(80))).toHaveLength(51);
  });

  it("stores search provider config", () => {
    useResearchStore.getState().setSearchConfig({ searxngUrl: "https://search.example" });
    expect(useResearchStore.getState().searchConfig.searxngUrl).toBe("https://search.example");
  });
});

describe("thinkingForEffort", () => {
  it("maps effort indices to proxy thinking levels", () => {
    expect(thinkingForEffort(0)).toBe("low");
    expect(thinkingForEffort(1)).toBe("medium");
    expect(thinkingForEffort(2)).toBe("high");
    expect(thinkingForEffort(3)).toBe("max");
  });
});
