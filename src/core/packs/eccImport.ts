import type {
  PackIssue,
  ValidatedCommand,
  ValidatedManifest,
  ValidatedRule,
  ValidatedSkill,
} from "./packValidation";
import {
  validateCommandMarkdown,
  validateManifestJson,
  validateRuleMarkdown,
  validateSkillMarkdown,
} from "./packValidation";

export interface PackSourceFile {
  path: string;
  content: string;
}

export interface RushImportSkill {
  title: string;
  when: string;
  how: string;
  tags: string[];
  confidence: number;
  approved: boolean;
  sourcePath: string;
  origin: string;
}

export interface ImportedPackRejectedFile {
  path: string;
  kind: "skill" | "command" | "rule" | "manifest" | "unknown";
  issues: PackIssue[];
}

export interface ImportedPackWarning {
  path: string;
  issues: PackIssue[];
}

export interface ImportedPack {
  skills: RushImportSkill[];
  commands: ValidatedCommand[];
  rules: ValidatedRule[];
  manifests: ValidatedManifest[];
  rejected: ImportedPackRejectedFile[];
  warnings: ImportedPackWarning[];
  stats: {
    files: number;
    accepted: number;
    rejected: number;
    skipped: number;
  };
}

export interface EccImportOptions {
  approveImportedSkills?: boolean;
  defaultConfidence?: number;
  includeUnknownMarkdownAsRules?: boolean;
}

type ImportKind = "skill" | "command" | "rule" | "manifest" | "unknown";

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function importKind(path: string, includeUnknownMarkdownAsRules: boolean): ImportKind {
  const clean = normalizePath(path);
  const lower = clean.toLowerCase();
  if (/\/skill\.md$/.test(lower) || /^skills\/[^/]+\/skill\.md$/.test(lower)) return "skill";
  if (/^commands\/.+\.md$/.test(lower)) return "command";
  if (/^rules\/.+\.md$/.test(lower)) return "rule";
  if (/^manifests\/.+\.json$/.test(lower)) return "manifest";
  if (includeUnknownMarkdownAsRules && /\.md$/.test(lower)) return "rule";
  return "unknown";
}

function key(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function acceptedIssues(issues: PackIssue[]): PackIssue[] {
  return issues.filter((issue) => issue.severity === "warning");
}

function toRushSkill(skill: ValidatedSkill, options: Required<EccImportOptions>): RushImportSkill {
  const sourcePath = skill.sourcePath ?? "";
  return {
    title: skill.title,
    when: skill.when,
    how: skill.how,
    tags: [...new Set([...skill.tags, "imported", skill.origin].filter(Boolean))],
    confidence: options.defaultConfidence,
    approved: options.approveImportedSkills,
    sourcePath,
    origin: skill.origin,
  };
}

export function importEccPack(files: PackSourceFile[], options: EccImportOptions = {}): ImportedPack {
  const resolved: Required<EccImportOptions> = {
    approveImportedSkills: options.approveImportedSkills ?? false,
    defaultConfidence: Math.max(0, Math.min(100, Number(options.defaultConfidence ?? 85) || 85)),
    includeUnknownMarkdownAsRules: options.includeUnknownMarkdownAsRules ?? false,
  };
  const skills = new Map<string, RushImportSkill>();
  const commands = new Map<string, ValidatedCommand>();
  const rules = new Map<string, ValidatedRule>();
  const manifests: ValidatedManifest[] = [];
  const rejected: ImportedPackRejectedFile[] = [];
  const warnings: ImportedPackWarning[] = [];
  let skipped = 0;

  for (const file of files) {
    const path = normalizePath(file.path);
    const kind = importKind(path, resolved.includeUnknownMarkdownAsRules);
    if (kind === "unknown") {
      skipped += 1;
      continue;
    }

    if (kind === "skill") {
      const result = validateSkillMarkdown(file.content, path);
      if (!result.ok || !result.value) {
        rejected.push({ path, kind, issues: result.issues });
        continue;
      }
      const item = toRushSkill(result.value, resolved);
      skills.set(key(item.title), item);
      if (acceptedIssues(result.issues).length) warnings.push({ path, issues: acceptedIssues(result.issues) });
      continue;
    }

    if (kind === "command") {
      const result = validateCommandMarkdown(file.content, path);
      if (!result.ok || !result.value) {
        rejected.push({ path, kind, issues: result.issues });
        continue;
      }
      commands.set(key(result.value.name), result.value);
      if (acceptedIssues(result.issues).length) warnings.push({ path, issues: acceptedIssues(result.issues) });
      continue;
    }

    if (kind === "rule") {
      const result = validateRuleMarkdown(file.content, path);
      if (!result.ok || !result.value) {
        rejected.push({ path, kind, issues: result.issues });
        continue;
      }
      rules.set(key(`${result.value.category ?? "rule"}-${result.value.name}`), result.value);
      if (acceptedIssues(result.issues).length) warnings.push({ path, issues: acceptedIssues(result.issues) });
      continue;
    }

    const result = validateManifestJson(file.content);
    if (!result.ok || !result.value) {
      rejected.push({ path, kind, issues: result.issues });
      continue;
    }
    manifests.push(result.value);
    if (acceptedIssues(result.issues).length) warnings.push({ path, issues: acceptedIssues(result.issues) });
  }

  const accepted = skills.size + commands.size + rules.size + manifests.length;
  return {
    skills: [...skills.values()].sort((a, b) => a.title.localeCompare(b.title)),
    commands: [...commands.values()].sort((a, b) => a.name.localeCompare(b.name)),
    rules: [...rules.values()].sort((a, b) => (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name)),
    manifests,
    rejected,
    warnings,
    stats: {
      files: files.length,
      accepted,
      rejected: rejected.length,
      skipped,
    },
  };
}

export function summarizeImportedPack(pack: ImportedPack): string {
  return [
    `Files scanned: ${pack.stats.files}`,
    `Accepted: ${pack.stats.accepted}`,
    `Skills: ${pack.skills.length}`,
    `Commands: ${pack.commands.length}`,
    `Rules: ${pack.rules.length}`,
    `Manifests: ${pack.manifests.length}`,
    `Rejected: ${pack.rejected.length}`,
    `Skipped: ${pack.stats.skipped}`,
    `Warnings: ${pack.warnings.length}`,
  ].join("\n");
}
