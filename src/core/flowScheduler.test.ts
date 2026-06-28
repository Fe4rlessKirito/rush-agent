import { describe, expect, it } from "vitest";
import { ToolRegistry } from "./agent/tools";
import { formatSchedulerResults, runFlowScheduledLane, runFlowScheduler } from "./flowScheduler";
import type { FlowPlan } from "./flowStore";
import type { ChatRequest, Provider, ProviderConfig } from "./providers/types";

function fakeProvider(requests: ChatRequest[] = []): Provider {
  const config: ProviderConfig = {
    id: "fake",
    label: "Fake",
    kind: "custom",
    baseUrl: "http://localhost",
    defaultModel: "fake-model",
    enabled: true,
  };

  return {
    config,
    async listModels() {
      return ["fake-model"];
    },
    async *streamChat(req: ChatRequest) {
      requests.push(req);
      const last = req.messages[req.messages.length - 1]?.content;
      const task = typeof last === "string" ? last : JSON.stringify(last);
      if (task.includes("fail")) throw new Error(`failed ${task}`);
      yield { delta: `result for ${task}`, done: false };
      yield { delta: "", done: true };
    },
  };
}

function tools(): ToolRegistry {
  return new ToolRegistry();
}

describe("flowScheduler", () => {
  it("runs independent lanes and returns their outputs", async () => {
    const plan: FlowPlan = {
      summary: "Do two things.",
      verification: "Check both.",
      lanes: [
        { id: "a", title: "Alpha", task: "alpha task", dependsOn: [] },
        { id: "b", title: "Beta", task: "beta task", dependsOn: [] },
      ],
    };

    const results = await runFlowScheduler({
      provider: fakeProvider(),
      model: "fake-model",
      tools: tools(),
      plan,
    });

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.map((result) => result.output)).toEqual(
      expect.arrayContaining(["result for alpha task", "result for beta task"]),
    );
  });

  it("respects lane dependencies", async () => {
    const starts: string[] = [];
    const plan: FlowPlan = {
      summary: "Chain work.",
      verification: "Check order.",
      lanes: [
        { id: "first", title: "First", task: "first task", dependsOn: [] },
        { id: "second", title: "Second", task: "second task", dependsOn: ["first"] },
      ],
    };

    const results = await runFlowScheduler({
      provider: fakeProvider(),
      model: "fake-model",
      tools: tools(),
      plan,
      onLaneStart: (lane) => starts.push(lane.id),
    });

    expect(results.map((result) => result.lane.id)).toEqual(["first", "second"]);
    expect(starts).toEqual(["first", "second"]);
  });

  it("blocks lanes whose dependencies failed", async () => {
    const errors: string[] = [];
    const plan: FlowPlan = {
      summary: "Fail one thing.",
      verification: "Report failure.",
      lanes: [
        { id: "bad", title: "Bad", task: "fail this lane", dependsOn: [] },
        { id: "after", title: "After", task: "after task", dependsOn: ["bad"] },
      ],
    };

    const results = await runFlowScheduler({
      provider: fakeProvider(),
      model: "fake-model",
      tools: tools(),
      plan,
      onLaneError: (_lane, error) => errors.push(error),
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: false, lane: { id: "bad" } });
    expect(results[1]).toMatchObject({ ok: false, lane: { id: "after" } });
    expect(results[1].error).toContain("dependency failed");
    expect(errors).toHaveLength(2);
  });

  it("skips lanes that should no longer run", async () => {
    const requests: ChatRequest[] = [];
    const skipped: string[] = [];
    const plan: FlowPlan = {
      summary: "Cancel one thing.",
      verification: "Report skip.",
      lanes: [
        { id: "cancelled", title: "Cancelled", task: "cancelled task", dependsOn: [] },
      ],
    };

    const results = await runFlowScheduler({
      provider: fakeProvider(requests),
      model: "fake-model",
      tools: tools(),
      plan,
      shouldRunLane: () => false,
      onLaneSkip: (lane, reason) => skipped.push(`${lane.id}: ${reason}`),
    });

    expect(requests).toHaveLength(0);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false, skipped: true, lane: { id: "cancelled" } });
    expect(skipped[0]).toContain("cancelled");
  });

  it("passes lane-specific abort signals to scheduled lanes", async () => {
    const requests: ChatRequest[] = [];
    const controller = new AbortController();
    const plan: FlowPlan = {
      summary: "Signal one thing.",
      verification: "Check signal.",
      lanes: [
        { id: "signalled", title: "Signalled", task: "signal task", dependsOn: [] },
      ],
    };

    const result = await runFlowScheduledLane(
      {
        provider: fakeProvider(requests),
        model: "fake-model",
        tools: tools(),
        plan,
        getLaneSignal: () => controller.signal,
      },
      plan.lanes[0],
    );

    expect(result.ok).toBe(true);
    expect(requests[0].signal).toBe(controller.signal);
  });

  it("skips lanes whose lane-specific signal is already aborted", async () => {
    const requests: ChatRequest[] = [];
    const controller = new AbortController();
    controller.abort();
    const plan: FlowPlan = {
      summary: "Abort one thing.",
      verification: "Check abort.",
      lanes: [
        { id: "aborted", title: "Aborted", task: "aborted task", dependsOn: [] },
      ],
    };

    const result = await runFlowScheduledLane(
      {
        provider: fakeProvider(requests),
        model: "fake-model",
        tools: tools(),
        plan,
        getLaneSignal: () => controller.signal,
      },
      plan.lanes[0],
    );

    expect(requests).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, skipped: true, lane: { id: "aborted" } });
  });

  it("formats scheduler results for the final Flow synthesis prompt", () => {
    const report = formatSchedulerResults([
      {
        lane: { id: "docs", title: "Docs", task: "Read docs", dependsOn: [] },
        ok: true,
        output: "Docs are ready.",
      },
      {
        lane: { id: "tests", title: "Tests", task: "Run tests", dependsOn: ["docs"] },
        ok: false,
        output: "",
        error: "Tests failed.",
      },
      {
        lane: { id: "cancelled", title: "Cancelled", task: "Cancel it", dependsOn: [] },
        ok: false,
        output: "",
        error: "User cancelled it.",
        skipped: true,
      },
    ]);

    expect(report).toContain("## Docs [completed]");
    expect(report).toContain("Docs are ready.");
    expect(report).toContain("## Tests [blocked]");
    expect(report).toContain("Tests failed.");
    expect(report).toContain("## Cancelled [skipped]");
  });

  it("includes dependency results when running one scheduled lane", async () => {
    const requests: ChatRequest[] = [];
    const plan: FlowPlan = {
      summary: "Use prior work.",
      verification: "Check final.",
      lanes: [
        { id: "source", title: "Source", task: "source task", dependsOn: [] },
        { id: "target", title: "Target", task: "target task", dependsOn: ["source"] },
      ],
    };

    const result = await runFlowScheduledLane(
      {
        provider: fakeProvider(requests),
        model: "fake-model",
        tools: tools(),
        plan,
      },
      plan.lanes[1],
      [{ lane: plan.lanes[0], ok: true, output: "source output" }],
    );

    expect(result.ok).toBe(true);
    expect(requests[0].messages[0].content).toContain("Completed dependency lane results");
    expect(requests[0].messages[0].content).toContain("source output");
  });
});
