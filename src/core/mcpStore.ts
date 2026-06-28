import { create } from "zustand";
import { persist } from "zustand/middleware";

export type McpTransport = "stdio" | "http";
export type McpServerStatus = "disconnected" | "connecting" | "connected" | "error";

export interface McpServerConfig {
  id: string;
  label: string;
  transport: McpTransport;
  enabled: boolean;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface McpRuntimeResource {
  serverId: string;
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  text?: string;
}

export interface McpRuntimeTool {
  serverId: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpState {
  servers: McpServerConfig[];
  statuses: Record<string, McpServerStatus>;
  errors: Record<string, string>;
  resources: McpRuntimeResource[];
  deferredTools: McpRuntimeTool[];
  upsertServer: (server: McpServerConfig) => void;
  removeServer: (id: string) => void;
  setStatus: (id: string, status: McpServerStatus, error?: string) => void;
  setResources: (serverId: string, resources: Omit<McpRuntimeResource, "serverId">[]) => void;
  setDeferredTools: (serverId: string, tools: Omit<McpRuntimeTool, "serverId">[]) => void;
  resetRuntime: () => void;
}

function cleanId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeServer(server: McpServerConfig): McpServerConfig {
  const id = cleanId(server.id || server.label || server.command || server.url || "mcp-server");
  const transport = server.transport === "http" ? "http" : "stdio";
  return {
    ...server,
    id,
    label: server.label.trim() || id,
    transport,
    enabled: server.enabled !== false,
    command: server.command?.trim() || undefined,
    args: Array.isArray(server.args) ? server.args.map(String).filter(Boolean) : [],
    url: server.url?.trim() || undefined,
    env: server.env ?? {},
  };
}

export const useMcpStore = create<McpState>()(
  persist(
    (set) => ({
      servers: [],
      statuses: {},
      errors: {},
      resources: [],
      deferredTools: [],

      upsertServer: (server) =>
        set((state) => {
          const normalized = normalizeServer(server);
          const idx = state.servers.findIndex((item) => item.id === normalized.id);
          const servers = state.servers.slice();
          if (idx === -1) servers.push(normalized);
          else servers[idx] = normalized;
          return { servers };
        }),

      removeServer: (id) =>
        set((state) => ({
          servers: state.servers.filter((server) => server.id !== id),
          resources: state.resources.filter((resource) => resource.serverId !== id),
          deferredTools: state.deferredTools.filter((tool) => tool.serverId !== id),
          statuses: Object.fromEntries(Object.entries(state.statuses).filter(([key]) => key !== id)),
          errors: Object.fromEntries(Object.entries(state.errors).filter(([key]) => key !== id)),
        })),

      setStatus: (id, status, error) =>
        set((state) => ({
          statuses: { ...state.statuses, [id]: status },
          errors: {
            ...state.errors,
            ...(error ? { [id]: error } : Object.fromEntries(Object.entries(state.errors).filter(([key]) => key !== id))),
          },
        })),

      setResources: (serverId, resources) =>
        set((state) => ({
          resources: [
            ...state.resources.filter((resource) => resource.serverId !== serverId),
            ...resources.map((resource) => ({ ...resource, serverId })),
          ],
        })),

      setDeferredTools: (serverId, tools) =>
        set((state) => ({
          deferredTools: [
            ...state.deferredTools.filter((tool) => tool.serverId !== serverId),
            ...tools.map((tool) => ({ ...tool, serverId })),
          ],
        })),

      resetRuntime: () => set({ statuses: {}, errors: {}, resources: [], deferredTools: [] }),
    }),
    { name: "rush-mcp" },
  ),
);
