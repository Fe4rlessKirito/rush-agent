import { describe, expect, it } from "vitest";
import { buildFlowRuntimeInstructions } from "./flowPrompt";

describe("buildFlowRuntimeInstructions", () => {
  it("instructs Flow to batch independent Agent calls and verify results", () => {
    const prompt = buildFlowRuntimeInstructions();

    expect(prompt).toContain("Rush Flow mode");
    expect(prompt).toContain("call Agent in a single <tool_calls> batch");
    expect(prompt).toContain("visible worker lane");
    expect(prompt).toContain("Verifier lane");
    expect(prompt).toContain("Do not batch destructive actions");
  });
});
