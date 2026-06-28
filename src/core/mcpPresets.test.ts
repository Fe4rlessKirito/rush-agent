import { describe, expect, it } from "vitest";
import { getMcpPreset, missingPresetFields } from "./mcpPresets";

describe("mcp presets", () => {
  it("builds the documented Roblox Studio stdio config", () => {
    const preset = getMcpPreset("roblox-studio")!;
    const config = preset.buildConfig({});

    expect(config).toMatchObject({
      id: "roblox-studio",
      transport: "stdio",
      command: "cmd.exe",
      args: ["/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"],
      enabled: true,
    });
  });

  it("requires user-provided values for sensitive/path presets", () => {
    const obsidian = getMcpPreset("obsidian-rest")!;
    const filesystem = getMcpPreset("filesystem")!;

    expect(missingPresetFields(obsidian, {}).map((field) => field.key)).toEqual(["apiKey"]);
    expect(missingPresetFields(filesystem, {}).map((field) => field.key)).toEqual(["rootPath"]);
  });

  it("builds Obsidian REST env config with defaults", () => {
    const preset = getMcpPreset("obsidian-rest")!;
    const config = preset.buildConfig({ apiKey: "secret" });

    expect(config).toMatchObject({
      command: "uvx",
      args: ["mcp-obsidian"],
      env: {
        OBSIDIAN_API_KEY: "secret",
        OBSIDIAN_HOST: "127.0.0.1",
        OBSIDIAN_PORT: "27124",
      },
    });
  });
});
