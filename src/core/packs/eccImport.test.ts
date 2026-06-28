import { describe, expect, it } from "vitest";
import { importEccPack, summarizeImportedPack, type PackSourceFile } from "./eccImport";

const goodSkill = [
  "---",
  "name: search-first",
  "description: Research before coding",
  "origin: ECC",
  "tags: [research, workflow]",
  "---",
  "# Search First",
  "",
  "## When to Use",
  "Use before building a custom tool or integration.",
  "",
  "## Workflow",
  "Check existing libraries, docs, MCP servers, and local patterns before implementing.",
].join("\n");

const goodCommand = [
  "---",
  "description: Review local changes",
  "argument-hint: [pr-number]",
  "---",
  "# Code Review",
  "",
  "Gather the git diff, read changed files, check security risks, and report findings by severity.",
].join("\n");

const goodRule = [
  "# TypeScript Rules",
  "",
  "Prefer strict types, avoid unsafe any, keep React components focused, and add tests for behavior.",
].join("\n");

function fixture(): PackSourceFile[] {
  return [
    { path: "skills/search-first/SKILL.md", content: goodSkill },
    { path: "commands/code-review.md", content: goodCommand },
    { path: "rules/typescript/coding-style.md", content: goodRule },
    { path: "manifests/install-profiles.json", content: JSON.stringify({ version: 1, profiles: { developer: { modules: ["rules-core"] } } }) },
    { path: "README.md", content: "# Ignore me" },
  ];
}

describe("ECC import", () => {
  it("imports validated ECC skills, commands, rules, and manifests", () => {
    const pack = importEccPack(fixture(), {
      approveImportedSkills: true,
      defaultConfidence: 92,
    });

    expect(pack.stats).toEqual({
      files: 5,
      accepted: 4,
      rejected: 0,
      skipped: 1,
    });
    expect(pack.skills).toHaveLength(1);
    expect(pack.skills[0]).toMatchObject({
      title: "search-first",
      approved: true,
      confidence: 92,
      origin: "ECC",
      sourcePath: "skills/search-first/SKILL.md",
    });
    expect(pack.skills[0].tags).toEqual(["research", "workflow", "ECC", "imported"]);
    expect(pack.commands[0]).toMatchObject({
      name: "code-review",
      argumentHint: "[pr-number]",
    });
    expect(pack.rules[0]).toMatchObject({
      name: "TypeScript Rules",
      category: "typescript",
    });
    expect(pack.manifests[0].entries).toEqual(expect.arrayContaining(["developer", "rules-core"]));
  });

  it("rejects invalid pack files but keeps valid files", () => {
    const pack = importEccPack([
      ...fixture(),
      { path: "skills/tiny/SKILL.md", content: "---\nname: tiny\n---\nshort" },
      { path: "manifests/bad.json", content: "{ nope" },
    ]);

    expect(pack.skills).toHaveLength(1);
    expect(pack.rejected).toHaveLength(2);
    expect(pack.rejected.map((item) => item.path)).toEqual([
      "skills/tiny/SKILL.md",
      "manifests/bad.json",
    ]);
  });

  it("keeps unsafe accepted files as warnings", () => {
    const pack = importEccPack([
      {
        path: "commands/danger.md",
        content: [
          "---",
          "description: dangerous command",
          "---",
          "# Danger",
          "",
          "This command explains why git reset --hard should be avoided unless explicitly requested.",
        ].join("\n"),
      },
    ]);

    expect(pack.commands).toHaveLength(1);
    expect(pack.warnings).toHaveLength(1);
    expect(pack.warnings[0].issues[0]).toMatchObject({ code: "unsafe-content" });
  });

  it("dedupes imported items by stable normalized keys", () => {
    const pack = importEccPack([
      { path: "skills/search-first/SKILL.md", content: goodSkill },
      { path: "skills/search-first-copy/SKILL.md", content: goodSkill.replace("Research before coding", "Duplicate") },
      { path: "commands/code-review.md", content: goodCommand },
      { path: "commands/code_review.md", content: goodCommand },
    ]);

    expect(pack.skills).toHaveLength(1);
    expect(pack.commands).toHaveLength(1);
  });

  it("can optionally treat unknown markdown as rule content", () => {
    const pack = importEccPack([
      {
        path: "docs/custom-rule.md",
        content: "# Custom Rule\n\nUse careful review and keep generated changes scoped to the request.",
      },
    ], { includeUnknownMarkdownAsRules: true });

    expect(pack.rules).toHaveLength(1);
    expect(pack.stats.skipped).toBe(0);
  });

  it("summarizes import results", () => {
    const summary = summarizeImportedPack(importEccPack(fixture()));

    expect(summary).toContain("Files scanned: 5");
    expect(summary).toContain("Skills: 1");
    expect(summary).toContain("Skipped: 1");
  });
});
