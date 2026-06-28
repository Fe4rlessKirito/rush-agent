import { describe, expect, it } from "vitest";
import { createMcpTools, type McpSource } from "./mcpTools";

const connected: McpSource = {
  snapshot: () => ({
    connected: true,
    resources: [
      {
        uri: "mcp://docs/readme",
        name: "Readme",
        description: "Project readme",
        mimeType: "text/markdown",
        text: "# Readme\nBody",
      },
    ],
    deferredTools: ["mcp__docs__search", "mcp__github__issues"],
  }),
};

describe("mcp skeleton tools", () => {
  it("reports no connected servers clearly", async () => {
    const tools = new Map(createMcpTools().map((tool) => [tool.definition.name, tool]));

    const result = await tools.get("ListMcpResourcesTool")!.execute({});

    expect(result.ok).toBe(true);
    expect(result.content).toContain("No MCP servers are connected");
  });

  it("lists and reads connected resources", async () => {
    const tools = new Map(createMcpTools(connected).map((tool) => [tool.definition.name, tool]));

    const listed = await tools.get("ListMcpResourcesTool")!.execute({});
    expect(listed.content).toContain("mcp://docs/readme");

    const read = await tools.get("ReadMcpResourceTool")!.execute({ uri: "mcp://docs/readme" });
    expect(read.content).toContain("# Readme");
  });

  it("searches deferred MCP tools", async () => {
    const tools = new Map(createMcpTools(connected).map((tool) => [tool.definition.name, tool]));

    const result = await tools.get("ToolSearch")!.execute({ query: "github" });

    expect(result.content).toContain("mcp__github__issues");
    expect(result.content).not.toContain("mcp__docs__search");
  });
});
