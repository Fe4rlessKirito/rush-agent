import type { InstalledPack, PackCatalogStateData, PackScope } from "./packCatalog";
import { normalizeInstalledPack } from "./packMigration";

export interface PackBackupFile {
  kind: "rush-pack-backup";
  schemaVersion: 1;
  exportedAt: number;
  packs: InstalledPack[];
}

export type PackBackupImportMode = "merge" | "replace";

export function createPackBackup(packs: InstalledPack[], exportedAt = Date.now()): PackBackupFile {
  return {
    kind: "rush-pack-backup",
    schemaVersion: 1,
    exportedAt,
    packs: packs.map(clonePack),
  };
}

export function stringifyPackBackup(packs: InstalledPack[], exportedAt = Date.now()): string {
  return `${JSON.stringify(createPackBackup(packs, exportedAt), null, 2)}\n`;
}

export function parsePackBackupJson(json: string): PackBackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Backup file is not valid JSON.");
  }

  if (!isRecord(parsed)) {
    throw new Error("Backup file must be a JSON object.");
  }
  if (parsed.kind !== "rush-pack-backup" || parsed.schemaVersion !== 1) {
    throw new Error("Backup file is not a Rush pack backup.");
  }
  if (!Array.isArray(parsed.packs)) {
    throw new Error("Backup file does not contain a packs array.");
  }

  return {
    kind: "rush-pack-backup",
    schemaVersion: 1,
    exportedAt: numberOrNow(parsed.exportedAt),
    packs: parsed.packs.map((pack, index) => normalizeInstalledPack(pack, index)),
  };
}

export function importPackBackup(
  data: PackCatalogStateData,
  backup: PackBackupFile,
  mode: PackBackupImportMode = "merge",
): PackCatalogStateData {
  const incoming = backup.packs.map(clonePack);
  if (mode === "replace") {
    return {
      ...data,
      packs: incoming,
    };
  }

  const incomingIds = new Set(incoming.map((pack) => pack.id));
  return {
    ...data,
    packs: [...incoming, ...data.packs.filter((pack) => !incomingIds.has(pack.id))],
  };
}

function clonePack(pack: InstalledPack): InstalledPack {
  return {
    ...pack,
    scope: (pack.scope ?? "global") as PackScope,
    projectIds: [...(pack.projectIds ?? [])],
    stats: { ...pack.stats },
    warnings: pack.warnings.map(cloneJson),
    rejected: pack.rejected.map(cloneJson),
    skills: pack.skills.map(cloneJson),
    commands: pack.commands.map(cloneJson),
    rules: pack.rules.map(cloneJson),
    manifests: pack.manifests.map(cloneJson),
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberOrNow(value: unknown, fallback = Date.now()): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
