import type { Tool } from "./tools";

export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  text?: string;
}

export interface McpServerSnapshot {
  connected: boolean;
  servers?: Array<{ id: string; label: string; status: string; error?: string }>;
  resources: McpResource[];
  deferredTools: string[];
}

export interface McpSource {
  snapshot(): McpServerSnapshot;
}

const emptyMcpSource: McpSource = {
  snapshot() {
    return { connected: false, resources: [], deferredTools: [] };
  },
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function formatResource(resource: McpResource): string {
  return [
    resource.uri,
    resource.name ? `Name: ${resource.name}` : "",
    resource.description ? `Description: ${resource.description}` : "",
    resource.mimeType ? `MIME: ${resource.mimeType}` : "",
  ].filter(Boolean).join("\n");
}

function formatServers(snapshot: McpServerSnapshot): string {
  if (!snapshot.servers?.length) return "";
  return snapshot.servers
    .map((server) => `${server.id} [${server.status}] ${server.label}${server.error ? ` - ${server.error}` : ""}`)
    .join("\n");
}

export function createMcpTools(source: McpSource = emptyMcpSource): Tool[] {
  return [
    {
      definition: {
        name: "ListMcpResourcesTool",
        description: "List resources exposed by connected MCP servers.",
        inputSchema: { type: "object", properties: {} },
      },
      async execute() {
        const snapshot = source.snapshot();
        if (!snapshot.connected) {
          const servers = formatServers(snapshot);
          return {
            ok: true,
            content: servers
              ? `No MCP servers are connected yet.\nConfigured servers:\n${servers}`
              : "No MCP servers are connected yet. Configure MCP servers before using MCP resources.",
          };
        }
        return {
          ok: true,
          content: snapshot.resources.length
            ? snapshot.resources.map(formatResource).join("\n\n")
            : "Connected MCP servers exposed no resources.",
        };
      },
    },
    {
      definition: {
        name: "ReadMcpResourceTool",
        description: "Read one MCP resource by URI from connected MCP servers.",
        inputSchema: {
          type: "object",
          properties: {
            uri: { type: "string", description: "MCP resource URI." },
          },
          required: ["uri"],
        },
      },
      async execute(args) {
        const uri = text(args.uri);
        if (!uri) return { ok: false, isError: true, content: "Missing uri." };
        const snapshot = source.snapshot();
        if (!snapshot.connected) {
          return { ok: false, isError: true, content: "No MCP servers are connected yet." };
        }
        const resource = snapshot.resources.find((item) => item.uri === uri);
        if (!resource) return { ok: false, isError: true, content: `Unknown MCP resource: ${uri}` };
        return { ok: true, content: resource.text ?? formatResource(resource) };
      },
    },
    {
      definition: {
        name: "ToolSearch",
        description: "Search deferred MCP tools by name or description.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Tool search query." },
          },
          required: ["query"],
        },
      },
      async execute(args) {
        const query = text(args.query).toLowerCase();
        const snapshot = source.snapshot();
        if (!snapshot.connected) {
          return { ok: true, content: "No MCP servers are connected yet, so there are no deferred tools to load." };
        }
        const matches = snapshot.deferredTools.filter((tool) => tool.toLowerCase().includes(query));
        return { ok: true, content: matches.length ? matches.join("\n") : "No deferred MCP tools matched." };
      },
    },
    {
      definition: {
        name: "WaitForMcpServers",
        description: "Check whether MCP servers are connected and ready.",
        inputSchema: {
          type: "object",
          properties: {
            servers: { type: "array", items: { type: "string" }, description: "Optional server names to wait for." },
          },
        },
      },
      async execute() {
        const snapshot = source.snapshot();
        return {
          ok: true,
          content: snapshot.connected
            ? `MCP servers are connected.${formatServers(snapshot) ? `\n${formatServers(snapshot)}` : ""}`
            : formatServers(snapshot)
              ? `MCP servers are configured but not connected yet:\n${formatServers(snapshot)}`
              : "No MCP servers are connected yet. Configure MCP servers before waiting for them.",
        };
      },
    },
  ];
}
