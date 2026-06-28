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

import { importScannedPack, packNameFromPath, type PackFolderScan } from "./packFolderImport";
import { importEccPack } from "./eccImport";
import { usePackStore } from "./packStore";

const skill = [
  "---",
  "name: search-first",
  "description: Research before coding",
  "origin: ECC",
  "tags: [research]",
  "---",
  "# Search First",
  "",
  "## When to Use",
  "Use before building a custom tool or integration.",
  "",
  "## Workflow",
  "Check existing libraries, docs, MCP servers, and local patterns before implementing.",
].join("\n");

function scan(overrides: Partial<PackFolderScan> = {}): PackFolderScan {
  return {
    root: "C:/Users/marko/Downloads/ECC-2.0.0",
    files: [
      { path: "skills/search-first/SKILL.md", content: skill },
      {
        path: "rules/typescript/style.md",
        content: "# TypeScript Style\n\nPrefer strict types and focused tests for behavior changes.",
      },
    ],
    skipped_count: 4,
    warnings: ["Skipped node_modules"],
    ...overrides,
  };
}

describe("packFolderImport", () => {
  beforeEach(() => {
    usePackStore.setState({ schemaVersion: 1, packs: [] });
    globalThis.localStorage.clear();
  });

  it("derives a friendly pack name from Windows and POSIX paths", () => {
    expect(packNameFromPath("C:\\Users\\marko\\Downloads\\ECC-2.0.0")).toBe("ECC-2.0.0");
    expect(packNameFromPath("/tmp/packs/ecc/")).toBe("ecc");
    expect(packNameFromPath("")).toBe("Imported Pack");
  });

  it("imports scanned files into the persisted pack store", () => {
    const result = importScannedPack(scan(), {
      approveImportedSkills: true,
      defaultConfidence: 93,
    });

    expect(result.imported.stats).toMatchObject({
      files: 2,
      accepted: 2,
      rejected: 0,
    });
    expect(result.packId).toBe("ecc-2-0-0");
    expect(usePackStore.getState().packs[0]).toMatchObject({
      id: "ecc-2-0-0",
      name: "ECC-2.0.0",
      sourcePath: "C:/Users/marko/Downloads/ECC-2.0.0",
    });
    expect(usePackStore.getState().getEnabledBrainSkills()[0]).toMatchObject({
      title: "search-first",
      confidence: 93,
      approved: true,
    });
  });

  it("can preview scanned files without installing them", () => {
    const scanned = scan();
    const imported = importEccPack(scanned.files, {
      approveImportedSkills: true,
      defaultConfidence: 93,
    });

    expect(imported.stats.accepted).toBe(2);
    expect(usePackStore.getState().packs).toEqual([]);
  });

  it("allows metadata to override generated pack details", () => {
    const result = importScannedPack(scan(), {}, {
      id: "ecc-core",
      name: "ECC Core",
      description: "Imported ECC skills and rules",
      sourcePath: "D:/packs/ecc",
      enabled: false,
    });

    expect(result.packId).toBe("ecc-core");
    expect(usePackStore.getState().packs[0]).toMatchObject({
      id: "ecc-core",
      name: "ECC Core",
      description: "Imported ECC skills and rules",
      sourcePath: "D:/packs/ecc",
      enabled: false,
    });
    expect(usePackStore.getState().getEnabledBrainSkills()).toEqual([]);
  });
});
