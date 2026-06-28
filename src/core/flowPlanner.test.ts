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
    expect(plan.lanes[1].dependsOn).toEqual(["docs-lane"]);
    expect(plan.verification).toBe("Compare outputs.");
  });

  it("normalizes dependency ids with the same rules as lane ids", () => {
    const plan = parseFlowPlan(JSON.stringify({
      lanes: [
        { id: "Worker 1", title: "First", task: "Do first" },
        { id: "Worker 2", title: "Second", task: "Do second", dependsOn: ["Worker 1"] },
      ],
    }), "Fallback");

    expect(plan.lanes[0].id).toBe("worker-1");
    expect(plan.lanes[1].dependsOn).toEqual(["worker-1"]);
  });

  it("drops self, duplicate, and unknown dependencies", () => {
    const plan = parseFlowPlan(JSON.stringify({
      lanes: [
        { id: "A", task: "Do A", dependsOn: ["A", "missing"] },
        { id: "B", task: "Do B", dependsOn: ["A", "a", "missing"] },
      ],
    }), "Fallback");

    expect(plan.lanes[0].dependsOn).toEqual([]);
    expect(plan.lanes[1].dependsOn).toEqual(["a"]);
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
