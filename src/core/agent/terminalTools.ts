import { invoke } from "@tauri-apps/api/core";
import type { Tool } from "./tools";

export interface TerminalBackend {
  call(command: string, args?: Record<string, unknown>): Promise<string>;
}

const tauriTerminalBackend: TerminalBackend = {
  call(command, args = {}) {
    return invoke<string>(command, args);
  },
};

async function callTerminal(
  backend: TerminalBackend,
  command: string,
  args: Record<string, unknown> = {},
) {
  try {
    const content = await backend.call(command, args);
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

function optionalTimeout(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(250, Math.min(30_000, Math.round(value)));
}

async function executeShellCommand(
  backend: TerminalBackend,
  shell: "bash" | "powershell",
  args: Record<string, unknown>,
) {
  const command = String(args.command ?? "").trim();
  if (!command) return { ok: false, isError: true, content: "Missing command." };
  const timeoutMs = optionalTimeout(args.timeout_ms ?? args.timeoutMs) ?? 3000;
  const started = await callTerminal(backend, "terminal_start", { shell });
  if (!started.ok) return started;
  const sent = await callTerminal(backend, "terminal_send_line", { line: command });
  if (!sent.ok) return sent;
  if (args.run_in_background === true) {
    return {
      ok: true,
      content: [
        started.content,
        `Started command in the persistent ${shell} terminal: ${command}`,
        "Use terminal_read or terminal_wait_for_output to inspect output.",
      ].join("\n"),
    };
  }
  const output = await callTerminal(backend, "terminal_wait_for_output", { timeoutMs });
  return {
    ok: output.ok,
    isError: output.isError,
    content: [`$ ${command}`, output.content].join("\n"),
  };
}

export function createTerminalTools(backend: TerminalBackend = tauriTerminalBackend): Tool[] {
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
      execute: (args) => callTerminal(backend, "terminal_start", { shell: optionalString(args.shell) }),
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
      execute: (args) => callTerminal(backend, "terminal_write", { input: String(args.input ?? "") }),
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
      execute: (args) => callTerminal(backend, "terminal_send_line", { line: String(args.line ?? "") }),
    },
    {
      definition: {
        name: "terminal_read",
        description:
          "Read and clear buffered output from the persistent terminal session. Use after terminal_write to observe command output.",
        inputSchema: { type: "object", properties: {} },
      },
      execute: () => callTerminal(backend, "terminal_read"),
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
        callTerminal(backend, "terminal_wait_for_output", {
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
      execute: () => callTerminal(backend, "terminal_interrupt"),
    },
    {
      definition: {
        name: "terminal_stop",
        description: "Stop the persistent terminal session.",
        inputSchema: { type: "object", properties: {} },
      },
      execute: () => callTerminal(backend, "terminal_stop"),
    },
    {
      definition: {
        name: "Bash",
        description:
          "Claude-compatible shell command tool. Runs one command in the persistent bash terminal and returns the first output captured before timeout_ms.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to run." },
            description: { type: "string", description: "Short human-readable reason for the command." },
            timeout_ms: { type: "number", description: "Maximum wait for output, capped at 30000." },
            run_in_background: { type: "boolean", description: "Start the command and return without waiting for output." },
          },
          required: ["command"],
        },
      },
      execute: (args) => executeShellCommand(backend, "bash", args),
    },
    {
      definition: {
        name: "PowerShell",
        description:
          "Claude-compatible PowerShell command tool. Runs one command in the persistent PowerShell terminal and returns the first output captured before timeout_ms.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "PowerShell command to run." },
            description: { type: "string", description: "Short human-readable reason for the command." },
            timeout_ms: { type: "number", description: "Maximum wait for output, capped at 30000." },
            run_in_background: { type: "boolean", description: "Start the command and return without waiting for output." },
          },
          required: ["command"],
        },
      },
      execute: (args) => executeShellCommand(backend, "powershell", args),
    },
  ];
}
