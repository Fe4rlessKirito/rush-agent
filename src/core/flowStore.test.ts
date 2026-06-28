import { beforeEach, describe, expect, it } from "vitest";
import { buildFlowRunReport, useFlowStore } from "./flowStore";

describe("flowStore", () => {
  beforeEach(() => {
    useFlowStore.setState({ runs: [], activeRunId: "" });
  });

  it("creates a lane-based flow run", () => {
    const run = useFlowStore.getState().startRun("Build the feature");

    expect(run.status).toBe("running");
    expect(useFlowStore.getState().activeRunId).toBe(run.id);
    expect(run.lanes.map((lane) => lane.id)).toEqual(["planner", "worker", "verifier"]);
  });

  it("updates lane status and derives run status", () => {
    const run = useFlowStore.getState().startRun("Build the feature");

    useFlowStore.getState().setLaneStatus(run.id, "planner", "completed");
    useFlowStore.getState().setLaneStatus(run.id, "worker", "completed");
    useFlowStore.getState().setLaneStatus(run.id, "verifier", "completed");

    const updated = useFlowStore.getState().runs[0];
    expect(updated.status).toBe("completed");
  });

  it("appends lane output and cancels unfinished lanes", () => {
    const run = useFlowStore.getState().startRun("Build the feature");

    useFlowStore.getState().appendLaneOutput(run.id, "worker", "ran tests");
    useFlowStore.getState().setLaneOutput(run.id, "worker", "replaced output");
    useFlowStore.getState().cancelRun(run.id);

    const updated = useFlowStore.getState().runs[0];
    expect(updated.status).toBe("cancelled");
    expect(updated.lanes.find((lane) => lane.id === "worker")?.output).toBe("replaced output");
    expect(updated.lanes.every((lane) => lane.status === "cancelled")).toBe(true);
  });

  it("creates dynamic worker lanes before the verifier", () => {
    const run = useFlowStore.getState().startRun("Build the feature");

    const worker = useFlowStore.getState().createWorkerLane(run.id, "Worker 1", "Do the first slice");

    expect(worker?.id).toMatch(/^worker_/);
    const updated = useFlowStore.getState().runs[0];
    expect(updated.lanes.map((lane) => lane.role)).toEqual(["planner", "worker", "worker", "verifier"]);
    expect(updated.lanes[2]).toMatchObject({ id: worker?.id, title: "Worker 1" });
  });

  it("cancels, retries, and ignores individual lanes", () => {
    const run = useFlowStore.getState().startRun("Build the feature");
    const worker = useFlowStore.getState().createWorkerLane(run.id, "Worker 1", "Do the first slice");
    expect(worker).toBeTruthy();

    useFlowStore.getState().cancelLane(run.id, worker!.id);
    let updated = useFlowStore.getState().runs[0];
    expect(updated.status).toBe("running");
    expect(updated.lanes.find((lane) => lane.id === worker!.id)?.status).toBe("cancelled");

    useFlowStore.getState().retryLane(run.id, worker!.id);
    updated = useFlowStore.getState().runs[0];
    expect(updated.lanes.find((lane) => lane.id === worker!.id)).toMatchObject({
      status: "pending",
      output: "",
      summary: "Queued for retry.",
    });

    useFlowStore.getState().ignoreLane(run.id, worker!.id);
    updated = useFlowStore.getState().runs[0];
    expect(updated.lanes.find((lane) => lane.id === worker!.id)?.status).toBe("ignored");
  });

  it("allows ignored lanes to complete the run", () => {
    const run = useFlowStore.getState().startRun("Build the feature");
    const worker = useFlowStore.getState().createWorkerLane(run.id, "Worker 1", "Do the first slice");
    expect(worker).toBeTruthy();

    useFlowStore.getState().setLaneStatus(run.id, "planner", "completed");
    useFlowStore.getState().setLaneStatus(run.id, "worker", "completed");
    useFlowStore.getState().ignoreLane(run.id, worker!.id);
    useFlowStore.getState().setLaneStatus(run.id, "verifier", "completed");

    const updated = useFlowStore.getState().runs[0];
    expect(updated.status).toBe("completed");
  });

  it("builds a structured flow report", () => {
    const run = useFlowStore.getState().startRun("Build the feature");
    useFlowStore.getState().setPlan(run.id, {
      summary: "Plan summary",
      lanes: [{ id: "worker-1", title: "Worker 1", task: "Do the first slice", dependsOn: [] }],
      verification: "Verify the slice",
    });
    const worker = useFlowStore.getState().createWorkerLane(run.id, "Worker 1", "Do the first slice");
    expect(worker).toBeTruthy();
    useFlowStore.getState().appendLaneOutput(run.id, "planner", "Plan output");
    useFlowStore.getState().appendLaneOutput(run.id, worker!.id, "Worker output");
    useFlowStore.getState().appendLaneOutput(run.id, "verifier", "Verifier output");

    const report = buildFlowRunReport(useFlowStore.getState().runs[0]);

    expect(report).toContain("# Flow Report: Build the feature");
    expect(report).toContain("Plan: Plan summary");
    expect(report).toContain("Planned lanes:");
    expect(report).toContain("- Worker 1: Do the first slice");
    expect(report).toContain("Verification: Verify the slice");
    expect(report).toContain("## Planner");
    expect(report).toContain("Plan output");
    expect(report).toContain("## Workers");
    expect(report).toContain("Worker output");
    expect(report).toContain("## Verifier");
    expect(report).toContain("Verifier output");
  });
});
