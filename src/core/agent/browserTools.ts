import { invoke } from "@tauri-apps/api/core";
import type { Tool } from "./tools";

type ScreenshotBackend = (url: string, args: Record<string, unknown>) => Promise<string>;
type BrowserAutomationBackend = (command: string, args: Record<string, unknown>) => Promise<string>;

export interface BrowserToolOptions {
  fetcher?: typeof fetch;
  screenshot?: ScreenshotBackend | null;
  automation?: BrowserAutomationBackend | null;
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripTags(value: string): string {
  return clean(value.replace(/<[^>]+>/g, " "));
}

function matches(html: string, pattern: RegExp, limit = 20): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(pattern)) {
    out.push(stripTags(match[1] ?? match[0]));
    if (out.length >= limit) break;
  }
  return out.filter(Boolean);
}

function summarizeHtml(url: string, html: string): string {
  const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const headings = matches(html, /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi, 20);
  const buttons = matches(html, /<button[^>]*>([\s\S]*?)<\/button>/gi, 30);
  const links = [...html.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .slice(0, 30)
    .map((match) => `${stripTags(match[2] ?? "")} -> ${match[1]}`)
    .filter((line) => !line.startsWith(" ->"));
  const inputs = [...html.matchAll(/<(input|textarea|select)\b[^>]*>/gi)]
    .slice(0, 30)
    .map((match) => clean(match[0].replace(/\s+/g, " ")));

  return [
    `URL: ${url}`,
    `Title: ${title || "(none)"}`,
    "",
    "Headings:",
    headings.length ? headings.join("\n") : "(none)",
    "",
    "Buttons:",
    buttons.length ? buttons.join("\n") : "(none)",
    "",
    "Inputs:",
    inputs.length ? inputs.join("\n") : "(none)",
    "",
    "Links:",
    links.length ? links.join("\n") : "(none)",
  ].join("\n");
}

function summarizeWebsiteEnvironment(url: string, response: Response, html: string): string {
  const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const headings = matches(html, /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi, 24);
  const scripts = [...html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .slice(0, 40)
    .map((match) => match[1])
    .filter(Boolean);
  const forms = [...html.matchAll(/<form\b([^>]*)>/gi)]
    .slice(0, 30)
    .map((match) => clean(match[1] || "(same page)"));
  const links = [...html.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .slice(0, 60)
    .map((match) => `${stripTags(match[2] ?? "") || "(untitled)"} -> ${match[1]}`);
  const inputs = [...html.matchAll(/<(input|textarea|select)\b[^>]*>/gi)]
    .slice(0, 40)
    .map((match) => clean(match[0].replace(/\s+/g, " ")));
  const headers: string[] = [];
  response.headers.forEach((value, key) => {
    if (/^(content-security-policy|strict-transport-security|x-frame-options|x-content-type-options|referrer-policy|permissions-policy|cross-origin|access-control|set-cookie|cache-control|server)$/i.test(key)) {
      headers.push(`${key}: ${value}`);
    }
  });
  const visibleText = stripTags(html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " "))
    .slice(0, 8000);

  return [
    "Website Environment (passive fetch only)",
    `Requested URL: ${url}`,
    `Final URL: ${response.url || url}`,
    `HTTP status: ${response.status}`,
    `Title: ${title || "(none)"}`,
    "",
    "Security/metadata headers:",
    headers.length ? headers.join("\n") : "(none visible to browser fetch)",
    "",
    "Headings:",
    headings.length ? headings.join("\n") : "(none)",
    "",
    "Forms:",
    forms.length ? forms.join("\n") : "(none)",
    "",
    "Inputs:",
    inputs.length ? inputs.join("\n") : "(none)",
    "",
    "Scripts:",
    scripts.length ? scripts.join("\n") : "(none)",
    "",
    "Links:",
    links.length ? links.join("\n") : "(none)",
    "",
    "Visible text sample:",
    visibleText || "(none)",
  ].join("\n");
}

function defaultAutomation(command: string, args: Record<string, unknown>): Promise<string> {
  return invoke<{ content: string }>(command, { args }).then((result) => result.content);
}

function browserTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  automation: BrowserAutomationBackend,
): Tool {
  return {
    definition: {
      name,
      description,
      inputSchema: {
        type: "object",
        properties,
        required,
      },
    },
    async execute(args) {
      return { ok: true, content: await automation(name, args) };
    },
  };
}

export function createBrowserTools(options: BrowserToolOptions = {}): Tool[] {
  const fetcher = options.fetcher ?? fetch;
  const automation = options.automation ?? defaultAutomation;
  return [
    {
      definition: {
        name: "website_environment",
        description:
          "Passively fetch a website and return a safe environment summary: status, final URL, selected headers, headings, forms, inputs, scripts, links, and visible text. Use only for authorized defensive review or normal website understanding. Does not run exploit payloads, brute force, login attempts, load tests, stealth, or destructive checks.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "HTTP or HTTPS URL to inspect passively." },
          },
          required: ["url"],
        },
      },
      async execute(args) {
        const url = String(args.url ?? "").trim();
        if (!/^https?:\/\//i.test(url)) return { ok: false, isError: true, content: `Invalid URL: ${url}` };
        const res = await fetcher(url, { cache: "no-store", headers: { Accept: "text/html,*/*;q=0.5" } });
        const text = await res.text();
        if (!res.ok) return { ok: false, isError: true, content: `Fetch ${res.status}: ${text.slice(0, 2000)}` };
        return { ok: true, content: summarizeWebsiteEnvironment(url, res, text) };
      },
    },
    {
      definition: {
        name: "ui_inspect",
        description:
          "Fetch a URL and summarize visible HTML structure: title, headings, buttons, inputs, and links. Useful for quick UI debugging.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "HTTP or HTTPS URL to inspect." },
          },
          required: ["url"],
        },
      },
      async execute(args) {
        const url = String(args.url ?? "").trim();
        if (!/^https?:\/\//i.test(url)) return { ok: false, isError: true, content: `Invalid URL: ${url}` };
        const res = await fetcher(url, { headers: { Accept: "text/html,*/*;q=0.5" } });
        const text = await res.text();
        if (!res.ok) return { ok: false, isError: true, content: `Fetch ${res.status}: ${text.slice(0, 2000)}` };
        return { ok: true, content: summarizeHtml(url, text) };
      },
    },
    {
      definition: {
        name: "screenshot_url",
        description:
          "Capture a screenshot of a URL when a screenshot backend is available. Without that backend, returns an explicit capability error.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "HTTP or HTTPS URL to capture." },
            width: { type: "number", description: "Viewport width." },
            height: { type: "number", description: "Viewport height." },
          },
          required: ["url"],
        },
      },
      async execute(args) {
        const url = String(args.url ?? "").trim();
        if (!/^https?:\/\//i.test(url)) return { ok: false, isError: true, content: `Invalid URL: ${url}` };
        if (!options.screenshot) {
          try {
            return { ok: true, content: await automation("browser_screenshot", { ...args, url }) };
          } catch (err) {
            return { ok: false, isError: true, content: `no browser screenshot backend: ${String(err)}` };
          }
        }
        return { ok: true, content: await options.screenshot(url, args) };
      },
    },
    browserTool(
      "browser_open",
      "Open a URL in a persistent visible browser session. Adds https:// if no scheme is provided.",
      { url: { type: "string" }, sessionId: { type: "string" }, headless: { type: "boolean" }, width: { type: "number" }, height: { type: "number" } },
      ["url"],
      automation,
    ),
    browserTool(
      "browser_navigate",
      "Navigate the persistent browser session to a URL.",
      { url: { type: "string" }, sessionId: { type: "string" } },
      ["url"],
      automation,
    ),
    browserTool(
      "browser_click",
      "Click an element in the browser by CSS selector or visible text. Do not use for irreversible actions without user approval.",
      { selector: { type: "string", description: "CSS selector or visible text to click." }, sessionId: { type: "string" } },
      ["selector"],
      automation,
    ),
    browserTool(
      "browser_fill",
      "Fill an input or textarea matched by CSS selector.",
      { selector: { type: "string" }, text: { type: "string" }, sessionId: { type: "string" } },
      ["selector", "text"],
      automation,
    ),
    browserTool(
      "browser_press",
      "Press a keyboard key in the browser, optionally focused on a selector.",
      { key: { type: "string" }, selector: { type: "string" }, sessionId: { type: "string" } },
      ["key"],
      automation,
    ),
    browserTool(
      "browser_get_text",
      "Get visible text from the current browser page or a CSS selector.",
      { selector: { type: "string" }, sessionId: { type: "string" } },
      [],
      automation,
    ),
    browserTool(
      "browser_get_html",
      "Get rendered HTML from the current browser page or a CSS selector.",
      { selector: { type: "string" }, sessionId: { type: "string" } },
      [],
      automation,
    ),
    browserTool(
      "browser_eval",
      "Run JavaScript in the current browser page and return the result. Requires confirmation by default.",
      { script: { type: "string" }, sessionId: { type: "string" } },
      ["script"],
      automation,
    ),
    browserTool(
      "browser_screenshot",
      "Capture a screenshot of the current browser page and return a screenshot marker path.",
      { destination: { type: "string" }, fullPage: { type: "boolean" }, sessionId: { type: "string" } },
      [],
      automation,
    ),
    browserTool(
      "browser_links",
      "List links from the current rendered browser page.",
      { sessionId: { type: "string" } },
      [],
      automation,
    ),
    browserTool(
      "browser_close",
      "Close the persistent browser session.",
      { sessionId: { type: "string" } },
      [],
      automation,
    ),
  ];
}
