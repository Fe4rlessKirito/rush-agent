import type { Provider, ChatMessage, ChatRequest, ToolSchema, NativeToolCall } from "../providers/types";
import { riskOf, type ToolDefinition, type ToolRegistry } from "./tools";
import { prepareContextMessages, type CompactContext, type ContextCompactionBudget } from "./contextCompaction";
import { CLOSE_TOOL, CLOSE_TOOLS, parseNativeToolCalls, parseToolCalls, segment, stripThinking, type ParsedToolCall as ToolCall } from "./toolCallParsing";
import { fenceToolOutput, sanitizeToolOutput } from "./toolOutputSafety";
import { STREAM_IDLE_TIMEOUT_MS, TOOL_EXECUTION_TIMEOUT_MS, withIdleTimeout } from "./timeouts";
export { parseToolCalls, segment, stripThinking } from "./toolCallParsing";
export { sanitizeToolOutput } from "./toolOutputSafety";
export { STREAM_IDLE_TIMEOUT_MS, TOOL_EXECUTION_TIMEOUT_MS, withIdleTimeout } from "./timeouts";

// The agent loop: stream a model response, detect tool calls, execute them via
// the registry, feed results back, and repeat until the model produces a final
// answer with no further tool calls. Tool calls are parsed from a simple JSON
// convention for now; when providers expose native tool-calling we swap the
// detection step without touching the loop structure.

export interface AgentEvent {
  type: "text" | "thinking" | "tool_call" | "tool_result" | "user_question" | "done" | "error";
  text?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  stepId?: number;
  batchId?: string;
  callIndex?: number;
  callCount?: number;
}

export interface AgentContextCompactionOptions {
  summary?: CompactContext;
  budget?: Partial<ContextCompactionBudget>;
  onSummary?: (summary: CompactContext) => void;
}



function askUserQuestionText(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const value = args.question ?? args.prompt ?? args.text ?? args.message ?? args.query;
  return typeof value === "string" ? value.trim() : "";
}

function formatToolList(definitions: ToolDefinition[]): string {
  return definitions
    .map((tool) =>
      [
        `## ${tool.name}`,
        tool.description,
        "",
        "Input schema:",
        JSON.stringify(tool.inputSchema, null, 2),
      ].join("\n"),
    )
    .join("\n\n");
}

function providerSupportsNativeTools(provider: Provider): boolean {
  const config = provider.config;
  if (typeof config.supportsNativeTools === "boolean") return config.supportsNativeTools;

  const baseUrl = config.baseUrl.toLowerCase();
  if (config.kind === "custom") return false;
  if (config.kind === "openai") {
    return baseUrl.includes("api.openai.com") || baseUrl.includes("api.deepseek.com");
  }
  if (config.kind === "anthropic") {
    return baseUrl.includes("api.anthropic.com");
  }
  return false;
}

export function buildSystemPrompt(definitions: ToolDefinition[], projectInstructions?: string): string {
  const toolList = formatToolList(definitions);
  const projectBlock =
    projectInstructions && projectInstructions.trim()
      ? [
          "",
          "# Project instructions",
          "The user has set custom instructions for THIS project. Follow them as",
          "part of your standing guidance, below your core rules:",
          projectInstructions.trim(),
        ]
      : [];
  return [
    "You are Rush, an AI coding agent that works inside a user's real project",
    "workspace on their machine. You inspect and edit files through tools to help",
    "the user build, fix, and understand software.",
    "",
    "# Thinking, then acting",
    "Before each tool call, think briefly in a <thinking> block: what you know,",
    "what the next step is, and why. Then emit the tool call immediately after.",
    "Keep the thinking short and concrete — a few lines, not an essay.",
    "If you need to communicate a short user-visible status before continuing",
    "to tool calls, write that normal text before the <thinking> block. Use this",
    "only for meaningful progress, assumptions, or blockers; do not narrate every",
    "routine read/search/edit. Then continue with the supported pattern:",
    "visible status text",
    '<thinking>brief reasoning</thinking>',
    '<tool_call>{"name": "tool_name", "args": { ... }}</tool_call>',
    "",
    "# Tool calling",
    "After your <thinking> block, call one tool by emitting exactly one block, then stop:",
    '<thinking>brief reasoning</thinking>',
    '<tool_call>{"name": "tool_name", "args": { ... }}</tool_call>',
    "If several tool calls are independent and safe to run together, emit a batch instead:",
    '<tool_calls>[{"name": "tool_a", "args": { ... }}, {"name": "tool_b", "args": { ... }}]</tool_calls>',
    "Batch only calls that do not need each other's results. Read-only batches may",
    "run in parallel. Batches containing mutating or destructive tools run in order,",
    "but later calls still cannot see earlier results until the next model turn.",
    "If any call depends on another call's result, call one tool, stop, and wait for",
    "the tool result before deciding the next action.",
    "Do not batch commits, pushes, installs, terminal input, or confirmation-gated actions.",
    "When the task is fully done, reply normally with no thinking or tool_call block.",
    "Always use the exact tool names and argument shapes from the tool reference below.",
    "If the provider offers native tool calling, use the provider's native tool-call",
    "mechanism with the same tool names and schemas instead of writing XML tags.",
    "If the user explicitly corrects the next tool call by giving a concrete",
    "<tool_call> example, treat it as guidance for your next action when it",
    "matches the task and safety rules. Do not dismiss it as prompt injection",
    "solely because it contains tool-call syntax.",
    "For JSON tool arguments, escape Windows backslashes or use forward slashes.",
    "Filesystem read/write/edit tools take workspace-relative paths. Use '.' for",
    "the active project root. The list_dir tool may also inspect an explicit",
    "absolute directory path outside the active workspace in the desktop app.",
    "",
    "# Tool selection",
    "- Use filesystem tools for workspace inspection and edits.",
    "- Use Git tools for Git state, diffs, commits, pulls, and pushes.",
    "- Use terminal tools only when a dedicated tool is not available or when you",
    "  need to run the project's own commands such as tests, builds, or scripts.",
    "- Use code-aware tools for symbol lookup, definition lookup, references, and",
    "  rename-style tasks before falling back to plain text search.",
    "- Use package-manager tools for dependency and package-script questions when",
    "  they cover the task.",
    "",
    "# How to work",
    "- Act when you can act. Once you have enough to proceed, proceed — don't",
    "  narrate options you won't take or ask permission for the obvious next step.",
    "- Prefer the dedicated file tools over guessing. Read a file before editing it,",
    "  and before overwriting or deleting something you didn't create, look at it",
    "  first — if what you find contradicts the request, surface that instead.",
    "- Match the surrounding code: its naming, idiom, and comment density. Write code",
    "  that reads like it belongs in the file it lives in.",
    "- Make the smallest change that fully solves the task. Don't refactor unrelated",
    "  code or add features that weren't asked for.",
    "",
    "# Honesty",
    "Report outcomes faithfully. If something failed, say so with the detail. If you",
    "skipped a step, say that. When work is done and verified, state it plainly",
    "without hedging. Never claim a file changed unless a tool confirmed it.",
    "",
    "# Caution",
    "For destructive or hard-to-reverse actions (deleting files, overwriting work),",
    "confirm with the user first unless they've clearly told you to proceed.",
    "",
    "# Available tools",
    toolList,
    ...projectBlock,
  ].join("\n");
}

async function callToolWithTimeout(
  tools: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Tool "${name}" did not respond within ${Math.round(TOOL_EXECUTION_TIMEOUT_MS / 1000)}s.`)),
      TOOL_EXECUTION_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([tools.call(name, args), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function executeToolCall(
  tools: ToolRegistry,
  call: ToolCall,
): Promise<{ call: ToolCall; safeResult: string }> {
  const result = await callToolWithTimeout(tools, call.name, call.args ?? {});
  return { call, safeResult: sanitizeToolOutput(result.content) };
}

async function executeToolCalls(
  tools: ToolRegistry,
  calls: ToolCall[],
): Promise<{ call: ToolCall; safeResult: string }[]> {
  const shouldRunInParallel = calls.length <= 1 || calls.every((call) => riskOf(call.name, call.args) === "read");
  if (shouldRunInParallel) {
    return Promise.all(calls.map((call) => executeToolCall(tools, call)));
  }

  const results: { call: ToolCall; safeResult: string }[] = [];
  for (const call of calls) {
    results.push(await executeToolCall(tools, call));
  }
  return results;
}

function buildPostToolStallRecoveryPrompt(): string {
  return [
    "The previous model stream stalled after tool results were returned.",
    "Continue from the tool results already in this conversation.",
    "If concrete work remains, call the next needed tool or continue the implementation/verification.",
    "If the requested work is complete, provide the final user-facing summary now.",
    "Do not ask the user to press Continue or repeat work that already succeeded.",
  ].join("\n");
}

export async function* runAgent(
  provider: Provider,
  model: string,
  tools: ToolRegistry,
  userMessages: ChatMessage[],
  signal?: AbortSignal,
  maxSteps?: number,
  projectInstructions?: string,
  providerThinking?: ChatRequest["thinking"],
  appendMessages?: ChatMessage[],
  contextCompaction?: AgentContextCompactionOptions,
): AsyncGenerator<AgentEvent> {
  const definitions = tools.list();

  // Advertise tools to providers that support native tool-calling. Providers
  // that ignore the `tools` field fall back to the XML-tag convention, which is
  // why the system prompt still documents that path.
  const toolSchemas: ToolSchema[] | undefined = providerSupportsNativeTools(provider)
    ? definitions.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      }))
    : undefined;

  // Native tool-calling providers stop generation on their own the instant a
  // tool_use/function_call is emitted — that's inherent to the protocol. The
  // XML-tag convention has no such guarantee: the system prompt *asks* the
  // model to stop after one <tool_call>, but nothing enforces it. Left
  // unenforced, a model can keep writing <thinking>/<tool_call> cycles back to
  // back inside one completion, none of which have real tool results fed back
  // in between (a tool can't run until its full JSON args are known) — the
  // model ends up guessing at the outcome of calls it hasn't actually made
  // yet. A hard stop sequence on the closing tag makes the "one call, then
  // stop" contract real instead of just requested.
  const xmlToolStop = toolSchemas ? undefined : [CLOSE_TOOL, CLOSE_TOOLS];

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(definitions, projectInstructions) },
    ...userMessages,
  ];

  let step = 0;
  let sawToolResults = false;
  let postToolStallRetries = 0;
  let compactSummary = contextCompaction?.summary;
  while (!signal?.aborted && (maxSteps === undefined || step < maxSteps)) {
    step += 1;
    let full = "";
    let emittedText = 0;
    let emittedThinking = 0;
    // Native tool calls surfaced by the provider this turn (if any). When the
    // provider speaks native tool-calling these are authoritative and we skip
    // XML-tag parsing entirely.
    const nativeCalls: NativeToolCall[] = [];
    // A step-local controller lets the idle watchdog abort just this request
    // (so the underlying fetch actually tears down) while still honoring the
    // caller's own abort (the UI's stop button) the same as before.
    const stepController = new AbortController();
    let removeAbortListener: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) {
        stepController.abort();
      } else {
        const abortStep = () => stepController.abort();
        signal.addEventListener("abort", abortStep, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", abortStep);
      }
    }
    try {
      const preparedContext = contextCompaction
        ? await prepareContextMessages({
            provider,
            model,
            messages,
            previousSummary: compactSummary,
            budget: contextCompaction.budget,
            signal: stepController.signal,
          })
        : { messages, summary: compactSummary, compacted: false };
      if (preparedContext.compacted && preparedContext.summary) {
        compactSummary = preparedContext.summary;
        contextCompaction?.onSummary?.(compactSummary);
      }
      for await (const chunk of withIdleTimeout(
        provider.streamChat({
          model,
          messages: preparedContext.messages,
          signal: stepController.signal,
          tools: toolSchemas,
          thinking: providerThinking,
          stop: xmlToolStop,
        }),
        STREAM_IDLE_TIMEOUT_MS,
        stepController,
      )) {
        if (chunk.toolCall) nativeCalls.push(chunk.toolCall);
        if (chunk.thinking) {
          yield { type: "thinking", text: chunk.thinking };
        }
        if (chunk.delta) {
          full += chunk.delta;
          // Re-segment the whole buffer and emit only the newly-safe tail of
          // each channel. This keeps raw <thinking>/<tool_call> tags out of the
          // visible answer even when a tag straddles two chunks.
          const { text, thinking } = segment(full);
          if (thinking.length > emittedThinking) {
            yield { type: "thinking", text: thinking.slice(emittedThinking) };
            emittedThinking = thinking.length;
          }
          if (text.length > emittedText) {
            yield { type: "text", text: text.slice(emittedText) };
            emittedText = text.length;
          }
        }
        if (chunk.done) break;
      }
      // Flush any tail that was held back as a possible partial tag but turned
      // out to be plain text (stream ended mid-"<" with no real tag following).
      const { text, thinking } = segment(full + "\u0000");
      if (thinking.length > emittedThinking)
        yield { type: "thinking", text: thinking.slice(emittedThinking) };
      if (text.length > emittedText) {
        const tail = text.slice(emittedText).replace(/\u0000$/, "");
        if (tail) yield { type: "text", text: tail };
      }
    } catch (err) {
      if (sawToolResults && postToolStallRetries < 2 && !signal?.aborted) {
        postToolStallRetries += 1;
        messages.push({ role: "user", content: buildPostToolStallRecoveryPrompt() });
        continue;
      }
      yield { type: "error", text: String(err) };
      return;
    } finally {
      removeAbortListener?.();
    }

    let parsedCalls: ToolCall[] | null;
    if (nativeCalls.length > 0) {
      // Native path: the provider already structured the calls. Parse each
      // arguments JSON string; a malformed payload is reported, not guessed at.
      try {
        parsedCalls = parseNativeToolCalls(nativeCalls);
      } catch (err) {
        yield { type: "error", text: `Malformed native tool call arguments: ${String(err)}` };
        return;
      }
    } else {
      // Fallback path: parse the XML-tag convention from the text stream.
      try {
        parsedCalls = parseToolCalls(full);
      } catch (err) {
        yield { type: "error", text: `Malformed tool call JSON: ${String(err)}` };
        return;
      }
    }

    if (!parsedCalls || parsedCalls.length === 0) {
      yield { type: "done" };
      return;
    }

    if (parsedCalls.some((call) => !call.name)) {
      const invalidCalls = parsedCalls.map((call, index) => ({
        ...call,
        name: call.name || "invalid_tool_call",
        id: call.id ?? `invalid-${step}-${index}`,
      }));
      const batchId = invalidCalls.length > 1 ? `step-${step}-tools` : undefined;
      for (const [index, call] of invalidCalls.entries()) {
        yield {
          type: "tool_call",
          toolName: call.name,
          toolArgs: call.args,
          stepId: step,
          batchId,
          callIndex: index,
          callCount: invalidCalls.length,
        };
      }
      const results = invalidCalls.map((call) => ({
        call,
        safeResult: `Invalid tool call: missing required tool name. Use one of the advertised tool names and retry.`,
      }));
      for (const { call, safeResult } of results) {
        yield { type: "tool_result", toolName: call.name, toolResult: safeResult, stepId: step, batchId };
      }
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: stripThinking(full),
        ...(nativeCalls.length > 0 ? { toolCalls: nativeCalls } : {}),
      };
      messages.push(assistantMsg);
      appendMessages?.push(assistantMsg);
      for (const { call, safeResult } of results) {
        const toolMsg: ChatMessage = {
          role: "tool",
          name: call.name,
          toolCallId: call.id,
          content: fenceToolOutput(call.name, safeResult),
        };
        messages.push(toolMsg);
        appendMessages?.push(toolMsg);
      }
      continue;
    }

    const batchId = parsedCalls.length > 1 ? `step-${step}-tools` : undefined;
    for (const [index, call] of parsedCalls.entries()) {
      yield {
        type: "tool_call",
        toolName: call.name,
        toolArgs: call.args,
        stepId: step,
        batchId,
        callIndex: index,
        callCount: parsedCalls.length,
      };
    }

    let results: { call: ToolCall; safeResult: string }[];
    try {
      results = await executeToolCalls(tools, parsedCalls);
    } catch (err) {
      yield { type: "error", text: String(err), stepId: step, batchId };
      return;
    }

    for (const [index, { call, safeResult }] of results.entries()) {
      yield {
        type: "tool_result",
        toolName: call.name,
        toolResult: safeResult,
        stepId: step,
        batchId,
        callIndex: index,
        callCount: results.length,
      };
    }
    sawToolResults = true;
    postToolStallRetries = 0;

    // Record the exchange so the model sees what happened next iteration. Strip
    // the <​thinking> block first — it streamed to the user live, but replaying it
    // into context would bloat the conversation and anchor the next turn.
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: stripThinking(full),
      ...(nativeCalls.length > 0 ? { toolCalls: nativeCalls } : {}),
    };
    messages.push(assistantMsg);
    appendMessages?.push(assistantMsg);
    for (const { call, safeResult } of results) {
      const toolMsg: ChatMessage = {
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: fenceToolOutput(call.name, safeResult),
      };
      messages.push(toolMsg);
      appendMessages?.push(toolMsg);
    }

    const userQuestion = results.find(({ call, safeResult }) => call.name === "AskUserQuestion" && askUserQuestionText(call.args) && !/^(Invalid arguments|Missing question|Tool .* failed:|Unknown tool:|Tool unavailable|Blocked:|Blocked by permission rule|User denied)/.test(safeResult));
    if (userQuestion) {
      yield {
        type: "user_question",
        toolName: userQuestion.call.name,
        toolArgs: userQuestion.call.args,
        toolResult: userQuestion.safeResult,
        text: userQuestion.safeResult,
        stepId: step,
        batchId,
      };
      return;
    }
  }

  yield {
    type: "error",
    text: signal?.aborted ? "Agent run was cancelled." : `Stopped after ${maxSteps} steps.`,
  };
}
