import { afterEach, describe, expect, it, vi } from "vitest";
import { createDevFs } from "./devFs";
import { createReleaseTools } from "./releaseTools";

function toolMap(seed: Record<string, string>) {
  return new Map(createReleaseTools(createDevFs(seed)).map((tool) => [tool.definition.name, tool]));
}

describe("releaseTools", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("checks local release readiness", async () => {
    const tools = toolMap({
      "package.json": JSON.stringify({ version: "1.2.3" }),
      "package-lock.json": JSON.stringify({ version: "1.2.3" }),
      "src-tauri/Cargo.toml": '[package]\nversion = "1.2.3"\n',
      "src-tauri/tauri.conf.json": JSON.stringify({ version: "1.2.3" }),
      "releases/Rush-Agent-v1.2.3-x64-setup.exe": "exe",
      "releases/Rush-Agent-v1.2.3-x64-setup.exe.sig": "sig",
      "releases/Rush-Agent-v1.2.3-x64.msi": "msi",
      "releases/Rush-Agent-v1.2.3-x64.msi.sig": "sig",
      "releases/latest.json": JSON.stringify({
        version: "1.2.3",
        platforms: { "windows-x86_64": { url: "https://example.com/setup.exe", signature: "abc" } },
      }),
    });

    const result = await tools.get("release_prepare")!.execute({});

    expect(result.content).toContain("Expected version: 1.2.3");
    expect(result.content).toContain("Rush-Agent-v1.2.3-x64-setup.exe: present");
    expect(result.content).toContain("signatureLength=3");
  });

  it("verifies published latest.json", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      version: "1.2.3",
      platforms: { "windows-x86_64": { url: "https://example.com/setup.exe", signature: "abc" } },
    }), { status: 200 })));
    const tools = toolMap({});

    const result = await tools.get("release_verify")!.execute({
      url: "https://example.com/latest.json",
      version: "1.2.3",
    });

    expect(result.content).toContain("version=1.2.3 (matches)");
    expect(result.content).toContain("signatureLength=3");
  });
});
