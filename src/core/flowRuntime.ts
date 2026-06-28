const laneControllers = new Map<string, AbortController>();

function key(runId: string, laneId: string): string {
  return `${runId}:${laneId}`;
}

export function registerFlowLaneController(runId: string, laneId: string, controller: AbortController): void {
  laneControllers.set(key(runId, laneId), controller);
}

export function unregisterFlowLaneController(runId: string, laneId: string): void {
  laneControllers.delete(key(runId, laneId));
}

export function cancelFlowLane(runId: string, laneId: string): boolean {
  const controller = laneControllers.get(key(runId, laneId));
  if (!controller) return false;
  controller.abort();
  laneControllers.delete(key(runId, laneId));
  return true;
}
