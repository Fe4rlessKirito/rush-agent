import type { Provider, ProviderConfig, ChatRequest, ChatChunk } from "./types";
import { parseModelList } from "./modelParser";

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
        messages: req.messages,
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxTokens,
        stream: true,
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`streamChat ${res.status}: ${await res.text()}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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
          const delta = json.choices?.[0]?.delta?.content ?? "";
          if (delta) yield { delta, done: false };
        } catch {
          // partial JSON across chunk boundary; ignore and wait for more
        }
      }
    }
    yield { delta: "", done: true };
  }
}
