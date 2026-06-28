import { describe, expect, it } from "vitest";
import { fallbackFlowPlan, parseFlowPlan } from "./flowPlanner";

describe("flowPlanner", () => {
  it("parses and normalizes planner JSON", () => {
    const plan = parseFlowPlan(JSON.stringify({
      summary: "Split the work.",
      lanes: [
        { id: "Docs Lane", title: "Docs", task: "Inspect docs", dependsOn: [] },
        { id: "Tests", title: "Tests", task: "Run tests", dependsOn: ["docs-lane"] },
      ],
      verification: "Compare outputs.",
    }), "Build feature");

    expect(plan.summary).toBe("Split the work.");
    expect(plan.lanes).toHaveLength(2);
    expect(plan.lanes[0]).toMatchObject({ id: "docs-lane", title: "Docs", task: "Inspect docs" });
    expect(plan.verification).toBe("Compare outputs.");
  });

  it("extracts JSON from surrounding text", () => {
    const plan = parseFlowPlan('Plan:\n{"summary":"S","lanes":[{"title":"One","task":"Do it"}],"verification":"Check"}', "Fallback");

    expect(plan.lanes[0]).toMatchObject({ id: "worker-1", title: "One", task: "Do it" });
  });

  it("falls back when no lanes are usable", () => {
    const plan = parseFlowPlan('{"summary":"No lanes","lanes":[]}', "Ship it");

    expect(plan).toEqual(fallbackFlowPlan("Ship it"));
  });
});
