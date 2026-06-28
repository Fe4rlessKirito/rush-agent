import { describe, expect, it } from "vitest";
import { buildNoSearchResultsReport, DEFAULT_SEARCH_CONFIG, formatSearchResults, searchProviderStatus, searchWeb, type SearchResponse } from "./searchProviders";

describe("formatSearchResults", () => {
  it("formats result blocks for model context", () => {
    const response: SearchResponse = {
      engine: "duckduckgo",
      results: [
        { title: "Signal", url: "https://signal.org", snippet: "Private messenger", source: "DuckDuckGo" },
      ],
    };
    expect(formatSearchResults(response)).toContain("[1] Signal");
    expect(formatSearchResults(response)).toContain("URL: https://signal.org");
  });

  it("includes warnings when no results are available", () => {
    expect(formatSearchResults({ engine: "searxng", results: [], warning: "Missing endpoint" })).toBe(
      "Search warning: Missing endpoint",
    );
  });

  it("builds a markdown report instead of letting no-source research guess", () => {
    const report = buildNoSearchResultsReport("best private messenger", {
      engine: "duckduckgo",
      results: [],
      warning: "DuckDuckGo returned no instant-answer results.",
    });

    expect(report).toContain("# Deep Research could not start");
    expect(report).toContain("- Engine: duckduckgo");
    expect(report).toContain("did not generate a research report");
    expect(report).toContain("SearXNG");
  });
});

describe("searchProviderStatus", () => {
  it("marks keyless DuckDuckGo as ready with a coverage hint", () => {
    const status = searchProviderStatus("Default", DEFAULT_SEARCH_CONFIG);
    expect(status).toMatchObject({ engine: "duckduckgo", ready: true, label: "DuckDuckGo" });
    expect(status.hint).toContain("keyless");
  });

  it("validates SearXNG endpoint configuration", () => {
    expect(searchProviderStatus("searxng", DEFAULT_SEARCH_CONFIG)).toMatchObject({
      ready: false,
      warning: expect.stringContaining("endpoint is not configured"),
    });
    expect(searchProviderStatus("searxng", { ...DEFAULT_SEARCH_CONFIG, searxngUrl: "not a url" })).toMatchObject({
      ready: false,
      warning: expect.stringContaining("invalid"),
    });
    expect(searchProviderStatus("searxng", { ...DEFAULT_SEARCH_CONFIG, searxngUrl: "https://search.example" })).toMatchObject({
      ready: true,
    });
  });

  it("explains missing Tavily and Brave keys", () => {
    expect(searchProviderStatus("tavily", DEFAULT_SEARCH_CONFIG).warning).toContain("Tavily API key");
    expect(searchProviderStatus("brave", DEFAULT_SEARCH_CONFIG).warning).toContain("Brave Search API key");
  });

  it("returns actionable warning for configured-but-unwired engines", async () => {
    await expect(searchWeb("hello", "google", DEFAULT_SEARCH_CONFIG)).resolves.toMatchObject({
      engine: "google",
      results: [],
      warning: expect.stringContaining("not wired"),
    });
  });
});
