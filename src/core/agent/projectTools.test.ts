import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectTools } from "./projectTools";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

function toolMap() {
  return new Map(createProjectTools({
    getContext: () => ({
      mode: "code",
      activeProjectId: "p_1",
      projectName: "Rush",
      projectPath: "C:/repo",
      instructions: "Use tests.",
    }),
  }).map((tool) => [tool.definition.name, tool]));
}

describe("projectTools", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("returns active project context", async () => {
    const result = await toolMap().get("project_context")!.execute({});

    expect(result.content).toContain("Mode: code");
    expect(result.content).toContain("Project name: Rush");
    expect(result.content).toContain("Use tests.");
  });

  it("opens http URLs through Tauri", async () => {
    invokeMock.mockResolvedValue(undefined);

    const result = await toolMap().get("open_url")!.execute({ url: "http://localhost:1420" });

    expect(invokeMock).toHaveBeenCalledWith("open_url", { url: "http://localhost:1420" });
    expect(result.ok).toBe(true);
  });

  it("rejects non-web URLs", async () => {
    const result = await toolMap().get("open_url")!.execute({ url: "file:///C:/secret.txt" });

    expect(result.ok).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
