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

import { buildBrainContext, extractBrainFromTurn } from "./brainRuntime";
import { useBrainStore } from "./brainStore";

function resetBrain() {
  useBrainStore.setState({
    memoriesEnabled: true,
    skillsEnabled: true,
    autoExtractMemories: true,
    autoExtractSkills: true,
    autoApproveSkills: true,
    minimumConfidence: 85,
    maxInjectedSkills: 3,
    memories: [],
    skills: [],
  });
}

describe("brain runtime", () => {
  beforeEach(resetBrain);

  it("injects memories and approved skills into prompt context", () => {
    useBrainStore.getState().addMemory("User prefers concise replies", "preference");
    useBrainStore.getState().addExtractedSkill({
      title: "Fix TypeScript Build",
      when: "Use when the build has TypeScript errors.",
      how: "Run the build, patch type errors, rerun tests.",
      tags: ["typescript", "build"],
      confidence: 90,
    });

    const context = buildBrainContext("fix the TypeScript build", "agent");
    expect(context).toContain("Brain memories");
    expect(context).toContain("User prefers concise replies");
    expect(context).toContain("Brain skills");
    expect(context).toContain("/skill fix-typescript-build");
  });

  it("extracts obvious memory statements from user turns", () => {
    extractBrainFromTurn({
      userText: "remember that I prefer compact UI answers",
      assistantText: "Got it.",
      mode: "plain",
    });

    expect(useBrainStore.getState().memories[0]).toMatchObject({
      text: "I prefer compact UI answers",
      kind: "fact",
    });
  });

  it("extracts a draft skill from code turns that used tools", () => {
    extractBrainFromTurn({
      userText: "fix the failing build",
      assistantText: "Build passes now.",
      mode: "agent",
      toolNames: ["read_file", "edit_file", "terminal_run"],
    });

    expect(useBrainStore.getState().skills[0]).toMatchObject({
      title: "fix the failing build",
      approved: false,
    });
  });
});
