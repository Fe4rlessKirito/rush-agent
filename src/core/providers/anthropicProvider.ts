import type { Provider, ProviderConfig, ChatRequest, ChatChunk, ChatMessage } from "./types";
import { parseModelList } from "./modelParser";

// Speaks Anthropic's Messages API. Differs from OpenAI in three ways we handle:
// system prompt is a top-level field, the auth header is x-api-key, and a
// version header is required.
export class AnthropicProvider implements Provider {
  constructor(public readonly config: ProviderConfig) {}

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.config.apiKey ?? "",
      "anthropic-version": "2023-06-01",
      ...(this.config.headers ?? {}),
    };
  }

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/$/, "")}${path}`;
  }

  async listModels(): Promise<string[]> {
    // Anthropic exposes /v1/models on recent API versions.
    const res = await fetch(this.url("/models"), { headers: this.headers() });
    if (!res.ok) return [this.config.defaultModel];
    const json = await res.json();
    return parseModelList(json, this.config.defaultModel);
  }

  async *streamChat(req: ChatRequest): AsyncGenerator<ChatChunk> {
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const turns = req.messages
      .filter((m): m is ChatMessage => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));

    const res = await fetch(this.url("/messages"), {
      method: "POST",
      headers: this.headers(),
      signal: req.signal,
      body: JSON.stringify({
        model: req.model,
        system: system || undefined,
        messages: turns,
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature ?? 0.2,
        stream: true,
        // Anthropic tool schema: top-level array with input_schema (JSON Schema).
        ...(req.tools && req.tools.length
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
              })),
            }
          : {}),
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`streamChat ${res.status}: ${await res.text()}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // tool_use blocks stream as: content_block_start (id+name) ->
    // input_json_delta (partial_json fragments) -> content_block_stop. Track the
    // currently-open tool_use block by its content index.
    let activeTool: { index: number; id: string; name: string; args: string } | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        try {
          const json = JSON.parse(trimmed.slice(5).trim());
          if (json.type === "content_block_start" && json.content_block?.type === "tool_use") {
            activeTool = {
              index: json.index,
              id: json.content_block.id,
              name: json.content_block.name,
              args: "",
            };
          } else if (json.type === "content_block_delta" && json.delta?.type === "input_json_delta") {
            if (activeTool && json.index === activeTool.index) {
              activeTool.args += json.delta.partial_json ?? "";
            }
          } else if (json.type === "content_block_delta" && json.delta?.text) {
            yield { delta: json.delta.text, done: false };
          } else if (json.type === "content_block_stop") {
            if (activeTool && json.index === activeTool.index) {
              yield {
                delta: "",
                done: false,
                toolCall: { id: activeTool.id, name: activeTool.name, argsJson: activeTool.args || "{}" },
              };
              activeTool = null;
            }
          } else if (json.type === "message_stop") {
            yield { delta: "", done: true };
            return;
          }
        } catch {
          // ignore partial frames
        }
      }
    }
    yield { delta: "", done: true };
  }
}
