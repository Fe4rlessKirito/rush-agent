import type { BugBountyHeader, BugBountyProgramDraft, BugBountyPlatform } from "./bugBountyStore";

const URL_PATTERN = /https?:\/\/[^\s)\]}>"']+/gi;
const DOMAIN_PATTERN = /(?:\*\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}/gi;
const HEADER_PATTERN = /\b([A-Za-z][A-Za-z0-9-]*-[A-Za-z0-9-]+)\s*:\s*([^\n\r]+)/g;

const EXCLUDED_CLASS_KEYWORDS = [
  "clickjacking",
  "csrf",
  "self-xss",
  "social engineering",
  "physical attack",
  "denial of service",
  "dos",
  "spam",
  "rate limit",
  "brute force",
  "missing security headers",
  "best practices",
];

function platformFromText(text: string): BugBountyPlatform {
  const lower = text.toLowerCase();
  if (lower.includes("hackerone.com") || lower.includes("hackerone")) return "hackerone";
  if (lower.includes("bugcrowd.com") || lower.includes("bugcrowd")) return "bugcrowd";
  if (lower.includes("intigriti.com") || lower.includes("intigriti")) return "intigriti";
  return "custom";
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function cleanAsset(value: string): string {
  return value
    .trim()
    .replace(/[,.);\]}>]+$/g, "")
    .replace(/^[(<{[]+/g, "");
}

function extractUrls(text: string): string[] {
  return unique(Array.from(text.matchAll(URL_PATTERN), ([match]) => cleanAsset(match)));
}

function extractDomains(text: string): string[] {
  return unique(Array.from(text.matchAll(DOMAIN_PATTERN), ([match]) => cleanAsset(match.toLowerCase())));
}

function sectionLines(text: string, keywords: string[]): string[] {
  const lines = text.split(/\r?\n/);
  const matches: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    const startsSection = keywords.some((keyword) => lower.includes(keyword));
    if (startsSection) {
      inSection = true;
      matches.push(trimmed);
      continue;
    }
    if (inSection && /^#{1,6}\s+|^[A-Z][A-Za-z\s]{2,}:$/.test(trimmed)) {
      inSection = false;
    }
    if (inSection && trimmed) matches.push(trimmed);
  }
  return matches;
}

function extractAssetsFromLines(lines: string[]): string[] {
  return unique([
    ...extractUrls(lines.join("\n")),
    ...extractDomains(lines.join("\n")),
  ]);
}

function extractRequiredHeaders(text: string): BugBountyHeader[] {
  const headers: BugBountyHeader[] = [];
  const headerText = sectionLines(text, ["header", "headers", "x-bug-bounty", "user-agent"]).join("\n");
  for (const match of headerText.matchAll(HEADER_PATTERN)) {
    headers.push({ name: match[1].trim(), value: match[2].trim() });
  }
  return headers;
}

function extractExcludedClasses(text: string): string[] {
  const lower = text.toLowerCase();
  return EXCLUDED_CLASS_KEYWORDS.filter((keyword) => lower.includes(keyword));
}

function titleFromPolicy(text: string, programUrl: string): string {
  const heading = text.split(/\r?\n/).map((line) => line.trim()).find((line) => /^#\s+\S/.test(line));
  if (heading) return heading.replace(/^#+\s*/, "").trim();
  if (programUrl) return programUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return "Bug bounty program";
}

export function parseBugBountyPolicy(text: string): BugBountyProgramDraft {
  const policyText = text.trim();
  const urls = extractUrls(policyText);
  const programUrl = urls.find((url) => /hackerone|bugcrowd|intigriti/i.test(url)) ?? urls[0] ?? "";
  const inScopeLines = sectionLines(policyText, ["in scope", "scope", "eligible assets", "targets"]);
  const outOfScopeLines = sectionLines(policyText, ["out of scope", "not in scope", "excluded", "ineligible"]);
  const outOfScopeAssets = extractAssetsFromLines(outOfScopeLines);
  const inScopeAssets = extractAssetsFromLines(inScopeLines).filter((asset) => !outOfScopeAssets.includes(asset));

  return {
    name: titleFromPolicy(policyText, programUrl),
    platform: platformFromText(policyText),
    programUrl,
    requiredHeaders: extractRequiredHeaders(policyText),
    inScopeAssets,
    outOfScopeAssets,
    excludedVulnerabilityClasses: extractExcludedClasses(policyText),
    notes: [
      "Imported policy draft. Review scope manually before testing.",
      "Only perform authorized, non-destructive checks allowed by the program policy.",
    ].join("\n"),
    policyText,
  };
}
