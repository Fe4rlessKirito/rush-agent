import type { FlowLane, FlowLaneStatus, FlowPlan, FlowRunStatus } from "../../core/flowStore";
import { useFlowStore } from "../../core/flowStore";
import { buildFlowPlan } from "../../core/flowPlanner";
import { formatSchedulerResults, runFlowScheduler } from "../../core/flowScheduler";
import { registerFlowLaneController, unregisterFlowLaneController } from "../../core/flowRuntime";
import type { ToolRegistry } from "../../core/agent/tools";
import type { Provider } from "../../core/providers/types";
import type { CodeFlowAgentEventFlowCallbacks } from "./chatAgentEvents";

interface FlowSendRuntimeOptions {
  provider: Provider;
  model: string;
  tools: ToolRegistry;
  flowRunId: string;
  userText: string;
  signal: AbortSignal;
  baseFlowContext: string;
  projectInstructions: string;
  getRunLanes: () => FlowLane[];
  setPlan: (plan: FlowPlan) => void;
  setLaneStatus: (laneId: string, status: FlowLaneStatus, summary?: string) => void;
  createWorkerLane: (title: string, summary?: string, planLaneId?: string) => FlowLane | null;
  appendLaneOutput: (laneId: string, output: string) => void;
  completeRun: (status: FlowRunStatus) => void;
}

export interface FlowSendRuntimeResult {
  ok: boolean;
  flowContext: string;
  error?: string;
}

export function flowSendStoreCallbacks(flowRunId: string) {
  return {
    getRunLanes: () => useFlowStore.getState().runs.find((run) => run.id === flowRunId)?.lanes ?? [],
    setPlan: (plan: FlowPlan) => useFlowStore.getState().setPlan(flowRunId, plan),
    setLaneStatus: (laneId: string, status: FlowLaneStatus, summary?: string) => {
      useFlowStore.getState().setLaneStatus(flowRunId, laneId, status, summary);
    },
    createWorkerLane: (title: string, summary?: string, planLaneId?: string) =>
      useFlowStore.getState().createWorkerLane(flowRunId, title, summary, planLaneId),
    appendLaneOutput: (laneId: string, output: string) => {
      useFlowStore.getState().appendLaneOutput(flowRunId, laneId, output);
    },
    completeRun: (status: FlowRunStatus) => {
      useFlowStore.getState().completeRun(flowRunId, status);
    },
  } satisfies Pick<FlowSendRuntimeOptions,
    | "getRunLanes"
    | "setPlan"
    | "setLaneStatus"
    | "createWorkerLane"
    | "appendLaneOutput"
    | "completeRun"
  >;
}

export function flowAgentEventStoreCallbacks(flowRunId: string | null): CodeFlowAgentEventFlowCallbacks {
  return {
    appendLaneOutput: (laneId, output) => {
      if (!flowRunId) return;
      useFlowStore.getState().appendLaneOutput(flowRunId, laneId, output);
    },
    setLaneStatus: (laneId, status, summary) => {
      if (!flowRunId) return;
      useFlowStore.getState().setLaneStatus(flowRunId, laneId, status, summary);
    },
    completeRun: (status) => {
      if (!flowRunId) return;
      useFlowStore.getState().completeRun(flowRunId, status);
    },
    findPlannedAgentLane: (taskTitle) => {
      if (!flowRunId) return null;
      const currentRun = useFlowStore.getState().runs.find((run) => run.id === flowRunId);
      return currentRun?.lanes.find((lane) =>
        lane.role === "worker" &&
        lane.status === "pending" &&
        (lane.summary === taskTitle || lane.title === taskTitle || taskTitle.includes(lane.title)),
      ) ?? null;
    },
    createWorkerLane: (title, summary) => {
      if (!flowRunId) return { id: "worker" };
      return useFlowStore.getState().createWorkerLane(flowRunId, title, summary) ?? { id: "worker" };
    },
  };
}

export async function prepareFlowSendRuntime({
  provider,
  model,
  tools,
  flowRunId,
  userText,
  signal,
  baseFlowContext,
  projectInstructions,
  getRunLanes,
  setPlan,
  setLaneStatus,
  createWorkerLane,
  appendLaneOutput,
  completeRun,
}: FlowSendRuntimeOptions): Promise<FlowSendRuntimeResult> {
  try {
    const plan = await buildFlowPlan(provider, model, userText, signal);
    setPlan(plan);
    setLaneStatus("planner", "completed", plan.summary);
    for (const lane of plan.lanes) {
      createWorkerLane(lane.title, lane.task, lane.id);
    }

    const runtimeLaneFor = (planLaneId: string) => getRunLanes().find((item) => item.planLaneId === planLaneId);
    const canRunPlanLane = (planLaneId: string) => {
      const runtimeLane = runtimeLaneFor(planLaneId);
      return runtimeLane ? runtimeLane.status !== "cancelled" && runtimeLane.status !== "ignored" : true;
    };
    const unregisterPlanLane = (planLaneId: string) => {
      const runtimeLane = runtimeLaneFor(planLaneId);
      if (runtimeLane) unregisterFlowLaneController(flowRunId, runtimeLane.id);
    };

    setLaneStatus("worker", "running", "Scheduling planned worker lanes.");
    const schedulerResults = await runFlowScheduler({
      provider,
      model,
      tools,
      plan,
      signal,
      projectInstructions,
      shouldRunLane(lane) {
        return canRunPlanLane(lane.id);
      },
      getLaneSignal(lane) {
        const runtimeLane = runtimeLaneFor(lane.id);
        if (!runtimeLane || !canRunPlanLane(lane.id)) return undefined;
        const controller = new AbortController();
        registerFlowLaneController(flowRunId, runtimeLane.id, controller);
        return controller.signal;
      },
      onLaneStart(lane) {
        const runtimeLane = runtimeLaneFor(lane.id);
        if (!runtimeLane || !canRunPlanLane(lane.id)) return;
        setLaneStatus(runtimeLane.id, "running", lane.task);
      },
      onLaneComplete(lane, output) {
        const runtimeLane = runtimeLaneFor(lane.id);
        if (!runtimeLane || !canRunPlanLane(lane.id)) return;
        appendLaneOutput(runtimeLane.id, output);
        setLaneStatus(runtimeLane.id, "completed", "Scheduler completed this worker lane.");
        unregisterPlanLane(lane.id);
      },
      onLaneError(lane, error) {
        const runtimeLane = runtimeLaneFor(lane.id);
        if (!runtimeLane || !canRunPlanLane(lane.id)) return;
        appendLaneOutput(runtimeLane.id, error);
        setLaneStatus(runtimeLane.id, "blocked", error);
        unregisterPlanLane(lane.id);
      },
      onLaneSkip(lane) {
        unregisterPlanLane(lane.id);
      },
    });
    setLaneStatus("worker", "completed", "Scheduled worker lanes finished.");

    const schedulerContext = formatSchedulerResults(schedulerResults);
    return {
      ok: true,
      flowContext: [
        "You are Rush in Code mode. You may use workspace tools directly and may call Agent whenever a focused subagent would help with independent investigation, verification, or parallelizable work. Batch independent Agent calls with <tool_calls> when useful, keep subagent tasks concrete, and synthesize their results before answering. Do tightly coupled or sequential edits yourself instead of delegating everything.",
        baseFlowContext,
        "# Deterministic Flow plan",
        `Summary: ${plan.summary}`,
        "Worker lanes:",
        ...plan.lanes.map((lane) => `- ${lane.id} / ${lane.title}: ${lane.task}${lane.dependsOn.length ? ` (depends on ${lane.dependsOn.join(", ")})` : ""}`),
        `Verification: ${plan.verification}`,
        "# Scheduled worker results",
        schedulerContext,
        "Use these scheduled worker results as completed Flow lane output. Do not rerun the same lanes unless verification finds a specific gap.",
      ].join("\n"),
    };
  } catch (err) {
    const message = `Flow planner failed: ${String(err)}`;
    setLaneStatus("planner", "blocked", message);
    completeRun("blocked");
    return { ok: false, flowContext: baseFlowContext, error: message };
  }
}
