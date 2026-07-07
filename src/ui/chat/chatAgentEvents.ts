import type { AgentEvent } from "../../core/agent/agentLoop";
import type { ChatLine } from "../../core/store";
import { describeToolCall, describeToolResult } from "./chatPanelHelpers";

function toolCallLine(event: AgentEvent): ChatLine {
  return {
    role: "tool",
    text: describeToolCall(event.toolName, event.toolArgs),
    meta: { toolName: event.toolName, toolArgs: event.toolArgs },
  };
}

function toolResultLine(event: AgentEvent): ChatLine {
  return {
    role: "tool",
    text: describeToolResult(event.toolName, event.toolResult),
    meta: { toolName: event.toolName, toolResult: event.toolResult },
  };
}

function errorLine(event: AgentEvent): ChatLine {
  return { role: "tool", text: `Error: ${event.text}` };
}

function appendToolExchange(
  appendToolLine: (line: ChatLine) => void,
  line: ChatLine,
  newAssistantLine: (meta: ChatLine["meta"]) => ChatLine,
  assistantMeta: ChatLine["meta"],
) {
  appendToolLine(line);
  appendToolLine(newAssistantLine(assistantMeta));
}

export interface PendingUserQuestionLike {
  question: string;
  choices: Array<{ label: string; value: string; description: string }>;
}

interface ChatModeAgentEventOptions {
  event: AgentEvent;
  assistantMeta: ChatLine["meta"];
  appendText: (text: string) => void;
  appendThinking: (text: string) => void;
  appendToolLine: (line: ChatLine) => void;
  newAssistantLine: (meta: ChatLine["meta"]) => ChatLine;
  nextPaint: () => Promise<void>;
  pendingQuestionFromEvent: (event: AgentEvent) => PendingUserQuestionLike;
  setPendingUserQuestion: (question: PendingUserQuestionLike) => void;
  setBusy: (busy: boolean) => void;
  trackToolName: (toolName: string) => void;
  addAssistantText: (text: string) => void;
}

export async function handleChatModeAgentEvent({
  event,
  assistantMeta,
  appendText,
  appendThinking,
  appendToolLine,
  newAssistantLine,
  nextPaint,
  pendingQuestionFromEvent,
  setPendingUserQuestion,
  setBusy,
  trackToolName,
  addAssistantText,
}: ChatModeAgentEventOptions): Promise<boolean> {
  if (event.type === "thinking" && event.text) {
    appendThinking(event.text);
    await nextPaint();
  } else if (event.type === "text" && event.text) {
    addAssistantText(event.text);
    appendText(event.text);
    await nextPaint();
  } else if (event.type === "tool_call") {
    if (event.toolName) trackToolName(event.toolName);
    appendToolExchange(appendToolLine, toolCallLine(event), newAssistantLine, assistantMeta);
  } else if (event.type === "tool_result") {
    appendToolExchange(appendToolLine, toolResultLine(event), newAssistantLine, assistantMeta);
  } else if (event.type === "user_question") {
    setPendingUserQuestion(pendingQuestionFromEvent(event));
    setBusy(false);
    return false;
  } else if (event.type === "error") {
    appendToolLine(errorLine(event));
  }
  return true;
}

export interface CodeFlowAgentEventFlowCallbacks {
  appendLaneOutput: (laneId: string, output: string) => void;
  setLaneStatus: (laneId: string, status: "pending" | "running" | "completed" | "blocked" | "cancelled" | "ignored", summary?: string) => void;
  completeRun: (status: "running" | "completed" | "blocked" | "cancelled") => void;
  findPlannedAgentLane: (taskTitle: string) => { id: string } | null;
  createWorkerLane: (title: string, summary: string) => { id: string };
}

interface CodeFlowAgentEventHandlerOptions {
  assistantMeta: ChatLine["meta"];
  isFlow: boolean;
  hasFlowRun: boolean;
  appendText: (text: string) => void;
  appendThinking: (text: string) => void;
  appendToolLine: (line: ChatLine) => void;
  newAssistantLine: (meta: ChatLine["meta"]) => ChatLine;
  nextPaint: () => Promise<void>;
  pendingQuestionFromEvent: (event: AgentEvent) => PendingUserQuestionLike;
  setPendingUserQuestion: (question: PendingUserQuestionLike) => void;
  setBusy: (busy: boolean) => void;
  trackToolName: (toolName: string) => void;
  addAssistantText: (text: string) => void;
  getAssistantText: () => string;
  flow: CodeFlowAgentEventFlowCallbacks;
}

export function createCodeFlowAgentEventHandler({
  assistantMeta,
  isFlow,
  hasFlowRun,
  appendText,
  appendThinking,
  appendToolLine,
  newAssistantLine,
  nextPaint,
  pendingQuestionFromEvent,
  setPendingUserQuestion,
  setBusy,
  trackToolName,
  addAssistantText,
  getAssistantText,
  flow,
}: CodeFlowAgentEventHandlerOptions) {
  let flowSawTool = false;
  const flowResultLanes: string[] = [];

  const handle = (event: AgentEvent) => {
    if (event.type === "text" && event.text) {
      appendText(event.text);
      if (hasFlowRun && !flowSawTool) {
        flow.appendLaneOutput("planner", event.text);
      }
    } else if (event.type === "thinking" && event.text) {
      appendThinking(event.text);
      if (hasFlowRun) {
        flow.appendLaneOutput(
          flowSawTool ? flowResultLanes[flowResultLanes.length - 1] ?? "worker" : "planner",
          event.text,
        );
      }
    } else if (event.type === "tool_call") {
      if (event.toolName) trackToolName(event.toolName);
      if (!isFlow && event.toolName === "suggest_mode_switch") {
        appendToolExchange(appendToolLine, toolCallLine(event), newAssistantLine, assistantMeta);
        return;
      }
      if (hasFlowRun) {
        if (!flowSawTool) {
          flowSawTool = true;
          flow.setLaneStatus("planner", "completed", "Plan handed off to tool-capable workers.");
          flow.setLaneStatus("worker", "running", "Executing delegated tool work.");
        }
        const isAgentCall = event.toolName === "Agent";
        const taskTitle = String(event.toolArgs?.task ?? event.toolArgs?.description ?? "Subagent").trim();
        const plannedLane = isAgentCall ? flow.findPlannedAgentLane(taskTitle) : null;
        const lane = plannedLane ?? (isAgentCall
          ? flow.createWorkerLane(
              taskTitle.length > 42 ? `${taskTitle.slice(0, 42)}...` : taskTitle,
              "Running a dedicated Flow subagent.",
            )
          : null);
        const laneId = lane?.id ?? "worker";
        flowResultLanes.push(laneId);
        if (lane) {
          flow.setLaneStatus(lane.id, "running", "Subagent running.");
        }
        flow.appendLaneOutput(laneId, `\n${describeToolCall(event.toolName, event.toolArgs)}`);
      }
      appendToolExchange(appendToolLine, toolCallLine(event), newAssistantLine, assistantMeta);
    } else if (event.type === "tool_result") {
      if (event.toolName === "suggest_mode_switch" && hasFlowRun) {
        return;
      }
      if (hasFlowRun) {
        const laneId = flowResultLanes.shift() ?? "worker";
        flow.appendLaneOutput(laneId, `\n${describeToolResult(event.toolName, event.toolResult)}`);
        if (laneId !== "worker") {
          flow.setLaneStatus(laneId, "completed", "Subagent returned a result.");
        }
      }
      appendToolExchange(appendToolLine, toolResultLine(event), newAssistantLine, assistantMeta);
    } else if (event.type === "user_question") {
      setPendingUserQuestion(pendingQuestionFromEvent(event));
      if (hasFlowRun) {
        flow.setLaneStatus(flowSawTool ? "worker" : "planner", "blocked", "Waiting for user answer.");
      }
      setBusy(false);
    } else if (event.type === "error") {
      if (hasFlowRun) {
        flow.setLaneStatus(flowSawTool ? "worker" : "planner", "blocked", event.text ?? "Flow blocked.");
        flow.completeRun("blocked");
      }
      appendToolLine(errorLine(event));
    } else if (event.type === "done" && hasFlowRun) {
      if (!flowSawTool) {
        flow.setLaneStatus("planner", "completed", "Plan completed without worker tool calls.");
      } else {
        flow.setLaneStatus("worker", "completed", "Worker tool lane completed.");
      }
      flow.setLaneStatus("verifier", "running", "Reviewing final response.");
      flow.appendLaneOutput("verifier", getAssistantText() || "Flow completed.");
      flow.setLaneStatus("verifier", "completed", "Final answer ready.");
      flow.completeRun("completed");
    }
  };

  return async (event: AgentEvent) => {
    handle(event);
    if (event.type === "text" || event.type === "thinking") {
      if (event.type === "text" && event.text) addAssistantText(event.text);
      await nextPaint();
    }
  };
}
