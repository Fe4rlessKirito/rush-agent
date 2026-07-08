import { beforeEach, describe, expect, it } from "vitest";
import { useBugBountyStore } from "../bugBountyStore";
import { createBrowserTools } from "./browserTools";

function activateProgram() {
  const id = useBugBountyStore.getState().addProgram({
    name: "Example Program",
    inScopeAssets: ["example.com", "localhost"],
    outOfScopeAssets: ["blocked.example.com"],
    requiredHeaders: [{ name: "X-Researcher", value: "rush" }],
  });
  useBugBountyStore.getState().setActiveProgram(id);
}

function toolMap(automation?: (command: string, args: Record<string, unknown>) => Promise<string>) {
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
  return new Map(createBrowserTools({ fetcher, automation }).map((tool) => [tool.definition.name, tool]));
}

describe("browserTools", () => {
  beforeEach(() => {
    useBugBountyStore.setState({ programs: [], activeProgramId: null });
  });

  it("blocks passive URL inspection without an active Bug Bounty profile", async () => {
    const result = await toolMap().get("ui_inspect")!.execute({ url: "http://localhost:5173" });

    expect(result.ok).toBe(false);
    expect(result.denied).toBe(true);
    expect(result.content).toContain("Blocked: no active Bug Bounty program profile is selected");
  });

  it("summarizes HTML UI structure for in-scope targets", async () => {
    activateProgram();

    const result = await toolMap().get("ui_inspect")!.execute({ url: "http://localhost:5173" });

    expect(result.content).toContain("Title: App");
    expect(result.content).toContain("Dashboard");
    expect(result.content).toContain("Save");
    expect(result.content).toContain("Docs -> /docs");
  });

  it("blocks screenshot_url when the URL is out of scope", async () => {
    activateProgram();

    const result = await toolMap().get("screenshot_url")!.execute({ url: "https://blocked.example.com" });

    expect(result.ok).toBe(false);
    expect(result.denied).toBe(true);
    expect(result.content).toContain("Blocked by Bug Bounty scope for Example Program");
  });

  it("reports missing screenshot backend clearly for in-scope targets", async () => {
    activateProgram();

    const result = await toolMap().get("screenshot_url")!.execute({ url: "http://localhost:5173" });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("no browser screenshot backend");
  });

  it("scope-checks simple browser navigation wrappers and passes required headers", async () => {
    activateProgram();
    let received: Record<string, unknown> | undefined;
    const automation = async (_command: string, args: Record<string, unknown>) => {
      received = args;
      return "opened";
    };

    const result = await toolMap(automation).get("browser_open")!.execute({ url: "https://example.com/app" });

    expect(result.ok).toBe(true);
    expect(received?.headers).toMatchObject({ "X-Researcher": "rush" });
  });
});
