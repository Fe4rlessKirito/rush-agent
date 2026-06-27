import { describe, it, expect } from "vitest";
import { parseModelList } from "./modelParser";

describe("parseModelList", () => {
  it("parses the OpenAI /models shape ({ data: [{ id }] })", () => {
    const payload = {
      object: "list",
      data: [
        { id: "gpt-4o", object: "model", owned_by: "openai" },
        { id: "gpt-4o-mini", object: "model", owned_by: "openai" },
      ],
    };
    const out = parseModelList(payload);
    expect(out).toContain("gpt-4o");
    expect(out).toContain("gpt-4o-mini");
  });

  it("parses a bare array of id objects", () => {
    const out = parseModelList([{ id: "a" }, { id: "b" }]);
    expect(out).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("parses a bare array of strings", () => {
    const out = parseModelList(["llama3.1", "mistral"]);
    expect(out).toEqual(expect.arrayContaining(["llama3.1", "mistral"]));
  });

  it("reads the 'model' and 'name' id keys, not just 'id'", () => {
    const out = parseModelList({ data: [{ model: "by-model" }, { name: "by-name" }] });
    expect(out).toEqual(expect.arrayContaining(["by-model", "by-name"]));
  });

  it("walks grouped/nested model collections", () => {
    const payload = {
      modelGroups: [
        { name: "fast", models: [{ id: "flash-1" }, { id: "flash-2" }] },
        { name: "smart", models: [{ id: "pro-1" }] },
      ],
    };
    const out = parseModelList(payload);
    expect(out).toEqual(expect.arrayContaining(["flash-1", "flash-2", "pro-1"]));
  });

  it("appends the fallback model and de-duplicates it", () => {
    const out = parseModelList({ data: [{ id: "gpt-4o" }] }, "gpt-4o");
    expect(out.filter((m) => m === "gpt-4o")).toHaveLength(1);
  });

  it("includes the fallback even when the payload yields nothing", () => {
    const out = parseModelList({ unexpected: true }, "my-default");
    expect(out).toContain("my-default");
  });

  it("returns an empty list for junk with no fallback", () => {
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList(42)).toEqual([]);
    expect(parseModelList("a string")).toEqual([]);
  });

  it("trims whitespace and drops empty model ids", () => {
    const out = parseModelList({ data: [{ id: "  spaced  " }, { id: "   " }] });
    expect(out).toContain("spaced");
    expect(out).not.toContain("");
  });

  it("does not duplicate ids that appear twice", () => {
    const out = parseModelList({ data: [{ id: "dupe" }, { id: "dupe" }] });
    expect(out.filter((m) => m === "dupe")).toHaveLength(1);
  });
});
