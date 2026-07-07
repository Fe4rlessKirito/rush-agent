import type { ChatMessage } from "../../core/providers/types";
import type { Attachment } from "./chatAttachments";

export function contentText(value: ChatMessage["content"]): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => part.type === "text" ? part.text : `[${part.type}]`).join("\n");
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function modelContextLimit(model: string | null): number {
  const name = (model ?? "").toLowerCase();
  if (/claude|gemini|gpt-5/.test(name)) return 200_000;
  if (/gpt-4o|\bo[13]\b|o3|o4/.test(name)) return 128_000;
  return 128_000;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

export function normalizePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function estimateContextWindowUsage({
  messages,
  input,
  contextItems,
  attachments,
}: {
  messages: ChatMessage[];
  input: string;
  contextItems: Array<{ text: string }>;
  attachments: Attachment[];
}): number {
  const messageTokens = messages.reduce((sum, message) => sum + estimateTokens(contentText(message.content)), 0);
  const inputTokens = estimateTokens(input);
  const libraryTokens = contextItems.reduce((sum, item) => sum + estimateTokens(item.text), 0);
  const attachmentTokens = attachments.reduce((sum, item) => sum + estimateTokens(`${item.name} ${item.type || "attachment"}`), 0);
  return messageTokens + inputTokens + libraryTokens + attachmentTokens;
}
