import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildNoSearchResultsReport,
  DEFAULT_SEARCH_CONFIG,
  formatSearchResults,
  parseDuckDuckGoHtmlResults,
  searchProviderStatus,
  searchWeb,
  type SearchResponse,
} from "./searchProviders";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe("DuckDuckGo search", () => {
  it("parses DuckDuckGo HTML result pages", () => {
    const results = parseDuckDuckGoHtmlResults(`
      <html><body>
        <div class="result results_links">
          <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fprices&amp;rut=abc">Computer prices 2000-2025</a>
          <a class="result__snippet">Historical computer goods price index &amp; analysis.</a>
        </div>
      </body></html>
    `);

    expect(results).toEqual([
      {
        title: "Computer prices 2000-2025",
        url: "https://example.com/prices",
        snippet: "Historical computer goods price index & analysis.",
        source: "DuckDuckGo",
      },
    ]);
  });

  it("falls back to DuckDuckGo HTML results when instant answers are empty", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ RelatedTopics: [], AbstractText: "" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => `
          <html><body>
            <div class="result">
              <a class="result__a" href="https://example.com/research">Research source</a>
              <div class="result__snippet">Useful source snippet.</div>
            </div>
          </body></html>
        `,
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchWeb("computer goods prices 2000 2025", "duckduckgo", DEFAULT_SEARCH_CONFIG)).resolves.toMatchObject({
      engine: "duckduckgo",
      results: [
        {
          title: "Research source",
          url: "https://example.com/research",
          snippet: "Useful source snippet.",
          source: "DuckDuckGo",
        },
      ],
      warning: expect.stringContaining("HTML search results"),
    });
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
