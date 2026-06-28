import { describe, expect, it } from "vitest";
import { filterProviderModels, groupModels, modelDisplayName } from "./modelGroups";

describe("groupModels", () => {
  it("groups obvious provider families and keeps the category order stable", () => {
    const groups = groupModels([
      "deepseek-v4-pro",
      "gpt-5-4",
      "claude-sonnet-4-6",
      "gemini-3-1-pro",
      "claude-opus-4-8",
      "qwen3-coder",
    ]);

    expect(groups.map((g) => g.label)).toEqual([
      "Claude",
      "OpenAI",
      "Gemini",
      "DeepSeek",
      "Qwen",
    ]);
    expect(groups[0].models).toEqual(["claude-opus-4-8", "claude-sonnet-4-6"]);
  });

  it("deduplicates and sorts natural model names", () => {
    const groups = groupModels(["llama3.1", "llama2", "llama3.1", "mistral-small", "mistral-large"]);
    expect(groups.find((g) => g.label === "Llama")?.models).toEqual(["llama3.1", "llama2"]);
    expect(groups.find((g) => g.label === "Mistral")?.models).toEqual(["mistral-large", "mistral-small"]);
  });

  it("formats model ids for option labels", () => {
    expect(modelDisplayName("claude-opus-4-8")).toBe("Claude Opus 4 8");
    expect(modelDisplayName("gpt-5-4")).toBe("GPT 5 4");
  });

  it("sorts OpenAI version variants from newest downward", () => {
    const groups = groupModels([
      "gpt-5",
      "gpt-5-2",
      "gpt-5-5",
      "gpt-5-4",
      "gpt-5-3",
      "gpt-5-5-mini",
      "gpt-5-4-mini",
    ]);

    expect(groups.find((g) => g.label === "OpenAI")?.models).toEqual([
      "gpt-5-5",
      "gpt-5-5-mini",
      "gpt-5-4",
      "gpt-5-4-mini",
      "gpt-5-3",
      "gpt-5-2",
      "gpt-5",
    ]);
  });

  it("filters Leech Anthropic to Claude models only", () => {
    expect(
      filterProviderModels("leech-proxy", [
        "claude-opus-4-8",
        "gpt-5-4",
        "gemini-3-1-pro",
        "claude-sonnet-4-6",
      ]),
    ).toEqual(["claude-opus-4-8", "claude-sonnet-4-6"]);
  });

  it("filters Leech OpenAI to non-Claude models", () => {
    expect(
      filterProviderModels("leech-proxy-openai", [
        "claude-opus-4-8",
        "gpt-5-4",
        "gemini-3-1-pro",
        "deepseek-v4-pro",
      ]),
    ).toEqual(["gpt-5-4", "gemini-3-1-pro", "deepseek-v4-pro"]);
  });

  it("leaves other provider model lists unchanged", () => {
    const models = ["claude-opus-4-8", "gpt-5-4"];
    expect(filterProviderModels("local-proxy", models)).toBe(models);
  });
});
