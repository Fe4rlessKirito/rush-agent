import { useMemo, useRef, useState } from "react";
import { buildFlowRunReport, useFlowStore, type FlowLane, type FlowLaneStatus, type FlowRun, type FlowRunStatus } from "../../core/flowStore";
import { useAppStore } from "../../core/store";
import { useProjectStore } from "../../core/projectStore";
import { ProviderRegistry } from "../../core/providers/registry";
import { runFlowScheduledLane, type FlowScheduledLaneResult } from "../../core/flowScheduler";
import { cancelFlowLane } from "../../core/flowRuntime";
import type { Provider } from "../../core/providers/types";
import { ChatPanel, codeTools } from "./ChatPanel";

type FlowCountKey = "queued" | "running" | "completed" | "blocked" | "skipped";

function statusText(status: FlowLaneStatus | FlowRunStatus): string {
  return status.replace("_", " ");
}

function lanePreview(lane: FlowLane): string {
  const text = lane.output.trim();
  if (!text) return lane.summary;
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

function flowCounts(lanes: FlowLane[]): Record<FlowCountKey, number> {
  return lanes.reduce<Record<FlowCountKey, number>>(
    (counts, lane) => {
      if (lane.status === "pending") counts.queued += 1;
      else if (lane.status === "running") counts.running += 1;
      else if (lane.status === "completed") counts.completed += 1;
      else if (lane.status === "blocked") counts.blocked += 1;
      else if (lane.status === "cancelled" || lane.status === "ignored") counts.skipped += 1;
      return counts;
    },
    { queued: 0, running: 0, completed: 0, blocked: 0, skipped: 0 },
  );
}

function laneStateHint(lane: FlowLane): string {
  if (lane.status === "ignored") return "Skipped by user. This lane will not block completion.";
  if (lane.status === "cancelled") return "Cancelled. Retry this lane when you want it back in the run.";
  if (lane.status === "blocked") return "Needs attention before Flow can finish cleanly.";
  return "";
}

function dependencyWaitText(run: FlowRun | undefined, lane: FlowLane): string {
  if (!run?.plan || lane.status !== "pending" || !lane.planLaneId) return "";
  const planLane = run.plan.lanes.find((item) => item.id === lane.planLaneId);
  if (!planLane?.dependsOn.length) return "";
  const waitingOn = planLane.dependsOn
    .map((depId) => {
      const depPlan = run.plan?.lanes.find((item) => item.id === depId);
      const depLane = run.lanes.find((item) => item.planLaneId === depId);
      if (!depLane || depLane.status === "completed" || depLane.status === "ignored") return "";
      return depPlan?.title ?? depLane.title;
    })
    .filter(Boolean);
  return waitingOn.length ? `Waiting on ${waitingOn.join(", ")}` : "";
}

export function FlowView() {
  const [showReport, setShowReport] = useState(false);
  const [reportSaved, setReportSaved] = useState(false);
  const [selectedLaneId, setSelectedLaneId] = useState<string | null>(null);
  const [laneCopied, setLaneCopied] = useState(false);
  const [resumingRunId, setResumingRunId] = useState<string | null>(null);
  const [retryingLaneIds, setRetryingLaneIds] = useState<Set<string>>(() => new Set());
  const retryControllers = useRef<Record<string, AbortController>>({});
  const runs = useFlowStore((s) => s.runs);
  const activeRunId = useFlowStore((s) => s.activeRunId);
  const cancelRun = useFlowStore((s) => s.cancelRun);
  const cancelLane = useFlowStore((s) => s.cancelLane);
  const retryLane = useFlowStore((s) => s.retryLane);
  const ignoreLane = useFlowStore((s) => s.ignoreLane);
  const setLaneStatus = useFlowStore((s) => s.setLaneStatus);
  const setLaneOutput = useFlowStore((s) => s.setLaneOutput);
  const appendLaneOutput = useFlowStore((s) => s.appendLaneOutput);
  const clearRuns = useFlowStore((s) => s.clearRuns);
  const providers = useAppStore((s) => s.providers);
  const activeProviderId = useAppStore((s) => s.activeProviderId);
  const activeModel = useAppStore((s) => s.activeModel);
  const setFlowChat = useAppStore((s) => s.setFlowChat);
  const projectInstructions = useProjectStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.instructions ?? "",
  );
  const activeRun = runs.find((run) => run.id === activeRunId) ?? runs[0];
  const selectedLane = activeRun?.lanes.find((lane) => lane.id === selectedLaneId);
  const report = useMemo(() => activeRun ? buildFlowRunReport(activeRun) : "", [activeRun]);
  const counts = useMemo(() => flowCounts(activeRun?.lanes ?? []), [activeRun]);
  const canResumeActiveRun = Boolean(
    activeRun?.plan &&
    activeRun.status !== "running" &&
    resumingRunId !== activeRun.id &&
    activeRun.lanes.some((lane) =>
      lane.role === "worker" &&
      lane.id !== "worker" &&
      lane.status !== "completed" &&
      lane.status !== "ignored",
    ),
  );

  async function copyReport() {
    if (!report) return;
    await navigator.clipboard?.writeText(report).catch(() => {});
  }

  async function copyLaneOutput(lane: FlowLane) {
    const body = [
      `${lane.title} [${statusText(lane.status)}]`,
      lane.summary,
      "",
      lane.output.trim() || "No output recorded.",
    ].join("\n");
    await navigator.clipboard?.writeText(body).catch(() => {});
    setLaneCopied(true);
    window.setTimeout(() => setLaneCopied(false), 1400);
  }

  function saveReportToLibrary() {
    if (!activeRun || !report) return;
    setFlowChat((lines) => [
      ...lines,
      {
        role: "tool",
        text: `Saved Flow report for Library:\n\n${report}`,
      },
    ]);
    setReportSaved(true);
    window.setTimeout(() => setReportSaved(false), 1600);
  }

  function setRetrying(laneId: string, retrying: boolean) {
    setRetryingLaneIds((ids) => {
      const next = new Set(ids);
      if (retrying) next.add(laneId);
      else next.delete(laneId);
      return next;
    });
  }

  function cancelWorkerLane(runId: string, laneId: string) {
    retryControllers.current[laneId]?.abort();
    delete retryControllers.current[laneId];
    cancelFlowLane(runId, laneId);
    setRetrying(laneId, false);
    cancelLane(runId, laneId);
  }

  function lanePlanTask(run: FlowRun | undefined, lane: FlowLane | undefined): string {
    if (!run?.plan || !lane?.planLaneId) return "";
    return run.plan.lanes.find((item) => item.id === lane.planLaneId)?.task ?? "";
  }

  function laneTimestamp(value: number | undefined): string {
    return value ? new Date(value).toLocaleString() : "Not recorded";
  }

  function appendToLatestFlowAgent(text: string) {
    setFlowChat((lines) => {
      const next = lines.slice();
      const current = next[next.length - 1];
      if (!current || current.role !== "agent") return [...next, { role: "agent", text }];
      next[next.length - 1] = { ...current, text: `${current.text}${text}` };
      return next;
    });
  }

  function buildVerifierRefresh(runId: string): string {
    const run = useFlowStore.getState().runs.find((item) => item.id === runId);
    if (!run) return "Verifier refresh failed: run no longer exists.";
    const workerLanes = run.lanes.filter((item) => item.role === "worker" && item.id !== "worker");
    return [
      "Flow verifier refreshed after worker lane retry.",
      "",
      "Worker lane statuses:",
      ...workerLanes.map((worker) => [
        `- ${worker.title}: ${statusText(worker.status)}`,
        worker.output.trim() ? `  ${worker.output.trim().slice(0, 700)}` : `  ${worker.summary}`,
      ].join("\n")),
    ].join("\n");
  }

  function syncRunAfterWorkerRetry(runId: string): boolean {
    const run = useFlowStore.getState().runs.find((item) => item.id === runId);
    if (!run) return false;
    const workerLanes = run.lanes.filter((item) => item.role === "worker" && item.id !== "worker");
    if (workerLanes.length === 0) return false;
    const activeWorkers = workerLanes.filter((item) => item.status !== "ignored");

    if (activeWorkers.some((item) => item.status === "blocked" || item.status === "cancelled")) {
      setLaneStatus(runId, "worker", "blocked", "One or more worker lanes still need attention.");
      setLaneOutput(runId, "verifier", buildVerifierRefresh(runId));
      setLaneStatus(runId, "verifier", "blocked", "Verifier waiting for worker lanes to recover.");
      return false;
    }

    if (activeWorkers.some((item) => item.status === "pending" || item.status === "running")) {
      setLaneStatus(runId, "worker", "running", "Worker lanes are still in progress.");
      setLaneOutput(runId, "verifier", buildVerifierRefresh(runId));
      setLaneStatus(runId, "verifier", "pending", "Verifier waiting for worker lanes.");
      return false;
    }

    setLaneStatus(runId, "worker", "completed", "All active worker lanes are completed.");
    setLaneStatus(runId, "verifier", "running", "Refreshing verification after worker retry.");
    setLaneOutput(runId, "verifier", buildVerifierRefresh(runId));
    setLaneStatus(runId, "verifier", "completed", "Verifier refreshed after worker retry.");
    return true;
  }

  async function rerunFinalSynthesis(runId: string, provider: Provider, signal: AbortSignal) {
    const run = useFlowStore.getState().runs.find((item) => item.id === runId);
    if (!run || !activeModel) return;
    const report = buildFlowRunReport(run);
    let revised = "";

    setLaneStatus(runId, "verifier", "running", "Generating revised final answer after worker retry.");
    setFlowChat((lines) => [
      ...lines,
      { role: "tool", text: "Flow retry completed. Revising final answer from refreshed worker results." },
      { role: "agent", text: "" },
    ]);

    try {
      for await (const chunk of provider.streamChat({
        model: activeModel,
        signal,
        messages: [
          {
            role: "system",
            content: [
              "You are Rush in Flow verifier mode.",
              "Produce the revised final answer after a worker lane retry.",
              "Use the Flow report as the source of truth. Do not call tools.",
              "Be concise, mention what changed if the retry changed the outcome, and state any remaining limitations.",
              projectInstructions,
            ].filter(Boolean).join("\n\n"),
          },
          {
            role: "user",
            content: [
              `Original request: ${run.prompt}`,
              "",
              report,
            ].join("\n"),
          },
        ],
      })) {
        if (!chunk.delta) continue;
        revised += chunk.delta;
        appendToLatestFlowAgent(chunk.delta);
      }
      const finalText = revised.trim() || "Final synthesis completed without text output.";
      setLaneOutput(runId, "verifier", finalText);
      setLaneStatus(runId, "verifier", "completed", "Revised final answer ready.");
    } catch (err) {
      const error = `Final synthesis failed: ${String(err)}`;
      appendToLatestFlowAgent(`\n\n${error}`);
      setLaneOutput(runId, "verifier", error);
      setLaneStatus(runId, "verifier", "blocked", error);
    }
  }

  async function retryWorkerLane(runId: string, lane: FlowLane) {
    const run = useFlowStore.getState().runs.find((item) => item.id === runId);
    const planLane = lane.planLaneId ? run?.plan?.lanes.find((item) => item.id === lane.planLaneId) : undefined;
    if (!run || !run.plan || !planLane) {
      retryLane(runId, lane.id);
      setLaneStatus(runId, lane.id, "blocked", "This lane is not linked to a schedulable Flow plan lane.");
      return;
    }
    const plan = run.plan;
    if (!activeProviderId || !activeModel) {
      retryLane(runId, lane.id);
      setLaneStatus(runId, lane.id, "blocked", "Pick a provider + model in Settings first.");
      return;
    }

    const dependencyResults: FlowScheduledLaneResult[] = [];
    for (const depId of planLane.dependsOn) {
      const depPlanLane = plan.lanes.find((item) => item.id === depId);
      const depRuntimeLane = run.lanes.find((item) => item.planLaneId === depId);
      if (!depPlanLane || !depRuntimeLane || depRuntimeLane.status !== "completed") {
        retryLane(runId, lane.id);
        setLaneStatus(runId, lane.id, "blocked", `Cannot retry until dependency completes: ${depPlanLane?.title ?? depId}`);
        return;
      }
      dependencyResults.push({
        lane: depPlanLane,
        ok: true,
        output: depRuntimeLane.output.trim() || depRuntimeLane.summary,
      });
    }

    const controller = new AbortController();
    retryControllers.current[lane.id] = controller;
    retryLane(runId, lane.id);
    setRetrying(lane.id, true);

    try {
      const provider = new ProviderRegistry(providers).get(activeProviderId);
      const result = await runFlowScheduledLane(
        {
          provider,
          model: activeModel,
          tools: codeTools,
          plan,
          signal: controller.signal,
          projectInstructions,
          onLaneStart() {
            setLaneStatus(runId, lane.id, "running", planLane.task);
          },
        },
        planLane,
        dependencyResults,
      );

      if (result.ok) {
        appendLaneOutput(runId, lane.id, result.output);
        setLaneStatus(runId, lane.id, "completed", "Retry completed this worker lane.");
      } else {
        appendLaneOutput(runId, lane.id, result.error ?? "Worker lane failed.");
        setLaneStatus(runId, lane.id, "blocked", result.error ?? "Worker lane failed.");
      }
      if (syncRunAfterWorkerRetry(runId)) {
        await rerunFinalSynthesis(runId, provider, controller.signal);
      }
    } catch (err) {
      appendLaneOutput(runId, lane.id, String(err));
      setLaneStatus(runId, lane.id, "blocked", String(err));
      syncRunAfterWorkerRetry(runId);
    } finally {
      delete retryControllers.current[lane.id];
      setRetrying(lane.id, false);
    }
  }

  async function resumeRun(runId: string) {
    const run = useFlowStore.getState().runs.find((item) => item.id === runId);
    if (!run?.plan || !activeProviderId || !activeModel) return;

    const provider = new ProviderRegistry(providers).get(activeProviderId);
    const resumeController = new AbortController();
    setResumingRunId(runId);
    setFlowChat((lines) => [
      ...lines,
      { role: "tool", text: "Resuming Flow run from saved lane state." },
    ]);

    const runtimeLaneFor = (planLaneId: string) =>
      useFlowStore.getState().runs
        .find((item) => item.id === runId)
        ?.lanes.find((lane) => lane.planLaneId === planLaneId);

    const completedResultFor = (planLaneId: string): FlowScheduledLaneResult | null => {
      const currentRun = useFlowStore.getState().runs.find((item) => item.id === runId);
      const planLane = currentRun?.plan?.lanes.find((item) => item.id === planLaneId);
      const runtimeLane = runtimeLaneFor(planLaneId);
      if (!planLane || !runtimeLane) return null;
      if (runtimeLane.status !== "completed" && runtimeLane.status !== "ignored") return null;
      return {
        lane: planLane,
        ok: true,
        output: runtimeLane.output.trim() || runtimeLane.summary,
        skipped: runtimeLane.status === "ignored",
      };
    };

    const runPlanLane = async (planLaneId: string, stack: string[] = []): Promise<FlowScheduledLaneResult | null> => {
      const currentRun = useFlowStore.getState().runs.find((item) => item.id === runId);
      const plan = currentRun?.plan;
      const planLane = plan?.lanes.find((item) => item.id === planLaneId);
      const runtimeLane = runtimeLaneFor(planLaneId);
      if (!currentRun || !plan || !planLane || !runtimeLane) return null;
      const completed = completedResultFor(planLaneId);
      if (completed) return completed;
      if (stack.includes(planLaneId)) {
        setLaneStatus(runId, runtimeLane.id, "blocked", "Cannot resume: circular Flow lane dependency.");
        return null;
      }

      const dependencyResults: FlowScheduledLaneResult[] = [];
      for (const depId of planLane.dependsOn) {
        const depResult = await runPlanLane(depId, [...stack, planLaneId]);
        if (!depResult?.ok) {
          setLaneStatus(runId, runtimeLane.id, "blocked", `Cannot resume until dependency completes: ${depId}`);
          return null;
        }
        dependencyResults.push(depResult);
      }

      retryLane(runId, runtimeLane.id);
      const result = await runFlowScheduledLane(
        {
          provider,
          model: activeModel,
          tools: codeTools,
          plan,
          signal: resumeController.signal,
          projectInstructions,
          onLaneStart() {
            setLaneStatus(runId, runtimeLane.id, "running", planLane.task);
          },
        },
        planLane,
        dependencyResults,
      );

      if (result.ok) {
        appendLaneOutput(runId, runtimeLane.id, result.output);
        setLaneStatus(runId, runtimeLane.id, "completed", "Resume completed this worker lane.");
      } else {
        appendLaneOutput(runId, runtimeLane.id, result.error ?? "Worker lane failed during resume.");
        setLaneStatus(runId, runtimeLane.id, "blocked", result.error ?? "Worker lane failed during resume.");
      }
      return result;
    };

    try {
      setLaneStatus(runId, "worker", "running", "Resuming unfinished worker lanes.");
      for (const lane of run.plan.lanes) {
        const runtimeLane = runtimeLaneFor(lane.id);
        if (!runtimeLane || runtimeLane.status === "completed" || runtimeLane.status === "ignored") continue;
        await runPlanLane(lane.id);
      }
      if (syncRunAfterWorkerRetry(runId)) {
        await rerunFinalSynthesis(runId, provider, resumeController.signal);
      }
    } catch (err) {
      setLaneStatus(runId, "worker", "blocked", `Resume failed: ${String(err)}`);
    } finally {
      setResumingRunId(null);
    }
  }

  return (
    <main className="flow-view">
      <div className="flow-shell">
        <div className="flow-head">
          <div>
            <span className="flow-title">Flow</span>
            <p>{activeRun ? activeRun.title : "Plan, delegate, and verify code-capable work."}</p>
          </div>
          <div className="flow-head-actions">
            {activeRun && <span className={`flow-tag ${activeRun.status}`}>{statusText(activeRun.status)}</span>}
            {activeRun && activeRun.status === "running" && (
              <button className="flow-mini-btn" onClick={() => cancelRun(activeRun.id)}>Cancel</button>
            )}
            {activeRun && canResumeActiveRun && (
              <button className="flow-mini-btn" onClick={() => resumeRun(activeRun.id)}>
                {resumingRunId === activeRun.id ? "Resuming" : "Resume"}
              </button>
            )}
            {activeRun && <button className="flow-mini-btn" onClick={() => setShowReport(true)}>Report</button>}
            {runs.length > 0 && <button className="flow-mini-btn ghost" onClick={clearRuns}>Clear</button>}
          </div>
        </div>

        {activeRun?.plan && (
          <div className="flow-plan-panel">
            <div>
              <strong>Plan</strong>
              <span>{activeRun.plan.summary}</span>
            </div>
            <div className="flow-plan-lanes">
              {activeRun.plan.lanes.map((lane) => (
                <code key={lane.id}>{lane.title}</code>
              ))}
            </div>
          </div>
        )}

        {activeRun && (
          <div className="flow-summary" aria-label="Flow execution summary">
            {([
              ["queued", "Queued"],
              ["running", "Running"],
              ["completed", "Done"],
              ["blocked", "Needs review"],
              ["skipped", "Skipped"],
            ] as Array<[FlowCountKey, string]>).map(([key, label]) => (
              <div className={`flow-summary-chip ${key}`} key={key}>
                <strong>{counts[key]}</strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
        )}

        <div className="flow-agents" aria-label="Flow agents">
          {(activeRun?.lanes ?? [
            { id: "planner", role: "planner", title: "Planner", status: "pending", summary: "Breaks the request into work lanes.", output: "" },
            { id: "worker", role: "worker", title: "Workers", status: "pending", summary: "Runs code-capable delegated work.", output: "" },
            { id: "verifier", role: "verifier", title: "Verifier", status: "pending", summary: "Checks the result before handoff.", output: "" },
          ]).map((lane) => (
            <div className={`flow-agent ${lane.status}`} key={lane.id}>
              <div className="flow-agent-top">
                <span className="flow-agent-dot" />
                <span className={`flow-lane-status ${lane.status}`}>{statusText(lane.status)}</span>
              </div>
              <strong>{lane.title}</strong>
              <span className="flow-agent-preview">
                {dependencyWaitText(activeRun, lane) || laneStateHint(lane) || lanePreview(lane)}
              </span>
              {activeRun && lane.role === "worker" && (
                <div className="flow-lane-actions" aria-label={`${lane.title} lane controls`}>
                  <button onClick={() => setSelectedLaneId(lane.id)}>Details</button>
                  {(lane.status === "pending" || lane.status === "running") && (
                    <button onClick={() => cancelWorkerLane(activeRun.id, lane.id)}>Cancel</button>
                  )}
                  {(lane.status === "blocked" || lane.status === "cancelled" || lane.status === "ignored") && (
                    <button onClick={() => retryWorkerLane(activeRun.id, lane)} disabled={retryingLaneIds.has(lane.id)}>
                      {retryingLaneIds.has(lane.id) ? "Retrying" : "Retry"}
                    </button>
                  )}
                  {lane.status !== "ignored" && (
                    <button className="ghost" onClick={() => ignoreLane(activeRun.id, lane.id)}>Ignore</button>
                  )}
                </div>
              )}
              {activeRun && lane.role !== "worker" && (
                <div className="flow-lane-actions" aria-label={`${lane.title} lane controls`}>
                  <button onClick={() => setSelectedLaneId(lane.id)}>Details</button>
                </div>
              )}
            </div>
          ))}
        </div>

        {runs.length > 1 && (
          <div className="flow-run-strip" aria-label="Recent Flow runs">
            {runs.slice(0, 5).map((run) => (
              <span className={run.id === activeRun?.id ? "active" : ""} key={run.id}>
                {run.title}
              </span>
            ))}
          </div>
        )}

        <div className="flow-chat">
          <ChatPanel mode="flow" />
        </div>

        {showReport && activeRun && (
          <div className="flow-report-overlay" onMouseDown={() => setShowReport(false)}>
            <div className="flow-report" onMouseDown={(e) => e.stopPropagation()}>
              <div className="flow-report-head">
                <div>
                  <strong>Flow Report</strong>
                  <span>{activeRun.title} · {statusText(activeRun.status)}</span>
                </div>
                <button onClick={() => setShowReport(false)} aria-label="Close Flow report">x</button>
              </div>
              <pre>{report}</pre>
              <div className="flow-report-actions">
                <button onClick={copyReport}>Copy</button>
                <button onClick={saveReportToLibrary}>{reportSaved ? "Saved" : "Save to Library"}</button>
              </div>
            </div>
          </div>
        )}

        {selectedLane && activeRun && (
          <div className="flow-report-overlay" onMouseDown={() => setSelectedLaneId(null)}>
            <div className="flow-lane-detail" onMouseDown={(e) => e.stopPropagation()}>
              <div className="flow-report-head">
                <div>
                  <strong>{selectedLane.title}</strong>
                  <span>{selectedLane.role} · {statusText(selectedLane.status)}</span>
                </div>
                <button onClick={() => setSelectedLaneId(null)} aria-label="Close lane details">x</button>
              </div>
              <div className="flow-lane-detail-grid">
                <section>
                  <span>Status</span>
                  <strong>{statusText(selectedLane.status)}</strong>
                </section>
                <section>
                  <span>Started</span>
                  <strong>{laneTimestamp(selectedLane.startedAt)}</strong>
                </section>
                <section>
                  <span>Finished</span>
                  <strong>{laneTimestamp(selectedLane.completedAt)}</strong>
                </section>
              </div>
              {lanePlanTask(activeRun, selectedLane) && (
                <div className="flow-lane-detail-block">
                  <strong>Task</strong>
                  <p>{lanePlanTask(activeRun, selectedLane)}</p>
                </div>
              )}
              <div className="flow-lane-detail-block">
                <strong>Summary</strong>
                <p>{selectedLane.summary || "No summary recorded."}</p>
              </div>
              <div className="flow-lane-detail-block output">
                <strong>Output</strong>
                <pre>{selectedLane.output.trim() || "No output recorded."}</pre>
              </div>
              <div className="flow-report-actions">
                <button onClick={() => copyLaneOutput(selectedLane)}>{laneCopied ? "Copied" : "Copy"}</button>
                {selectedLane.role === "worker" && (selectedLane.status === "pending" || selectedLane.status === "running") && (
                  <button onClick={() => cancelWorkerLane(activeRun.id, selectedLane.id)}>Cancel</button>
                )}
                {selectedLane.role === "worker" && (selectedLane.status === "blocked" || selectedLane.status === "cancelled" || selectedLane.status === "ignored") && (
                  <button onClick={() => retryWorkerLane(activeRun.id, selectedLane)} disabled={retryingLaneIds.has(selectedLane.id)}>
                    {retryingLaneIds.has(selectedLane.id) ? "Retrying" : "Retry"}
                  </button>
                )}
                {selectedLane.role === "worker" && selectedLane.status !== "ignored" && (
                  <button className="ghost" onClick={() => ignoreLane(activeRun.id, selectedLane.id)}>Ignore</button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
