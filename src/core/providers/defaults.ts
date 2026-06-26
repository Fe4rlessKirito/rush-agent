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
    id: "local-proxy",
    label: "Custom Proxy",
    kind: "custom",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.1",
    enabled: false,
  },
];
