import { describe, expect, it } from "vitest";
import { createSkillTools, type SkillSource } from "./skillTools";

const source: SkillSource = {
  listSkills: () => [
    {
      id: "skill_build",
      title: "Build Rust App",
      when: "Use when packaging the desktop app",
      how: "Run cargo check, npm build, then tauri build.",
      tags: ["rust", "release"],
      confidence: 95,
      approved: true,
      createdAt: 1,
    },
    {
      id: "draft",
      title: "Draft Skill",
      when: "Never",
      how: "Draft",
      tags: [],
      confidence: 10,
      approved: false,
      createdAt: 2,
    },
  ],
};

describe("skill tools", () => {
  it("lists approved skills", async () => {
    const tools = new Map(createSkillTools(source).map((tool) => [tool.definition.name, tool]));

    const result = await tools.get("SkillList")!.execute({});

    expect(result.content).toContain("Build Rust App");
    expect(result.content).not.toContain("Draft Skill");
  });

  it("returns the matching skill procedure", async () => {
    const tools = new Map(createSkillTools(source).map((tool) => [tool.definition.name, tool]));

    const result = await tools.get("Skill")!.execute({ name: "release", input: "Ship this build" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Skill: Build Rust App");
    expect(result.content).toContain("Run cargo check");
    expect(result.content).toContain("Task input:");
  });

  it("reports available skills when a skill is missing", async () => {
    const tools = new Map(createSkillTools(source).map((tool) => [tool.definition.name, tool]));

    const result = await tools.get("Skill")!.execute({ name: "missing" });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("Skill not found");
    expect(result.content).toContain("Available skills");
  });
});
