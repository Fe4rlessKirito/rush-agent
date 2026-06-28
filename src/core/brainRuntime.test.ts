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
import { importEccPack } from "./packs/eccImport";
import { usePackStore } from "./packs/packStore";

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
  usePackStore.setState({ schemaVersion: 1, packs: [] });
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

  it("injects enabled imported pack skills into prompt context", () => {
    const pack = importEccPack([
      {
        path: "skills/search-first/SKILL.md",
        content: [
          "---",
          "name: search-first",
          "description: Research before coding",
          "origin: ECC",
          "tags: [research, workflow]",
          "---",
          "# Search First",
          "",
          "## When to Use",
          "Use before building custom integrations.",
          "",
          "## Workflow",
          "Check existing libraries, docs, MCP servers, and local patterns before implementing.",
        ].join("\n"),
      },
    ], {
      approveImportedSkills: true,
      defaultConfidence: 90,
    });
    usePackStore.getState().installPack(pack, {
      id: "ecc",
      name: "ECC",
      installedAt: 100,
    });

    const context = buildBrainContext("research this before coding", "agent");

    expect(context).toContain("Brain skills");
    expect(context).toContain("/skill search-first");
    expect(context).toContain("Check existing libraries");
  });

  it("does not inject disabled imported pack skills", () => {
    const pack = importEccPack([
      {
        path: "skills/search-first/SKILL.md",
        content: [
          "---",
          "name: search-first",
          "description: Research before coding",
          "origin: ECC",
          "---",
          "# Search First",
          "",
          "## When to Use",
          "Use before building custom integrations.",
          "",
          "## Workflow",
          "Check existing libraries, docs, MCP servers, and local patterns before implementing.",
        ].join("\n"),
      },
    ], {
      approveImportedSkills: true,
      defaultConfidence: 90,
    });
    usePackStore.getState().installPack(pack, {
      id: "ecc",
      name: "ECC",
      enabled: false,
    });

    expect(buildBrainContext("research this before coding", "agent")).not.toContain("/skill search-first");
  });

  it("injects project-scoped imported pack skills only for matching projects", () => {
    const pack = importEccPack([
      {
        path: "skills/search-first/SKILL.md",
        content: [
          "---",
          "name: search-first",
          "description: Research before coding",
          "origin: ECC",
          "---",
          "# Search First",
          "",
          "## When to Use",
          "Use before building custom integrations.",
          "",
          "## Workflow",
          "Check existing libraries, docs, MCP servers, and local patterns before implementing.",
        ].join("\n"),
      },
    ], {
      approveImportedSkills: true,
      defaultConfidence: 90,
    });
    usePackStore.getState().installPack(pack, {
      id: "ecc",
      name: "ECC",
      scope: "projects",
      projectIds: ["project-a"],
    });

    expect(buildBrainContext("research this before coding", "agent")).not.toContain("/skill search-first");
    expect(buildBrainContext("research this before coding", "agent", "project-a")).toContain("/skill search-first");
  });

  it("extracts obvious memory statements from user turns", () => {
    extractBrainFromTurn({
      userText: "remember that I prefer compact UI answers",
      assistantText: "Got it.",
      mode: "plain",
    });

    expect(useBrainStore.getState().memories[0]).toMatchObject({
      text: "User prefers compact UI answers",
      kind: "preference",
    });
    expect(useBrainStore.getState().memories).toHaveLength(1);
  });

  it("extracts explicit remembered instructions without keeping command filler", () => {
    extractBrainFromTurn({
      userText: "remember to always run tests before release.",
      assistantText: "Got it.",
      mode: "plain",
    });

    expect(useBrainStore.getState().memories[0]).toMatchObject({
      text: "run tests before release",
      kind: "instruction",
    });
  });

  it("ignores low-value memory extraction from parser testing chatter", () => {
    extractBrainFromTurn({
      userText: "remember that the tool_call parser forgot </tool_calls> again",
      assistantText: "Got it.",
      mode: "plain",
    });

    expect(useBrainStore.getState().memories).toEqual([]);
  });

  it("extracts a draft skill from code turns that used tools", () => {
    extractBrainFromTurn({
      userText: "fix the failing TypeScript build",
      assistantText: "Ran the build, patched type errors, and verified the build passes now.",
      mode: "agent",
      toolNames: ["read_file", "edit_file", "terminal_run"],
    });

    expect(useBrainStore.getState().skills[0]).toMatchObject({
      title: "fix the failing TypeScript build",
      approved: false,
    });
  });

  it("does not extract skills from tool-call parser stress-test chatter", () => {
    const noisyPrompts = [
      "yeah i agree with everything you said continue",
      "Run a full tool-call stress test. Use tools where appropriate.",
      "you forgot the starting </tool_calls>",
      "forgot the </tool_calls> again at the start",
    ];

    for (const userText of noisyPrompts) {
      extractBrainFromTurn({
        userText,
        assistantText: "Ran the requested checks.",
        mode: "agent",
        toolNames: ["list_dir", "read_file", "grep_search", "git_status"],
      });
    }

    expect(useBrainStore.getState().skills).toEqual([]);
  });

  it("does not extract skills from shallow two-tool tasks", () => {
    extractBrainFromTurn({
      userText: "fix typo",
      assistantText: "Fixed.",
      mode: "agent",
      toolNames: ["read_file", "edit_file"],
    });

    expect(useBrainStore.getState().skills).toEqual([]);
  });

  it("deletes skills by id", () => {
    useBrainStore.getState().addExtractedSkill({
      title: "Fix TypeScript Build",
      when: "Use when TypeScript build errors appear.",
      how: "Run build, patch errors, rerun checks.",
      tags: ["typescript"],
      confidence: 90,
    });
    const id = useBrainStore.getState().skills[0].id;

    useBrainStore.getState().deleteSkill(id);

    expect(useBrainStore.getState().skills).toEqual([]);
  });
});
