import { describe, expect, it } from "vitest";
import { createFlowTools, FlowTaskStore } from "./flowTools";
import { ToolRegistry } from "./tools";
import type { ChatChunk, ChatRequest, Provider, ProviderConfig } from "../providers/types";

class StaticProvider implements Provider {
  readonly config: ProviderConfig = {
    id: "test",
    label: "Test",
    kind: "custom",
    baseUrl: "http://localhost",
    defaultModel: "test-model",
    enabled: true,
  };
  readonly requests: ChatRequest[] = [];

  async listModels(): Promise<string[]> {
    return ["test-model"];
  }

  async *streamChat(req: ChatRequest): AsyncGenerator<ChatChunk> {
    this.requests.push(req);
    yield { delta: "subagent answer", done: false };
    yield { delta: "", done: true };
  }
}

function tools(provider = new StaticProvider()) {
  const registry = new ToolRegistry();
  const taskStore = new FlowTaskStore();
  registry.registerAll(createFlowTools({
    getProvider: () => provider,
    getModel: () => "test-model",
    getTools: () => registry,
    taskStore,
    maxAgentTurns: 2,
  }));
  return { registry, provider };
}

describe("Flow task tools", () => {
  it("creates, lists, updates, reads output, and stops tasks", async () => {
    const { registry } = tools();

    const created = await registry.call("TaskCreate", {
      title: "Inspect parser",
      details: "Find fragile parsing code",
    });
    expect(created.ok).toBe(true);
    const id = created.content.match(/task_[a-z0-9]+/)?.[0];
    expect(id).toBeTruthy();

    const list = await registry.call("TaskList", {});
    expect(list.content).toContain("Inspect parser");

    const updated = await registry.call("TaskUpdate", {
      id,
      status: "completed",
      output: "Parser looks fine.",
    });
    expect(updated.content).toContain("[completed]");

    const output = await registry.call("TaskOutput", { id });
    expect(output.content).toBe("Parser looks fine.");

    const stopped = await registry.call("TaskStop", { id });
    expect(stopped.content).toContain("[cancelled]");
  });
});

describe("Agent tool", () => {
  it("describes batched Agent calls as Flow worker lanes", () => {
    const { registry } = tools();

    const agent = registry.list().find((tool) => tool.name === "Agent");

    expect(agent?.description).toContain("batch independent Agent calls");
    expect(agent?.description).toContain("worker lane");
  });

  it("runs a bounded subagent and returns its final text", async () => {
    const provider = new StaticProvider();
    const { registry } = tools(provider);

    const result = await registry.call("Agent", { task: "Summarize the codebase", maxTurns: 1 });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Subagent result for: Summarize the codebase");
    expect(result.content).toContain("subagent answer");
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].messages.some((message) => String(message.content).includes("Rush Flow subagent"))).toBe(true);
  });
});
