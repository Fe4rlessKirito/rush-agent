import { beforeEach, describe, expect, it } from "vitest";
import { useBugBountyStore } from "../bugBountyStore";
import { createWebTools } from "./webTools";
import type { SearchResponse } from "../searchProviders";

function activateProgram() {
  const id = useBugBountyStore.getState().addProgram({
    name: "Example Program",
    inScopeAssets: ["example.com"],
    outOfScopeAssets: ["blocked.example.com"],
    requiredHeaders: [{ name: "X-Researcher", value: "rush" }],
  });
  useBugBountyStore.getState().setActiveProgram(id);
}

function toolMap(fetcher?: typeof fetch) {
  const search = async (): Promise<SearchResponse> => ({
    engine: "duckduckgo",
    results: [
      { title: "Allowed", url: "https://example.com/docs", snippet: "Useful docs", source: "Test" },
      { title: "Blocked", url: "https://blocked.test/docs", snippet: "Ignore me", source: "Test" },
    ],
  });
  const defaultFetcher = async () =>
    new Response("<html><head><style>.x{}</style></head><body><h1>Title</h1><p>Hello <b>world</b>.</p></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  return new Map(createWebTools({ search, fetcher: fetcher ?? defaultFetcher }).map((tool) => [tool.definition.name, tool]));
}

describe("web tools", () => {
  beforeEach(() => {
    useBugBountyStore.setState({ programs: [], activeProgramId: null });
  });

  it("registers deep_research_search", () => {
    expect(toolMap().has("deep_research_search")).toBe(true);
  });

  it("filters WebSearch results by allowed domains", async () => {
    const tools = toolMap();

    const result = await tools.get("WebSearch")!.execute({
      query: "docs",
      allowed_domains: ["example.com"],
    });

    expect(result.content).toContain("Allowed");
    expect(result.content).not.toContain("Blocked");
  });

  it("filters deep_research_search results by allowed domains", async () => {
    const tools = toolMap();

    const result = await tools.get("deep_research_search")!.execute({
      query: "docs",
      allowed_domains: ["example.com"],
    });

    expect(result.content).toContain("Allowed");
    expect(result.content).not.toContain("Blocked");
  });

  it("blocks WebFetch without an active Bug Bounty profile", async () => {
    const result = await toolMap().get("WebFetch")!.execute({ url: "https://example.com/docs" });

    expect(result.ok).toBe(false);
    expect(result.denied).toBe(true);
    expect(result.content).toContain("Blocked: no active Bug Bounty program profile is selected");
  });

  it("fetches and converts HTML page text for in-scope targets", async () => {
    activateProgram();
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

  it("passes required Bug Bounty headers to WebFetch", async () => {
    activateProgram();
    let received: HeadersInit | undefined;
    const fetcher = async (_url: RequestInfo | URL, init?: RequestInit) => {
      received = init?.headers;
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    };

    const result = await toolMap(fetcher).get("WebFetch")!.execute({ url: "https://example.com/docs" });

    expect(result.ok).toBe(true);
    expect(received).toMatchObject({ "X-Researcher": "rush" });
  });
});
