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
  const searchResponse = await searchWeb(prompt, engine, options.searchConfig);
  let gatheredSources = searchResponse.results;
  let warning = searchResponse.warning;
  let content = warning ? `Search warning: ${warning}\n\n` : "";

  options.callbacks?.onSources?.(gatheredSources, warning);
  if (content) options.callbacks?.onContent?.(content);

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
      const response = await searchWeb(query, selectedEngine, config);
      gatheredSources = mergeSources(gatheredSources, response.results);
      warning = response.warning ?? warning;
      options.callbacks?.onSources?.(gatheredSources, warning);
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
          formatSearchResults(searchResponse),
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
      options.callbacks?.onContent?.(content);
    } else if (event.type === "tool_call") {
      options.callbacks?.onContent?.(content || `Searching with ${event.toolName ?? "web tool"}...\n\n`);
    } else if (event.type === "error") {
      options.callbacks?.onError?.(event.text ?? "Deep Research tool run failed.", content);
    }
  }

  if (gatheredSources.length === 0) {
    content = buildNoSearchResultsReport(prompt, {
      ...searchResponse,
      results: [],
      warning: warning ?? searchResponse.warning ?? "No search results returned after follow-up searches.",
    } satisfies SearchResponse);
    options.callbacks?.onContent?.(content);
  }

  return { content, sources: gatheredSources, warning };
}
