import type { ChatLine } from "../../core/store";

export function newAssistantLine(meta: ChatLine["meta"]): ChatLine {
  return { role: "agent", text: "", meta };
}

export function appendLatestAgentErrorLine(lines: ChatLine[], text: string): ChatLine[] {
  const next = lines.slice();
  const cur = next[next.length - 1];
  next[next.length - 1] = {
    ...cur,
    role: "agent",
    text: `${cur.text}${cur.text ? "\n\n" : ""}${text}`,
  };
  return next;
}

export function markLatestAgentLineCompleted(lines: ChatLine[], completedAt: number): ChatLine[] {
  const next = lines.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].role !== "agent") continue;
    next[i] = { ...next[i], meta: { ...(next[i].meta ?? {}), completedAt } };
    break;
  }
  return next;
}
