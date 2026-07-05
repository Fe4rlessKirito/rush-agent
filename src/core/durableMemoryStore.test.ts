import { describe, expect, it } from "vitest";
import { normalizeMemoryText, scoreMemoryFacts, type DurableMemoryFact } from "./durableMemoryStore";

describe("durable memory scoring", () => {
  it("normalizes whitespace and case for dedupe keys", () => {
    expect(normalizeMemoryText("  Use   SQLite For Memory  ")).toBe("use sqlite for memory");
  });

  it("ranks facts by lexical relevance", () => {
    const facts: DurableMemoryFact[] = [
      { id: "1", text: "The project uses React for the desktop UI", textNorm: "", type: "tech", source: "test", createdAt: 1, used: 0 },
      { id: "2", text: "Durable memory stores facts in SQLite-like persistent storage", textNorm: "", type: "tech", source: "test", createdAt: 2, used: 0 },
      { id: "3", text: "Release builds are signed before publishing", textNorm: "", type: "release", source: "test", createdAt: 3, used: 0 },
    ];

    const ranked = scoreMemoryFacts(facts, "persistent memory facts");
    expect(ranked[0].fact.id).toBe("2");
    expect(ranked.map((item) => item.fact.id)).not.toContain("1");
  });
});
