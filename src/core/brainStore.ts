import { create } from "zustand";
import { persist } from "zustand/middleware";

export type MemoryKind = "fact" | "preference" | "instruction" | "note";

export interface BrainMemory {
  id: string;
  text: string;
  kind: MemoryKind;
  createdAt: number;
}

export interface BrainSkill {
  id: string;
  title: string;
  when: string;
  how: string;
  tags: string[];
  confidence: number;
  approved: boolean;
  createdAt: number;
}

export interface BrainSettings {
  memoriesEnabled: boolean;
  skillsEnabled: boolean;
  autoExtractMemories: boolean;
  autoExtractSkills: boolean;
  autoApproveSkills: boolean;
  minimumConfidence: number;
  maxInjectedSkills: number;
}

export interface BrainState extends BrainSettings {
  memories: BrainMemory[];
  skills: BrainSkill[];
  addMemory: (text: string, kind: MemoryKind) => void;
  addSkill: (skill: Omit<BrainSkill, "id" | "createdAt" | "confidence" | "approved">) => void;
  addExtractedSkill: (skill: Omit<BrainSkill, "id" | "createdAt" | "approved">) => void;
  deleteSkill: (id: string) => void;
  importMemories: (items: Array<{ text: string; kind?: MemoryKind }>) => void;
  importSkills: (items: Array<Partial<BrainSkill>>) => void;
  extractFromTurn: (input: { userText: string; assistantText: string; mode: "plain" | "agent" | "flow"; toolNames?: string[] }) => void;
  setBrainSetting: <K extends keyof BrainSettings>(key: K, value: BrainSettings[K]) => void;
  tidyMemories: () => void;
  auditSkills: () => void;
}

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function normalizeKind(kind: unknown): MemoryKind {
  return kind === "preference" || kind === "instruction" || kind === "note" ? kind : "fact";
}

function normalizeTags(tags: unknown): string[] {
  if (Array.isArray(tags)) return tags.map(String).map((t) => t.trim()).filter(Boolean);
  if (typeof tags === "string") return tags.split(",").map((t) => t.trim()).filter(Boolean);
  return [];
}

function normalizedText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function hasMemory(memories: BrainMemory[], text: string): boolean {
  const key = normalizedText(text);
  return memories.some((memory) => normalizedText(memory.text) === key);
}

const LOW_VALUE_MEMORY_PATTERNS = [
  /\btool[- ]?call/i,
  /\btool_calls?\b/i,
  /<\/?tool_calls?>/i,
  /\bstress\s+test\b/i,
  /\bparser\b/i,
];

function cleanMemoryText(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!?]+$/, "");
}

function validMemoryText(value: string): boolean {
  const text = cleanMemoryText(value);
  if (text.length < 4 || text.length > 240) return false;
  if (LOW_VALUE_MEMORY_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return true;
}

function pushMemory(
  matches: Array<{ text: string; kind: MemoryKind }>,
  text: string,
  kind: MemoryKind,
) {
  const cleaned = cleanMemoryText(text);
  if (!validMemoryText(cleaned)) return;
  if (matches.some((memory) => normalizedText(memory.text) === normalizedText(cleaned))) return;
  matches.push({ text: cleaned, kind });
}

function pushRememberedMemory(matches: Array<{ text: string; kind: MemoryKind }>, value: string) {
  const remembered = cleanMemoryText(value);
  const preference = remembered.match(/^(?:i prefer|i like|my preference is)\s+(.{4,})/i)?.[1];
  if (preference) {
    pushMemory(matches, `User prefers ${preference}`, "preference");
    return;
  }

  const instruction = remembered.match(/^(?:to\s+|please\s+)?(?:always\s+)?(.{4,})/i)?.[1];
  if (/^(?:to\s+|please\s+|always\s+)/i.test(remembered) && instruction) {
    pushMemory(matches, instruction, "instruction");
    return;
  }

  pushMemory(matches, remembered, "fact");
}

function extractMemories(userText: string): Array<{ text: string; kind: MemoryKind }> {
  const text = userText.trim();
  const matches: Array<{ text: string; kind: MemoryKind }> = [];
  const remember = text.match(/\bremember(?:\s+that|:)?\s+(.{4,})/i)?.[1];
  if (remember) pushRememberedMemory(matches, remember);

  const preference = text.match(/\b(?:i prefer|i like|my preference is)\s+(.{4,})/i)?.[1];
  if (preference) pushMemory(matches, `User prefers ${preference}`, "preference");

  const name = text.match(/\b(?:my name is|call me)\s+([A-Za-z][\w -]{1,40})/i)?.[1];
  if (name) pushMemory(matches, `User wants to be called ${name}`, "fact");

  const instruction = text.match(/\b(?:always|please always)\s+(.{4,})/i)?.[1];
  if (instruction) pushMemory(matches, instruction, "instruction");
  return matches;
}

function titleFromTask(userText: string): string {
  return userText
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[?.!]+$/, "")
    .slice(0, 48) || "Workflow";
}

const TASK_VERBS = [
  "add",
  "build",
  "debug",
  "fix",
  "implement",
  "investigate",
  "refactor",
  "release",
  "repair",
  "ship",
  "test",
  "update",
  "verify",
];

const LOW_VALUE_SKILL_PATTERNS = [
  /\b(?:yeah|yup|ok(?:ay)?|sure)\b.*\bcontinue\b/i,
  /\bcontinue\b/i,
  /\bstress\s+test\b/i,
  /\btool[- ]?call/i,
  /\btool_calls?\b/i,
  /<\/?tool_calls?>/i,
  /\bparser\b/i,
  /\bforgot\b.*<\/?tool_calls?>/i,
  /\bstarting\s+<\/?tool_calls?>/i,
  /\blist\s+(?:everything|all files)\b/i,
];

function hasTaskSignal(text: string): boolean {
  const lower = text.toLowerCase();
  return TASK_VERBS.some((verb) => new RegExp(`\\b${verb}\\b`).test(lower));
}

function shouldExtractSkill(userText: string, assistantText: string, toolNames: string[]): boolean {
  const text = userText.trim();
  if (text.length < 12 || text.length > 220) return false;
  if (LOW_VALUE_SKILL_PATTERNS.some((pattern) => pattern.test(text))) return false;
  if (!hasTaskSignal(text)) return false;

  const distinctTools = new Set(toolNames);
  if (distinctTools.size < 3) return false;

  const outcome = assistantText.trim().toLowerCase();
  if (!outcome || /^(done|ok|okay|sure|yes|no)\.?$/.test(outcome)) return false;

  return true;
}

export const useBrainStore = create<BrainState>()(
  persist(
    (set) => ({
      memoriesEnabled: true,
      skillsEnabled: true,
      autoExtractMemories: true,
      autoExtractSkills: true,
      autoApproveSkills: true,
      minimumConfidence: 85,
      maxInjectedSkills: 3,
      memories: [],
      skills: [],

      addMemory: (text, kind) =>
        set((s) => ({
          memories: [
            {
              id: newId(),
              text: text.trim(),
              kind,
              createdAt: Date.now(),
            },
            ...s.memories,
          ].filter((m) => m.text),
        })),

      addSkill: (skill) =>
        set((s) => ({
          skills: [
            {
              ...skill,
              id: newId(),
              title: skill.title.trim(),
              when: skill.when.trim(),
              how: skill.how.trim(),
              tags: normalizeTags(skill.tags),
              confidence: 100,
              approved: s.autoApproveSkills,
              createdAt: Date.now(),
            },
            ...s.skills,
          ].filter((sk) => sk.title && sk.when && sk.how),
        })),

      addExtractedSkill: (skill) =>
        set((s) => ({
          skills: [
            {
              ...skill,
              id: newId(),
              title: skill.title.trim(),
              when: skill.when.trim(),
              how: skill.how.trim(),
              tags: normalizeTags(skill.tags),
              confidence: Math.max(0, Math.min(100, Number(skill.confidence) || 0)),
              approved: s.autoApproveSkills && skill.confidence >= s.minimumConfidence,
              createdAt: Date.now(),
            },
            ...s.skills,
          ].filter((sk) => sk.title && sk.when && sk.how),
        })),

      deleteSkill: (id) => set((s) => ({ skills: s.skills.filter((skill) => skill.id !== id) })),

      importMemories: (items) =>
        set((s) => ({
          memories: [
            ...items
              .map((item) => ({
                id: newId(),
                text: String(item.text ?? "").trim(),
                kind: normalizeKind(item.kind),
                createdAt: Date.now(),
              }))
              .filter((item) => item.text),
            ...s.memories,
          ],
        })),

      importSkills: (items) =>
        set((s) => ({
          skills: [
            ...items
              .map((item) => ({
                id: newId(),
                title: String(item.title ?? "").trim(),
                when: String(item.when ?? "").trim(),
                how: String(item.how ?? "").trim(),
                tags: normalizeTags(item.tags),
                confidence: Number(item.confidence ?? 75),
                approved: Boolean(item.approved ?? false),
                createdAt: Date.now(),
              }))
              .filter((item) => item.title && item.when && item.how),
            ...s.skills,
          ],
        })),

      extractFromTurn: ({ userText, assistantText, mode, toolNames = [] }) =>
        set((s) => {
          const memories = s.autoExtractMemories
            ? [
                ...extractMemories(userText)
                  .filter((memory) => !hasMemory(s.memories, memory.text))
                  .map((memory) => ({
                    id: newId(),
                    text: memory.text,
                    kind: memory.kind,
                    createdAt: Date.now(),
                  })),
                ...s.memories,
              ]
            : s.memories;

          let skills = s.skills;
          if (s.autoExtractSkills && mode !== "plain" && shouldExtractSkill(userText, assistantText, toolNames)) {
            const title = titleFromTask(userText);
            const exists = s.skills.some((skill) => normalizedText(skill.title) === normalizedText(title));
            if (!exists) {
              const confidence = Math.min(90, 60 + toolNames.length * 5);
              skills = [
                {
                  id: newId(),
                  title,
                  when: `Use for similar tasks: ${userText.trim().slice(0, 180)}`,
                  how: [
                    `Workflow observed in ${mode === "flow" ? "Flow" : "Code"} mode.`,
                    `Tools used: ${Array.from(new Set(toolNames)).join(", ")}.`,
                    assistantText.trim() ? `Final outcome: ${assistantText.trim().slice(0, 240)}` : "Review the task result and adapt the steps.",
                  ].join("\n"),
                  tags: ["auto", mode],
                  confidence,
                  approved: s.autoApproveSkills && confidence >= s.minimumConfidence,
                  createdAt: Date.now(),
                },
                ...s.skills,
              ];
            }
          }

          return { memories, skills };
        }),

      setBrainSetting: (key, value) => set({ [key]: value } as Pick<BrainState, typeof key>),

      tidyMemories: () =>
        set((s) => {
          const seen = new Set<string>();
          return {
            memories: s.memories.filter((m) => {
              const key = m.text.toLowerCase().replace(/\s+/g, " ").trim();
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            }),
          };
        }),

      auditSkills: () =>
        set((s) => ({
          skills: s.skills
            .map((skill) => ({
              ...skill,
              approved: skill.confidence >= s.minimumConfidence ? true : skill.approved,
            }))
            .sort((a, b) => b.confidence - a.confidence),
        })),
    }),
    { name: "rush-brain" },
  ),
);
