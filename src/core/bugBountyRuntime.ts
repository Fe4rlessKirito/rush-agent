import { useBugBountyStore } from "./bugBountyStore";
import { checkBugBountyScope, requiredHeadersForProgram } from "./bugBountyScope";

export interface BugBountyScopeDecision {
  ok: boolean;
  message?: string;
  headers: Record<string, string>;
  programName?: string;
  matchedAsset?: string;
}

export function activeBugBountyScopeDecision(url: string): BugBountyScopeDecision {
  const state = useBugBountyStore.getState();
  const program = state.programs.find((item) => item.id === state.activeProgramId);
  if (!program) {
    return {
      ok: false,
      headers: {},
      message: "Blocked: no active Bug Bounty program profile is selected. Select a saved program before using scoped web tools.",
    };
  }

  const scope = checkBugBountyScope(program, url);
  if (!scope.ok) {
    return {
      ok: false,
      headers: {},
      programName: program.name,
      matchedAsset: scope.matchedAsset,
      message: `Blocked by Bug Bounty scope for ${program.name}: ${scope.reason}${scope.matchedAsset ? ` Matched: ${scope.matchedAsset}` : ""}`,
    };
  }

  return {
    ok: true,
    headers: requiredHeadersForProgram(program),
    programName: program.name,
    matchedAsset: scope.matchedAsset,
    message: `Allowed by Bug Bounty scope for ${program.name}${scope.matchedAsset ? ` (${scope.matchedAsset})` : ""}.`,
  };
}

export function mergeBugBountyHeaders(base: HeadersInit | undefined, scopedHeaders: Record<string, string>): HeadersInit {
  return { ...(base as Record<string, string> | undefined), ...scopedHeaders };
}
