import { describe, expect, it } from "vitest";
import { ToolRegistry } from "./tools";
import { isToolAvailableInMode } from "./toolModes";

describe("ToolRegistry permission rules", () => {
  it("blocks denied shell commands before execution", async () => {
    let executed = false;
    const tools = new ToolRegistry();
    tools.register({
      definition: {
        name: "Bash",
        description: "Run command",
        inputSchema: { type: "object", properties: {}, required: ["command"] },
      },
      async execute() {
        executed = true;
        return { ok: true, content: "ran" };
      },
    });
    tools.setPermissionRules({ deny: ["Bash(rm *)"] });

    const result = await tools.call("Bash", { command: "rm -rf dist" });

    expect(result.denied).toBe(true);
    expect(executed).toBe(false);
  });

  it("lets allow rules bypass destructive confirmation", async () => {
    let confirmed = false;
    const tools = new ToolRegistry();
    tools.register({
      definition: {
        name: "Bash",
        description: "Run command",
        inputSchema: { type: "object", properties: {}, required: ["command"] },
      },
      async execute() {
        return { ok: true, content: "ran" };
      },
    });
    tools.setConfirmer(async () => {
      confirmed = true;
      return false;
    });
    tools.setPermissionRules({ allow: ["Bash(npm test)"] });

    const result = await tools.call("Bash", { command: "npm test" });

    expect(result.ok).toBe(true);
    expect(confirmed).toBe(false);
  });

  it("applies Claude-style read deny rules to Rush read_file calls", async () => {
    let executed = false;
    const tools = new ToolRegistry();
    tools.register({
      definition: {
        name: "read_file",
        description: "Read file",
        inputSchema: { type: "object", properties: {}, required: ["path"] },
      },
      async execute() {
        executed = true;
        return { ok: true, content: "secret" };
      },
    });
    tools.setPermissionRules({ deny: ["Read(secrets/**)"] });

    const result = await tools.call("read_file", { path: "secrets/key.txt" });

    expect(result.denied).toBe(true);
    expect(executed).toBe(false);
  });

  it("applies path-scoped ask rules to Rush write_file calls", async () => {
    let executed = false;
    let confirmedPath = "";
    const tools = new ToolRegistry();
    tools.register({
      definition: {
        name: "write_file",
        description: "Write file",
        inputSchema: { type: "object", properties: {}, required: ["path", "content"] },
      },
      async execute() {
        executed = true;
        return { ok: true, content: "wrote" };
      },
    });
    tools.setConfirmer(async (request) => {
      confirmedPath = String(request.args.path);
      return false;
    });
    tools.setPermissionRules({ ask: ["Write(src/**)"] });

    const result = await tools.call("write_file", { path: "src/generated.ts", content: "export {};" });

    expect(result.denied).toBe(true);
    expect(executed).toBe(false);
    expect(confirmedPath).toBe("src/generated.ts");
  });

  it("hides and blocks tools disabled by the registry mode filter", async () => {
    let executed = false;
    const tools = new ToolRegistry({
      isToolEnabled: (name) => isToolAvailableInMode("code", name),
    });
    tools.register({
      definition: {
        name: "Agent",
        description: "Spawn subagent",
        inputSchema: { type: "object", properties: {}, required: ["task"] },
      },
      async execute() {
        executed = true;
        return { ok: true, content: "spawned" };
      },
    });
    tools.register({
      definition: {
        name: "read_file",
        description: "Read file",
        inputSchema: { type: "object", properties: {}, required: ["path"] },
      },
      async execute() {
        return { ok: true, content: "file" };
      },
    });

    expect(tools.list().map((tool) => tool.name)).toEqual(["read_file"]);

    const result = await tools.call("Agent", { task: "inspect" });

    expect(result.denied).toBe(true);
    expect(result.content).toContain("Tool unavailable in this mode");
    expect(executed).toBe(false);
  });
});
