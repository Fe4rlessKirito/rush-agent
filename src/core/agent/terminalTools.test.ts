import { describe, expect, it } from "vitest";
import { createTerminalTools, type TerminalBackend } from "./terminalTools";

function mockBackend(): { backend: TerminalBackend; calls: Array<{ command: string; args?: Record<string, unknown> }> } {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  return {
    calls,
    backend: {
      async call(command, args) {
        calls.push({ command, args });
        if (command === "terminal_wait_for_output") return "command output";
        return "ok";
      },
    },
  };
}

describe("Claude-compatible shell tools", () => {
  it("runs Bash through the persistent terminal backend", async () => {
    const { backend, calls } = mockBackend();
    const tools = new Map(createTerminalTools(backend).map((tool) => [tool.definition.name, tool]));

    const result = await tools.get("Bash")!.execute({ command: "npm test", timeout_ms: 1000 });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("$ npm test");
    expect(result.content).toContain("command output");
    expect(calls).toEqual([
      { command: "terminal_start", args: { shell: "bash" } },
      { command: "terminal_send_line", args: { line: "npm test" } },
      { command: "terminal_wait_for_output", args: { timeoutMs: 1000 } },
    ]);
  });

  it("runs PowerShell through the persistent terminal backend", async () => {
    const { backend, calls } = mockBackend();
    const tools = new Map(createTerminalTools(backend).map((tool) => [tool.definition.name, tool]));

    await tools.get("PowerShell")!.execute({ command: "Get-ChildItem", timeout_ms: 500 });

    expect(calls[0]).toEqual({ command: "terminal_start", args: { shell: "powershell" } });
    expect(calls[1]).toEqual({ command: "terminal_send_line", args: { line: "Get-ChildItem" } });
  });

  it("returns immediately for background shell commands", async () => {
    const { backend, calls } = mockBackend();
    const tools = new Map(createTerminalTools(backend).map((tool) => [tool.definition.name, tool]));

    const result = await tools.get("Bash")!.execute({
      command: "npm run dev",
      run_in_background: true,
    });

    expect(result.content).toContain("Started command");
    expect(calls.map((call) => call.command)).toEqual(["terminal_start", "terminal_send_line"]);
  });
});
