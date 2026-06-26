import type { Provider, ProviderConfig } from "./types";
import { OpenAIProvider } from "./openaiProvider";
import { AnthropicProvider } from "./anthropicProvider";

// Factory: turns a stored config into a live Provider. Custom proxies default
// to the OpenAI wire format since that is the de-facto proxy standard; if a
// proxy speaks Anthropic, set kind to "anthropic" instead.
export function createProvider(config: ProviderConfig): Provider {
  switch (config.kind) {
    case "anthropic":
      return new AnthropicProvider(config);
    case "openai":
    case "custom":
    default:
      return new OpenAIProvider(config);
  }
}

export class ProviderRegistry {
  private cache = new Map<string, Provider>();

  constructor(private configs: ProviderConfig[]) {}

  setConfigs(configs: ProviderConfig[]): void {
    this.configs = configs;
    this.cache.clear();
  }

  list(): ProviderConfig[] {
    return this.configs.filter((c) => c.enabled);
  }

  get(id: string): Provider {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const config = this.configs.find((c) => c.id === id);
    if (!config) throw new Error(`Unknown provider: ${id}`);
    const provider = createProvider(config);
    this.cache.set(id, provider);
    return provider;
  }
}
