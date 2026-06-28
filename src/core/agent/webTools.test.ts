import { describe, expect, it } from "vitest";
import { createWebTools } from "./webTools";
import type { SearchResponse } from "../searchProviders";

function toolMap() {
  const search = async (): Promise<SearchResponse> => ({
    engine: "duckduckgo",
    results: [
      { title: "Allowed", url: "https://example.com/docs", snippet: "Useful docs", source: "Test" },
      { title: "Blocked", url: "https://blocked.test/docs", snippet: "Ignore me", source: "Test" },
    ],
  });
  const fetcher = async () =>
    new Response("<html><head><style>.x{}</style></head><body><h1>Title</h1><p>Hello <b>world</b>.</p></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  return new Map(createWebTools({ search, fetcher }).map((tool) => [tool.definition.name, tool]));
}

describe("web tools", () => {
  it("filters WebSearch results by allowed domains", async () => {
    const tools = toolMap();

    const result = await tools.get("WebSearch")!.execute({
      query: "docs",
      allowed_domains: ["example.com"],
    });

    expect(result.content).toContain("Allowed");
    expect(result.content).not.toContain("Blocked");
  });

  it("fetches and converts HTML page text", async () => {
    const tools = toolMap();

    const result = await tools.get("WebFetch")!.execute({
      url: "https://example.com/docs",
      prompt: "Extract the title",
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("URL: https://example.com/docs");
    expect(result.content).toContain("Extraction hint: Extract the title");
    expect(result.content).toContain("Title Hello world.");
    expect(result.content).not.toContain("<h1>");
  });
});
