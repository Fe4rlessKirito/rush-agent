import { useMcpStore, type McpServerConfig, type McpTransport } from "../mcpStore";
import { invoke } from "@tauri-apps/api/core";
import type { McpSource } from "./mcpTools";
import type { JSONSchema, Tool } from "./tools";

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.split(/\s+/).filter(Boolean);
  return [];
}

function envMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, val]) => [key.trim(), String(val)])
      .filter(([key]) => key),
  );
}

function transport(value: unknown): McpTransport {
  return text(value).toLowerCase() === "http" ? "http" : "stdio";
}

function formatServer(server: McpServerConfig): string {
  const status = useMcpStore.getState().statuses[server.id] ?? "disconnected";
  const error = useMcpStore.getState().errors[server.id];
  return [
    `${server.id} [${status}] ${server.label}`,
    `Transport: ${server.transport}`,
    server.command ? `Command: ${server.command}${server.args?.length ? ` ${server.args.join(" ")}` : ""}` : "",
    server.url ? `URL: ${server.url}` : "",
    `Enabled: ${server.enabled}`,
    error ? `Error: ${error}` : "",
  ].filter(Boolean).join("\n");
}

function toolInputSchema(schema: unknown): JSONSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const candidate = schema as Partial<JSONSchema>;
  if (candidate.type !== "object" || !candidate.properties || typeof candidate.properties !== "object") {
    return { type: "object", properties: {} };
  }
  return {
    type: "object",
    properties: candidate.properties,
    required: Array.isArray(candidate.required) ? candidate.required.map(String) : undefined,
  };
}

interface McpProbeResource {
  uri: string;
  name?: string;
  description?: string;
  mime_type?: string;
  text?: string;
}

interface McpProbeTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

interface McpProbeResult {
  resources: McpProbeResource[];
  tools: McpProbeTool[];
  stderr: string;
}

interface McpToolCallResult {
  content: string;
  is_error: boolean;
  raw: unknown;
  stderr: string;
}

export interface McpProbeBackend {
  probeStdio(server: McpServerConfig, timeoutMs?: number): Promise<McpProbeResult>;
  callToolStdio(server: McpServerConfig, toolName: string, args: unknown, timeoutMs?: number): Promise<McpToolCallResult>;
  startStdioSession?(server: McpServerConfig, timeoutMs?: number): Promise<McpProbeResult>;
  callToolSession?(serverId: string, toolName: string, args: unknown, timeoutMs?: number): Promise<McpToolCallResult>;
  stopSession?(serverId: string): Promise<{ id: string; stderr: string }>;
}

const tauriMcpProbeBackend: McpProbeBackend = {
  probeStdio(server, timeoutMs) {
    return invoke<McpProbeResult>("mcp_probe_stdio", {
      command: server.command,
      args: server.args ?? [],
      env: server.env ?? {},
      timeoutMs,
    });
  },
  callToolStdio(server, toolName, args, timeoutMs) {
    return invoke<McpToolCallResult>("mcp_call_tool_stdio", {
      command: server.command,
      args: server.args ?? [],
      env: server.env ?? {},
      toolName,
      arguments: args ?? {},
      timeoutMs,
    });
  },
  startStdioSession(server, timeoutMs) {
    return invoke<McpProbeResult>("mcp_start_stdio_session", {
      id: server.id,
      command: server.command,
      args: server.args ?? [],
      env: server.env ?? {},
      timeoutMs,
    });
  },
  callToolSession(serverId, toolName, args, timeoutMs) {
    return invoke<McpToolCallResult>("mcp_call_tool_session", {
      id: serverId,
      toolName,
      arguments: args ?? {},
      timeoutMs,
    });
  },
  stopSession(serverId) {
    return invoke<{ id: string; stderr: string }>("mcp_stop_session", { id: serverId });
  },
};

export const mcpRuntimeSource: McpSource = {
  snapshot() {
    const state = useMcpStore.getState();
    const enabled = state.servers.filter((server) => server.enabled);
    const connected = enabled.some((server) => state.statuses[server.id] === "connected") ||
      state.resources.length > 0 ||
      state.deferredTools.length > 0;
    return {
      connected,
      servers: enabled.map((server) => ({
        id: server.id,
        label: server.label,
        status: state.statuses[server.id] ?? "disconnected",
        error: state.errors[server.id],
      })),
      resources: state.resources.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
        text: resource.text,
      })),
      deferredTools: state.deferredTools.map((tool) =>
        tool.description ? `${tool.name} - ${tool.description}` : tool.name,
      ),
    };
  },
};

export function createMcpConfigTools(backend: McpProbeBackend = tauriMcpProbeBackend): Tool[] {
  return [
    {
      definition: {
        name: "McpServerList",
        description: "List configured Rush MCP servers and their current runtime status.",
        inputSchema: { type: "object", properties: {} },
      },
      async execute() {
        const servers = useMcpStore.getState().servers;
        return { ok: true, content: servers.length ? servers.map(formatServer).join("\n\n") : "No MCP servers configured." };
      },
    },
    {
      definition: {
        name: "McpServerConfigure",
        description:
          "Add or update a Rush MCP server definition. This stores config only; full transport startup is handled by the MCP runtime.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable server id." },
            label: { type: "string", description: "Human-readable server label." },
            transport: { type: "string", description: "stdio or http." },
            command: { type: "string", description: "Command for stdio servers." },
            args: { type: "array", items: { type: "string" }, description: "Command arguments." },
            url: { type: "string", description: "URL for HTTP/SSE MCP servers." },
            env: { type: "object", description: "Environment variables for stdio servers." },
            enabled: { type: "boolean", description: "Whether the server should be active." },
          },
          required: ["id"],
        },
      },
      async execute(args) {
        const id = text(args.id);
        if (!id) return { ok: false, isError: true, content: "Missing id." };
        const server: McpServerConfig = {
          id,
          label: text(args.label) || id,
          transport: transport(args.transport),
          command: text(args.command) || undefined,
          args: stringList(args.args),
          url: text(args.url) || undefined,
          env: envMap(args.env),
          enabled: args.enabled !== false,
        };
        useMcpStore.getState().upsertServer(server);
        return { ok: true, content: `Configured MCP server:\n${formatServer(server)}` };
      },
    },
    {
      definition: {
        name: "McpServerConnect",
        description:
          "Connect to a configured stdio MCP server long enough to discover its resources and tools, then populate Rush's MCP runtime store.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Configured MCP server id." },
            timeout_ms: { type: "number", description: "Probe timeout, capped by backend." },
          },
          required: ["id"],
        },
      },
      async execute(args) {
        const id = text(args.id);
        if (!id) return { ok: false, isError: true, content: "Missing id." };
        const store = useMcpStore.getState();
        const server = store.servers.find((item) => item.id === id);
        if (!server) return { ok: false, isError: true, content: `Unknown MCP server: ${id}` };
        if (!server.enabled) return { ok: false, isError: true, content: `MCP server is disabled: ${id}` };
        if (server.transport !== "stdio") {
          return { ok: false, isError: true, content: `MCP transport ${server.transport} is not probeable yet.` };
        }
        if (!server.command) return { ok: false, isError: true, content: `MCP server ${id} has no command configured.` };

        store.setStatus(id, "connecting");
        try {
          const timeoutMs = Number(args.timeout_ms ?? 3000) || 3000;
          const result = backend.startStdioSession
            ? await backend.startStdioSession(server, timeoutMs)
            : await backend.probeStdio(server, timeoutMs);
          useMcpStore.getState().setResources(
            id,
            result.resources.map((resource) => ({
              uri: resource.uri,
              name: resource.name,
              description: resource.description,
              mimeType: resource.mime_type,
              text: resource.text,
            })),
          );
          useMcpStore.getState().setDeferredTools(
            id,
            result.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.input_schema,
            })),
          );
          useMcpStore.getState().setStatus(id, "connected");
          return {
            ok: true,
            content: [
              `Connected MCP server: ${id}`,
              `Resources: ${result.resources.length}`,
              `Tools: ${result.tools.length}`,
              result.stderr.trim() ? `Stderr:\n${result.stderr.trim().slice(0, 2000)}` : "",
            ].filter(Boolean).join("\n"),
          };
        } catch (err) {
          useMcpStore.getState().setStatus(id, "error", String(err));
          return { ok: false, isError: true, content: `MCP connect failed for ${id}: ${String(err)}` };
        }
      },
    },
    {
      definition: {
        name: "McpServerDisconnect",
        description:
          "Mark a configured MCP server disconnected and clear its discovered runtime resources and deferred tools.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", description: "Configured MCP server id." } },
          required: ["id"],
        },
      },
      async execute(args) {
        const id = text(args.id);
        if (!id) return { ok: false, isError: true, content: "Missing id." };
        const store = useMcpStore.getState();
        if (!store.servers.some((server) => server.id === id)) {
          return { ok: false, isError: true, content: `Unknown MCP server: ${id}` };
        }
        store.setResources(id, []);
        store.setDeferredTools(id, []);
        if (backend.stopSession) {
          try {
            await backend.stopSession(id);
          } catch {
            // If no process is running, still clear frontend runtime state.
          }
        }
        store.setStatus(id, "disconnected");
        return { ok: true, content: `Disconnected MCP server: ${id}` };
      },
    },
    {
      definition: {
        name: "McpToolCall",
        description:
          "Call a discovered MCP tool through its configured stdio server. If server_id is omitted, Rush resolves it from discovered tools.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "MCP tool name, e.g. mcp__server__tool or native tool name." },
            server_id: { type: "string", description: "Optional configured MCP server id." },
            arguments: { type: "object", description: "Tool arguments object." },
            timeout_ms: { type: "number", description: "Call timeout, capped by backend." },
          },
          required: ["name"],
        },
      },
      async execute(args) {
        const name = text(args.name);
        if (!name) return { ok: false, isError: true, content: "Missing name." };
        const store = useMcpStore.getState();
        const discovered = store.deferredTools.find((tool) => tool.name === name);
        const serverId = text(args.server_id) || discovered?.serverId || "";
        if (!serverId) {
          return { ok: false, isError: true, content: `No MCP server_id provided and tool was not discovered: ${name}` };
        }
        const server = store.servers.find((item) => item.id === serverId);
        if (!server) return { ok: false, isError: true, content: `Unknown MCP server: ${serverId}` };
        if (!server.enabled) return { ok: false, isError: true, content: `MCP server is disabled: ${serverId}` };
        if (server.transport !== "stdio") {
          return { ok: false, isError: true, content: `MCP transport ${server.transport} tool calls are not implemented yet.` };
        }
        if (!server.command) return { ok: false, isError: true, content: `MCP server ${serverId} has no command configured.` };
        try {
          const toolArgs = args.arguments && typeof args.arguments === "object" ? args.arguments : {};
          const timeoutMs = Number(args.timeout_ms ?? 5000) || 5000;
          const result = backend.callToolSession && store.statuses[serverId] === "connected"
            ? await backend.callToolSession(serverId, name, toolArgs, timeoutMs)
            : await backend.callToolStdio(server, name, toolArgs, timeoutMs);
          return {
            ok: !result.is_error,
            isError: result.is_error,
            content: [
              `MCP tool ${name} on ${serverId}:`,
              result.content || "(no content)",
              result.stderr.trim() ? `\nStderr:\n${result.stderr.trim().slice(0, 2000)}` : "",
            ].filter(Boolean).join("\n"),
          };
        } catch (err) {
          return { ok: false, isError: true, content: `MCP tool call failed for ${name}: ${String(err)}` };
        }
      },
    },
    {
      definition: {
        name: "McpServerRemove",
        description: "Remove a configured Rush MCP server and clear its runtime resources/tools.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", description: "Server id." } },
          required: ["id"],
        },
      },
      async execute(args) {
        const id = text(args.id);
        if (!id) return { ok: false, isError: true, content: "Missing id." };
        useMcpStore.getState().removeServer(id);
        return { ok: true, content: `Removed MCP server: ${id}` };
      },
    },
  ];
}

export function createDynamicMcpTools(backend: McpProbeBackend = tauriMcpProbeBackend): Tool[] {
  const caller = new Map(createMcpConfigTools(backend).map((tool) => [tool.definition.name, tool])).get("McpToolCall");
  if (!caller) return [];

  const state = useMcpStore.getState();
  const connectedServers = new Set(
    state.servers
      .filter((server) => server.enabled && state.statuses[server.id] === "connected")
      .map((server) => server.id),
  );

  return state.deferredTools
    .filter((tool) => connectedServers.has(tool.serverId))
    .map((tool) => ({
      definition: {
        name: tool.name,
        description: tool.description
          ? `MCP tool from ${tool.serverId}: ${tool.description}`
          : `MCP tool from ${tool.serverId}.`,
        inputSchema: toolInputSchema(tool.inputSchema),
      },
      async execute(args) {
        return caller.execute({
          name: tool.name,
          server_id: tool.serverId,
          arguments: args,
        });
      },
    }));
}
