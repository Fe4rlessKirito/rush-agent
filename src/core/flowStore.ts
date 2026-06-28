import { create } from "zustand";
import { persist } from "zustand/middleware";

export type FlowLaneRole = "planner" | "worker" | "verifier";
export type FlowLaneStatus = "pending" | "running" | "completed" | "blocked" | "cancelled" | "ignored";
export type FlowRunStatus = "running" | "completed" | "blocked" | "cancelled";

export interface FlowPlanLane {
  id: string;
  title: string;
  task: string;
  dependsOn: string[];
}

export interface FlowPlan {
  summary: string;
  lanes: FlowPlanLane[];
  verification: string;
}

export interface FlowLane {
  id: string;
  planLaneId?: string;
  role: FlowLaneRole;
  title: string;
  status: FlowLaneStatus;
  summary: string;
  output: string;
  startedAt?: number;
  completedAt?: number;
}

export interface FlowRun {
  id: string;
  title: string;
  prompt: string;
  status: FlowRunStatus;
  plan?: FlowPlan;
  lanes: FlowLane[];
  createdAt: number;
  updatedAt: number;
}

export function buildFlowRunReport(run: FlowRun): string {
  const lanesByRole = {
    planner: run.lanes.filter((lane) => lane.role === "planner"),
    worker: run.lanes.filter((lane) => lane.role === "worker"),
    verifier: run.lanes.filter((lane) => lane.role === "verifier"),
  };
  const formatLane = (lane: FlowLane): string => [
    `### ${lane.title} [${lane.status}]`,
    lane.summary ? `Summary: ${lane.summary}` : "",
    lane.output.trim() ? lane.output.trim() : "No output recorded.",
  ].filter(Boolean).join("\n\n");

  return [
    `# Flow Report: ${run.title}`,
    "",
    `Status: ${run.status}`,
    `Prompt: ${run.prompt || "(empty)"}`,
    run.plan ? `Plan: ${run.plan.summary}` : "",
    run.plan?.lanes.length
      ? `Planned lanes:\n${run.plan.lanes.map((lane) => `- ${lane.title}: ${lane.task}`).join("\n")}`
      : "",
    run.plan?.verification ? `Verification: ${run.plan.verification}` : "",
    "",
    "## Planner",
    lanesByRole.planner.length ? lanesByRole.planner.map(formatLane).join("\n\n") : "No planner lane recorded.",
    "",
    "## Workers",
    lanesByRole.worker.length ? lanesByRole.worker.map(formatLane).join("\n\n") : "No worker lanes recorded.",
    "",
    "## Verifier",
    lanesByRole.verifier.length ? lanesByRole.verifier.map(formatLane).join("\n\n") : "No verifier lane recorded.",
  ].join("\n");
}

interface FlowState {
  runs: FlowRun[];
  activeRunId: string;
  startRun: (prompt: string) => FlowRun;
  setPlan: (runId: string, plan: FlowPlan) => void;
  createWorkerLane: (runId: string, title: string, summary?: string, planLaneId?: string) => FlowLane | null;
  setLaneStatus: (runId: string, laneId: string, status: FlowLaneStatus, summary?: string) => void;
  setLaneOutput: (runId: string, laneId: string, output: string) => void;
  appendLaneOutput: (runId: string, laneId: string, output: string) => void;
  cancelLane: (runId: string, laneId: string) => void;
  retryLane: (runId: string, laneId: string) => void;
  ignoreLane: (runId: string, laneId: string) => void;
  completeRun: (runId: string, status?: FlowRunStatus) => void;
  cancelRun: (runId: string) => void;
  clearRuns: () => void;
}

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

function titleFrom(prompt: string): string {
  const text = prompt.trim().replace(/\s+/g, " ");
  if (!text) return "Untitled flow";
  return text.length > 48 ? `${text.slice(0, 48)}...` : text;
}

function baseLanes(): FlowLane[] {
  return [
    {
      id: "planner",
      role: "planner",
      title: "Planner",
      status: "pending",
      summary: "Breaks the request into work lanes.",
      output: "",
    },
    {
      id: "worker",
      role: "worker",
      title: "Workers",
      status: "pending",
      summary: "Runs code-capable delegated work.",
      output: "",
    },
    {
      id: "verifier",
      role: "verifier",
      title: "Verifier",
      status: "pending",
      summary: "Checks the result before handoff.",
      output: "",
    },
  ];
}

function updateRun(runs: FlowRun[], runId: string, update: (run: FlowRun) => FlowRun): FlowRun[] {
  return runs.map((run) => (run.id === runId ? update(run) : run));
}

function runStatusFromLanes(lanes: FlowLane[]): FlowRunStatus {
  const activeLanes = lanes.filter((lane) => lane.status !== "ignored");
  if (activeLanes.length === 0) return "completed";
  if (activeLanes.some((lane) => lane.status === "blocked")) return "blocked";
  if (activeLanes.some((lane) => lane.status === "pending" || lane.status === "running")) return "running";
  if (activeLanes.some((lane) => lane.status === "cancelled")) return "blocked";
  if (activeLanes.every((lane) => lane.status === "completed")) return "completed";
  return "running";
}

export const useFlowStore = create<FlowState>()(
  persist(
    (set, get) => ({
      runs: [],
      activeRunId: "",

      startRun: (prompt) => {
        const time = Date.now();
        const run: FlowRun = {
          id: id("flow"),
          title: titleFrom(prompt),
          prompt,
          status: "running",
          lanes: baseLanes(),
          createdAt: time,
          updatedAt: time,
        };
        set((state) => ({
          runs: [run, ...state.runs].slice(0, 20),
          activeRunId: run.id,
        }));
        return run;
      },

      setPlan: (runId, plan) =>
        set((state) => ({
          runs: updateRun(state.runs, runId, (run) => ({
            ...run,
            plan,
            lanes: run.lanes.map((lane) =>
              lane.id === "planner"
                ? { ...lane, summary: plan.summary, output: JSON.stringify(plan, null, 2) }
                : lane,
            ),
            updatedAt: Date.now(),
          })),
        })),

      createWorkerLane: (runId, title, summary, planLaneId) => {
        const lane: FlowLane = {
          id: id("worker"),
          planLaneId,
          role: "worker",
          title: title.trim() || "Worker",
          status: "pending",
          summary: summary?.trim() || "Delegated subagent work.",
          output: "",
        };
        let created = false;
        set((state) => ({
          runs: updateRun(state.runs, runId, (run) => {
            created = true;
            const verifierIndex = run.lanes.findIndex((item) => item.role === "verifier");
            const lanes = run.lanes.slice();
            if (verifierIndex === -1) lanes.push(lane);
            else lanes.splice(verifierIndex, 0, lane);
            return { ...run, lanes, updatedAt: Date.now() };
          }),
        }));
        return created ? lane : null;
      },

      setLaneStatus: (runId, laneId, status, summary) =>
        set((state) => ({
          runs: updateRun(state.runs, runId, (run) => {
            const time = Date.now();
            const lanes = run.lanes.map((lane) => {
              if (lane.id !== laneId) return lane;
              return {
                ...lane,
                status,
                summary: summary ?? lane.summary,
                startedAt: status === "running" ? lane.startedAt ?? time : lane.startedAt,
                completedAt: ["completed", "blocked", "cancelled", "ignored"].includes(status) ? time : lane.completedAt,
              };
            });
            return { ...run, lanes, status: runStatusFromLanes(lanes), updatedAt: time };
          }),
        })),

      appendLaneOutput: (runId, laneId, output) =>
        set((state) => ({
          runs: updateRun(state.runs, runId, (run) => ({
            ...run,
            lanes: run.lanes.map((lane) =>
              lane.id === laneId ? { ...lane, output: `${lane.output}${output}` } : lane,
            ),
            updatedAt: Date.now(),
          })),
        })),

      setLaneOutput: (runId, laneId, output) =>
        set((state) => ({
          runs: updateRun(state.runs, runId, (run) => ({
            ...run,
            lanes: run.lanes.map((lane) =>
              lane.id === laneId ? { ...lane, output } : lane,
            ),
            updatedAt: Date.now(),
          })),
        })),

      cancelLane: (runId, laneId) =>
        set((state) => ({
          runs: updateRun(state.runs, runId, (run) => {
            const time = Date.now();
            const lanes = run.lanes.map((lane) =>
              lane.id === laneId
                ? {
                    ...lane,
                    status: "cancelled" as const,
                    summary: "Lane cancelled by user.",
                    completedAt: time,
                  }
                : lane,
            );
            return { ...run, lanes, status: runStatusFromLanes(lanes), updatedAt: time };
          }),
        })),

      retryLane: (runId, laneId) =>
        set((state) => ({
          runs: updateRun(state.runs, runId, (run) => {
            const time = Date.now();
            const lanes = run.lanes.map((lane) =>
              lane.id === laneId
                ? {
                    ...lane,
                    status: "pending" as const,
                    summary: "Queued for retry.",
                    output: "",
                    startedAt: undefined,
                    completedAt: undefined,
                  }
                : lane,
            );
            return { ...run, lanes, status: runStatusFromLanes(lanes), updatedAt: time };
          }),
        })),

      ignoreLane: (runId, laneId) =>
        set((state) => ({
          runs: updateRun(state.runs, runId, (run) => {
            const time = Date.now();
            const lanes = run.lanes.map((lane) =>
              lane.id === laneId
                ? {
                    ...lane,
                    status: "ignored" as const,
                    summary: "Lane ignored by user.",
                    completedAt: time,
                  }
                : lane,
            );
            return { ...run, lanes, status: runStatusFromLanes(lanes), updatedAt: time };
          }),
        })),

      completeRun: (runId, status) =>
        set((state) => ({
          runs: updateRun(state.runs, runId, (run) => {
            const nextStatus = status ?? runStatusFromLanes(run.lanes);
            const lanes = nextStatus === "completed"
              ? run.lanes.map((lane) => lane.status === "pending" ? { ...lane, status: "completed" as const } : lane)
              : run.lanes;
            return { ...run, lanes, status: nextStatus, updatedAt: Date.now() };
          }),
        })),

      cancelRun: (runId) => {
        const run = get().runs.find((item) => item.id === runId);
        if (!run) return;
        set((state) => ({
          runs: updateRun(state.runs, runId, (item) => ({
            ...item,
            status: "cancelled",
            lanes: item.lanes.map((lane) =>
              lane.status === "completed" ? lane : { ...lane, status: "cancelled" },
            ),
            updatedAt: Date.now(),
          })),
        }));
      },

      clearRuns: () => set({ runs: [], activeRunId: "" }),
    }),
    { name: "rush-flow-runs" },
  ),
);
