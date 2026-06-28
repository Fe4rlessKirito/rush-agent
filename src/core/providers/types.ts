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
  supportsThinking?: boolean;
  supportsImageChatEndpoint?: boolean;
  supportsFileChatEndpoint?: boolean;
  // Arbitrary extra headers a proxy may require (auth tokens, org ids, etc.)
  headers?: Record<string, string>;
  enabled: boolean;
}

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string; mediaType: string; name?: string };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];
  // Tool-call plumbing, filled in once MCP/tools land.
  name?: string;
  toolCallId?: string;
  toolCalls?: NativeToolCall[];
}

// JSON-schema description of a tool the model may call natively. Normalized
// shape; each provider serializes it into its own wire format. `parameters` is
// a JSON Schema object (the registry's ToolDefinition.inputSchema slots in
// directly).
export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// A fully-assembled native tool call surfaced by a provider. `argsJson` is the
// raw JSON string the model produced for the arguments — the loop parses it.
export interface NativeToolCall {
  id: string;
  name: string;
  argsJson: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  thinking?: "low" | "medium" | "high" | "max" | true | {
    type: "enabled";
    budget_tokens: number;
  };
  // When present, the provider advertises these tools to the model using its
  // native tool-calling protocol instead of the XML-tag convention.
  tools?: ToolSchema[];
}

export interface ChatChunk {
  delta: string;        // incremental text
  done: boolean;
  thinking?: string;    // incremental reasoning text, when provider exposes it
  // Present only on the chunk where a native tool call finishes assembling.
  toolCall?: NativeToolCall;
}

// A Provider knows how to speak one wire protocol against one endpoint.
export interface Provider {
  readonly config: ProviderConfig;
  listModels(): Promise<string[]>;
  streamChat(req: ChatRequest): AsyncGenerator<ChatChunk>;
}
