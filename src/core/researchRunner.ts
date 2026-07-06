import { thinkingForEffort } from "./effort";
import { runAgent } from "./agent/agentLoop";
import { ToolRegistry } from "./agent/tools";
import { createWebTools } from "./agent/webTools";
import {
  buildNoSearchResultsReport,
  formatSearchResults,
  searchWeb,
  type SearchConfig,
  type SearchEngine,
  type SearchResponse,
  type SearchResult,
} from "./searchProviders";
import type { Provider, ProviderConfig } from "./providers/types";
import type { ResearchSettings } from "./researchStore";

export interface ResearchRunCallbacks {
  onSources?: (sources: SearchResult[], warning?: string) => void;
  onContent?: (content: string) => void;
  onActivity?: (activity: string) => void;
  onError?: (error: string, content: string) => void;
}

export interface RunDeepResearchOptions {
  prompt: string;
  settings: ResearchSettings;
  provider: Provider;
  providerConfig?: ProviderConfig;
  model: string;
  searchConfig: SearchConfig;
  callbacks?: ResearchRunCallbacks;
}

export interface RunDeepResearchResult {
  content: string;
  sources: SearchResult[];
  warning?: string;
}

export function maxResearchSteps(rounds: string): number {
  const explicit = Number(rounds.match(/\d+/)?.[0] ?? 0);
  if (explicit > 0) return Math.max(4, Math.min(14, explicit * 3 + 2));
  return 8;
}

export function mergeSources<T extends { url: string; title: string; snippet: string; source: string }>(
  current: T[],
  incoming: T[],
): T[] {
  const seen = new Set(current.map((source) => source.url || `${source.title}:${source.snippet}`));
  const next = current.slice();
  for (const source of incoming) {
    const key = source.url || `${source.title}:${source.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(source);
  }
  return next.slice(0, 30);
}

export async function runDeepResearch(options: RunDeepResearchOptions): Promise<RunDeepResearchResult> {
  const prompt = options.prompt.trim();
  const engine = options.settings.engine as SearchEngine;
  options.callbacks?.onActivity?.("Searching initial sources...");
  const searchResponse = await searchWeb(prompt, engine, options.searchConfig);
  options.callbacks?.onActivity?.(searchResponse.warning && searchResponse.results.length === 0 && engine !== "duckduckgo" ? "Initial search had no usable results. Trying DuckDuckGo fallback..." : "Initial source search complete.");
  const initialSearchResponse = searchResponse.warning && searchResponse.results.length === 0 && engine !== "duckduckgo"
    ? await searchWeb(prompt, "duckduckgo", options.searchConfig)
    : searchResponse;
  let gatheredSources = initialSearchResponse.results;
  let warning = initialSearchResponse === searchResponse
    ? searchResponse.warning
    : initialSearchResponse.results.length > 0
      ? `${searchResponse.warning} Rush used DuckDuckGo fallback results instead.`
      : initialSearchResponse.warning ?? searchResponse.warning;
  let content = warning ? `Search warning: ${warning}\n\n` : "";

  options.callbacks?.onSources?.(gatheredSources, warning);
  if (content) options.callbacks?.onContent?.(content);
  options.callbacks?.onActivity?.(gatheredSources.length > 0 ? "Writing report from gathered sources..." : "No initial sources yet. Asking the research agent to search deeper...");

  const settingsText = [
    `Rounds: ${options.settings.rounds}`,
    `Format: ${options.settings.format}`,
    `Search engine preference: ${options.settings.engine}`,
    `Endpoint: ${options.settings.endpoint}`,
    `Model: ${options.model}`,
  ].join("\n");

  const researchTools = new ToolRegistry();
  researchTools.registerAll(createWebTools({
    engine,
    getSearchConfig: () => options.searchConfig,
    search: async (query, selectedEngine, config) => {
      options.callbacks?.onActivity?.(`Searching web: ${query}`);
      const response = await searchWeb(query, selectedEngine, config);
      gatheredSources = mergeSources(gatheredSources, response.results);
      warning = response.warning ?? warning;
      options.callbacks?.onSources?.(gatheredSources, warning);
      options.callbacks?.onActivity?.(response.results.length > 0 ? `Found ${response.results.length} source${response.results.length === 1 ? "" : "s"}.` : "Search returned no usable sources.");
      return response;
    },
  }));

  for await (const event of runAgent(
    options.provider,
    options.model,
    researchTools,
    [
      {
        role: "user",
        content: [
          `Research prompt:\n${prompt}`,
          "",
          `Settings:\n${settingsText}`,
          "",
          "Initial search results:",
          formatSearchResults(initialSearchResponse),
        ].join("\n"),
      },
    ],
    undefined,
    maxResearchSteps(options.settings.rounds),
    [
      "You are Rush Deep Research.",
      "Build a careful, structured Markdown research report.",
      "Use WebSearch to run follow-up searches when the initial results are missing, weak, too broad, or too narrow.",
      "Use WebFetch on relevant URLs when snippets are not enough.",
      "Use only gathered search/fetch source context for factual claims. Do not fill gaps from memory.",
      "If no usable sources can be found after trying alternate queries, say that clearly and do not produce a guessed report.",
      "Include: summary, key findings, source notes with URLs, uncertainties, and next steps.",
    ].join("\n"),
    options.providerConfig?.supportsThinking ? thinkingForEffort(2) : undefined,
  )) {
    if (event.type === "text" && event.text) {
      content += event.text;
      options.callbacks?.onActivity?.("Streaming report...");
      options.callbacks?.onContent?.(content);
    } else if (event.type === "tool_call") {
      options.callbacks?.onActivity?.(`Using ${event.toolName ?? "web tool"}...`);
      options.callbacks?.onContent?.(content || `Searching with ${event.toolName ?? "web tool"}...\n\n`);
    } else if (event.type === "tool_result") {
      options.callbacks?.onActivity?.(`${event.toolName ?? "Web tool"} finished.`);
    } else if (event.type === "error") {
      const message = event.text ?? "Deep Research tool run failed.";
      options.callbacks?.onError?.(message, content);
      throw new Error(message);
    }
  }

  if (gatheredSources.length === 0) {
      content = buildNoSearchResultsReport(prompt, {
        ...initialSearchResponse,
        results: [],
        warning: warning ?? initialSearchResponse.warning ?? "No search results returned after follow-up searches.",
      } satisfies SearchResponse);
    options.callbacks?.onContent?.(content);
  }

  options.callbacks?.onActivity?.("Research report complete.");
  return { content, sources: gatheredSources, warning };
}
