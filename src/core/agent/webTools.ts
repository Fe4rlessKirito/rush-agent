import {
  DEFAULT_SEARCH_CONFIG,
  formatSearchResults,
  searchWeb,
  type SearchConfig,
  type SearchEngine,
  type SearchResponse,
} from "../searchProviders";
import type { Tool } from "./tools";

type Fetcher = typeof fetch;
type Searcher = (query: string, engine: SearchEngine, config: SearchConfig) => Promise<SearchResponse>;

interface WebToolOptions {
  engine?: SearchEngine;
  getSearchConfig?: () => SearchConfig;
  search?: Searcher;
  fetcher?: Fetcher;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
}

function htmlToText(html: string): string {
  return cleanText(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

function hostAllowed(url: string, allowedDomains?: unknown, blockedDomains?: unknown): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return false;
  }

  const allowed = Array.isArray(allowedDomains) ? allowedDomains.map(String) : [];
  const blocked = Array.isArray(blockedDomains) ? blockedDomains.map(String) : [];
  const matches = (domain: string) => {
    const clean = domain.replace(/^www\./, "").toLowerCase();
    return host === clean || host.endsWith(`.${clean}`);
  };
  if (blocked.some(matches)) return false;
  if (allowed.length > 0 && !allowed.some(matches)) return false;
  return true;
}

export function createWebTools(options: WebToolOptions = {}): Tool[] {
  const search = options.search ?? searchWeb;
  const fetcher = options.fetcher ?? fetch;
  const getSearchConfig = options.getSearchConfig ?? (() => DEFAULT_SEARCH_CONFIG);
  const defaultEngine = options.engine ?? "Default";

  return [
    {
      definition: {
        name: "WebSearch",
        description:
          "Search the web and return result titles, URLs, snippets, and source names. Use WebFetch on a returned URL when page content is needed.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query." },
            engine: { type: "string", description: "Optional engine: Default, duckduckgo, searxng, tavily, brave." },
            allowed_domains: { type: "array", items: { type: "string" }, description: "Only include results from these domains." },
            blocked_domains: { type: "array", items: { type: "string" }, description: "Exclude results from these domains." },
          },
          required: ["query"],
        },
      },
      async execute(args) {
        const query = String(args.query ?? "").trim();
        if (!query) return { ok: false, isError: true, content: "Missing query." };
        const engine = String(args.engine ?? defaultEngine) as SearchEngine;
        const response = await search(query, engine, getSearchConfig());
        const filtered = {
          ...response,
          results: response.results.filter((result) =>
            hostAllowed(result.url, args.allowed_domains, args.blocked_domains),
          ),
        };
        return { ok: true, content: formatSearchResults(filtered) };
      },
    },
    {
      definition: {
        name: "deep_research_search",
        description:
          "Search with the configured Deep Research provider and return sources for iterative research. Use this to build broad reports over multiple focused searches.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Focused research search query." },
            engine: { type: "string", description: "Optional engine: Default, duckduckgo, searxng, tavily, brave." },
            allowed_domains: { type: "array", items: { type: "string" }, description: "Only include results from these domains." },
            blocked_domains: { type: "array", items: { type: "string" }, description: "Exclude results from these domains." },
          },
          required: ["query"],
        },
      },
      async execute(args) {
        const query = String(args.query ?? "").trim();
        if (!query) return { ok: false, isError: true, content: "Missing query." };
        const engine = String(args.engine ?? defaultEngine) as SearchEngine;
        const response = await search(query, engine, getSearchConfig());
        const filtered = {
          ...response,
          results: response.results.filter((result) =>
            hostAllowed(result.url, args.allowed_domains, args.blocked_domains),
          ),
        };
        return { ok: true, content: formatSearchResults(filtered) };
      },
    },
    {
      definition: {
        name: "WebFetch",
        description:
          "Fetch a URL and return readable page text. HTML is converted to plain text; large pages are truncated.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to fetch." },
            prompt: { type: "string", description: "Optional extraction hint. Included with returned content for the model to apply." },
            max_chars: { type: "number", description: "Maximum returned characters, capped at 50000." },
          },
          required: ["url"],
        },
      },
      async execute(args) {
        const url = String(args.url ?? "").trim();
        if (!url) return { ok: false, isError: true, content: "Missing url." };
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return { ok: false, isError: true, content: `Invalid URL: ${url}` };
        }
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return { ok: false, isError: true, content: `Unsupported URL protocol: ${parsed.protocol}` };
        }

        const res = await fetcher(url, { headers: { Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" } });
        const raw = await res.text();
        if (!res.ok) return { ok: false, isError: true, content: `Fetch ${res.status}: ${raw.slice(0, 2000)}` };

        const contentType = res.headers.get("content-type") ?? "";
        const text = contentType.includes("html") ? htmlToText(raw) : cleanText(raw);
        const max = Math.max(1000, Math.min(50_000, Number(args.max_chars ?? 20_000) || 20_000));
        const truncated = text.length > max;
        const prompt = String(args.prompt ?? "").trim();
        return {
          ok: true,
          content: [
            `URL: ${url}`,
            prompt ? `Extraction hint: ${prompt}` : "",
            truncated ? `Note: content truncated to ${max} characters.` : "",
            "",
            text.slice(0, max),
          ].filter((part) => part !== "").join("\n"),
        };
      },
    },
  ];
}
