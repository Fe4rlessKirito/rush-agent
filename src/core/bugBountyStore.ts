import { create } from "zustand";
import { persist } from "zustand/middleware";

export type BugBountyPlatform = "hackerone" | "bugcrowd" | "intigriti" | "custom";

export interface BugBountyHeader {
  name: string;
  value: string;
}

export interface BugBountyProgramProfile {
  id: string;
  name: string;
  platform: BugBountyPlatform;
  programUrl: string;
  researcherHandle: string;
  requiredHeaders: BugBountyHeader[];
  inScopeAssets: string[];
  outOfScopeAssets: string[];
  excludedVulnerabilityClasses: string[];
  notes: string;
  policyText: string;
  createdAt: number;
  updatedAt: number;
}

export interface BugBountyProgramDraft {
  name?: string;
  platform?: BugBountyPlatform;
  programUrl?: string;
  researcherHandle?: string;
  requiredHeaders?: BugBountyHeader[];
  inScopeAssets?: string[];
  outOfScopeAssets?: string[];
  excludedVulnerabilityClasses?: string[];
  notes?: string;
  policyText?: string;
}

interface BugBountyState {
  programs: BugBountyProgramProfile[];
  activeProgramId: string | null;
  addProgram: (draft: BugBountyProgramDraft) => string;
  updateProgram: (id: string, patch: BugBountyProgramDraft) => void;
  deleteProgram: (id: string) => void;
  setActiveProgram: (id: string | null) => void;
}

function newId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function uniqueStrings(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

function normalizeHeaders(headers: BugBountyHeader[] | undefined): BugBountyHeader[] {
  return (headers ?? [])
    .map((header) => ({ name: header.name.trim(), value: header.value.trim() }))
    .filter((header) => header.name || header.value);
}

function profileFromDraft(draft: BugBountyProgramDraft): BugBountyProgramProfile {
  const now = Date.now();
  const programUrl = draft.programUrl?.trim() ?? "";
  return {
    id: newId(),
    name: draft.name?.trim() || programUrl || "Bug bounty program",
    platform: draft.platform ?? "custom",
    programUrl,
    researcherHandle: draft.researcherHandle?.trim() ?? "",
    requiredHeaders: normalizeHeaders(draft.requiredHeaders),
    inScopeAssets: uniqueStrings(draft.inScopeAssets),
    outOfScopeAssets: uniqueStrings(draft.outOfScopeAssets),
    excludedVulnerabilityClasses: uniqueStrings(draft.excludedVulnerabilityClasses),
    notes: draft.notes?.trim() ?? "",
    policyText: draft.policyText ?? "",
    createdAt: now,
    updatedAt: now,
  };
}

function mergeProgram(program: BugBountyProgramProfile, patch: BugBountyProgramDraft): BugBountyProgramProfile {
  return {
    ...program,
    ...(patch.name !== undefined ? { name: patch.name.trim() || program.name } : {}),
    ...(patch.platform !== undefined ? { platform: patch.platform } : {}),
    ...(patch.programUrl !== undefined ? { programUrl: patch.programUrl.trim() } : {}),
    ...(patch.researcherHandle !== undefined ? { researcherHandle: patch.researcherHandle.trim() } : {}),
    ...(patch.requiredHeaders !== undefined ? { requiredHeaders: normalizeHeaders(patch.requiredHeaders) } : {}),
    ...(patch.inScopeAssets !== undefined ? { inScopeAssets: uniqueStrings(patch.inScopeAssets) } : {}),
    ...(patch.outOfScopeAssets !== undefined ? { outOfScopeAssets: uniqueStrings(patch.outOfScopeAssets) } : {}),
    ...(patch.excludedVulnerabilityClasses !== undefined ? { excludedVulnerabilityClasses: uniqueStrings(patch.excludedVulnerabilityClasses) } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes.trim() } : {}),
    ...(patch.policyText !== undefined ? { policyText: patch.policyText } : {}),
    updatedAt: Date.now(),
  };
}

export const useBugBountyStore = create<BugBountyState>()(
  persist(
    (set) => ({
      programs: [],
      activeProgramId: null,
      addProgram: (draft) => {
        const profile = profileFromDraft(draft);
        set((state) => ({
          programs: [profile, ...state.programs],
          activeProgramId: profile.id,
        }));
        return profile.id;
      },
      updateProgram: (id, patch) =>
        set((state) => ({
          programs: state.programs.map((program) => program.id === id ? mergeProgram(program, patch) : program),
        })),
      deleteProgram: (id) =>
        set((state) => ({
          programs: state.programs.filter((program) => program.id !== id),
          activeProgramId: state.activeProgramId === id ? null : state.activeProgramId,
        })),
      setActiveProgram: (id) => set({ activeProgramId: id }),
    }),
    { name: "rush-agent-bug-bounty-programs" },
  ),
);
