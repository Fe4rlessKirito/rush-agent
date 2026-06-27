import { invoke } from "@tauri-apps/api/core";
import type { Tool } from "./tools";

async function callTerminal(command: string, args: Record<string, unknown> = {}) {
  try {
    const content = await invoke<string>(command, args);
    return { ok: true, content: content || "Done." };
  } catch (err) {
    return { ok: false, isError: true, content: String(err) };
  }
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function createTerminalTools(): Tool[] {
  return [
    {
      definition: {
        name: "terminal_start",
        description:
          "Start a persistent terminal session in the active workspace. Supported shells: powershell, pwsh, cmd, sh, bash.",
        inputSchema: {
          type: "object",
          properties: {
            shell: { type: "string", description: "Optional shell name." },
          },
        },
      },
      execute: (args) => callTerminal("terminal_start", { shell: optionalString(args.shell) }),
    },
    {
      definition: {
        name: "terminal_write",
        description:
          "Write input to the persistent terminal session. Include a trailing newline to submit a command or answer a prompt.",
        inputSchema: {
          type: "object",
          properties: {
            input: { type: "string", description: "Text to send to terminal stdin." },
          },
          required: ["input"],
        },
      },
      execute: (args) => callTerminal("terminal_write", { input: String(args.input ?? "") }),
    },
    {
      definition: {
        name: "terminal_send_line",
        description:
          "Send one line of input to the persistent terminal session, automatically appending Enter. Use this to answer prompts such as Y/n.",
        inputSchema: {
          type: "object",
          properties: {
            line: { type: "string", description: "Line to send without the trailing newline." },
          },
          required: ["line"],
        },
      },
      execute: (args) => callTerminal("terminal_send_line", { line: String(args.line ?? "") }),
    },
    {
      definition: {
        name: "terminal_read",
        description:
          "Read and clear buffered output from the persistent terminal session. Use after terminal_write to observe command output.",
        inputSchema: { type: "object", properties: {} },
      },
      execute: () => callTerminal("terminal_read"),
    },
    {
      definition: {
        name: "terminal_wait_for_output",
        description:
          "Wait briefly for new terminal output, then read and clear it. Use after sending input to observe prompts or command progress.",
        inputSchema: {
          type: "object",
          properties: {
            timeoutMs: { type: "number", description: "Maximum wait time in milliseconds, capped at 30000." },
          },
        },
      },
      execute: (args) =>
        callTerminal("terminal_wait_for_output", {
          timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
        }),
    },
    {
      definition: {
        name: "terminal_interrupt",
        description:
          "Send Ctrl+C to the persistent terminal session to interrupt the foreground command.",
        inputSchema: { type: "object", properties: {} },
      },
      execute: () => callTerminal("terminal_interrupt"),
    },
    {
      definition: {
        name: "terminal_stop",
        description: "Stop the persistent terminal session.",
        inputSchema: { type: "object", properties: {} },
      },
      execute: () => callTerminal("terminal_stop"),
    },
  ];
}
