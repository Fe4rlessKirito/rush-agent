import { beforeEach, describe, expect, it } from "vitest";
import { useMcpStore } from "./mcpStore";

describe("mcpStore", () => {
  beforeEach(() => {
    useMcpStore.setState({
      servers: [],
      statuses: {},
      errors: {},
      resources: [],
      deferredTools: [],
    });
  });

  it("normalizes and upserts server configs", () => {
    useMcpStore.getState().upsertServer({
      id: "Docs Server",
      label: "Docs",
      transport: "stdio",
      enabled: true,
      command: "node",
      args: ["server.js"],
    });

    expect(useMcpStore.getState().servers[0]).toMatchObject({
      id: "docs-server",
      label: "Docs",
      command: "node",
      args: ["server.js"],
    });
  });

  it("stores runtime resources and clears them on remove", () => {
    useMcpStore.getState().upsertServer({ id: "docs", label: "Docs", transport: "stdio", enabled: true });
    useMcpStore.getState().setResources("docs", [{ uri: "mcp://docs/readme", text: "Readme" }]);
    useMcpStore.getState().setDeferredTools("docs", [{ name: "mcp__docs__search" }]);

    expect(useMcpStore.getState().resources).toHaveLength(1);
    expect(useMcpStore.getState().deferredTools).toHaveLength(1);

    useMcpStore.getState().removeServer("docs");
    expect(useMcpStore.getState().resources).toHaveLength(0);
    expect(useMcpStore.getState().deferredTools).toHaveLength(0);
  });

  it("resets runtime state without removing configured servers", () => {
    useMcpStore.getState().upsertServer({ id: "docs", label: "Docs", transport: "stdio", enabled: true });
    useMcpStore.getState().setStatus("docs", "connected");
    useMcpStore.getState().setResources("docs", [{ uri: "mcp://docs/readme", text: "Readme" }]);
    useMcpStore.getState().setDeferredTools("docs", [{ name: "mcp__docs__search" }]);

    useMcpStore.getState().resetRuntime();

    expect(useMcpStore.getState().servers).toHaveLength(1);
    expect(useMcpStore.getState().statuses).toEqual({});
    expect(useMcpStore.getState().errors).toEqual({});
    expect(useMcpStore.getState().resources).toEqual([]);
    expect(useMcpStore.getState().deferredTools).toEqual([]);
  });
});
