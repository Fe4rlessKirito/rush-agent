import { describe, expect, it } from "vitest";
import { createBrowserTools } from "./browserTools";

function toolMap() {
  const fetcher = async () =>
    new Response(`
      <html>
        <head><title>App</title></head>
        <body>
          <h1>Dashboard</h1>
          <button>Save</button>
          <input aria-label="Name" />
          <a href="/docs">Docs</a>
        </body>
      </html>
    `, { status: 200, headers: { "content-type": "text/html" } });
  return new Map(createBrowserTools({ fetcher }).map((tool) => [tool.definition.name, tool]));
}

describe("browserTools", () => {
  it("summarizes HTML UI structure", async () => {
    const result = await toolMap().get("ui_inspect")!.execute({ url: "http://localhost:5173" });

    expect(result.content).toContain("Title: App");
    expect(result.content).toContain("Dashboard");
    expect(result.content).toContain("Save");
    expect(result.content).toContain("Docs -> /docs");
  });

  it("reports missing screenshot backend clearly", async () => {
    const result = await toolMap().get("screenshot_url")!.execute({ url: "http://localhost:5173" });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("no browser screenshot backend");
  });
});
