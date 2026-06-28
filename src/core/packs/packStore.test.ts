import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const store = new Map<string, string>();
  const mem: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => void store.delete(key),
    setItem: (key, value) => void store.set(key, String(value)),
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage = mem;
});

import { importEccPack } from "./eccImport";
import { usePackStore } from "./packStore";

const skill = [
  "---",
  "name: search-first",
  "description: Research before coding",
  "origin: ECC",
  "tags: [research, workflow]",
  "---",
  "# Search First",
  "",
  "## When to Use",
  "Use before building a custom tool or integration.",
  "",
  "## Workflow",
  "Check existing libraries, docs, MCP servers, and local patterns before implementing.",
].join("\n");

const command = [
  "---",
  "description: Review local changes",
  "---",
  "# Code Review",
  "",
  "Gather the git diff, read changed files, check security risks, and report findings by severity.",
].join("\n");

const rule = [
  "# TypeScript Rules",
  "",
  "Prefer strict types, avoid unsafe any, keep React components focused, and add tests for behavior.",
].join("\n");

function importedPack() {
  return importEccPack([
    { path: "skills/search-first/SKILL.md", content: skill },
    { path: "commands/code-review.md", content: command },
    { path: "rules/typescript/coding-style.md", content: rule },
  ], {
    approveImportedSkills: true,
    defaultConfidence: 90,
  });
}

describe("packStore", () => {
  beforeEach(() => {
    usePackStore.setState({ schemaVersion: 1, packs: [] });
    globalThis.localStorage.clear();
  });

  it("persists installed packs and exposes enabled selectors", () => {
    usePackStore.getState().installPack(importedPack(), {
      id: "ecc",
      name: "ECC",
      installedAt: 100,
    });

    expect(usePackStore.getState().packs[0].id).toBe("ecc");
    expect(usePackStore.getState().getEnabledSkills()[0].id).toBe("ecc:skill:search-first");
    expect(usePackStore.getState().getEnabledCommands()[0].id).toBe("ecc:command:code-review");
    expect(usePackStore.getState().getEnabledRules()[0].id).toBe("ecc:rule:typescript-typescript-rules");
    expect(globalThis.localStorage.getItem("rush-pack-catalog")).toContain("ECC");
  });

  it("hides disabled packs from runtime selectors", () => {
    usePackStore.getState().installPack(importedPack(), {
      id: "ecc",
      name: "ECC",
    });

    usePackStore.getState().setPackEnabled("ecc", false);

    expect(usePackStore.getState().packs[0].enabled).toBe(false);
    expect(usePackStore.getState().getEnabledBrainSkills()).toEqual([]);
  });

  it("filters project-scoped packs in runtime selectors", () => {
    usePackStore.getState().installPack(importedPack(), {
      id: "ecc",
      name: "ECC",
      scope: "projects",
      projectIds: ["project-a"],
    });

    expect(usePackStore.getState().getEnabledBrainSkills()).toEqual([]);
    expect(usePackStore.getState().getEnabledBrainSkills("project-a")).toHaveLength(1);
    expect(usePackStore.getState().getEnabledCommands("project-b")).toEqual([]);
  });

  it("removes packs and can clear the catalog", () => {
    usePackStore.getState().installPack(importedPack(), {
      id: "ecc",
      name: "ECC",
    });

    usePackStore.getState().removePack("ecc");
    expect(usePackStore.getState().packs).toEqual([]);

    usePackStore.getState().installPack(importedPack(), {
      id: "ecc",
      name: "ECC",
    });
    usePackStore.getState().clearPacks();
    expect(usePackStore.getState().packs).toEqual([]);
  });
});
