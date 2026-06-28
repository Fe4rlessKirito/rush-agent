import type { McpServerConfig } from "./mcpStore";

export type McpPresetFieldKind = "text" | "password" | "path";

export interface McpPresetField {
  key: string;
  label: string;
  kind: McpPresetFieldKind;
  placeholder?: string;
  required?: boolean;
}

export interface McpPreset {
  id: string;
  label: string;
  category: string;
  description: string;
  risk: "read" | "write" | "control";
  requirements: string[];
  fields: McpPresetField[];
  buildConfig(values: Record<string, string>): McpServerConfig;
}

function clean(value: string | undefined): string {
  return String(value ?? "").trim();
}

function valueOrPlaceholder(value: string | undefined, placeholder: string): string {
  const text = clean(value);
  return text || placeholder;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: "roblox-studio",
    label: "Roblox Studio",
    category: "Game development",
    description: "Connect to the built-in Studio MCP server for reading scripts, editing Luau, inspecting the data model, and controlling play mode.",
    risk: "control",
    requirements: [
      "Latest Roblox Studio installed.",
      "In Studio: Assistant > Manage MCP Servers > Enable Studio as MCP server.",
      "An experience must be open before connecting.",
    ],
    fields: [],
    buildConfig() {
      return {
        id: "roblox-studio",
        label: "Roblox Studio",
        transport: "stdio",
        enabled: true,
        command: "cmd.exe",
        args: ["/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"],
      };
    },
  },
  {
    id: "obsidian-rest",
    label: "Obsidian REST",
    category: "Knowledge base",
    description: "Connect through the Obsidian Local REST API plugin using the mcp-obsidian Python server.",
    risk: "write",
    requirements: [
      "Obsidian is running with the Local REST API community plugin enabled.",
      "uv/uvx is installed and available on PATH.",
      "Use a vault backup or Git before enabling write tools.",
    ],
    fields: [
      { key: "apiKey", label: "REST API key", kind: "password", required: true },
      { key: "host", label: "Host", kind: "text", placeholder: "127.0.0.1" },
      { key: "port", label: "Port", kind: "text", placeholder: "27124" },
    ],
    buildConfig(values) {
      return {
        id: "obsidian-rest",
        label: "Obsidian REST",
        transport: "stdio",
        enabled: true,
        command: "uvx",
        args: ["mcp-obsidian"],
        env: {
          OBSIDIAN_API_KEY: clean(values.apiKey),
          OBSIDIAN_HOST: valueOrPlaceholder(values.host, "127.0.0.1"),
          OBSIDIAN_PORT: valueOrPlaceholder(values.port, "27124"),
        },
      };
    },
  },
  {
    id: "obsidian-vault",
    label: "Obsidian Vault",
    category: "Knowledge base",
    description: "Connect directly to one vault folder using the Node obsidian-mcp server.",
    risk: "write",
    requirements: [
      "Node.js 20+ is installed.",
      "Provide the absolute path to the intended vault only.",
      "Use a vault backup or Git before enabling write tools.",
    ],
    fields: [
      { key: "vaultPath", label: "Vault path", kind: "path", placeholder: "C:\\Users\\marko\\Documents\\Obsidian Vault", required: true },
    ],
    buildConfig(values) {
      return {
        id: "obsidian-vault",
        label: "Obsidian Vault",
        transport: "stdio",
        enabled: true,
        command: "npx",
        args: ["-y", "obsidian-mcp", clean(values.vaultPath)],
      };
    },
  },
  {
    id: "playwright",
    label: "Playwright",
    category: "Browser automation",
    description: "Connect a browser automation MCP server for page inspection and interaction.",
    risk: "control",
    requirements: [
      "Node.js is installed.",
      "The first connection may download or install the Playwright MCP package through npx.",
    ],
    fields: [],
    buildConfig() {
      return {
        id: "playwright",
        label: "Playwright",
        transport: "stdio",
        enabled: true,
        command: "npx",
        args: ["-y", "@playwright/mcp@latest"],
      };
    },
  },
  {
    id: "filesystem",
    label: "Filesystem",
    category: "Local files",
    description: "Expose one local folder through the standard filesystem MCP server.",
    risk: "write",
    requirements: [
      "Node.js is installed.",
      "Use the narrowest folder path possible.",
    ],
    fields: [
      { key: "rootPath", label: "Root folder", kind: "path", placeholder: "C:\\Users\\marko\\Documents\\Project", required: true },
    ],
    buildConfig(values) {
      return {
        id: "filesystem",
        label: "Filesystem",
        transport: "stdio",
        enabled: true,
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", clean(values.rootPath)],
      };
    },
  },
];

export function getMcpPreset(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((preset) => preset.id === id);
}

export function missingPresetFields(preset: McpPreset, values: Record<string, string>): McpPresetField[] {
  return preset.fields.filter((field) => field.required && !clean(values[field.key]));
}
