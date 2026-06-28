import type { BrainSkill } from "../brainStore";
import type { ImportedPack, ImportedPackRejectedFile, ImportedPackWarning } from "./eccImport";
import type { ValidatedCommand, ValidatedManifest, ValidatedRule } from "./packValidation";

export interface InstalledPackMetadata {
  id?: string;
  name: string;
  description?: string;
  sourcePath?: string;
  origin?: string;
  enabled?: boolean;
  scope?: PackScope;
  projectIds?: string[];
  installedAt?: number;
}

export type PackScope = "global" | "projects";

export interface PackCatalogSkill extends BrainSkill {
  packId: string;
  sourcePath: string;
  origin: string;
}

export interface PackCatalogCommand extends ValidatedCommand {
  id: string;
  packId: string;
}

export interface PackCatalogRule extends ValidatedRule {
  id: string;
  packId: string;
}

export interface PackCatalogManifest extends ValidatedManifest {
  id: string;
  packId: string;
}

export interface InstalledPack {
  id: string;
  name: string;
  description?: string;
  sourcePath?: string;
  origin: string;
  enabled: boolean;
  scope: PackScope;
  projectIds: string[];
  installedAt: number;
  updatedAt: number;
  stats: ImportedPack["stats"];
  warnings: ImportedPackWarning[];
  rejected: ImportedPackRejectedFile[];
  skills: PackCatalogSkill[];
  commands: PackCatalogCommand[];
  rules: PackCatalogRule[];
  manifests: PackCatalogManifest[];
}

export interface PackCatalogStateData {
  schemaVersion: 1;
  packs: InstalledPack[];
}

export type EditablePackItemKind = "skill" | "command" | "rule";

export interface EditablePackItemPatch {
  title?: string;
  when?: string;
  how?: string;
  approved?: boolean;
  confidence?: number;
  description?: string;
  body?: string;
  argumentHint?: string;
  name?: string;
  category?: string;
}

export function createEmptyPackCatalog(): PackCatalogStateData {
  return { schemaVersion: 1, packs: [] };
}

export function installImportedPack(
  data: PackCatalogStateData,
  imported: ImportedPack,
  metadata: InstalledPackMetadata,
): PackCatalogStateData {
  const now = metadata.installedAt ?? Date.now();
  const packId = normalizeId(metadata.id || metadata.name || metadata.sourcePath || "imported-pack");
  const origin = clean(metadata.origin) || firstOrigin(imported) || "imported";
  const existing = data.packs.find((pack) => pack.id === packId);
  const installedAt = existing?.installedAt ?? now;
  const pack: InstalledPack = {
    id: packId,
    name: clean(metadata.name) || packId,
    description: clean(metadata.description) || undefined,
    sourcePath: clean(metadata.sourcePath) || undefined,
    origin,
    enabled: metadata.enabled ?? existing?.enabled ?? true,
    scope: metadata.scope ?? existing?.scope ?? "global",
    projectIds: unique(metadata.projectIds ?? existing?.projectIds ?? []),
    installedAt,
    updatedAt: now,
    stats: { ...imported.stats },
    warnings: cloneWarnings(imported.warnings),
    rejected: cloneRejected(imported.rejected),
    skills: imported.skills.map((skill) => ({
      id: itemId(packId, "skill", skill.title),
      packId,
      title: skill.title.trim(),
      when: skill.when.trim(),
      how: skill.how.trim(),
      tags: unique([...skill.tags, origin, "pack"]),
      confidence: clamp(skill.confidence),
      approved: Boolean(skill.approved),
      createdAt: installedAt,
      sourcePath: skill.sourcePath,
      origin: skill.origin || origin,
    })).filter((skill) => skill.title && skill.when && skill.how),
    commands: imported.commands.map((command) => ({
      ...command,
      id: itemId(packId, "command", command.name),
      packId,
    })),
    rules: imported.rules.map((rule) => ({
      ...rule,
      id: itemId(packId, "rule", `${rule.category ?? "rule"}-${rule.name}`),
      packId,
    })),
    manifests: imported.manifests.map((manifest, index) => ({
      ...manifest,
      entries: [...manifest.entries],
      id: itemId(packId, "manifest", `${manifest.version}-${index}`),
      packId,
    })),
  };

  return {
    ...data,
    packs: [pack, ...data.packs.filter((item) => item.id !== packId)],
  };
}

export function removePack(data: PackCatalogStateData, packId: string): PackCatalogStateData {
  const id = normalizeId(packId);
  return { ...data, packs: data.packs.filter((pack) => pack.id !== id) };
}

export function setPackEnabled(data: PackCatalogStateData, packId: string, enabled: boolean): PackCatalogStateData {
  const id = normalizeId(packId);
  return {
    ...data,
    packs: data.packs.map((pack) => (pack.id === id ? { ...pack, enabled } : pack)),
  };
}

export function setPackScope(
  data: PackCatalogStateData,
  packId: string,
  scope: PackScope,
  projectIds: string[] = [],
): PackCatalogStateData {
  const id = normalizeId(packId);
  return {
    ...data,
    packs: data.packs.map((pack) =>
      pack.id === id ? { ...pack, scope, projectIds: scope === "projects" ? unique(projectIds) : [] } : pack,
    ),
  };
}

export function updatePackItem(
  data: PackCatalogStateData,
  packId: string,
  kind: EditablePackItemKind,
  itemId: string,
  patch: EditablePackItemPatch,
): PackCatalogStateData {
  const id = normalizeId(packId);
  return {
    ...data,
    packs: data.packs.map((pack) => {
      if (pack.id !== id) return pack;
      const updatedAt = Date.now();
      if (kind === "skill") {
        return {
          ...pack,
          updatedAt,
          skills: pack.skills.map((skill) => skill.id === itemId ? {
            ...skill,
            title: clean(patch.title ?? skill.title) || skill.title,
            when: clean(patch.when ?? skill.when) || skill.when,
            how: String(patch.how ?? skill.how),
            approved: patch.approved ?? skill.approved,
            confidence: patch.confidence === undefined ? skill.confidence : clamp(patch.confidence),
          } : skill),
        };
      }
      if (kind === "command") {
        return {
          ...pack,
          updatedAt,
          commands: pack.commands.map((command) => command.id === itemId ? {
            ...command,
            name: normalizeId(clean(patch.name ?? command.name) || command.name),
            description: clean(patch.description ?? command.description) || command.description,
            body: String(patch.body ?? command.body),
            argumentHint: clean(patch.argumentHint ?? command.argumentHint) || undefined,
          } : command),
        };
      }
      return {
        ...pack,
        updatedAt,
        rules: pack.rules.map((rule) => rule.id === itemId ? {
          ...rule,
          name: clean(patch.name ?? rule.name) || rule.name,
          body: String(patch.body ?? rule.body),
          category: clean(patch.category ?? rule.category) || undefined,
        } : rule),
      };
    }),
  };
}

function packActiveForProject(pack: InstalledPack, projectId?: string | null): boolean {
  if (!pack.enabled) return false;
  const scope = pack.scope ?? "global";
  if (scope === "global") return true;
  if (!projectId) return false;
  return (pack.projectIds ?? []).includes(projectId);
}

export function selectEnabledPacks(data: PackCatalogStateData, projectId?: string | null): InstalledPack[] {
  return data.packs.filter((pack) => packActiveForProject(pack, projectId));
}

export function selectEnabledSkills(data: PackCatalogStateData, projectId?: string | null): PackCatalogSkill[] {
  return dedupeById(selectEnabledPacks(data, projectId).flatMap((pack) => pack.skills));
}

export function selectEnabledCommands(data: PackCatalogStateData, projectId?: string | null): PackCatalogCommand[] {
  return dedupeById(selectEnabledPacks(data, projectId).flatMap((pack) => pack.commands));
}

export function selectEnabledRules(data: PackCatalogStateData, projectId?: string | null): PackCatalogRule[] {
  return dedupeById(selectEnabledPacks(data, projectId).flatMap((pack) => pack.rules));
}

export function selectEnabledBrainSkills(data: PackCatalogStateData, projectId?: string | null): BrainSkill[] {
  return selectEnabledSkills(data, projectId).map(({ packId: _packId, sourcePath: _sourcePath, origin: _origin, ...skill }) => skill);
}

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeId(value: string): string {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "imported-pack";
}

function itemId(packId: string, kind: string, value: string): string {
  return `${packId}:${kind}:${normalizeId(value)}`;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function firstOrigin(imported: ImportedPack): string {
  return imported.skills[0]?.origin || imported.commands[0]?.origin || imported.rules[0]?.origin || "";
}

function cloneWarnings(warnings: ImportedPackWarning[]): ImportedPackWarning[] {
  return warnings.map((warning) => ({
    path: warning.path,
    issues: warning.issues.map((issue) => ({ ...issue })),
  }));
}

function cloneRejected(rejected: ImportedPackRejectedFile[]): ImportedPackRejectedFile[] {
  return rejected.map((file) => ({
    path: file.path,
    kind: file.kind,
    issues: file.issues.map((issue) => ({ ...issue })),
  }));
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
