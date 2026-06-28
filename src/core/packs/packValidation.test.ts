import { describe, expect, it } from "vitest";
import {
  parseFrontmatterDocument,
  parseSimpleYaml,
  validateCommandMarkdown,
  validateManifestJson,
  validateRuleMarkdown,
  validateSkillMarkdown,
} from "./packValidation";

describe("pack validation", () => {
  it("parses simple YAML frontmatter used by ECC files", () => {
    expect(parseSimpleYaml([
      "name: search-first",
      "description: Research before coding",
      "origin: ECC",
      "tags:",
      "  - research",
      "  - coding",
      "confidence: 90",
    ].join("\n"))).toEqual({
      name: "search-first",
      description: "Research before coding",
      origin: "ECC",
      tags: ["research", "coding"],
      confidence: 90,
    });
  });

  it("splits frontmatter and body", () => {
    const doc = parseFrontmatterDocument("---\nname: code-review\n---\n# Code Review\nBody");

    expect(doc.frontmatter.name).toBe("code-review");
    expect(doc.body).toBe("# Code Review\nBody");
  });

  it("validates an ECC-shaped skill markdown file", () => {
    const raw = [
      "---",
      "name: verification-loop",
      "description: Comprehensive verification workflow",
      "origin: ECC",
      "tags: [quality, tests]",
      "---",
      "# Verification Loop",
      "",
      "## When to Use",
      "Use after completing a feature.",
      "",
      "## Workflow",
      "Run build, type checks, lint, tests, and review the diff before shipping.",
    ].join("\n");

    const result = validateSkillMarkdown(raw, "skills/verification-loop/SKILL.md");

    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({
      title: "verification-loop",
      origin: "ECC",
      sourcePath: "skills/verification-loop/SKILL.md",
    });
    expect(result.value?.tags).toEqual(["quality", "tests", "ECC"]);
    expect(result.value?.how).toContain("Run build");
  });

  it("rejects empty or tiny skills", () => {
    const result = validateSkillMarkdown("---\nname: tiny\n---\nshort", "skills/tiny/SKILL.md");

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "body-too-short")).toBe(true);
  });

  it("validates command markdown and normalizes command names", () => {
    const result = validateCommandMarkdown([
      "---",
      "description: Code review local changes",
      "argument-hint: [pr-number]",
      "---",
      "# Code Review",
      "",
      "Gather git diff, read changed files, review risks, and report findings by severity.",
    ].join("\n"), "commands/code-review.md");

    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({
      name: "code-review",
      argumentHint: "[pr-number]",
    });
  });

  it("validates rule markdown with category inferred from path", () => {
    const result = validateRuleMarkdown([
      "# TypeScript Rules",
      "",
      "Prefer strict typing, avoid unsafe any, and keep React components small and testable.",
    ].join("\n"), "rules/typescript/coding-style.md");

    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({
      name: "TypeScript Rules",
      category: "typescript",
    });
  });

  it("warns on unsafe content without accepting it silently", () => {
    const result = validateCommandMarkdown([
      "---",
      "description: dangerous",
      "---",
      "# Dangerous",
      "",
      "Run git reset --hard before continuing so the tree is clean.",
    ].join("\n"), "commands/dangerous.md");

    expect(result.ok).toBe(true);
    expect(result.issues).toContainEqual(expect.objectContaining({
      severity: "warning",
      code: "unsafe-content",
    }));
  });

  it("validates ECC-style manifest JSON", () => {
    const result = validateManifestJson(JSON.stringify({
      version: 1,
      profiles: {
        developer: {
          modules: ["rules-core", "commands-core", "workflow-quality"],
        },
      },
    }));

    expect(result.ok).toBe(true);
    expect(result.value?.version).toBe(1);
    expect(result.value?.entries).toEqual(expect.arrayContaining(["developer", "rules-core", "commands-core"]));
  });

  it("rejects malformed manifest JSON", () => {
    const result = validateManifestJson("{ nope");

    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe("invalid-json");
  });
});
