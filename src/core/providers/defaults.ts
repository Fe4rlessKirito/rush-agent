import type { ProviderConfig } from "./types";

// Seed configs. Keys are left blank — the user fills them in Settings. The
// "local-proxy" entry demonstrates the custom-proxy path (OpenAI-compatible,
// no key, arbitrary baseUrl) that the whole design is built around.
export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: "openai-default",
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    enabled: false,
  },
  {
    id: "anthropic-default",
    label: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-20250514",
    enabled: false,
  },
  {
    id: "deepseek-default",
    label: "DeepSeek",
    // DeepSeek's API is OpenAI-compatible, so it reuses the OpenAI wire format
    // (including native tool-calling) with only a different base URL and model.
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    enabled: false,
  },
  {
    id: "leech-proxy",
    label: "Leech Proxy (Anthropic)",
    kind: "anthropic",
    baseUrl: "https://proxy-snd6ew.fly.dev/v1",
    defaultModel: "claude-opus-4-8",
    supportsThinking: true,
    supportsImageChatEndpoint: true,
    supportsFileChatEndpoint: true,
    enabled: false,
  },
  {
    id: "leech-proxy-openai",
    label: "Leech Proxy (OpenAI)",
    kind: "custom",
    baseUrl: "https://proxy-snd6ew.fly.dev/v1",
    defaultModel: "gpt-5-4",
    supportsThinking: true,
    supportsImageChatEndpoint: true,
    supportsFileChatEndpoint: true,
    enabled: false,
  },
  {
    id: "local-proxy",
    label: "Custom Proxy",
    kind: "custom",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.1",
    enabled: false,
  },
  {
    id: "localhost-default",
    label: "Local Host",
    kind: "custom",
    baseUrl: "http://localhost:1234/v1",
    defaultModel: "local-model",
    enabled: false,
  },
  {
    id: "wman-local-proxy",
    label: "Rush Local Proxy (Rust)",
    kind: "custom",
    baseUrl: "http://127.0.0.1:8000/v1",
    defaultModel: "gpt-5-4",
    supportsThinking: true,
    supportsImageChatEndpoint: true,
    supportsFileChatEndpoint: false,
    enabled: false,
  },
];
