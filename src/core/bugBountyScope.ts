import type { BugBountyProgramProfile } from "./bugBountyStore";

export interface BugBountyScopeCheck {
  ok: boolean;
  reason: string;
  matchedAsset?: string;
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
}

function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    const host = normalizeHost(url);
    return host || null;
  }
}

function assetMatches(asset: string, host: string): boolean {
  const normalized = normalizeHost(asset);
  if (!normalized) return false;
  if (normalized.startsWith("*.")) {
    const suffix = normalized.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === normalized || host.endsWith(`.${normalized}`);
}

export function checkBugBountyScope(program: BugBountyProgramProfile, url: string): BugBountyScopeCheck {
  const host = hostFromUrl(url);
  if (!host) return { ok: false, reason: "Invalid URL or hostname." };

  const outOfScope = program.outOfScopeAssets.find((asset) => assetMatches(asset, host));
  if (outOfScope) {
    return { ok: false, reason: "Target matches an out-of-scope asset.", matchedAsset: outOfScope };
  }

  const inScope = program.inScopeAssets.find((asset) => assetMatches(asset, host));
  if (!inScope) {
    return { ok: false, reason: "Target is not listed in this program's in-scope assets." };
  }

  return { ok: true, reason: "Target matches an in-scope asset.", matchedAsset: inScope };
}

export function requiredHeadersForProgram(program: BugBountyProgramProfile): Record<string, string> {
  return Object.fromEntries(program.requiredHeaders.map((header) => [header.name, header.value]));
}
