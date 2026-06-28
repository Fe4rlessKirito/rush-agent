import type {
  InstalledPack,
  PackCatalogStateData,
  PackCatalogCommand,
  PackCatalogManifest,
  PackCatalogRule,
  PackCatalogSkill,
  PackScope,
} from "./packCatalog";
import type { ImportedPackRejectedFile, ImportedPackWarning } from "./eccImport";

export function normalizePackCatalog(value: unknown): PackCatalogStateData {
  const record = isRecord(value) ? value : {};
  const packs = Array.isArray(record.packs) ? record.packs : [];
  return {
    schemaVersion: 1,
    packs: packs.map((pack, index) => normalizeInstalledPack(pack, index)),
  };
}

export function normalizeInstalledPack(value: unknown, index = 0): InstalledPack {
  const record = isRecord(value) ? value : {};
  const id = clean(record.id) || `imported-pack-${index + 1}`;
  const now = Date.now();
  const scope: PackScope = record.scope === "projects" ? "projects" : "global";
  const projectIds = scope === "projects" && Array.isArray(record.projectIds)
    ? uniqueStrings(record.projectIds)
    : [];

  const skills = array(record.skills).map((item, itemIndex) => normalizeSkill(item, id, itemIndex));
  const commands = array(record.commands).map((item, itemIndex) => normalizeCommand(item, id, itemIndex));
  const rules = array(record.rules).map((item, itemIndex) => normalizeRule(item, id, itemIndex));
  const manifests = array(record.manifests).map((item, itemIndex) => normalizeManifest(item, id, itemIndex));
  const rejected = array(record.rejected).map(cloneJson) as ImportedPackRejectedFile[];
  const warnings = array(record.warnings).map(cloneJson) as ImportedPackWarning[];

  return {
    id,
    name: clean(record.name) || id,
    description: clean(record.description) || undefined,
    sourcePath: clean(record.sourcePath) || undefined,
    origin: clean(record.origin) || "imported",
    enabled: record.enabled !== false,
    scope,
    projectIds,
    installedAt: numberOrNow(record.installedAt, now),
    updatedAt: numberOrNow(record.updatedAt, now),
    stats: normalizeStats(record.stats, {
      files: skills.length + commands.length + rules.length + manifests.length + rejected.length,
      accepted: skills.length + commands.length + rules.length + manifests.length,
      rejected: rejected.length,
      skipped: 0,
    }),
    warnings,
    rejected,
    skills,
    commands,
    rules,
    manifests,
  };
}

function normalizeSkill(value: unknown, packId: string, index: number): PackCatalogSkill {
  const record = isRecord(value) ? value : {};
  const title = clean(record.title) || clean(record.name) || `Skill ${index + 1}`;
  return {
    id: clean(record.id) || `${packId}:skill:${slug(title)}`,
    packId,
    title,
    when: clean(record.when) || clean(record.description) || `Use ${title} when relevant.`,
    how: clean(record.how) || clean(record.body) || "",
    tags: uniqueStrings(array(record.tags)),
    confidence: clamp(Number(record.confidence ?? 75)),
    approved: record.approved !== false,
    createdAt: numberOrNow(record.createdAt),
    sourcePath: clean(record.sourcePath) || "",
    origin: clean(record.origin) || "imported",
  };
}

function normalizeCommand(value: unknown, packId: string, index: number): PackCatalogCommand {
  const record = isRecord(value) ? value : {};
  const name = slug(clean(record.name) || `command-${index + 1}`) || `command-${index + 1}`;
  return {
    id: clean(record.id) || `${packId}:command:${name}`,
    packId,
    name,
    description: clean(record.description) || name,
    body: clean(record.body),
    argumentHint: clean(record.argumentHint) || undefined,
    origin: clean(record.origin) || "imported",
    sourcePath: clean(record.sourcePath) || undefined,
  };
}

function normalizeRule(value: unknown, packId: string, index: number): PackCatalogRule {
  const record = isRecord(value) ? value : {};
  const name = clean(record.name) || `Rule ${index + 1}`;
  return {
    id: clean(record.id) || `${packId}:rule:${slug(name)}`,
    packId,
    name,
    body: clean(record.body),
    category: clean(record.category) || undefined,
    origin: clean(record.origin) || "imported",
    sourcePath: clean(record.sourcePath) || undefined,
  };
}

function normalizeManifest(value: unknown, packId: string, index: number): PackCatalogManifest {
  const record = isRecord(value) ? value : {};
  const version = Math.max(1, Math.floor(Number(record.version) || 1));
  return {
    id: clean(record.id) || `${packId}:manifest:${version}-${index}`,
    packId,
    version,
    entries: uniqueStrings(array(record.entries)),
  };
}

function normalizeStats(value: unknown, fallback: InstalledPack["stats"]): InstalledPack["stats"] {
  const record = isRecord(value) ? value : {};
  return {
    files: numberOrZero(record.files, fallback.files),
    accepted: numberOrZero(record.accepted, fallback.accepted),
    rejected: numberOrZero(record.rejected, fallback.rejected),
    skipped: numberOrZero(record.skipped, fallback.skipped),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function slug(value: string): string {
  return clean(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-|-$/g, "");
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function numberOrNow(value: unknown, fallback = Date.now()): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function numberOrZero(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
