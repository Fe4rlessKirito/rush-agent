import { beforeEach, describe, expect, it } from "vitest";
import { useMcpStore } from "../mcpStore";
import { ToolRegistry } from "./tools";
import { createDynamicMcpTools, createMcpConfigTools, mcpRuntimeSource, type McpProbeBackend } from "./mcpRuntime";

describe("mcp runtime source", () => {
  beforeEach(() => {
    useMcpStore.setState({
      servers: [],
      statuses: {},
      errors: {},
      resources: [],
      deferredTools: [],
    });
  });

  it("exposes configured server statuses and runtime resources", () => {
    useMcpStore.getState().upsertServer({ id: "docs", label: "Docs", transport: "stdio", enabled: true });
    useMcpStore.getState().setStatus("docs", "connected");
    useMcpStore.getState().setResources("docs", [{ uri: "mcp://docs/readme", text: "Readme text" }]);
    useMcpStore.getState().setDeferredTools("docs", [{ name: "mcp__docs__search", description: "Search docs" }]);

    const snapshot = mcpRuntimeSource.snapshot();
    expect(snapshot.connected).toBe(true);
    expect(snapshot.servers?.[0]).toMatchObject({ id: "docs", status: "connected" });
    expect(snapshot.resources[0].uri).toBe("mcp://docs/readme");
    expect(snapshot.deferredTools[0]).toContain("mcp__docs__search");
  });
});

describe("mcp config tools", () => {
  beforeEach(() => {
    useMcpStore.setState({
      servers: [],
      statuses: {},
      errors: {},
      resources: [],
      deferredTools: [],
    });
  });

  it("configures, lists, and removes server definitions", async () => {
    const tools = new Map(createMcpConfigTools().map((tool) => [tool.definition.name, tool]));

    const configured = await tools.get("McpServerConfigure")!.execute({
      id: "Docs",
      label: "Docs MCP",
      command: "node",
      args: ["server.js"],
    });
    expect(configured.ok).toBe(true);
    expect(useMcpStore.getState().servers[0].id).toBe("docs");

    const listed = await tools.get("McpServerList")!.execute({});
    expect(listed.content).toContain("Docs MCP");

    await tools.get("McpServerRemove")!.execute({ id: "docs" });
    expect(useMcpStore.getState().servers).toHaveLength(0);
  });

  it("connects and disconnects stdio server discovery results", async () => {
    const backend: McpProbeBackend = {
      async probeStdio() {
        return {
          resources: [{ uri: "mcp://docs/readme", name: "Readme", mime_type: "text/markdown", text: "Readme" }],
          tools: [{
            name: "mcp__docs__search",
            description: "Search docs",
            input_schema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          }],
          stderr: "",
        };
      },
      async callToolStdio() {
        return {
          content: "searched docs",
          is_error: false,
          raw: {},
          stderr: "",
        };
      },
      async startStdioSession() {
        return {
          resources: [{ uri: "mcp://docs/readme", name: "Readme", mime_type: "text/markdown", text: "Readme" }],
          tools: [{
            name: "mcp__docs__search",
            description: "Search docs",
            input_schema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          }],
          stderr: "",
        };
      },
      async callToolSession() {
        return {
          content: "searched docs",
          is_error: false,
          raw: {},
          stderr: "",
        };
      },
      async stopSession() {
        return { id: "docs", stderr: "" };
      },
    };
    const tools = new Map(createMcpConfigTools(backend).map((tool) => [tool.definition.name, tool]));
    await tools.get("McpServerConfigure")!.execute({
      id: "docs",
      label: "Docs",
      command: "node",
      args: ["server.js"],
    });

    const connected = await tools.get("McpServerConnect")!.execute({ id: "docs" });
    expect(connected.ok).toBe(true);
    expect(useMcpStore.getState().statuses.docs).toBe("connected");
    expect(useMcpStore.getState().resources[0].uri).toBe("mcp://docs/readme");
    expect(useMcpStore.getState().deferredTools[0].name).toBe("mcp__docs__search");
    expect(useMcpStore.getState().deferredTools[0].inputSchema?.required).toEqual(["query"]);

    const disconnected = await tools.get("McpServerDisconnect")!.execute({ id: "docs" });
    expect(disconnected.ok).toBe(true);
    expect(useMcpStore.getState().statuses.docs).toBe("disconnected");
    expect(useMcpStore.getState().resources).toHaveLength(0);
  });

  it("calls a discovered stdio MCP tool", async () => {
    const backend: McpProbeBackend = {
      async probeStdio() {
        return { resources: [], tools: [], stderr: "" };
      },
      async callToolStdio(server, toolName, args) {
        throw new Error(`unexpected one-shot call ${server.id}:${toolName}:${JSON.stringify(args)}`);
      },
      async startStdioSession() {
        return { resources: [], tools: [], stderr: "" };
      },
      async callToolSession(serverId, toolName, args) {
        expect(serverId).toBe("docs");
        expect(toolName).toBe("mcp__docs__search");
        expect(args).toEqual({ query: "rush" });
        return {
          content: "result from mcp",
          is_error: false,
          raw: {},
          stderr: "",
        };
      },
    };
    const tools = new Map(createMcpConfigTools(backend).map((tool) => [tool.definition.name, tool]));
    await tools.get("McpServerConfigure")!.execute({
      id: "docs",
      label: "Docs",
      command: "node",
      args: ["server.js"],
    });
    useMcpStore.getState().setDeferredTools("docs", [{ name: "mcp__docs__search" }]);
    useMcpStore.getState().setStatus("docs", "connected");

    const called = await tools.get("McpToolCall")!.execute({
      name: "mcp__docs__search",
      arguments: { query: "rush" },
    });

    expect(called.ok).toBe(true);
    expect(called.content).toContain("result from mcp");
  });

  it("registers connected MCP tools as dynamic first-class tools", async () => {
    const backend: McpProbeBackend = {
      async probeStdio() {
        return { resources: [], tools: [], stderr: "" };
      },
      async callToolStdio() {
        throw new Error("unexpected one-shot call");
      },
      async callToolSession(serverId, toolName, args) {
        expect(serverId).toBe("docs");
        expect(toolName).toBe("mcp__docs__search");
        expect(args).toEqual({ query: "rush" });
        return { content: "dynamic mcp result", is_error: false, raw: {}, stderr: "" };
      },
    };

    useMcpStore.getState().upsertServer({
      id: "docs",
      label: "Docs",
      transport: "stdio",
      enabled: true,
      command: "node",
    });
    useMcpStore.getState().setStatus("docs", "connected");
    useMcpStore.getState().setDeferredTools("docs", [{
      name: "mcp__docs__search",
      description: "Search docs",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }]);

    const registry = new ToolRegistry();
    registry.setConfirmer(async () => true);
    registry.registerDynamic(() => createDynamicMcpTools(backend));

    const listed = registry.list().find((tool) => tool.name === "mcp__docs__search");
    expect(listed?.description).toContain("Search docs");
    expect(listed?.inputSchema.required).toEqual(["query"]);

    const called = await registry.call("mcp__docs__search", { query: "rush" });
    expect(called.ok).toBe(true);
    expect(called.content).toContain("dynamic mcp result");
  });
});
