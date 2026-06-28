import { describe, expect, it } from "vitest";
import { createPlanningTools, PlanningStore } from "./planningTools";

function toolMap(store = new PlanningStore()) {
  return {
    store,
    tools: new Map(createPlanningTools(store).map((tool) => [tool.definition.name, tool])),
  };
}

describe("planning tools", () => {
  it("enters and exits plan mode with a recorded plan", async () => {
    const { store, tools } = toolMap();

    const entered = await tools.get("EnterPlanMode")!.execute({ reason: "Needs sequencing" });
    expect(entered.content).toContain("Plan mode entered");
    expect(store.snapshot().inPlanMode).toBe(true);

    const exited = await tools.get("ExitPlanMode")!.execute({ plan: "1. Inspect\n2. Patch\n3. Test" });
    expect(exited.content).toContain("Plan recorded");
    expect(store.snapshot().inPlanMode).toBe(false);
    expect(store.snapshot().lastPlan).toContain("Inspect");
  });

  it("formats a bounded user question and records it", async () => {
    const { store, tools } = toolMap();

    const result = await tools.get("AskUserQuestion")!.execute({
      question: "Which mode should own this?",
      choices: [
        { label: "Code", description: "Filesystem access" },
        { label: "Chat", description: "No tools" },
      ],
    });

    expect(result.content).toContain("Question for user");
    expect(result.content).toContain("1. Code - Filesystem access");
    expect(store.snapshot().pendingQuestion).toContain("Which mode");
  });

  it("replaces the todo checklist", async () => {
    const { store, tools } = toolMap();

    const result = await tools.get("TodoWrite")!.execute({
      todos: [
        { content: "Inspect", status: "completed" },
        { content: "Patch", status: "in_progress" },
        { content: "Test" },
      ],
    });

    expect(result.content).toContain("[completed] Inspect");
    expect(result.content).toContain("[in_progress] Patch");
    expect(result.content).toContain("[pending] Test");
    expect(store.snapshot().todos).toHaveLength(3);
  });
});
