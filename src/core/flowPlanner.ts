import type { Provider } from "./providers/types";
import type { FlowPlan, FlowPlanLane } from "./flowStore";

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function extractJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("empty planner response");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("planner response did not contain JSON");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function normalizeId(value: string, fallback: string): string {
  return (value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || fallback;
}

export function fallbackFlowPlan(prompt: string): FlowPlan {
  return {
    summary: "Single-lane fallback plan.",
    lanes: [{
      id: "worker-1",
      title: "Worker 1",
      task: prompt.trim() || "Complete the requested Flow task.",
      dependsOn: [],
    }],
    verification: "Review the worker result and report any gaps.",
  };
}

export function parseFlowPlan(raw: string, prompt: string): FlowPlan {
  const parsed = extractJson(raw) as Record<string, unknown>;
  const rawLanes = Array.isArray(parsed.lanes) ? parsed.lanes : [];
  const lanes: FlowPlanLane[] = rawLanes
    .slice(0, 6)
    .map((item, index) => {
      const lane = item as Record<string, unknown>;
      return {
        id: normalizeId(text(lane.id), `worker-${index + 1}`),
        title: text(lane.title) || `Worker ${index + 1}`,
        task: text(lane.task) || text(lane.description) || prompt,
        dependsOn: Array.isArray(lane.dependsOn) ? lane.dependsOn.map(String).filter(Boolean) : [],
      };
    })
    .filter((lane) => lane.task);

  if (lanes.length === 0) return fallbackFlowPlan(prompt);
  return {
    summary: text(parsed.summary) || "Flow plan generated.",
    lanes,
    verification: text(parsed.verification) || "Verify all completed lanes and synthesize the result.",
  };
}

export async function buildFlowPlan(provider: Provider, model: string, prompt: string, signal?: AbortSignal): Promise<FlowPlan> {
  let full = "";
  try {
    for await (const chunk of provider.streamChat({
      model,
      signal,
      messages: [
        {
          role: "system",
          content: [
            "You are Rush's deterministic Flow planner.",
            "Return only valid JSON. Do not include markdown.",
            "Shape: {\"summary\":\"...\",\"lanes\":[{\"id\":\"worker-1\",\"title\":\"...\",\"task\":\"...\",\"dependsOn\":[]}],\"verification\":\"...\"}",
            "Create at most 4 worker lanes. Only split work that can run independently.",
          ].join("\n"),
        },
        { role: "user", content: prompt },
      ],
    })) {
      if (chunk.delta) full += chunk.delta;
      if (chunk.done) break;
    }
    return parseFlowPlan(full, prompt);
  } catch {
    return fallbackFlowPlan(prompt);
  }
}

