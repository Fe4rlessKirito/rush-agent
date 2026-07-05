import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";

const MAX_TEXT = 8000;
const sessions = new Map();
let playwright;

function normalizeUrl(url) {
  const raw = String(url || "").trim();
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(withScheme);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
  }
  return parsed.toString();
}

async function loadPlaywright() {
  if (playwright) return playwright;
  playwright = await import("playwright");
  return playwright;
}

async function ensureSession(args = {}) {
  const sessionId = String(args.sessionId || "default");
  const existing = sessions.get(sessionId);
  if (existing) return existing;

  const pw = await loadPlaywright();
  let browser;
  try {
    browser = await pw.chromium.launch({ channel: "msedge", headless: args.headless === true ? true : false });
  } catch {
    browser = await pw.chromium.launch({ headless: args.headless === true ? true : false });
  }
  const context = await browser.newContext({
    viewport: {
      width: Number(args.width || 1280),
      height: Number(args.height || 800),
    },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(Number(args.timeout || 30000));
  const session = { id: sessionId, browser, context, page };
  sessions.set(sessionId, session);
  return session;
}

async function closeSession(sessionId = "default") {
  const session = sessions.get(sessionId);
  if (!session) return false;
  sessions.delete(sessionId);
  await session.browser.close();
  return true;
}

async function clickTarget(page, selector) {
  try {
    await page.click(selector, { timeout: 8000 });
    return `Clicked: ${selector}`;
  } catch {
    await page.getByText(selector, { exact: false }).first().click({ timeout: 8000 });
    return `Clicked text: ${selector}`;
  }
}

async function handle(command, args = {}) {
  switch (command) {
    case "browser_open": {
      const session = await ensureSession(args);
      const url = normalizeUrl(args.url);
      await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: Number(args.timeout || 30000) });
      return { sessionId: session.id, content: `Opened ${url}\nTitle: ${await session.page.title()}` };
    }
    case "browser_navigate": {
      const session = await ensureSession(args);
      const url = normalizeUrl(args.url);
      await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: Number(args.timeout || 30000) });
      return { sessionId: session.id, content: `Opened ${url}\nTitle: ${await session.page.title()}` };
    }
    case "browser_click": {
      const session = await ensureSession(args);
      return { sessionId: session.id, content: await clickTarget(session.page, String(args.selector || args.text || "")) };
    }
    case "browser_fill": {
      const session = await ensureSession(args);
      const selector = String(args.selector || "");
      const text = String(args.text || "");
      await session.page.fill(selector, text, { timeout: 8000 });
      return { sessionId: session.id, content: `Filled ${selector} with ${text.length} chars` };
    }
    case "browser_press": {
      const session = await ensureSession(args);
      const key = String(args.key || "");
      const selector = args.selector ? String(args.selector) : "";
      if (selector) await session.page.press(selector, key, { timeout: 8000 });
      else await session.page.keyboard.press(key);
      return { sessionId: session.id, content: `Pressed ${key}` };
    }
    case "browser_get_text": {
      const session = await ensureSession(args);
      const selector = args.selector ? String(args.selector) : "body";
      const txt = await session.page.innerText(selector);
      return { sessionId: session.id, content: txt.slice(0, MAX_TEXT) || "(no visible text)" };
    }
    case "browser_get_html": {
      const session = await ensureSession(args);
      let html;
      if (args.selector) html = await session.page.innerHTML(String(args.selector));
      else html = await session.page.content();
      return { sessionId: session.id, content: html.slice(0, MAX_TEXT) };
    }
    case "browser_eval": {
      const session = await ensureSession(args);
      const result = await session.page.evaluate(String(args.script || ""));
      const content = typeof result === "string" ? result : JSON.stringify(result);
      return { sessionId: session.id, content: String(content || "").slice(0, MAX_TEXT) };
    }
    case "browser_screenshot": {
      const session = await ensureSession(args);
      const destination = args.destination
        ? String(args.destination)
        : path.join(os.tmpdir(), `rush_browser_${Date.now()}.png`);
      await session.page.screenshot({ path: destination, fullPage: args.fullPage === true });
      return { sessionId: session.id, content: `[SCREENSHOT:${destination}]`, path: destination };
    }
    case "browser_links": {
      const session = await ensureSession(args);
      const links = await session.page.$$eval("a[href]", (els) => els
        .slice(0, 80)
        .map((e) => `${(e.innerText || "").trim()} -> ${e.href}`)
        .filter(Boolean));
      return { sessionId: session.id, content: links.join("\n") || "(no links)" };
    }
    case "browser_close": {
      const sessionId = String(args.sessionId || "default");
      const closed = await closeSession(sessionId);
      return { sessionId, content: closed ? "Browser closed." : "Browser was not open." };
    }
    default:
      throw new Error(`Unknown browser command: ${command}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  let id = null;
  try {
    const req = JSON.parse(line);
    id = req.id;
    const result = await handle(req.command, req.args || {});
    process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ id, ok: false, error: String(err?.message || err) })}\n`);
  }
});

process.on("SIGTERM", async () => {
  for (const id of [...sessions.keys()]) await closeSession(id).catch(() => {});
  process.exit(0);
});
