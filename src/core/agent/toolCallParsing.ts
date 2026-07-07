import type { NativeToolCall } from "../providers/types";

const TOOL_CALL_RE_G = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
const TOOL_CALLS_RE = /<tool_calls>\s*([\s\S]*?)\s*<\/tool_calls>/;
const THINKING_RE = /<​thinking>\s*([\s\S]*?)\s*<\/thinking>/g;

// Any tag we treat specially. If the buffer ends with what *could* be the start
// of one of these (e.g. a lone "<think"), we hold that tail back rather than
// flashing raw angle brackets at the user mid-stream.
const OPEN_THINKING = "<​thinking>";
const CLOSE_THINKING = "<​/thinking>";
export const OPEN_TOOL = "<tool_call>";
export const OPEN_TOOLS = "<tool_calls>";
export const CLOSE_TOOL = "</tool_call>";
export const CLOSE_TOOLS = "</tool_calls>";

export interface ParsedToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

// Largest suffix of `buf` that is a prefix of any control tag. We must not emit
// it yet — the next chunk might complete the tag.
function pendingTagTail(buf: string): number {
  const tags = [OPEN_THINKING, CLOSE_THINKING, OPEN_TOOL, OPEN_TOOLS, CLOSE_TOOL, CLOSE_TOOLS];
  let hold = 0;
  for (const tag of tags) {
    for (let n = Math.min(tag.length - 1, buf.length); n > 0; n--) {
      if (buf.endsWith(tag.slice(0, n)) && n > hold) hold = n;
    }
  }
  return hold;
}

function matchingJsonClose(open: string): string {
  return open === "[" ? "]" : "}";
}

function findJsonValueEnd(text: string, start: number): number {
  const open = text[start];
  if (open !== "[" && open !== "{") return -1;
  const stack = [matchingJsonClose(open)];
  let inString = false;

  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let backslashes = 0;
      for (let j = i - 1; j >= start && text[j] === "\\"; j--) backslashes += 1;
      if (backslashes % 2 === 0) inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "[" || ch === "{") {
      stack.push(matchingJsonClose(ch));
    } else if (ch === "]" || ch === "}") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

function looksLikeToolCallObject(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && "name" in value;
}

function looksLikeToolCallArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(looksLikeToolCallObject);
}

function findRecoverableToolSyntax(text: string, from = 0): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  const closers = [
    { tag: CLOSE_TOOLS, open: "[" },
    { tag: CLOSE_TOOL, open: "{" },
  ];

  for (const { tag, open } of closers) {
    const closeAt = text.indexOf(tag, from);
    if (closeAt === -1) continue;
    for (let start = closeAt - 1; start >= from; start--) {
      if (text[start] !== open) continue;
      const valueEnd = findJsonValueEnd(text, start);
      if (valueEnd === -1 || valueEnd > closeAt) continue;
      if (text.slice(valueEnd, closeAt).trim()) continue;
      try {
        const parsed = parseToolJson(text.slice(start, valueEnd));
        const isToolPayload = open === "[" ? looksLikeToolCallArray(parsed) : looksLikeToolCallObject(parsed);
        if (!isToolPayload) continue;
        const candidate = { start, end: closeAt + tag.length };
        if (!best || candidate.start < best.start) best = candidate;
        break;
      } catch {
        continue;
      }
    }
  }

  return best;
}

function findPendingBareToolSyntaxStart(text: string): number {
  if (text.endsWith("\u0000")) return -1;

  const candidates = [
    ...text.matchAll(/(?:^|[\s([{])(\[\s*\{\s*"name"\s*:)/g),
    ...text.matchAll(/(?:^|[\s([{])(\{\s*"name"\s*:)/g),
    ...text.matchAll(/(?:^|[\s([{])(\[\s*(?:\{\s*)?(?:"(?:n(?:a(?:m(?:e)?)?)?)?)?)$/g),
    ...text.matchAll(/(?:^|[\s([{])(\{\s*(?:"(?:n(?:a(?:m(?:e)?)?)?)?)?)$/g),
  ];

  let best = -1;
  for (const match of candidates) {
    const matched = match[1];
    if (!matched || match.index === undefined) continue;
    const start = match.index + match[0].length - matched.length;
    const end = findJsonValueEnd(text, start);
    if (end !== -1 && text.slice(end).trim()) continue;
    best = best === -1 ? start : Math.min(best, start);
  }

  return best;
}

// Split the accumulated buffer into the visible answer text and the thinking
// text, suppressing tool_call blocks entirely. Returns only content that is
// *safe to emit* — any trailing partial tag is held back for the next chunk.
export function segment(buf: string): { text: string; thinking: string } {
  let safe = buf.slice(0, buf.length - pendingTagTail(buf));
  const pendingBareTool = findPendingBareToolSyntaxStart(safe);
  if (pendingBareTool !== -1) safe = safe.slice(0, pendingBareTool);
  let text = "";
  let thinking = "";
  let i = 0;
  while (i < safe.length) {
    if (safe.startsWith(OPEN_THINKING, i)) {
      const end = safe.indexOf(CLOSE_THINKING, i);
      const stop = end === -1 ? safe.length : end;
      thinking += safe.slice(i + OPEN_THINKING.length, stop);
      i = end === -1 ? safe.length : end + CLOSE_THINKING.length;
    } else if (safe.startsWith(OPEN_TOOL, i) || safe.startsWith(OPEN_TOOLS, i)) {
      // Suppress tool-call content from the visible stream entirely.
      const close = safe.startsWith(OPEN_TOOLS, i) ? CLOSE_TOOLS : CLOSE_TOOL;
      const end = safe.indexOf(close, i);
      i = end === -1 ? safe.length : end + close.length;
    } else if (safe.startsWith(CLOSE_TOOL, i)) {
      i += CLOSE_TOOL.length;
    } else if (safe.startsWith(CLOSE_TOOLS, i)) {
      i += CLOSE_TOOLS.length;
    } else {
      const recoverable = findRecoverableToolSyntax(safe, i);
      if (recoverable && recoverable.start === i) {
        i = recoverable.end;
        continue;
      }
      const nextThink = safe.indexOf(OPEN_THINKING, i);
      const nextTool = safe.indexOf(OPEN_TOOL, i);
      const nextTools = safe.indexOf(OPEN_TOOLS, i);
      const nextCloseTool = safe.indexOf(CLOSE_TOOL, i);
      const nextCloseTools = safe.indexOf(CLOSE_TOOLS, i);
      const candidates = [
        nextThink,
        nextTool,
        nextTools,
        nextCloseTool,
        nextCloseTools,
        recoverable?.start ?? -1,
      ].filter((n) => n !== -1);
      const next = candidates.length ? Math.min(...candidates) : safe.length;
      text += safe.slice(i, next);
      i = next;
    }
  }
  return { text, thinking };
}

// Remove <​thinking> blocks from text destined for the message history. The user
// sees reasoning stream live, but we don't replay it back into context on the
// next turn — that keeps the conversation lean and avoids anchoring the model to
// stale reasoning.
export function stripThinking(text: string): string {
  return text.replace(THINKING_RE, "").trim();
}

const JSON_SIMPLE_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

function hasFourHexDigits(text: string, start: number): boolean {
  return /^[0-9a-fA-F]{4}$/.test(text.slice(start, start + 4));
}

function isWindowsPathString(rawStringContent: string): boolean {
  return /^[A-Za-z]:\\/.test(rawStringContent) || rawStringContent.startsWith("\\\\");
}

function preserveWindowsPathBackslashes(rawStringContent: string): string {
  let out = "";
  for (let i = 0; i < rawStringContent.length; i++) {
    if (rawStringContent[i] !== "\\") {
      out += rawStringContent[i];
      continue;
    }

    let end = i + 1;
    while (rawStringContent[end] === "\\") end += 1;
    const run = rawStringContent.slice(i, end);
    out += run.length % 2 === 0 ? run : `${run}\\`;
    i = end - 1;
  }
  return out;
}

function rewriteJsonStringLiterals(
  text: string,
  transform: (rawStringContent: string) => string,
): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '"') {
      out += ch;
      continue;
    }

    let rawStringContent = "";
    let end = i + 1;
    while (end < text.length) {
      const cur = text[end];
      if (cur === '"') {
        let backslashes = 0;
        for (let j = end - 1; j > i && text[j] === "\\"; j--) backslashes += 1;
        if (backslashes % 2 === 0) break;
      }
      rawStringContent += cur;
      end += 1;
    }

    if (end >= text.length) {
      out += text.slice(i);
      break;
    }

    out += `"${transform(rawStringContent)}"`;
    i = end;
  }
  return out;
}

function preserveWindowsPaths(text: string): string {
  return rewriteJsonStringLiterals(text, (rawStringContent) =>
    isWindowsPathString(rawStringContent)
      ? preserveWindowsPathBackslashes(rawStringContent)
      : rawStringContent,
  );
}

function escapeInvalidJsonBackslashes(text: string): string {
  let out = "";
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) backslashes += 1;
      if (backslashes % 2 === 0) inString = !inString;
      out += ch;
      continue;
    }

    if (inString && ch === "\\") {
      const next = text[i + 1] ?? "";
      if (JSON_SIMPLE_ESCAPES.has(next) || (next === "u" && hasFourHexDigits(text, i + 2))) {
        out += ch;
      } else {
        out += "\\\\";
      }
      continue;
    }

    out += ch;
  }

  return out;
}

export function parseToolJson(raw: string): unknown {
  const windowsPathSafe = preserveWindowsPaths(raw);
  try {
    return JSON.parse(windowsPathSafe);
  } catch (err) {
    try {
      return JSON.parse(escapeInvalidJsonBackslashes(windowsPathSafe));
    } catch {
      throw err;
    }
  }
}

function toolArgs(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tool call args must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function parsedToolCallFrom(value: unknown): ParsedToolCall {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tool call JSON must be an object");
  }
  const item = value as { name?: unknown; args?: unknown };
  return {
    name: String(item.name ?? ""),
    args: toolArgs(item.args),
  };
}

export function parseNativeToolCalls(calls: NativeToolCall[]): ParsedToolCall[] {
  return calls.map((c) => {
    const args = c.argsJson ? parseToolJson(c.argsJson) : {};
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error(`arguments for ${c.name || "(missing tool name)"} must be a JSON object`);
    }
    return {
      id: c.id,
      name: c.name,
      args: args as Record<string, unknown>,
    };
  });
}

export function parseToolCalls(text: string): ParsedToolCall[] | null {
  const batch = text.match(TOOL_CALLS_RE);
  if (batch) {
    const parsed = parseToolJson(batch[1]);
    if (!Array.isArray(parsed)) throw new Error("tool_calls JSON must be an array");
    return parsed.map(parsedToolCallFrom);
  }

  const singles = [...text.matchAll(TOOL_CALL_RE_G)];
  if (singles.length > 0) return singles.map((single) => parsedToolCallFrom(parseToolJson(single[1])));

  const recoverable = findRecoverableToolSyntax(text);
  if (!recoverable) return null;
  const payload = text.slice(recoverable.start, recoverable.end);
  if (payload.endsWith(CLOSE_TOOLS)) {
    const parsed = parseToolJson(payload.slice(0, -CLOSE_TOOLS.length));
    if (!Array.isArray(parsed)) throw new Error("tool_calls JSON must be an array");
    return parsed.map(parsedToolCallFrom);
  }
  const parsed = parseToolJson(payload.slice(0, -CLOSE_TOOL.length));
  return [parsedToolCallFrom(parsed)];
}
