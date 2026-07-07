import type { Attachment } from "./chatAttachments";

export interface ProviderEndpointConfig {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export function supportsNativeImageContent(cfg: { kind?: string; baseUrl?: string } | undefined): boolean {
  const baseUrl = cfg?.baseUrl?.toLowerCase() ?? "";
  return (
    (cfg?.kind === "openai" && baseUrl.includes("api.openai.com")) ||
    (cfg?.kind === "anthropic" && baseUrl.includes("api.anthropic.com"))
  );
}

function providerHeaders(cfg: { apiKey?: string; headers?: Record<string, string> }): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  return { ...headers, ...(cfg.headers ?? {}) };
}

function multipartHeaders(cfg: { apiKey?: string; headers?: Record<string, string> }): Record<string, string> {
  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const extra = { ...(cfg.headers ?? {}) };
  delete extra["Content-Type"];
  delete extra["content-type"];
  return { ...headers, ...extra };
}

export async function* streamImageChat({
  cfg,
  imageAttachment,
  question,
  model,
  signal,
}: {
  cfg: ProviderEndpointConfig;
  imageAttachment: Attachment;
  question: string;
  model: string | null;
  signal?: AbortSignal;
}) {
  if (!imageAttachment.dataUrl) return;
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/with-image`, {
    method: "POST",
    headers: providerHeaders(cfg),
    signal,
    body: JSON.stringify({
      model,
      image: imageAttachment.dataUrl,
      filename: imageAttachment.name,
      question:
        question.trim() ||
        `What do you see in the attached image ${imageAttachment.name}?`,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`image chat ${res.status}: ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      const json = JSON.parse(payload);
      const delta =
        json.delta ??
        json.token ??
        json.choices?.[0]?.delta?.content ??
        json.choices?.[0]?.message?.content ??
        "";
      if (delta) yield String(delta);
    }
  }
}

export async function uploadFileChat({
  cfg,
  fileAttachment,
  question,
  model,
  signal,
}: {
  cfg: ProviderEndpointConfig;
  fileAttachment: Attachment;
  question: string;
  model: string | null;
  signal?: AbortSignal;
}): Promise<string> {
  const form = new FormData();
  form.append("file", fileAttachment.file, fileAttachment.name);
  form.append("question", question.trim() || "Please analyse this file.");
  form.append("model", model ?? "default");

  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/upload-file`, {
    method: "POST",
    headers: multipartHeaders(cfg),
    signal,
    body: form,
  });
  if (!res.ok) throw new Error(`file chat ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return String(
    json.analysis ??
    json.choices?.[0]?.message?.content ??
    json.content?.[0]?.text ??
    "",
  );
}

export async function streamImageEndpointAttachments({
  cfg,
  imageAttachments,
  question,
  model,
  signal,
  appendText,
  afterDelta,
}: {
  cfg: ProviderEndpointConfig;
  imageAttachments: Attachment[];
  question: string;
  model: string | null;
  signal?: AbortSignal;
  appendText: (text: string) => void;
  afterDelta?: () => Promise<void>;
}): Promise<string> {
  let text = "";
  for (const item of imageAttachments) {
    if (imageAttachments.length > 1) {
      const label = `\n\n${item.name}\n`;
      text += label;
      appendText(label);
    }
    for await (const delta of streamImageChat({ cfg, imageAttachment: item, question, model, signal })) {
      text += delta;
      appendText(delta);
      await afterDelta?.();
    }
  }
  return text;
}

export async function uploadFileEndpointAttachments({
  cfg,
  fileAttachments,
  question,
  model,
  signal,
  appendText,
}: {
  cfg: ProviderEndpointConfig;
  fileAttachments: Attachment[];
  question: string;
  model: string | null;
  signal?: AbortSignal;
  appendText: (text: string) => void;
}): Promise<string> {
  let text = "";
  for (const item of fileAttachments) {
    if (fileAttachments.length > 1) {
      const label = `\n\n${item.name}\n`;
      text += label;
      appendText(label);
    }
    const result = await uploadFileChat({ cfg, fileAttachment: item, question, model, signal });
    text += result;
    appendText(result || "No file analysis returned.");
  }
  return text;
}
