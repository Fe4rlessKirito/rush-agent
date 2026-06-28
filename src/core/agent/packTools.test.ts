import { describe, expect, it } from "vitest";
import { createPackTools, type PackToolSource } from "./packTools";

const source: PackToolSource = {
  listPacks: () => [
    {
      id: "ecc",
      name: "ECC",
      origin: "ECC",
      enabled: true,
      scope: "global",
      projectIds: [],
      installedAt: 1,
      updatedAt: 2,
      sourcePath: "C:/packs/ecc",
      stats: { files: 3, accepted: 3, rejected: 0, skipped: 0 },
      warnings: [],
      rejected: [],
      skills: [],
      commands: [],
      rules: [],
      manifests: [],
    },
  ],
  listSkills: () => [
    {
      id: "ecc:skill:search-first",
      packId: "ecc",
      title: "search-first",
      when: "Use before coding.",
      how: "Research docs and local patterns before implementing.",
      tags: ["research", "pack"],
      confidence: 90,
      approved: true,
      createdAt: 1,
      sourcePath: "skills/search-first/SKILL.md",
      origin: "ECC",
    },
  ],
  listCommands: () => [
    {
      id: "ecc:command:code-review",
      packId: "ecc",
      name: "code-review",
      description: "Review local changes",
      argumentHint: "[scope]",
      body: "Gather diffs and report findings by severity.",
      origin: "ECC",
      sourcePath: "commands/code-review.md",
    },
  ],
  listRules: () => [
    {
      id: "ecc:rule:typescript-typescript-rules",
      packId: "ecc",
      name: "TypeScript Rules",
      category: "typescript",
      body: "Prefer strict types and focused tests.",
      origin: "ECC",
      sourcePath: "rules/typescript/style.md",
    },
  ],
  listManifests: () => [
    {
      id: "ecc:manifest:1-0",
      packId: "ecc",
      version: 1,
      entries: ["developer", "rules-core"],
    },
  ],
};

describe("packTools", () => {
  it("lists enabled pack contents", async () => {
    const tools = new Map(createPackTools(source).map((tool) => [tool.definition.name, tool]));

    const result = await tools.get("PackList")!.execute({});

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Enabled Rush packs");
    expect(result.content).toContain("/code-review");
    expect(result.content).toContain("typescript: TypeScript Rules");
    expect(result.content).toContain("ecc:manifest:1-0");
  });

  it("reads pack commands by name", async () => {
    const tools = new Map(createPackTools(source).map((tool) => [tool.definition.name, tool]));

    const result = await tools.get("PackRead")!.execute({ query: "code-review", kind: "command" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Pack command: /code-review");
    expect(result.content).toContain("Arguments: [scope]");
    expect(result.content).toContain("Gather diffs");
  });

  it("reads pack skills by tag", async () => {
    const tools = new Map(createPackTools(source).map((tool) => [tool.definition.name, tool]));

    const result = await tools.get("PackRead")!.execute({ query: "research" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Pack skill: search-first");
  });

  it("reports available items when a query is missing", async () => {
    const tools = new Map(createPackTools(source).map((tool) => [tool.definition.name, tool]));

    const result = await tools.get("PackRead")!.execute({ query: "missing-item" });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("Pack item not found");
    expect(result.content).toContain("Available items");
  });
});
