import { describe, expect, it } from "vitest";
import { createWorktreeTools, type WorktreeBackend } from "./worktreeTools";

function mockBackend(): { backend: WorktreeBackend; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    backend: {
      async enter(args) {
        calls.push(`enter:${args.name ?? ""}:${args.branch ?? ""}:${args.base ?? ""}:${args.path ?? ""}`);
        return {
          path: "C:/repo/.rush/worktrees/feature",
          previous_root: "C:/repo",
          branch: args.branch ?? "rush/feature",
        };
      },
      async exit(args) {
        calls.push(`exit:${args.remove === true}`);
        return {
          path: "C:/repo",
          previous_root: "C:/repo/.rush/worktrees/feature",
          branch: "rush/feature",
        };
      },
    },
  };
}

describe("worktree tools", () => {
  it("enters a worktree and reports the switched root", async () => {
    const { backend, calls } = mockBackend();
    const tools = new Map(createWorktreeTools(backend).map((tool) => [tool.definition.name, tool]));

    const result = await tools.get("EnterWorktree")!.execute({
      name: "feature",
      branch: "rush/feature",
      base: "HEAD",
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Entered worktree");
    expect(result.content).toContain("C:/repo/.rush/worktrees/feature");
    expect(calls).toEqual(["enter:feature:rush/feature:HEAD:"]);
  });

  it("exits a worktree and restores the previous root", async () => {
    const { backend, calls } = mockBackend();
    const tools = new Map(createWorktreeTools(backend).map((tool) => [tool.definition.name, tool]));

    const result = await tools.get("ExitWorktree")!.execute({ remove: true });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Exited worktree");
    expect(result.content).toContain("Active root: C:/repo");
    expect(calls).toEqual(["exit:true"]);
  });
});
