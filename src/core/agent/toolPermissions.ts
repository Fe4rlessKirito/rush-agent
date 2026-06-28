export type PermissionEffect = "allow" | "ask" | "deny";

export interface PermissionRule {
  tool: string;
  specifier?: string;
  raw: string;
}

export interface PermissionConfig {
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

export interface PermissionMatch {
  effect: PermissionEffect;
  rule: PermissionRule;
}

const TOOL_ALIASES = new Map<string, string>([
  ["read_file", "Read"],
  ["write_file", "Write"],
  ["edit_file", "Edit"],
  ["glob_files", "Glob"],
  ["grep_search", "Grep"],
]);

const PATH_ARG_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
  "move_file",
  "list_dir",
  "glob_files",
  "grep_search",
]);
const COMMAND_ARG_TOOLS = new Set(["Bash", "PowerShell", "Monitor", "background_start"]);
const DOMAIN_ARG_TOOLS = new Set(["WebFetch"]);

export function parsePermissionRule(raw: string): PermissionRule {
  const trimmed = raw.trim();
  const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*)(?:\((.*)\))?$/);
  if (!match) return { tool: trimmed, raw };
  return {
    tool: match[1],
    specifier: match[2]?.trim(),
    raw,
  };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegex(glob: string): RegExp {
  const normalized = normalizePath(glob);
  let out = "^";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    const next = normalized[i + 1];
    const afterNext = normalized[i + 2];
    if (ch === "*" && next === "*" && afterNext === "/") {
      out += "(?:.*/)?";
      i += 2;
    } else if (ch === "*" && next === "*") {
      out += ".*";
      i++;
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(ch);
    }
  }
  out += "$";
  return new RegExp(out);
}

function pathSubject(tool: string, args: Record<string, unknown>): string | null {
  if (!PATH_ARG_TOOLS.has(tool)) return null;
  const value =
    args.file_path ??
    args.path ??
    args.src ??
    args.from ??
    args.dst ??
    args.to ??
    args.pattern ??
    args.glob;
  return typeof value === "string" ? normalizePath(value) : null;
}

function commandSubject(tool: string, args: Record<string, unknown>): string | null {
  if (!COMMAND_ARG_TOOLS.has(tool)) return null;
  const value = args.command ?? args.line ?? args.input;
  return typeof value === "string" ? value.trim() : null;
}

function domainSubject(tool: string, args: Record<string, unknown>): string | null {
  if (!DOMAIN_ARG_TOOLS.has(tool)) return null;
  const value = args.url;
  if (typeof value !== "string") return null;
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function matchesPathSpecifier(specifier: string, subject: string | null): boolean {
  if (!subject) return false;
  const normalized = normalizePath(specifier);
  if (normalized === "*" || normalized === "**") return true;
  if (!normalized.includes("*") && !normalized.includes("?")) {
    return subject === normalized || subject.startsWith(`${normalized.replace(/\/$/, "")}/`);
  }
  return globToRegex(normalized).test(subject);
}

function matchesCommandSpecifier(specifier: string, subject: string | null): boolean {
  if (!subject) return false;
  const trimmed = specifier.trim();
  if (trimmed === "*" || trimmed === "**") return true;
  return globToRegex(trimmed).test(subject);
}

function matchesDomainSpecifier(specifier: string, subject: string | null): boolean {
  if (!subject) return false;
  const domain = specifier.trim().toLowerCase().replace(/^domain:/, "").replace(/^www\./, "");
  if (!domain) return false;
  return subject === domain || subject.endsWith(`.${domain}`);
}

export function matchesPermissionRule(
  rule: PermissionRule | string,
  tool: string,
  args: Record<string, unknown> = {},
): boolean {
  const parsed = typeof rule === "string" ? parsePermissionRule(rule) : rule;
  if (parsed.tool !== tool && parsed.tool !== TOOL_ALIASES.get(tool)) return false;
  if (!parsed.specifier) return true;
  if (COMMAND_ARG_TOOLS.has(tool)) {
    return matchesCommandSpecifier(parsed.specifier, commandSubject(tool, args));
  }
  if (DOMAIN_ARG_TOOLS.has(tool)) {
    return matchesDomainSpecifier(parsed.specifier, domainSubject(tool, args));
  }
  return matchesPathSpecifier(parsed.specifier, pathSubject(tool, args));
}

export function resolvePermission(
  config: PermissionConfig | null | undefined,
  tool: string,
  args: Record<string, unknown> = {},
): PermissionMatch | null {
  if (!config) return null;
  const ordered: Array<[PermissionEffect, string[] | undefined]> = [
    ["deny", config.deny],
    ["ask", config.ask],
    ["allow", config.allow],
  ];
  for (const [effect, rules] of ordered) {
    for (const raw of rules ?? []) {
      const rule = parsePermissionRule(raw);
      if (matchesPermissionRule(rule, tool, args)) return { effect, rule };
    }
  }
  return null;
}
