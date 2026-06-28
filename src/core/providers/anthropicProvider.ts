import type { Provider, ProviderConfig, ChatRequest, ChatChunk, ChatMessage } from "./types";
import { parseModelList } from "./modelParser";

function contentText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function splitDataUrl(dataUrl: string): { mediaType: string; data: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return { mediaType: "image/png", data: dataUrl };
  return { mediaType: match[1], data: match[2] };
}

function anthropicContent(content: ChatMessage["content"]): unknown {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    const image = splitDataUrl(part.dataUrl);
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: part.mediaType || image.mediaType,
        data: image.data,
      },
    };
  });
}

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
    const system = req.messages.filter((m) => m.role === "system").map((m) => contentText(m.content)).join("\n");
    const turns = req.messages
      .filter((m): m is ChatMessage => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: anthropicContent(m.content) }));

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
        ...(this.config.supportsThinking && req.thinking ? { thinking: req.thinking } : {}),
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
    // input_json_delta (partial_json fragments) -> content_block_stop. Track by
    // content index so interleaved/parallel tool_use blocks assemble correctly.
    const activeTools = new Map<number, { id: string; name: string; args: string }>();
    const seenToolIds = new Set<string>();
    const uniqueToolId = (rawId: string, index: number): string => {
      const base = rawId || `toolu_${index}`;
      if (!seenToolIds.has(base)) {
        seenToolIds.add(base);
        return base;
      }
      let suffix = 2;
      let next = `${base}_${suffix}`;
      while (seenToolIds.has(next)) {
        suffix += 1;
        next = `${base}_${suffix}`;
      }
      seenToolIds.add(next);
      return next;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          yield { delta: "", done: true };
          return;
        }
        try {
          const json = JSON.parse(payload);
          if (json.type === "thinking_delta" && json.delta?.thinking) {
            yield { delta: "", done: false, thinking: json.delta.thinking };
          } else if (json.type === "content_block_start" && json.content_block?.type === "tool_use") {
            activeTools.set(json.index, {
              id: json.content_block.id ?? "",
              name: json.content_block.name,
              args: "",
            });
          } else if (json.type === "content_block_delta" && json.delta?.type === "input_json_delta") {
            const activeTool = activeTools.get(json.index);
            if (activeTool) activeTool.args += json.delta.partial_json ?? "";
          } else if (json.type === "content_block_delta" && json.delta?.text) {
            yield { delta: json.delta.text, done: false };
          } else if (json.type === "content_block_stop") {
            const activeTool = activeTools.get(json.index);
            if (activeTool) {
              yield {
                delta: "",
                done: false,
                toolCall: { id: uniqueToolId(activeTool.id, json.index), name: activeTool.name, argsJson: activeTool.args || "{}" },
              };
              activeTools.delete(json.index);
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
