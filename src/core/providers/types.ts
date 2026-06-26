// Core provider contracts. Every backend — standard vendor or custom proxy —
// is normalized to this interface so the agent layer never special-cases vendors.

export type ProviderKind = "openai" | "anthropic" | "custom";

export interface ProviderConfig {
  id: string;            // stable unique id, e.g. "openai-default" or "my-proxy"
  label: string;         // human-facing name shown in UI
  kind: ProviderKind;    // wire protocol to speak
  baseUrl: string;       // full base URL; this is what makes custom proxies work
  apiKey?: string;       // optional for keyless local proxies
  defaultModel: string;
  // Arbitrary extra headers a proxy may require (auth tokens, org ids, etc.)
  headers?: Record<string, string>;
  enabled: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  // Tool-call plumbing, filled in once MCP/tools land.
  name?: string;
  toolCallId?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatChunk {
  delta: string;        // incremental text
  done: boolean;
}

// A Provider knows how to speak one wire protocol against one endpoint.
export interface Provider {
  readonly config: ProviderConfig;
  listModels(): Promise<string[]>;
  streamChat(req: ChatRequest): AsyncGenerator<ChatChunk>;
}
