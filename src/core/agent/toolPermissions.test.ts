import { describe, expect, it } from "vitest";
import {
  globToRegex,
  matchesPermissionRule,
  parsePermissionRule,
  resolvePermission,
} from "./toolPermissions";
import { isToolAvailableInMode } from "./toolModes";

describe("tool permission rules", () => {
  it("parses bare and specifier rules", () => {
    expect(parsePermissionRule("WebSearch")).toEqual({ tool: "WebSearch", raw: "WebSearch" });
    expect(parsePermissionRule("Read(src/**)")).toEqual({
      tool: "Read",
      specifier: "src/**",
      raw: "Read(src/**)",
    });
  });

  it("matches path specifiers for Claude filesystem tools", () => {
    expect(matchesPermissionRule("Read(src/**)", "Read", { file_path: "src/App.tsx" })).toBe(true);
    expect(matchesPermissionRule("Read(src/**)", "Read", { file_path: "package.json" })).toBe(false);
    expect(matchesPermissionRule("Edit(src)", "Edit", { file_path: "src/core/a.ts" })).toBe(true);
  });

  it("matches Claude-style path rules against Rush filesystem tool aliases", () => {
    expect(matchesPermissionRule("Read(src/**)", "read_file", { path: "src/App.tsx" })).toBe(true);
    expect(matchesPermissionRule("Read(src/**)", "read_file", { path: "package.json" })).toBe(false);
    expect(matchesPermissionRule("Write(src/**)", "write_file", { path: "src/generated.ts" })).toBe(true);
    expect(matchesPermissionRule("Edit(src/**)", "edit_file", { path: "src/core/a.ts" })).toBe(true);
    expect(matchesPermissionRule("Glob(src/**)", "glob_files", { pattern: "src/core/*.ts" })).toBe(true);
    expect(matchesPermissionRule("Grep(src/**)", "grep_search", { glob: "src/**/*.ts" })).toBe(true);
  });

  it("checks deny before ask and allow", () => {
    const result = resolvePermission(
      {
        allow: ["Read(**)"],
        ask: ["Read(src/**)"],
        deny: ["Read(src/secrets/**)"],
      },
      "Read",
      { file_path: "src/secrets/key.txt" },
    );

    expect(result?.effect).toBe("deny");
  });

  it("matches command specifiers for shell tools", () => {
    expect(matchesPermissionRule("Bash(npm test)", "Bash", { command: "npm test" })).toBe(true);
    expect(matchesPermissionRule("Bash(npm run *)", "Bash", { command: "npm run build" })).toBe(true);
    expect(matchesPermissionRule("PowerShell(Get-ChildItem *)", "PowerShell", { command: "Get-ChildItem src" })).toBe(true);
    expect(matchesPermissionRule("Bash(npm test)", "Bash", { command: "npm run build" })).toBe(false);
  });

  it("matches WebFetch domain specifiers", () => {
    expect(matchesPermissionRule("WebFetch(domain:example.com)", "WebFetch", { url: "https://docs.example.com/a" })).toBe(true);
    expect(matchesPermissionRule("WebFetch(domain:example.com)", "WebFetch", { url: "https://example.org/a" })).toBe(false);
  });

  it("converts simple globs to regexes", () => {
    const re = globToRegex("src/**/*.ts");
    expect(re.test("src/core/agent/tools.ts")).toBe(true);
    expect(re.test("src/core/agent/tools.tsx")).toBe(false);
  });

  it("keeps Flow coordination tools out of Code and Chat modes", () => {
    expect(isToolAvailableInMode("chat", "read_file")).toBe(false);
    expect(isToolAvailableInMode("code", "read_file")).toBe(true);
    expect(isToolAvailableInMode("code", "Agent")).toBe(false);
    expect(isToolAvailableInMode("flow", "Agent")).toBe(true);
  });
});
