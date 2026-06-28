import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "./anthropicProvider";
import { OpenAIProvider } from "./openaiProvider";

function sseResponse(data = "data: [DONE]\n\n"): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(data));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

async function drain(provider: { streamChat: OpenAIProvider["streamChat"] }) {
  for await (const _chunk of provider.streamChat({
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    thinking: { type: "enabled", budget_tokens: 1024 },
  })) {
    // drain stream
  }
}

async function collect(provider: { streamChat: OpenAIProvider["streamChat"] }, data = "data: [DONE]\n\n") {
  const fetchMock = vi.fn().mockResolvedValue(sseResponse(data));
  vi.stubGlobal("fetch", fetchMock);
  const chunks = [];
  for await (const chunk of provider.streamChat({
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        name: "read_file",
        description: "Read a file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
  })) {
    chunks.push(chunk);
  }
  return { chunks, fetchMock };
}

describe("provider payloads", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not send WMan thinking options to standard OpenAI providers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse());
    vi.stubGlobal("fetch", fetchMock);

    await drain(
      new OpenAIProvider({
        id: "openai",
        label: "OpenAI",
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "test-model",
        enabled: true,
      }),
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.thinking).toBeUndefined();
  });

  it("sends thinking options only when the provider declares support", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse());
    vi.stubGlobal("fetch", fetchMock);

    await drain(
      new OpenAIProvider({
        id: "leech",
        label: "Leech",
        kind: "custom",
        baseUrl: "https://proxy-snd6ew.fly.dev/v1",
        defaultModel: "test-model",
        supportsThinking: true,
        enabled: true,
      }),
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  it("maps image parts to OpenAI chat content arrays", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse());
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAIProvider({
      id: "openai",
      label: "OpenAI",
      kind: "openai",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "test-model",
      enabled: true,
    });

    for await (const _chunk of provider.streamChat({
      model: "test-model",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "image", dataUrl: "data:image/png;base64,abc", mediaType: "image/png" },
          ],
        },
      ],
    })) {
      // drain stream
    }

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "describe this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    ]);
  });

  it("maps image parts to Anthropic base64 image blocks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse());
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AnthropicProvider({
      id: "anthropic",
      label: "Anthropic",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      defaultModel: "test-model",
      enabled: true,
    });

    for await (const _chunk of provider.streamChat({
      model: "test-model",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "image", dataUrl: "data:image/jpeg;base64,abc", mediaType: "image/jpeg" },
          ],
        },
      ],
    })) {
      // drain stream
    }

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "describe this" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: "abc",
        },
      },
    ]);
  });

  it("sends OpenAI native tool schemas and tool result ids", async () => {
    const { fetchMock } = await collect(
      new OpenAIProvider({
        id: "openai",
        label: "OpenAI",
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "test-model",
        enabled: true,
      }),
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.tools[0]).toMatchObject({
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file.",
        parameters: { type: "object" },
      },
    });

    vi.unstubAllGlobals();
    const fetchWithToolResult = vi.fn().mockResolvedValue(sseResponse());
    vi.stubGlobal("fetch", fetchWithToolResult);
    const provider = new OpenAIProvider({
      id: "openai",
      label: "OpenAI",
      kind: "openai",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "test-model",
      enabled: true,
    });
    for await (const _chunk of provider.streamChat({
      model: "test-model",
      messages: [{ role: "tool", name: "read_file", toolCallId: "call_1", content: "file contents" }],
    })) {
      // drain stream
    }

    const toolBody = JSON.parse(String(fetchWithToolResult.mock.calls[0][1]?.body));
    expect(toolBody.messages[0]).toMatchObject({
      role: "tool",
      name: "read_file",
      tool_call_id: "call_1",
      content: "file contents",
    });
  });

  it("sends OpenAI assistant native tool calls before tool results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse());
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAIProvider({
      id: "openai",
      label: "OpenAI",
      kind: "openai",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "test-model",
      enabled: true,
    });

    for await (const _chunk of provider.streamChat({
      model: "test-model",
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read_file", argsJson: "{\"path\":\"package.json\"}" }],
        },
        { role: "tool", name: "read_file", toolCallId: "call_1", content: "file contents" },
      ],
    })) {
      // drain stream
    }

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.messages[0]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: {
          name: "read_file",
          arguments: "{\"path\":\"package.json\"}",
        },
      }],
    });
  });

  it("assembles OpenAI native tool-call fragments by index", async () => {
    const data = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read_file","arguments":"{\\"pa"}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"package.json\\"}"}}]},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const { chunks } = await collect(
      new OpenAIProvider({
        id: "openai",
        label: "OpenAI",
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "test-model",
        enabled: true,
      }),
      data,
    );

    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCall: { id: "call_a", name: "read_file", argsJson: "{\"path\":\"package.json\"}" },
        }),
      ]),
    );
  });

  it("assembles parallel OpenAI native tool calls in index order", async () => {
    const data = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"read_file","arguments":"{\\"path\\":\\"b"}},{"index":0,"id":"call_a","function":{"name":"read_file","arguments":"{\\"path\\":\\"a"}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":".ts\\"}"}},{"index":0,"function":{"arguments":".ts\\"}"}}]},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const { chunks } = await collect(
      new OpenAIProvider({
        id: "openai",
        label: "OpenAI",
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "test-model",
        enabled: true,
      }),
      data,
    );

    expect(chunks.filter((chunk) => chunk.toolCall).map((chunk) => chunk.toolCall)).toEqual([
      { id: "call_a", name: "read_file", argsJson: "{\"path\":\"a.ts\"}" },
      { id: "call_b", name: "read_file", argsJson: "{\"path\":\"b.ts\"}" },
    ]);
  });

  it("generates deterministic OpenAI native tool-call ids when ids are missing", async () => {
    const data = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"name":"read_file","arguments":"{\\"path\\":\\"b.ts\\"}"}},{"index":0,"function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const { chunks } = await collect(
      new OpenAIProvider({
        id: "openai",
        label: "OpenAI",
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "test-model",
        enabled: true,
      }),
      data,
    );

    expect(chunks.filter((chunk) => chunk.toolCall).map((chunk) => chunk.toolCall)).toEqual([
      { id: "call_0", name: "read_file", argsJson: "{\"path\":\"a.ts\"}" },
      { id: "call_1", name: "read_file", argsJson: "{\"path\":\"b.ts\"}" },
    ]);
  });

  it("deduplicates duplicate OpenAI native tool-call ids", async () => {
    const data = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_dup","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}},{"index":1,"id":"call_dup","function":{"name":"read_file","arguments":"{\\"path\\":\\"b.ts\\"}"}}]},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const { chunks } = await collect(
      new OpenAIProvider({
        id: "openai",
        label: "OpenAI",
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "test-model",
        enabled: true,
      }),
      data,
    );

    expect(chunks.filter((chunk) => chunk.toolCall).map((chunk) => chunk.toolCall?.id)).toEqual([
      "call_dup",
      "call_dup_2",
    ]);
  });

  it("sends Anthropic system prompts and native tool schemas", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse());
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AnthropicProvider({
      id: "anthropic",
      label: "Anthropic",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      defaultModel: "test-model",
      enabled: true,
    });

    for await (const _chunk of provider.streamChat({
      model: "test-model",
      messages: [
        { role: "system", content: "System one." },
        { role: "system", content: "System two." },
        { role: "user", content: "hello" },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    })) {
      // drain stream
    }

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.system).toBe("System one.\nSystem two.");
    expect(body.tools[0]).toMatchObject({
      name: "read_file",
      description: "Read a file.",
      input_schema: { type: "object" },
    });
  });

  it("sends Anthropic tool_use and tool_result blocks for native tool follow-ups", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse());
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AnthropicProvider({
      id: "anthropic",
      label: "Anthropic",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      defaultModel: "test-model",
      enabled: true,
    });

    for await (const _chunk of provider.streamChat({
      model: "test-model",
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "toolu_1", name: "read_file", argsJson: "{\"path\":\"package.json\"}" }],
        },
        { role: "tool", name: "read_file", toolCallId: "toolu_1", content: "file contents" },
      ],
    })) {
      // drain stream
    }

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.messages).toEqual([
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "toolu_1",
          name: "read_file",
          input: { path: "package.json" },
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "file contents",
        }],
      },
    ]);
  });

  it("assembles Anthropic native tool-use blocks", async () => {
    const data = [
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\""}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":":\\"package.json\\"}"}}',
      'data: {"type":"content_block_stop","index":1}',
      'data: {"type":"message_stop"}',
      "",
    ].join("\n\n");
    const { chunks } = await collect(
      new AnthropicProvider({
        id: "anthropic",
        label: "Anthropic",
        kind: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        defaultModel: "test-model",
        enabled: true,
      }),
      data,
    );

    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCall: { id: "toolu_1", name: "read_file", argsJson: "{\"path\":\"package.json\"}" },
        }),
      ]),
    );
  });

  it("assembles interleaved Anthropic native tool-use blocks by content index", async () => {
    const data = [
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_b","name":"read_file"}}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_a","name":"read_file"}}',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"b.ts\\"}"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}',
      'data: {"type":"content_block_stop","index":1}',
      'data: {"type":"content_block_stop","index":2}',
      'data: {"type":"message_stop"}',
      "",
    ].join("\n\n");
    const { chunks } = await collect(
      new AnthropicProvider({
        id: "anthropic",
        label: "Anthropic",
        kind: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        defaultModel: "test-model",
        enabled: true,
      }),
      data,
    );

    expect(chunks.filter((chunk) => chunk.toolCall).map((chunk) => chunk.toolCall)).toEqual([
      { id: "toolu_a", name: "read_file", argsJson: "{\"path\":\"a.ts\"}" },
      { id: "toolu_b", name: "read_file", argsJson: "{\"path\":\"b.ts\"}" },
    ]);
  });

  it("generates and deduplicates Anthropic native tool-use ids", async () => {
    const data = [
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","name":"read_file"}}',
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_dup","name":"read_file"}}',
      'data: {"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"toolu_dup","name":"read_file"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"b.ts\\"}"}}',
      'data: {"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"c.ts\\"}"}}',
      'data: {"type":"content_block_stop","index":1}',
      'data: {"type":"content_block_stop","index":2}',
      'data: {"type":"content_block_stop","index":3}',
      'data: {"type":"message_stop"}',
      "",
    ].join("\n\n");
    const { chunks } = await collect(
      new AnthropicProvider({
        id: "anthropic",
        label: "Anthropic",
        kind: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        defaultModel: "test-model",
        enabled: true,
      }),
      data,
    );

    expect(chunks.filter((chunk) => chunk.toolCall).map((chunk) => chunk.toolCall?.id)).toEqual([
      "toolu_1",
      "toolu_dup",
      "toolu_dup_2",
    ]);
  });
});
