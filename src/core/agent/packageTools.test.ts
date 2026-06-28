import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPackageTools } from "./packageTools";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

function tool(name: string) {
  const found = createPackageTools().find((item) => item.definition.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

describe("packageTools", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("registers run_tests", () => {
    const names = createPackageTools().map((item) => item.definition.name);
    expect(names).toContain("run_tests");
    expect(names).toContain("diagnostics");
    expect(names).toContain("format_files");
    expect(names).toContain("lint");
    expect(names).toContain("dependency_audit");
  });

  it("auto-runs npm test when package scripts include test", async () => {
    invokeMock
      .mockResolvedValueOnce(JSON.stringify({ test: "vitest run" }))
      .mockResolvedValueOnce("tests passed");

    const result = await tool("run_tests").execute({ args: ["--run"] });

    expect(invokeMock).toHaveBeenNthCalledWith(1, "npm_scripts", {});
    expect(invokeMock).toHaveBeenNthCalledWith(2, "npm_run_script", { script: "test", args: ["--run"] });
    expect(result).toEqual({ ok: true, content: "tests passed" });
  });

  it("falls back to cargo tests in auto mode", async () => {
    invokeMock
      .mockResolvedValueOnce(JSON.stringify({ build: "vite build" }))
      .mockResolvedValueOnce("cargo tests passed");

    const result = await tool("run_tests").execute({});

    expect(invokeMock).toHaveBeenNthCalledWith(1, "npm_scripts", {});
    expect(invokeMock).toHaveBeenNthCalledWith(2, "cargo_test_cmd", {});
    expect(result).toEqual({ ok: true, content: "cargo tests passed" });
  });

  it("runs lint through npm lint when present", async () => {
    invokeMock
      .mockResolvedValueOnce(JSON.stringify({ lint: "eslint ." }))
      .mockResolvedValueOnce("lint passed");

    const result = await tool("lint").execute({});

    expect(invokeMock).toHaveBeenNthCalledWith(1, "npm_scripts", {});
    expect(invokeMock).toHaveBeenNthCalledWith(2, "npm_run_script", { script: "lint", args: [] });
    expect(result).toEqual({ ok: true, content: "lint passed" });
  });

  it("uses cargo fmt when no npm format script exists", async () => {
    invokeMock
      .mockResolvedValueOnce(JSON.stringify({ build: "vite build" }))
      .mockResolvedValueOnce("formatted");

    const result = await tool("format_files").execute({ check: true });

    expect(invokeMock).toHaveBeenNthCalledWith(1, "npm_scripts", {});
    expect(invokeMock).toHaveBeenNthCalledWith(2, "cargo_fmt_cmd", { check: true });
    expect(result).toEqual({ ok: true, content: "formatted" });
  });

  it("runs npm dependency audit", async () => {
    invokeMock.mockResolvedValueOnce("0 vulnerabilities");

    const result = await tool("dependency_audit").execute({ kind: "npm" });

    expect(invokeMock).toHaveBeenCalledWith("npm_audit", {});
    expect(result).toEqual({ ok: true, content: "0 vulnerabilities" });
  });
});
