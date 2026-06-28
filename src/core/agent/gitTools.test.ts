import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGitTools } from "./gitTools";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

function tool(name: string) {
  const found = createGitTools().find((item) => item.definition.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

describe("gitTools", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("registers the Git tools listed in the catalog", () => {
    const names = createGitTools().map((item) => item.definition.name);

    expect(names).toEqual([
      "git_status",
      "git_diff",
      "git_branch",
      "git_current_branch",
      "git_log",
      "git_show",
      "git_blame",
      "git_commit",
      "git_push",
      "git_pull",
      "git_reset",
    ]);
  });

  it("calls git_log with a bounded limit argument", async () => {
    invokeMock.mockResolvedValue("abc123 commit");

    const result = await tool("git_log").execute({ limit: 3 });

    expect(invokeMock).toHaveBeenCalledWith("git_log", { limit: 3 });
    expect(result).toEqual({ ok: true, content: "abc123 commit" });
  });

  it("passes git_reset mode and target to Tauri", async () => {
    invokeMock.mockResolvedValue("Done.");

    const result = await tool("git_reset").execute({ mode: "soft", ref: "HEAD~1" });

    expect(invokeMock).toHaveBeenCalledWith("git_reset", { mode: "soft", target: "HEAD~1" });
    expect(result).toEqual({ ok: true, content: "Done." });
  });

  it("calls git_show with revision and optional path", async () => {
    invokeMock.mockResolvedValue("commit patch");

    const result = await tool("git_show").execute({ rev: "HEAD~1", path: "src/a.ts" });

    expect(invokeMock).toHaveBeenCalledWith("git_show", { rev: "HEAD~1", path: "src/a.ts" });
    expect(result).toEqual({ ok: true, content: "commit patch" });
  });

  it("calls git_blame with an optional line range", async () => {
    invokeMock.mockResolvedValue("blame output");

    const result = await tool("git_blame").execute({ path: "src/a.ts", start_line: 2, end_line: 4 });

    expect(invokeMock).toHaveBeenCalledWith("git_blame", { path: "src/a.ts", startLine: 2, endLine: 4 });
    expect(result).toEqual({ ok: true, content: "blame output" });
  });
});
