import { describe, expect, it } from "vitest";
import { chunkText, searchRagDocuments, type RagDocument } from "./ragStore";

describe("RAG document search", () => {
  it("chunks long content with overlap", () => {
    const content = "a".repeat(900);
    const chunks = chunkText(content, 400);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1].start).toBeLessThan(chunks[0].end);
  });

  it("returns matching chunks ranked by query term coverage", () => {
    const documents: RagDocument[] = [
      { id: "a", name: "api", content: "authentication tokens and github branches", source: "test", createdAt: 1, updatedAt: 1 },
      { id: "b", name: "notes", content: "spreadsheet import and document reader", source: "test", createdAt: 2, updatedAt: 2 },
    ];

    const results = searchRagDocuments(documents, "github token branches", 3, 300);
    expect(results[0].document.id).toBe("a");
    expect(results[0].score).toBeGreaterThan(0.5);
  });
});
