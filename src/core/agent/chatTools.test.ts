import { describe, expect, it } from "vitest";
import { createChatTools } from "./chatTools";
import { ToolRegistry } from "./tools";
import { isToolAvailableInMode } from "./toolModes";
import { runAgent } from "./agentLoop";
import type { BrainMemory, MemoryKind } from "../brainStore";
import type { Conversation } from "../store";
import type { ResearchRun } from "../researchStore";
import type { ChatChunk, ChatRequest, Provider, ProviderConfig } from "../providers/types";

function registry() {
  const memories: BrainMemory[] = [
    { id: "mem_1", kind: "preference", text: "User prefers concise answers", createdAt: 2 },
    { id: "mem_2", kind: "fact", text: "Project is called Rush", createdAt: 1 },
  ];
  const conversations: Conversation[] = [
    {
      id: "chat_1",
      mode: "plain",
      title: "Quantum notes",
      createdAt: 3,
      lines: [
        { role: "user", text: "Explain quantum physics" },
        { role: "agent", text: "Quantum physics studies small-scale systems." },
      ],
    },
  ];
  const runs: ResearchRun[] = [
    {
      id: "research_1",
      title: "Search providers",
      prompt: "Compare DuckDuckGo and SearXNG",
      status: "completed",
      settings: { rounds: "1", format: "brief", engine: "duckduckgo", endpoint: "", model: "" },
      content: "DuckDuckGo and SearXNG are free search options.",
      sources: [],
      createdAt: 1,
      updatedAt: 4,
    },
  ];
  const added: Array<{ text: string; kind: MemoryKind }> = [];
  const tools = createChatTools({
    getMemories: () => memories,
    addMemory: (text, kind) => added.push({ text, kind }),
    getConversations: () => conversations,
    getResearchRuns: () => runs,
  });
  return { tools, added };
}

describe("chat app tools", () => {
  it("searches and adds Brain memories", async () => {
    const { tools, added } = registry();
    const search = tools.find((tool) => tool.definition.name === "app_memory_search")!;
    const add = tools.find((tool) => tool.definition.name === "app_memory_add")!;

    await expect(search.execute({ query: "concise" })).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining("User prefers concise answers"),
    });
    await expect(add.execute({ text: "User likes dark UI", kind: "preference" })).resolves.toMatchObject({
      ok: true,
    });
    expect(added).toEqual([{ text: "User likes dark UI", kind: "preference" }]);
  });

  it("searches and reads Library chats and Deep Research runs", async () => {
    const { tools } = registry();
    const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));

    await expect(byName.get("app_library_search")!.execute({ query: "quantum" })).resolves.toMatchObject({
      content: expect.stringContaining("chat_1"),
    });
    await expect(byName.get("app_library_read")!.execute({ id: "chat_1" })).resolves.toMatchObject({
      content: expect.stringContaining("Quantum physics studies"),
    });
    await expect(byName.get("app_research_search")!.execute({ query: "searxng" })).resolves.toMatchObject({
      content: expect.stringContaining("research_1"),
    });
    await expect(byName.get("app_research_read")!.execute({ id: "research_1" })).resolves.toMatchObject({
      content: expect.stringContaining("DuckDuckGo and SearXNG"),
    });
  });

  it("allows only app tools in Chat mode registries", async () => {
    const toolRegistry = new ToolRegistry({
      isToolEnabled: (name) => isToolAvailableInMode("chat", name),
    });
    toolRegistry.registerAll(registry().tools);
    toolRegistry.register({
      definition: {
        name: "read_file",
        description: "Read file",
        inputSchema: { type: "object", properties: {}, required: ["path"] },
      },
      execute: async () => ({ ok: true, content: "file" }),
    });

    expect(toolRegistry.list().map((tool) => tool.name)).toEqual([
      "app_memory_search",
      "app_memory_add",
      "app_library_search",
      "app_library_read",
      "app_research_search",
      "app_research_read",
    ]);
    await expect(toolRegistry.call("read_file", { path: "package.json" })).resolves.toMatchObject({
      denied: true,
      content: expect.stringContaining("Tool unavailable in this mode"),
    });
  });

  it("runs Chat app tools through the agent loop", async () => {
    class ChatToolProvider implements Provider {
      readonly config: ProviderConfig = {
        id: "chat-provider",
        label: "Chat Provider",
        kind: "custom",
        baseUrl: "http://localhost",
        defaultModel: "chat-model",
        supportsNativeTools: true,
        enabled: true,
      };
      readonly requests: ChatRequest[] = [];

      async listModels(): Promise<string[]> {
        return ["chat-model"];
      }

      async *streamChat(req: ChatRequest): AsyncGenerator<ChatChunk> {
        this.requests.push({
          ...req,
          messages: req.messages.map((m) => ({ ...m })),
        });
        if (this.requests.length === 1) {
          yield {
            delta: "",
            done: false,
            toolCall: { id: "call_mem", name: "app_memory_search", argsJson: "{\"query\":\"concise\"}" },
          };
        } else {
          yield { delta: "Found the memory.", done: false };
        }
        yield { delta: "", done: true };
      }
    }

    const toolRegistry = new ToolRegistry({
      isToolEnabled: (name) => isToolAvailableInMode("chat", name),
    });
    toolRegistry.registerAll(registry().tools);
    const provider = new ChatToolProvider();
    const events = [];

    for await (const event of runAgent(
      provider,
      "chat-model",
      toolRegistry,
      [{ role: "user", content: "What do you remember about my style?" }],
    )) {
      events.push(event);
    }

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_call", toolName: "app_memory_search" }),
        expect.objectContaining({
          type: "tool_result",
          toolName: "app_memory_search",
          toolResult: expect.stringContaining("User prefers concise answers"),
        }),
        expect.objectContaining({ type: "text", text: "Found the memory." }),
      ]),
    );
    expect(provider.requests[0].tools?.map((tool) => tool.name)).toEqual([
      "app_memory_search",
      "app_memory_add",
      "app_library_search",
      "app_library_read",
      "app_research_search",
      "app_research_read",
    ]);
    expect(provider.requests[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          toolCallId: "call_mem",
          content: expect.stringContaining("User prefers concise answers"),
        }),
      ]),
    );
  });
});
