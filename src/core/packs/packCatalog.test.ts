import { describe, expect, it } from "vitest";
import { importEccPack, type PackSourceFile } from "./eccImport";
import {
  createEmptyPackCatalog,
  installImportedPack,
  removePack,
  selectEnabledBrainSkills,
  selectEnabledCommands,
  selectEnabledRules,
  selectEnabledSkills,
  setPackEnabled,
  setPackScope,
  updatePackItem,
} from "./packCatalog";

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
  "argument-hint: [pr-number]",
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

function files(): PackSourceFile[] {
  return [
    { path: "skills/search-first/SKILL.md", content: skill },
    { path: "commands/code-review.md", content: command },
    { path: "rules/typescript/coding-style.md", content: rule },
    { path: "manifests/install-profiles.json", content: JSON.stringify({ version: 1, profiles: { developer: { modules: ["rules-core"] } } }) },
  ];
}

function importedPack() {
  return importEccPack(files(), {
    approveImportedSkills: true,
    defaultConfidence: 91,
  });
}

describe("pack catalog", () => {
  it("installs an imported pack with stable pack and item ids", () => {
    const catalog = installImportedPack(createEmptyPackCatalog(), importedPack(), {
      name: "ECC 2.0",
      sourcePath: "C:/packs/ECC-2.0.0",
      installedAt: 100,
    });

    expect(catalog.packs).toHaveLength(1);
    expect(catalog.packs[0]).toMatchObject({
      id: "ecc-2-0",
      name: "ECC 2.0",
      sourcePath: "C:/packs/ECC-2.0.0",
      origin: "ECC",
      enabled: true,
      installedAt: 100,
      updatedAt: 100,
    });
    expect(catalog.packs[0].skills[0]).toMatchObject({
      id: "ecc-2-0:skill:search-first",
      packId: "ecc-2-0",
      confidence: 91,
      approved: true,
      createdAt: 100,
      sourcePath: "skills/search-first/SKILL.md",
    });
    expect(catalog.packs[0].commands[0].id).toBe("ecc-2-0:command:code-review");
    expect(catalog.packs[0].rules[0].id).toBe("ecc-2-0:rule:typescript-typescript-rules");
    expect(catalog.packs[0].manifests[0].id).toBe("ecc-2-0:manifest:1-0");
  });

  it("replaces an existing pack with the same id while preserving install time and enabled state", () => {
    const first = installImportedPack(createEmptyPackCatalog(), importedPack(), {
      id: "ecc",
      name: "ECC",
      installedAt: 100,
    });
    const disabled = setPackEnabled(first, "ecc", false);
    const replaced = installImportedPack(disabled, importedPack(), {
      id: "ecc",
      name: "ECC Updated",
      installedAt: 250,
    });

    expect(replaced.packs).toHaveLength(1);
    expect(replaced.packs[0]).toMatchObject({
      id: "ecc",
      name: "ECC Updated",
      enabled: false,
      installedAt: 100,
      updatedAt: 250,
    });
  });

  it("filters selectors to enabled packs only", () => {
    const enabled = installImportedPack(createEmptyPackCatalog(), importedPack(), {
      id: "enabled",
      name: "Enabled Pack",
      installedAt: 100,
    });
    const withDisabled = installImportedPack(enabled, importedPack(), {
      id: "disabled",
      name: "Disabled Pack",
      enabled: false,
      installedAt: 200,
    });

    expect(selectEnabledSkills(withDisabled).map((item) => item.packId)).toEqual(["enabled"]);
    expect(selectEnabledCommands(withDisabled).map((item) => item.packId)).toEqual(["enabled"]);
    expect(selectEnabledRules(withDisabled).map((item) => item.packId)).toEqual(["enabled"]);
  });

  it("filters project-scoped packs by active project id", () => {
    const global = installImportedPack(createEmptyPackCatalog(), importedPack(), {
      id: "global",
      name: "Global Pack",
      installedAt: 100,
    });
    const scoped = installImportedPack(global, importedPack(), {
      id: "scoped",
      name: "Scoped Pack",
      installedAt: 200,
      scope: "projects",
      projectIds: ["project-a"],
    });

    expect(selectEnabledSkills(scoped).map((item) => item.packId)).toEqual(["global"]);
    expect(selectEnabledSkills(scoped, "project-a").map((item) => item.packId)).toEqual(["scoped", "global"]);
    expect(selectEnabledCommands(scoped, "project-b").map((item) => item.packId)).toEqual(["global"]);
  });

  it("can update pack scope after install", () => {
    const catalog = installImportedPack(createEmptyPackCatalog(), importedPack(), {
      id: "ecc",
      name: "ECC",
    });
    const scoped = setPackScope(catalog, "ecc", "projects", ["project-a", "project-b"]);

    expect(scoped.packs[0]).toMatchObject({
      scope: "projects",
      projectIds: ["project-a", "project-b"],
    });
    expect(selectEnabledBrainSkills(scoped)).toEqual([]);
    expect(selectEnabledBrainSkills(scoped, "project-b")).toHaveLength(1);
  });

  it("can edit installed pack items without reinstalling", () => {
    const catalog = installImportedPack(createEmptyPackCatalog(), importedPack(), {
      id: "ecc",
      name: "ECC",
      installedAt: 100,
    });
    const commandId = catalog.packs[0].commands[0].id;
    const skillId = catalog.packs[0].skills[0].id;
    const editedCommand = updatePackItem(catalog, "ecc", "command", commandId, {
      description: "Review changed files",
      body: "Read the diff and report bugs.",
    });
    const editedSkill = updatePackItem(editedCommand, "ecc", "skill", skillId, {
      approved: false,
      confidence: 33,
    });

    expect(editedSkill.packs[0].commands[0]).toMatchObject({
      description: "Review changed files",
      body: "Read the diff and report bugs.",
    });
    expect(editedSkill.packs[0].skills[0]).toMatchObject({
      approved: false,
      confidence: 33,
    });
  });

  it("removes an installed pack", () => {
    const catalog = installImportedPack(createEmptyPackCatalog(), importedPack(), {
      id: "ecc",
      name: "ECC",
    });

    expect(removePack(catalog, "ecc").packs).toEqual([]);
  });

  it("exports enabled skills in Brain-compatible shape", () => {
    const catalog = installImportedPack(createEmptyPackCatalog(), importedPack(), {
      id: "ecc",
      name: "ECC",
      installedAt: 100,
    });
    const skills = selectEnabledBrainSkills(catalog);

    expect(skills).toEqual([
      expect.objectContaining({
        id: "ecc:skill:search-first",
        title: "search-first",
        when: "Research before coding",
        confidence: 91,
        approved: true,
        createdAt: 100,
      }),
    ]);
    expect(skills[0]).not.toHaveProperty("packId");
    expect(skills[0]).not.toHaveProperty("sourcePath");
    expect(skills[0]).not.toHaveProperty("origin");
  });
});
