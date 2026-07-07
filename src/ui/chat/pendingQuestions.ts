import type { AgentEvent } from "../../core/agent/agentLoop";

export interface PendingUserQuestion {
  question: string;
  choices: Array<{ label: string; value: string; description: string }>;
}

function questionChoices(value: unknown): PendingUserQuestion["choices"] {
  if (!Array.isArray(value)) return [];
  return value.map((raw, index) => {
    const item: Record<string, unknown> = raw && typeof raw === "object" ? raw as Record<string, unknown> : { label: raw };
    const label = String(item.label ?? item.value ?? item.title ?? raw ?? `Option ${index + 1}`).trim() || `Option ${index + 1}`;
    const valueText = String(item.value ?? item.label ?? label).trim() || label;
    const description = String(item.description ?? "").trim();
    return { label, value: valueText, description };
  });
}

export function pendingQuestionFromAgentEvent(event: AgentEvent): PendingUserQuestion {
  const question = String(event.toolArgs?.question ?? event.text ?? "").trim() || "Please answer the clarification question.";
  return { question, choices: questionChoices(event.toolArgs?.choices) };
}
