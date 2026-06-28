export type PackItemKind = "skill" | "command" | "rule" | "manifest";
export type PackSeverity = "error" | "warning";

export interface PackIssue {
  severity: PackSeverity;
  code: string;
  message: string;
}

export interface FrontmatterDocument {
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface ValidatedPackItem<T> {
  ok: boolean;
  kind: PackItemKind;
  value: T | null;
  issues: PackIssue[];
}

export interface ValidatedSkill {
  title: string;
  when: string;
  how: string;
  tags: string[];
  origin: string;
  sourcePath?: string;
  description?: string;
}

export interface ValidatedCommand {
  name: string;
  description: string;
  body: string;
  argumentHint?: string;
  origin: string;
  sourcePath?: string;
}

export interface ValidatedRule {
  name: string;
  body: string;
  category?: string;
  origin: string;
  sourcePath?: string;
}

export interface ValidatedManifest {
  version: number;
  entries: string[];
}

const MAX_BODY_CHARS = 80_000;
const UNSAFE_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+-rf\s+(?:\/|\*)/i, "contains a dangerous recursive delete command"],
  [/\bRemove-Item\b[\s\S]{0,80}\b-Recurse\b[\s\S]{0,80}\b-Force\b/i, "contains a dangerous PowerShell recursive delete command"],
  [/\bgit\s+reset\s+--hard\b/i, "contains a destructive git reset command"],
  [/\b(?:curl|wget)\b[\s\S]{0,120}\|\s*(?:sh|bash|powershell|pwsh)\b/i, "pipes a remote download directly into a shell"],
  [/\bsk-[A-Za-z0-9_-]{16,}/, "appears to contain an OpenAI-style secret"],
  [/\bghp_[A-Za-z0-9_]{20,}/, "appears to contain a GitHub token"],
];

function issue(severity: PackSeverity, code: string, message: string): PackIssue {
  return { severity, code, message };
}

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  if (typeof value === "string") return value.split(",").map(clean).filter(Boolean);
  return [];
}

export function parseFrontmatterDocument(raw: string): FrontmatterDocument {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return { frontmatter: {}, body: text.trim() };
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: {}, body: text.trim() };
  return {
    frontmatter: parseSimpleYaml(match[1]),
    body: text.slice(match[0].length).trim(),
  };
}

export function parseSimpleYaml(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    if (!value) {
      const items: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        const item = next.match(/^\s*-\s*(.*)$/);
        if (!item) break;
        items.push(unquote(item[1].trim()));
        index += 1;
      }
      result[key] = items;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      result[key] = value.slice(1, -1).split(",").map((item) => unquote(item.trim())).filter(Boolean);
    } else if (value === "true" || value === "false") {
      result[key] = value === "true";
    } else if (/^-?\d+(\.\d+)?$/.test(value)) {
      result[key] = Number(value);
    } else {
      result[key] = unquote(value);
    }
  }
  return result;
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function commonIssues(body: string): PackIssue[] {
  const issues: PackIssue[] = [];
  if (body.length > MAX_BODY_CHARS) {
    issues.push(issue("error", "body-too-large", `Body is ${body.length} characters; limit is ${MAX_BODY_CHARS}.`));
  }
  for (const [pattern, message] of UNSAFE_PATTERNS) {
    if (pattern.test(body)) issues.push(issue("warning", "unsafe-content", message));
  }
  if (/<\/?tool_calls?>|<\/?tool_call>/i.test(body)) {
    issues.push(issue("warning", "tool-call-markup", "contains raw tool-call markup that could confuse model/tool parsers"));
  }
  return issues;
}

function result<T>(kind: PackItemKind, value: T | null, issues: PackIssue[]): ValidatedPackItem<T> {
  return {
    ok: !issues.some((item) => item.severity === "error"),
    kind,
    value,
    issues,
  };
}

export function validateSkillMarkdown(raw: string, sourcePath?: string): ValidatedPackItem<ValidatedSkill> {
  const doc = parseFrontmatterDocument(raw);
  const title = clean(doc.frontmatter.name) || titleFromMarkdown(doc.body) || titleFromPath(sourcePath);
  const description = clean(doc.frontmatter.description);
  const origin = clean(doc.frontmatter.origin) || "imported";
  const tags = [...new Set([...stringList(doc.frontmatter.tags), origin].filter(Boolean))];
  const issues = commonIssues(doc.body);
  if (!title) issues.push(issue("error", "missing-title", "Skill is missing a name/title."));
  if (!description && !/##\s+When to Use|##\s+Trigger/i.test(doc.body)) {
    issues.push(issue("warning", "missing-when", "Skill has no description or obvious usage section."));
  }
  if (doc.body.length < 80) issues.push(issue("error", "body-too-short", "Skill body is too short to be useful."));

  return result("skill", title ? {
    title,
    when: description || extractSection(doc.body, /##\s+(?:When to Use|Trigger)\b/i) || `Use the ${title} skill when relevant.`,
    how: doc.body,
    tags,
    origin,
    sourcePath,
    description,
  } : null, issues);
}

export function validateCommandMarkdown(raw: string, sourcePath?: string): ValidatedPackItem<ValidatedCommand> {
  const doc = parseFrontmatterDocument(raw);
  const pathName = titleFromPath(sourcePath);
  const name = slug(clean(doc.frontmatter.name) || pathName || titleFromMarkdown(doc.body));
  const description = clean(doc.frontmatter.description) || titleFromMarkdown(doc.body);
  const issues = commonIssues(doc.body);
  if (!name) issues.push(issue("error", "missing-name", "Command is missing a name."));
  if (!description) issues.push(issue("warning", "missing-description", "Command is missing a description."));
  if (doc.body.length < 40) issues.push(issue("error", "body-too-short", "Command body is too short to be useful."));

  return result("command", name ? {
    name,
    description: description || name,
    body: doc.body,
    argumentHint: argumentHint(doc.frontmatter["argument-hint"]),
    origin: clean(doc.frontmatter.origin) || "imported",
    sourcePath,
  } : null, issues);
}

export function validateRuleMarkdown(raw: string, sourcePath?: string): ValidatedPackItem<ValidatedRule> {
  const doc = parseFrontmatterDocument(raw);
  const name = clean(doc.frontmatter.name) || titleFromMarkdown(doc.body) || titleFromPath(sourcePath);
  const issues = commonIssues(doc.body);
  if (!name) issues.push(issue("error", "missing-name", "Rule is missing a name."));
  if (doc.body.length < 40) issues.push(issue("error", "body-too-short", "Rule body is too short to be useful."));

  return result("rule", name ? {
    name,
    body: doc.body,
    category: clean(doc.frontmatter.category) || sourcePath?.split(/[\\/]/).slice(-2, -1)[0],
    origin: clean(doc.frontmatter.origin) || "imported",
    sourcePath,
  } : null, issues);
}

export function validateManifestJson(raw: string): ValidatedPackItem<ValidatedManifest> {
  const issues: PackIssue[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return result<ValidatedManifest>("manifest", null, [issue("error", "invalid-json", `Manifest is not valid JSON: ${String(err)}`)]);
  }
  const obj = parsed as Record<string, unknown>;
  const version = Number(obj.version ?? 0);
  if (!Number.isInteger(version) || version < 1) issues.push(issue("error", "invalid-version", "Manifest version must be a positive integer."));
  const entries = collectManifestEntries(obj);
  if (entries.length === 0) issues.push(issue("warning", "empty-manifest", "Manifest contains no obvious entries."));
  return result("manifest", { version, entries }, issues);
}

function collectManifestEntries(obj: Record<string, unknown>): string[] {
  const out: string[] = [];
  const visit = (value: unknown, key?: string) => {
    if (key && /^[a-z0-9-]+$/i.test(key)) out.push(key);
    if (typeof value === "string") {
      if (value.includes("/") || value.includes(":") || /^[a-z0-9-]+$/i.test(value)) out.push(value);
    } else if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
    } else if (value && typeof value === "object") {
      for (const [nextKey, next] of Object.entries(value as Record<string, unknown>)) visit(next, nextKey);
    }
  };
  visit(obj);
  return [...new Set(out)];
}

function argumentHint(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const cleaned = value.map(clean).filter(Boolean);
    return cleaned.length ? `[${cleaned.join(", ")}]` : undefined;
  }
  return clean(value) || undefined;
}

function titleFromMarkdown(body: string): string {
  return clean(body.match(/^#\s+(.+)$/m)?.[1]);
}

function titleFromPath(path: string | undefined): string {
  if (!path) return "";
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  return base.replace(/\.(md|markdown)$/i, "");
}

function extractSection(body: string, heading: RegExp): string {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return "";
  const out: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) break;
    out.push(lines[index]);
  }
  return out.join("\n").trim();
}
