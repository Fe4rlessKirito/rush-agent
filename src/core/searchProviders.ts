export type SearchEngine = "Default" | "duckduckgo" | "searxng" | "tavily" | "brave" | "google" | "serper";

export interface SearchConfig {
  searxngUrl: string;
  tavilyKey: string;
  braveKey: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface SearchResponse {
  engine: SearchEngine;
  results: SearchResult[];
  warning?: string;
}

export interface SearchProviderStatus {
  engine: SearchEngine;
  ready: boolean;
  label: string;
  hint: string;
  warning?: string;
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  searxngUrl: "",
  tavilyKey: "",
  braveKey: "",
};

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeEngine(engine: SearchEngine): SearchEngine {
  return engine === "Default" ? "duckduckgo" : engine;
}

export function searchProviderStatus(engine: SearchEngine, config: SearchConfig): SearchProviderStatus {
  const selected = normalizeEngine(engine);
  if (selected === "duckduckgo") {
    return {
      engine: selected,
      ready: true,
      label: "DuckDuckGo",
      hint: "Free and keyless. Uses DuckDuckGo instant-answer data, so broad web result coverage can be limited.",
    };
  }
  if (selected === "searxng") {
    const raw = config.searxngUrl.trim();
    if (!raw) {
      return {
        engine: selected,
        ready: false,
        label: "SearXNG",
        hint: "Free metasearch. Paste a SearXNG instance URL to enable it.",
        warning: "SearXNG endpoint is not configured. Add an instance URL, for example https://searx.example.com.",
      };
    }
    try {
      const url = new URL(raw);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported protocol");
    } catch {
      return {
        engine: selected,
        ready: false,
        label: "SearXNG",
        hint: "Use the base URL of a SearXNG instance.",
        warning: `SearXNG endpoint is invalid: ${raw}`,
      };
    }
    return {
      engine: selected,
      ready: true,
      label: "SearXNG",
      hint: "Free metasearch using your configured SearXNG instance.",
    };
  }
  if (selected === "tavily") {
    const ready = Boolean(config.tavilyKey.trim());
    return {
      engine: selected,
      ready,
      label: "Tavily",
      hint: "AI-oriented search with a free API tier. Requires a Tavily API key.",
      warning: ready ? undefined : "Tavily API key is not configured. Add a free-tier Tavily key to use this provider.",
    };
  }
  if (selected === "brave") {
    const ready = Boolean(config.braveKey.trim());
    return {
      engine: selected,
      ready,
      label: "Brave Search",
      hint: "Independent search index with a free API tier. Requires a Brave Search API key.",
      warning: ready ? undefined : "Brave Search API key is not configured. Add a free-tier Brave key to use this provider.",
    };
  }
  return {
    engine: selected,
    ready: false,
    label: selected,
    hint: "This provider is not wired in Rush yet.",
    warning: `${selected} search is not wired yet. Use DuckDuckGo, SearXNG, Tavily, or Brave.`,
  };
}

function uniqueResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = result.url || `${result.title}:${result.snippet}`;
    if (!result.title && !result.snippet) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function duckTopics(topics: unknown[], acc: SearchResult[]) {
  for (const topic of topics) {
    const item = topic as Record<string, unknown>;
    if (Array.isArray(item.Topics)) {
      duckTopics(item.Topics, acc);
      continue;
    }
    const text = clean(item.Text);
    if (!text) continue;
    const [title, ...rest] = text.split(" - ");
    acc.push({
      title: title || text,
      url: clean(item.FirstURL),
      snippet: rest.join(" - ") || text,
      source: "DuckDuckGo",
    });
  }
}

async function searchDuckDuckGo(query: string): Promise<SearchResponse> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const results: SearchResult[] = [];
  const abstract = clean(json.AbstractText);
  if (abstract) {
    results.push({
      title: clean(json.Heading) || query,
      url: clean(json.AbstractURL),
      snippet: abstract,
      source: "DuckDuckGo",
    });
  }
  if (Array.isArray(json.RelatedTopics)) duckTopics(json.RelatedTopics, results);
  return {
    engine: "duckduckgo",
    results: uniqueResults(results).slice(0, 8),
    warning: results.length === 0 ? "DuckDuckGo returned no instant-answer results." : undefined,
  };
}

async function searchSearxng(query: string, config: SearchConfig): Promise<SearchResponse> {
  const status = searchProviderStatus("searxng", config);
  if (!status.ready) return { engine: "searxng", results: [], warning: status.warning };
  const base = config.searxngUrl.trim().replace(/\/$/, "");
  const res = await fetch(`${base}/search?q=${encodeURIComponent(query)}&format=json`);
  if (!res.ok) throw new Error(`SearXNG ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const results = (Array.isArray(json.results) ? json.results : []).map((item: Record<string, unknown>) => ({
    title: clean(item.title),
    url: clean(item.url),
    snippet: clean(item.content),
    source: clean(item.engine) || "SearXNG",
  }));
  return { engine: "searxng", results: uniqueResults(results).slice(0, 8) };
}

async function searchTavily(query: string, config: SearchConfig): Promise<SearchResponse> {
  const status = searchProviderStatus("tavily", config);
  if (!status.ready) return { engine: "tavily", results: [], warning: status.warning };
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: config.tavilyKey.trim(),
      query,
      max_results: 8,
      include_answer: false,
    }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const results = (Array.isArray(json.results) ? json.results : []).map((item: Record<string, unknown>) => ({
    title: clean(item.title),
    url: clean(item.url),
    snippet: clean(item.content),
    source: "Tavily",
  }));
  return { engine: "tavily", results: uniqueResults(results).slice(0, 8) };
}

async function searchBrave(query: string, config: SearchConfig): Promise<SearchResponse> {
  const status = searchProviderStatus("brave", config);
  if (!status.ready) return { engine: "brave", results: [], warning: status.warning };
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": config.braveKey.trim(),
    },
  });
  if (!res.ok) throw new Error(`Brave ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const results = (Array.isArray(json.web?.results) ? json.web.results : []).map((item: Record<string, unknown>) => ({
    title: clean(item.title),
    url: clean(item.url),
    snippet: clean(item.description),
    source: "Brave",
  }));
  return { engine: "brave", results: uniqueResults(results).slice(0, 8) };
}

export async function searchWeb(query: string, engine: SearchEngine, config: SearchConfig): Promise<SearchResponse> {
  const selected = normalizeEngine(engine);
  try {
    if (selected === "searxng") return await searchSearxng(query, config);
    if (selected === "tavily") return await searchTavily(query, config);
    if (selected === "brave") return await searchBrave(query, config);
    if (selected === "google" || selected === "serper") {
      return { engine: selected, results: [], warning: searchProviderStatus(selected, config).warning };
    }
    return await searchDuckDuckGo(query);
  } catch (err) {
    return { engine: selected, results: [], warning: String(err) };
  }
}

export function formatSearchResults(response: SearchResponse): string {
  if (response.results.length === 0) {
    return response.warning ? `Search warning: ${response.warning}` : "No search results returned.";
  }
  return response.results
    .map((result, index) => [
      `[${index + 1}] ${result.title}`,
      result.url ? `URL: ${result.url}` : "",
      result.snippet ? `Snippet: ${result.snippet}` : "",
      `Source: ${result.source}`,
    ].filter(Boolean).join("\n"))
    .join("\n\n");
}
