export interface ModelGroup {
  label: string;
  models: string[];
}

const CATEGORY_ORDER = [
  "Claude",
  "OpenAI",
  "Gemini",
  "DeepSeek",
  "Qwen",
  "Llama",
  "Mistral",
  "Grok",
  "Local",
  "Other",
] as const;

function categoryFor(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("claude") || m.includes("anthropic")) return "Claude";
  if (m.includes("gpt") || /^o[134]/.test(m) || m.includes("openai")) return "OpenAI";
  if (m.includes("gemini") || m.includes("palm")) return "Gemini";
  if (m.includes("deepseek")) return "DeepSeek";
  if (m.includes("qwen")) return "Qwen";
  if (m.includes("llama") || m.includes("codellama") || m.includes("meta-")) return "Llama";
  if (m.includes("mistral") || m.includes("mixtral") || m.includes("codestral")) return "Mistral";
  if (m.includes("grok") || m.includes("xai") || m.includes("x-ai")) return "Grok";
  if (m.includes("local") || m.includes("ollama")) return "Local";
  return "Other";
}

function qualityRank(model: string): number {
  const m = model.toLowerCase();
  const ordered = [
    "opus",
    "gpt-5",
    "o3",
    "o4",
    "sonnet",
    "pro",
    "gpt-4.1",
    "gpt-4o",
    "deepseek-v",
    "gemini-3",
    "haiku",
    "large",
    "medium",
    "flash",
    "mini",
    "small",
    "lite",
  ];
  const hit = ordered.findIndex((part) => m.includes(part));
  return hit === -1 ? ordered.length : hit;
}

function latestNumberRank(model: string): number {
  const numbers = model.match(/\d+(?:\.\d+)?/g)?.map(Number).filter(Number.isFinite) ?? [];
  return numbers.length ? -Math.max(...numbers) : 0;
}

function openAIVersionScore(model: string): number {
  const m = model.toLowerCase();
  const gpt = m.match(/\bgpt[-_]?(\d+)(?:[._-](\d+))?/);
  if (gpt) {
    const major = Number(gpt[1]);
    const minor = gpt[2] ? Number(gpt[2]) : 0;
    return major * 100 + minor;
  }
  const oSeries = m.match(/\bo(\d+)(?:[._-](\d+))?/);
  if (oSeries) {
    const major = Number(oSeries[1]);
    const minor = oSeries[2] ? Number(oSeries[2]) : 0;
    return major * 100 + minor;
  }
  return 0;
}

function openAISizeRank(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("mini")) return 1;
  if (m.includes("nano")) return 2;
  return 0;
}

function compareOpenAIModels(a: string, b: string): number {
  const version = openAIVersionScore(b) - openAIVersionScore(a);
  if (version !== 0) return version;
  const size = openAISizeRank(a) - openAISizeRank(b);
  if (size !== 0) return size;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function compareModels(a: string, b: string): number {
  if (categoryFor(a) === "OpenAI" && categoryFor(b) === "OpenAI") {
    return compareOpenAIModels(a, b);
  }
  const quality = qualityRank(a) - qualityRank(b);
  if (quality !== 0) return quality;
  const latest = latestNumberRank(a) - latestNumberRank(b);
  if (latest !== 0) return latest;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function groupModels(models: string[]): ModelGroup[] {
  const unique = Array.from(new Set(models.filter((m) => m.trim()).map((m) => m.trim())));
  const grouped = new Map<string, string[]>();
  for (const model of unique) {
    const label = categoryFor(model);
    grouped.set(label, [...(grouped.get(label) ?? []), model]);
  }

  return CATEGORY_ORDER.map((label) => ({
    label,
    models: (grouped.get(label) ?? []).sort(compareModels),
  })).filter((group) => group.models.length > 0);
}

export function modelDisplayName(model: string): string {
  return model
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bGpt\b/g, "GPT")
    .replace(/\bAi\b/g, "AI")
    .replace(/\bApi\b/g, "API");
}

export function filterProviderModels(providerId: string, models: string[]): string[] {
  if (providerId === "leech-proxy") {
    return models.filter((model) => model.toLowerCase().includes("claude"));
  }
  if (providerId === "leech-proxy-openai") {
    return models.filter((model) => !model.toLowerCase().includes("claude"));
  }
  return models;
}
