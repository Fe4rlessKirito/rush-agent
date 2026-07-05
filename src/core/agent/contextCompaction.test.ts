import { describe, expect, it } from "vitest";
import {
  buildSummaryMessage,
  mergeCompactContexts,
  normalizeCompactContext,
  prepareContextMessages,
  shouldCompact,
  splitForCompaction,
  type CompactContext,
} from "./contextCompaction";
import type { ChatChunk, ChatRequest, Provider, ProviderConfig } from "../providers/types";

class SummaryProvider implements Provider {
  readonly config: ProviderConfig = {
    id: "test",
    label: "Test",
    kind: "custom",
    baseUrl: "http://localhost",
    defaultModel: "test-model",
    enabled: true,
  };
  readonly requests: ChatRequest[] = [];

  async listModels(): Promise<string[]> {
    return ["test-model"];
  }

  async *streamChat(req: ChatRequest): AsyncGenerator<ChatChunk> {
    this.requests.push(req);
    yield {
      delta: JSON.stringify({
        goal: "Ship context compaction",
        currentState: ["Compaction is being implemented"],
        decisions: ["Use a structured summary"],
        filesChanged: [{ path: "src/core/agent/contextCompaction.ts", summary: "Adds compaction helpers" }],
        verification: ["Tests pending"],
        releaseState: "Unreleased",
        durableCommands: ["npm test -- --run"],
        nextSteps: ["Wire into runAgent"],
      }),
      done: false,
    };
    yield { delta: "", done: true };
  }
}

function summary(overrides: Partial<CompactContext> = {}): CompactContext {
  return {
    goal: "Existing goal",
    currentState: [],
    decisions: [],
    filesChanged: [],
    verification: [],
    durableCommands: [],
    nextSteps: [],
    ...overrides,
  };
}

describe("context compaction", () => {
  it("detects when messages exceed the configured budget", () => {
    expect(shouldCompact([{ role: "user", content: "x".repeat(20) }], { maxChars: 10 })).toBe(true);
    expect(shouldCompact([{ role: "user", content: "short" }], { maxChars: 100 })).toBe(false);
  });

  it("splits the system prompt, compactable middle, and recent tail", () => {
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "old 1" },
      { role: "assistant" as const, content: "old 2" },
      { role: "user" as const, content: "new 1" },
      { role: "assistant" as const, content: "new 2" },
    ];

    const split = splitForCompaction(messages, { keepRecentMessages: 2 });

    expect(split.system).toEqual(messages[0]);
    expect(split.compact).toEqual([messages[1], messages[2]]);
    expect(split.keep).toEqual([messages[3], messages[4]]);
  });

  it("normalizes malformed summary data into the fixed schema", () => {
    expect(normalizeCompactContext({
      goal: " Goal ",
      currentState: ["done", 1, ""],
      filesChanged: [{ path: " a.ts ", summary: " changed " }, { path: "bad" }],
    })).toMatchObject({
      goal: "Goal",
      currentState: ["done"],
      filesChanged: [{ path: "a.ts", summary: "changed" }],
      decisions: [],
    });
  });

  it("merges previous and next summaries without duplicating list entries", () => {
    const merged = mergeCompactContexts(
      summary({ decisions: ["Use JSON"], filesChanged: [{ path: "a.ts", summary: "old" }] }),
      summary({ goal: "New goal", decisions: ["Use JSON", "Keep recent raw turns"], filesChanged: [{ path: "a.ts", summary: "new" }] }),
    );

    expect(merged.goal).toBe("New goal");
    expect(merged.decisions).toEqual(["Use JSON", "Keep recent raw turns"]);
    expect(merged.filesChanged).toEqual([{ path: "a.ts", summary: "new" }]);
  });

  it("builds an internal system summary message", () => {
    const message = buildSummaryMessage(summary({ goal: "Compact context", nextSteps: ["Run tests"] }));

    expect(message.role).toBe("system");
    expect(String(message.content)).toContain("Conversation memory summary");
    expect(String(message.content)).toContain("Compact context");
    expect(String(message.content)).toContain("Run tests");
  });

  it("uses the provider to compact old messages and keeps recent raw messages", async () => {
    const provider = new SummaryProvider();
    const messages = [
      { role: "system" as const, content: "system prompt" },
      { role: "user" as const, content: "old".repeat(20) },
      { role: "assistant" as const, content: "middle".repeat(20) },
      { role: "user" as const, content: "latest request" },
    ];

    const prepared = await prepareContextMessages({
      provider,
      model: "test-model",
      messages,
      budget: { maxChars: 50, keepRecentMessages: 1 },
    });

    expect(prepared.compacted).toBe(true);
    expect(prepared.summary?.goal).toBe("Ship context compaction");
    expect(provider.requests).toHaveLength(1);
    expect(prepared.messages[0]).toEqual(messages[0]);
    expect(prepared.messages[1].role).toBe("system");
    expect(prepared.messages.at(-1)).toEqual(messages.at(-1));
  });
});
