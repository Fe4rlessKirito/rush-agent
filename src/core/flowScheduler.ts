import type { Provider } from "./providers/types";
import type { FlowPlan, FlowPlanLane } from "./flowStore";
import { runAgent } from "./agent/agentLoop";
import type { ToolRegistry } from "./agent/tools";

export interface FlowScheduledLaneResult {
  lane: FlowPlanLane;
  ok: boolean;
  output: string;
  error?: string;
  skipped?: boolean;
}

export interface FlowSchedulerOptions {
  provider: Provider;
  model: string;
  tools: ToolRegistry;
  plan: FlowPlan;
  signal?: AbortSignal;
  projectInstructions?: string;
  maxConcurrency?: number;
  onLaneStart?: (lane: FlowPlanLane) => void;
  onLaneComplete?: (lane: FlowPlanLane, output: string) => void;
  onLaneError?: (lane: FlowPlanLane, error: string) => void;
  onLaneSkip?: (lane: FlowPlanLane, reason: string) => void;
  shouldRunLane?: (lane: FlowPlanLane) => boolean;
  getLaneSignal?: (lane: FlowPlanLane) => AbortSignal | undefined;
}

function skipLane(options: FlowSchedulerOptions, lane: FlowPlanLane, reason: string): FlowScheduledLaneResult {
  options.onLaneSkip?.(lane, reason);
  return { lane, ok: false, output: "", error: reason, skipped: true };
}

function mergeSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter(Boolean) as AbortSignal[];
  if (active.length <= 1) return active[0];
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (active.some((signal) => signal.aborted)) {
    controller.abort();
    return controller.signal;
  }
  for (const signal of active) {
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

export async function runFlowScheduledLane(
  options: FlowSchedulerOptions,
  lane: FlowPlanLane,
  dependencyResults: FlowScheduledLaneResult[] = [],
): Promise<FlowScheduledLaneResult> {
  const chunks: string[] = [];
  if (options.shouldRunLane && !options.shouldRunLane(lane)) {
    return skipLane(options, lane, "Skipped because the lane was cancelled or ignored.");
  }
  const signal = mergeSignals(options.signal, options.getLaneSignal?.(lane));
  if (signal?.aborted) {
    return skipLane(options, lane, "Skipped because the lane was cancelled before it started.");
  }
  options.onLaneStart?.(lane);
  try {
    for await (const event of runAgent(
      options.provider,
      options.model,
      options.tools,
      [{ role: "user", content: lane.task }],
      signal,
      4,
      [
        options.projectInstructions ?? "",
        "You are a scheduled Rush Flow worker lane.",
        `Lane title: ${lane.title}`,
        dependencyResults.length > 0
          ? [
              "# Completed dependency lane results",
              ...dependencyResults.map((result) => [
                `## ${result.lane.title} [${result.ok ? "completed" : "blocked"}]`,
                result.ok ? result.output : result.error ?? "Dependency failed.",
              ].join("\n")),
            ].join("\n\n")
          : "",
        "Work only on this lane task. Return a concise result for the verifier.",
        "Do not call Agent from this worker lane; use direct tools if needed.",
      ].filter(Boolean).join("\n\n"),
    )) {
      if (event.type === "text" && event.text) chunks.push(event.text);
      if (event.type === "error" && event.text) throw new Error(event.text);
    }
    const output = chunks.join("").trim() || "Worker lane completed without text output.";
    if (options.shouldRunLane && !options.shouldRunLane(lane)) {
      return skipLane(options, lane, "Skipped because the lane was cancelled or ignored before completion.");
    }
    options.onLaneComplete?.(lane, output);
    return { lane, ok: true, output };
  } catch (err) {
    if (signal?.aborted || (options.shouldRunLane && !options.shouldRunLane(lane))) {
      return skipLane(options, lane, "Skipped because the lane was cancelled while running.");
    }
    const error = String(err);
    options.onLaneError?.(lane, error);
    return { lane, ok: false, output: "", error };
  }
}

export async function runFlowScheduler(options: FlowSchedulerOptions): Promise<FlowScheduledLaneResult[]> {
  const maxConcurrency = Math.max(1, Math.min(4, options.maxConcurrency ?? 2));
  const pending = new Map(options.plan.lanes.map((lane) => [lane.id, lane]));
  const completed = new Set<string>();
  const failed = new Set<string>();
  const results: FlowScheduledLaneResult[] = [];

  while (pending.size > 0) {
    if (options.signal?.aborted) break;
    const ready = [...pending.values()].filter((lane) =>
      lane.dependsOn.every((dep) => completed.has(dep) || !pending.has(dep)),
    );

    if (ready.length === 0) {
      for (const lane of pending.values()) {
        const error = `Lane dependencies could not be satisfied: ${lane.dependsOn.join(", ") || "unknown"}`;
        options.onLaneError?.(lane, error);
        results.push({ lane, ok: false, output: "", error });
        failed.add(lane.id);
      }
      pending.clear();
      break;
    }

    const batch = ready.slice(0, maxConcurrency);
    for (const lane of batch) pending.delete(lane.id);

    const dependencyResultsFor = (lane: FlowPlanLane) =>
      results.filter((result) => lane.dependsOn.includes(result.lane.id));
    const batchResults = await Promise.all(batch.map((lane) =>
      options.shouldRunLane && !options.shouldRunLane(lane)
        ? skipLane(options, lane, "Skipped because the lane was cancelled or ignored.")
        : runFlowScheduledLane(options, lane, dependencyResultsFor(lane)),
    ));
    for (const result of batchResults) {
      results.push(result);
      if (result.ok) completed.add(result.lane.id);
      else failed.add(result.lane.id);
    }

    for (const lane of [...pending.values()]) {
      if (lane.dependsOn.some((dep) => failed.has(dep))) {
        const error = `Skipped because a dependency failed: ${lane.dependsOn.filter((dep) => failed.has(dep)).join(", ")}`;
        pending.delete(lane.id);
        options.onLaneError?.(lane, error);
        results.push({ lane, ok: false, output: "", error });
        failed.add(lane.id);
      }
    }
  }

  return results;
}

export function formatSchedulerResults(results: FlowScheduledLaneResult[]): string {
  if (results.length === 0) return "No scheduled worker lanes ran.";
  return results
    .map((result) => [
      `## ${result.lane.title} [${result.ok ? "completed" : result.skipped ? "skipped" : "blocked"}]`,
      result.ok ? result.output : result.error ?? "Worker lane failed.",
    ].join("\n"))
    .join("\n\n");
}
