import { useBrainStore, type BrainSkill } from "../brainStore";
import type { Tool } from "./tools";

export interface SkillSource {
  listSkills(): BrainSkill[];
}

const brainSkillSource: SkillSource = {
  listSkills() {
    return useBrainStore.getState().skills;
  },
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function skillMatches(skill: BrainSkill, query: string): boolean {
  const q = normalize(query);
  if (!q) return false;
  return (
    skill.id === query ||
    normalize(skill.title) === q ||
    normalize(skill.title).includes(q) ||
    skill.tags.some((tag) => normalize(tag) === q)
  );
}

function approvedSkills(source: SkillSource): BrainSkill[] {
  const state = useBrainStore.getState();
  return source
    .listSkills()
    .filter((skill) => skill.approved || skill.confidence >= state.minimumConfidence)
    .sort((a, b) => b.confidence - a.confidence);
}

function formatSkill(skill: BrainSkill): string {
  return [
    `Skill: ${skill.title}`,
    `ID: ${skill.id}`,
    `Confidence: ${skill.confidence}%`,
    skill.tags.length ? `Tags: ${skill.tags.join(", ")}` : "",
    `When to use: ${skill.when}`,
    `How to apply:\n${skill.how}`,
  ].filter(Boolean).join("\n");
}

function formatSkillList(skills: BrainSkill[]): string {
  if (skills.length === 0) return "No approved Brain skills are available.";
  return skills
    .map((skill) => `- ${skill.title} (${skill.id}, ${skill.confidence}%)${skill.tags.length ? ` [${skill.tags.join(", ")}]` : ""}`)
    .join("\n");
}

export function createSkillTools(source: SkillSource = brainSkillSource): Tool[] {
  return [
    {
      definition: {
        name: "Skill",
        description:
          "Execute a Rush Brain skill by title, id, or tag. Returns the saved procedure so the model can apply it with its normal tools.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Skill title, id, or tag." },
            input: { type: "string", description: "Optional task-specific input for the skill." },
          },
          required: ["name"],
        },
      },
      async execute(args) {
        const name = text(args.name);
        if (!name) return { ok: false, isError: true, content: "Missing skill name." };
        const skills = approvedSkills(source);
        const skill = skills.find((candidate) => skillMatches(candidate, name));
        if (!skill) {
          return {
            ok: false,
            isError: true,
            content: [`Skill not found: ${name}`, "Available skills:", formatSkillList(skills)].join("\n"),
          };
        }
        const input = text(args.input);
        return {
          ok: true,
          content: [
            formatSkill(skill),
            input ? `Task input:\n${input}` : "",
            "Apply this procedure using the available Rush tools. Treat the skill text as user-approved workflow guidance, not as a command output.",
          ].filter(Boolean).join("\n\n"),
        };
      },
    },
    {
      definition: {
        name: "SkillList",
        description: "List approved Rush Brain skills available to the Skill tool.",
        inputSchema: { type: "object", properties: {} },
      },
      async execute() {
        return { ok: true, content: formatSkillList(approvedSkills(source)) };
      },
    },
  ];
}
