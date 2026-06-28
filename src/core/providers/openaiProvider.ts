import type { Provider, ProviderConfig, ChatRequest, ChatChunk, ChatMessage } from "./types";
import { parseModelList } from "./modelParser";

function openAIContent(content: ChatMessage["content"]): unknown {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    return { type: "image_url", image_url: { url: part.dataUrl } };
  });
}

function openAIMessage(msg: ChatMessage): Record<string, unknown> {
  return {
    role: msg.role,
    content: msg.toolCalls?.length ? openAIContent(msg.content) || null : openAIContent(msg.content),
    ...(msg.name ? { name: msg.name } : {}),
    ...(msg.toolCallId ? { tool_call_id: msg.toolCallId } : {}),
    ...(msg.toolCalls?.length
      ? {
          tool_calls: msg.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: call.argsJson || "{}",
            },
          })),
        }
      : {}),
  };
}

// Speaks the OpenAI Chat Completions wire format. Because most custom proxies
// (LiteLLM, OpenRouter, vLLM, Ollama's /v1, etc.) are OpenAI-compatible, the
// "custom" kind reuses this exact implementation — only baseUrl/headers differ.
export class OpenAIProvider implements Provider {
  constructor(public readonly config: ProviderConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) h["Authorization"] = `Bearer ${this.config.apiKey}`;
    return { ...h, ...(this.config.headers ?? {}) };
  }

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/$/, "")}${path}`;
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(this.url("/models"), { headers: this.headers() });
    if (!res.ok) throw new Error(`listModels ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return parseModelList(json, this.config.defaultModel);
  }

  async *streamChat(req: ChatRequest): AsyncGenerator<ChatChunk> {
    const res = await fetch(this.url("/chat/completions"), {
      method: "POST",
      headers: this.headers(),
      signal: req.signal,
      body: JSON.stringify({
        model: req.model,
        messages: req.messages.map(openAIMessage),
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxTokens,
        stream: true,
        ...(this.config.supportsThinking && req.thinking ? { thinking: req.thinking } : {}),
        // Advertise tools in OpenAI function-calling format when present.
        ...(req.tools && req.tools.length
          ? {
              tools: req.tools.map((t) => ({
                type: "function",
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                },
              })),
              tool_choice: "auto",
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

    // Native tool calls arrive as fragments across many chunks, keyed by index.
    // Accumulate id/name/arguments per index, then flush when the stream signals
    // completion (finish_reason "tool_calls" or [DONE]).
    const pending = new Map<number, { id: string; name: string; args: string }>();
    const seenToolIds = new Set<string>();
    const uniqueToolId = (rawId: string, index: number): string => {
      const base = rawId || `call_${index}`;
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
    const flushToolCalls = function* (): Generator<ChatChunk> {
      const ordered = [...pending.entries()].sort((a, b) => a[0] - b[0]);
      for (const [index, tc] of ordered) {
        if (!tc.name) continue;
        yield { delta: "", done: false, toolCall: { id: uniqueToolId(tc.id, index), name: tc.name, argsJson: tc.args || "{}" } };
      }
      pending.clear();
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
          yield* flushToolCalls();
          yield { delta: "", done: true };
          return;
        }
        try {
          const json = JSON.parse(payload);
          const choice = json.choices?.[0];
          const delta = choice?.delta?.content ?? "";
          if (delta) {
            if (choice?.delta?.thinking === true) {
              yield { delta: "", done: false, thinking: delta };
            } else {
              yield { delta, done: false };
            }
          }

          const toolDeltas = choice?.delta?.tool_calls;
          if (Array.isArray(toolDeltas)) {
            for (const td of toolDeltas) {
              const idx = td.index ?? 0;
              const cur = pending.get(idx) ?? { id: "", name: "", args: "" };
              if (td.id) cur.id = td.id;
              if (td.function?.name) cur.name = td.function.name;
              if (td.function?.arguments) cur.args += td.function.arguments;
              pending.set(idx, cur);
            }
          }

          if (choice?.finish_reason === "tool_calls") {
            yield* flushToolCalls();
          }
        } catch {
          // partial JSON across chunk boundary; ignore and wait for more
        }
      }
    }
    yield* flushToolCalls();
    yield { delta: "", done: true };
  }
}
