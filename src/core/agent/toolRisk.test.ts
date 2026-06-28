import { describe, it, expect } from "vitest";
import { riskOf, summarize } from "./tools";

describe("riskOf", () => {
  it("classifies pure read tools as 'read'", () => {
    for (const name of ["read_file", "read_file_range", "read_many_files", "file_info", "project_files_summary", "list_dir", "list_tree", "git_status", "git_diff", "git_log", "git_show", "git_blame", "grep_search", "deep_research_search", "ui_inspect", "screenshot_url", "release_prepare", "release_verify", "dependency_audit", "project_context"]) {
      expect(riskOf(name, {})).toBe("read");
    }
  });

  it("classifies always-destructive tools as 'destructive'", () => {
    for (const name of ["delete_file", "move_file", "git_push", "git_pull", "npm_install", "run_tests", "McpServerConfigure", "McpServerConnect", "McpServerRemove", "McpToolCall", "mcp__docs__search"]) {
      expect(riskOf(name, {})).toBe("destructive");
    }
  });

  it("treats an unknown mutating tool as 'write' by default", () => {
    expect(riskOf("write_file", { path: "a.ts" })).toBe("write");
    expect(riskOf("write_many_files", {})).toBe("write");
    expect(riskOf("edit_file", { path: "a.ts" })).toBe("write");
    expect(riskOf("create_dir", { path: "src/new" })).toBe("write");
    expect(riskOf("open_url", { url: "http://localhost:1420" })).toBe("write");
    expect(riskOf("search_replace", { dryRun: false })).toBe("write");
    expect(riskOf("search_replace", {})).toBe("read");
  });

  it("is arg-sensitive for git_reset: only a hard reset is destructive", () => {
    expect(riskOf("git_reset", { mode: "hard" })).toBe("destructive");
    expect(riskOf("git_reset", { mode: "HARD" })).toBe("destructive");
    expect(riskOf("git_reset", { mode: "soft" })).toBe("write");
    expect(riskOf("git_reset", {})).toBe("write");
  });

  it("treats removing a worktree as destructive", () => {
    expect(riskOf("EnterWorktree", {})).toBe("write");
    expect(riskOf("ExitWorktree", {})).toBe("write");
    expect(riskOf("ExitWorktree", { remove: true })).toBe("destructive");
  });

  it("gates side-effecting commands (terminal/commit/build) behind confirmation", () => {
    expect(riskOf("Bash", { command: "ls" })).toBe("destructive");
    expect(riskOf("PowerShell", { command: "Get-ChildItem" })).toBe("destructive");
    expect(riskOf("Monitor", { command: "npm run dev" })).toBe("destructive");
    expect(riskOf("background_start", { command: "npm run dev" })).toBe("destructive");
    expect(riskOf("terminal_write", { input: "npm test\n" })).toBe("destructive");
    expect(riskOf("terminal_send_line", { line: "ls" })).toBe("destructive");
    expect(riskOf("terminal_start", {})).toBe("destructive");
    expect(riskOf("git_commit", { message: "x" })).toBe("destructive");
    expect(riskOf("npm_run_script", { script: "build" })).toBe("destructive");
    expect(riskOf("diagnostics", {})).toBe("destructive");
    expect(riskOf("format_files", {})).toBe("destructive");
    expect(riskOf("lint", {})).toBe("destructive");
    expect(riskOf("dev_server_start", {})).toBe("destructive");
    expect(riskOf("cargo_check", {})).toBe("destructive");
  });

  it("keeps read-only terminal inspection cheap", () => {
    expect(riskOf("terminal_read", {})).toBe("read");
    expect(riskOf("terminal_wait_for_output", {})).toBe("read");
    expect(riskOf("background_read", {})).toBe("read");
    expect(riskOf("background_list", {})).toBe("read");
    expect(riskOf("dev_server_status", {})).toBe("read");
  });
});

describe("summarize", () => {
  it("describes a delete by its path", () => {
    expect(summarize("delete_file", { path: "src/a.ts" })).toBe("Delete src/a.ts");
  });

  it("describes a move with both endpoints", () => {
    expect(summarize("move_file", { src: "a.ts", dst: "b.ts" })).toContain("a.ts");
    expect(summarize("move_file", { from: "a.ts", to: "b.ts" })).toContain("b.ts");
  });

  it("includes the commit message", () => {
    expect(summarize("git_commit", { message: "fix bug" })).toBe("Commit: fix bug");
  });

  it("shows the terminal command line", () => {
    expect(summarize("terminal_send_line", { line: "npm test" })).toContain("npm test");
  });

  it("falls back to a generic name(args) form for unmapped tools", () => {
    expect(summarize("some_tool", { a: 1, b: 2 })).toBe("some_tool(a, b)");
  });
});
