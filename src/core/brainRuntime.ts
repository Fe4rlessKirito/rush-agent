import { useBrainStore, type BrainSkill } from "./brainStore";

type BrainMode = "plain" | "agent" | "flow";

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function normalize(text: string): string {
  return words(text).join("-");
}

function skillScore(skill: BrainSkill, prompt: string): number {
  const q = prompt.toLowerCase();
  const slashRefs = q.match(/\/skill(?:[:\s]+([a-z0-9_.-]+))?/g) ?? [];
  const titleKey = normalize(skill.title);
  if (slashRefs.length && (q.includes(`/${titleKey}`) || q.includes(titleKey))) return 1000;
  const skillText = [skill.title, skill.when, skill.how, skill.tags.join(" ")].join(" ").toLowerCase();
  const promptWords = new Set(words(prompt).filter((word) => word.length > 2));
  let score = skill.approved ? 20 : 0;
  score += skill.confidence / 5;
  for (const word of promptWords) {
    if (skillText.includes(word)) score += 8;
  }
  for (const tag of skill.tags) {
    if (q.includes(tag.toLowerCase())) score += 18;
  }
  return score;
}

export function buildBrainContext(userText: string, mode: BrainMode): string {
  const brain = useBrainStore.getState();
  const sections: string[] = [];

  if (brain.memoriesEnabled && brain.memories.length) {
    sections.push(
      [
        "# Brain memories",
        "Use these remembered facts only when relevant. If a memory conflicts with the current user message, prefer the current message.",
        ...brain.memories.slice(0, 20).map((memory) => `- [${memory.kind}] ${memory.text}`),
      ].join("\n"),
    );
  }

  if (brain.skillsEnabled && brain.maxInjectedSkills > 0) {
    const approved = brain.skills
      .filter((skill) => skill.approved || skill.confidence >= brain.minimumConfidence)
      .sort((a, b) => skillScore(b, userText) - skillScore(a, userText))
      .slice(0, brain.maxInjectedSkills);

    if (approved.length) {
      sections.push(
        [
          "# Brain skills",
          mode === "plain"
            ? "These are reusable behavior notes. Do not claim filesystem or terminal access in Chat mode."
            : "If the user's request mentions /skill or one of these skills fits, apply the matching procedure.",
          ...approved.map((skill) =>
            [
              `## /skill ${normalize(skill.title)}`,
              `Title: ${skill.title}`,
              `When to use: ${skill.when}`,
              `How: ${skill.how}`,
              skill.tags.length ? `Tags: ${skill.tags.join(", ")}` : "",
            ].filter(Boolean).join("\n"),
          ),
        ].join("\n\n"),
      );
    }
  }

  return sections.join("\n\n");
}

export function extractBrainFromTurn(input: {
  userText: string;
  assistantText: string;
  mode: BrainMode;
  toolNames?: string[];
}): void {
  useBrainStore.getState().extractFromTurn(input);
}
