import { describe, expect, it } from "vitest";
import { importEccPack, type PackSourceFile } from "./eccImport";
import { createEmptyPackCatalog, installImportedPack, setPackScope } from "./packCatalog";
import {
  createPackBackup,
  importPackBackup,
  parsePackBackupJson,
  stringifyPackBackup,
} from "./packBackup";

const skill = [
  "---",
  "name: backup-skill",
  "description: Imported from a backup fixture",
  "---",
  "# Backup Skill",
  "",
  "## When to Use",
  "Use when restoring pack data.",
  "",
  "## Workflow",
  "Check that pack metadata and items survive the backup round trip.",
].join("\n");

function importedPack() {
  return importEccPack(files(), {
    approveImportedSkills: true,
    defaultConfidence: 90,
  });
}

function files(): PackSourceFile[] {
  return [
    { path: "skills/backup/SKILL.md", content: skill },
    { path: "commands/restore.md", content: "# Restore\n\nRestore backup data carefully." },
  ];
}

function catalog() {
  const installed = installImportedPack(createEmptyPackCatalog(), importedPack(), {
    id: "backup-pack",
    name: "Backup Pack",
    installedAt: 100,
  });
  return setPackScope(installed, "backup-pack", "projects", ["project-a"]);
}

describe("pack backup", () => {
  it("exports and parses installed packs without losing project scope", () => {
    const data = catalog();
    const json = stringifyPackBackup(data.packs, 200);
    const parsed = parsePackBackupJson(json);

    expect(parsed).toMatchObject({
      kind: "rush-pack-backup",
      schemaVersion: 1,
      exportedAt: 200,
    });
    expect(parsed.packs[0]).toMatchObject({
      id: "backup-pack",
      name: "Backup Pack",
      scope: "projects",
      projectIds: ["project-a"],
    });
    expect(parsed.packs[0].skills[0].packId).toBe("backup-pack");
  });

  it("merges backup packs by replacing matching ids and preserving unrelated packs", () => {
    const existing = installImportedPack(catalog(), importedPack(), {
      id: "other-pack",
      name: "Other Pack",
      installedAt: 150,
    });
    const backup = createPackBackup([{ ...catalog().packs[0], name: "Restored Pack" }], 200);
    const merged = importPackBackup(existing, backup, "merge");

    expect(merged.packs.map((pack) => pack.id)).toEqual(["backup-pack", "other-pack"]);
    expect(merged.packs[0].name).toBe("Restored Pack");
  });

  it("can replace the full pack catalog from a backup", () => {
    const existing = installImportedPack(catalog(), importedPack(), {
      id: "other-pack",
      name: "Other Pack",
    });
    const backup = createPackBackup([catalog().packs[0]], 200);
    const restored = importPackBackup(existing, backup, "replace");

    expect(restored.packs.map((pack) => pack.id)).toEqual(["backup-pack"]);
  });

  it("rejects non-backup JSON", () => {
    expect(() => parsePackBackupJson("{\"kind\":\"other\"}")).toThrow("not a Rush pack backup");
    expect(() => parsePackBackupJson("not-json")).toThrow("not valid JSON");
  });
});
