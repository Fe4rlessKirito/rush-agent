import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useAppStore, type ChatLine, type Conversation } from "../../core/store";
import { useProjectStore } from "../../core/projectStore";
import { useFlowStore } from "../../core/flowStore";
import { useFileStore } from "../../core/fileStore";
import { buildBrainContext, extractBrainFromTurn } from "../../core/brainRuntime";
import { thinkingForEffort } from "../../core/effort";
import { ProviderRegistry } from "../../core/providers/registry";
import { groupModels, modelDisplayName } from "../../core/providers/modelGroups";
import { useResearchStore, type ResearchRun } from "../../core/researchStore";
import type { ConfirmRequest } from "../../core/agent/tools";
import { buildFlowRuntimeInstructions } from "../../core/agent/flowPrompt";
import { runAgent } from "../../core/agent/agentLoop";
import { chooseAndSetProjectRoot, setDesktopProjectRoot } from "../../core/projectRoot";
import {
  buildPackRuntimeContext,
  resolvePackCommandInvocation,
  suggestPackCommands,
  userTextWithPackCommandInvocation,
} from "../../core/packs/packRuntime";
import { usePackStore } from "../../core/packs/packStore";
import type { ChatContentPart, ChatMessage } from "../../core/providers/types";
import {
  estimateContextWindowUsage,
  formatTokenCount,
  modelContextLimit,
  normalizePercent,
} from "../chat/contextWindow";
import {
  presetFromPermissions,
  type PermissionPreset,
} from "../chat/chatPanelHelpers";
import {
  codeTools,
  chatTools,
  flowTools,
} from "../chat/chatToolRegistries";
import { supportsNativeImageContent } from "../chat/attachmentEndpointChat";
import { runAttachmentSendRuntime } from "../chat/attachmentSendRuntime";
import {
  attachmentUnsupportedMessage,
  buildImagePrompt,
  buildUserContent,
  buildVisibleUserText,
  fallbackChatHistory,
  flowPromptForTurn,
  splitAttachments,
} from "../chat/chatSendPreparation";
import {
  libraryContextText,
  researchContextText,
  userTextWithLibraryContext,
  conversationText,
  type LibraryContextItem,
} from "../chat/libraryContext";
import {
  openComposerProjectRoot as openComposerProjectRootWithDeps,
  syncConversationProjectRoot as syncConversationProjectRootWithDeps,
} from "../chat/projectContext";
import {
  createCodeFlowAgentEventHandler,
  handleChatModeAgentEvent,
} from "../chat/chatAgentEvents";
import {
  flowAgentEventStoreCallbacks,
  flowSendStoreCallbacks,
  prepareFlowSendRuntime,
} from "../chat/flowSendRuntime";
import { ChatMessages } from "../chat/ChatMessages";
import { ChatComposer } from "../chat/ChatComposer";
import { PendingUserQuestionCard } from "../chat/PendingUserQuestionCard";
import { ImagePreviewModal } from "../chat/ImagePreviewModal";
import { ConfirmActionModal } from "../chat/ConfirmActionModal";
import { ChatContextPicker } from "../chat/ChatContextPicker";
import { ModeSwitchBanner } from "../chat/ModeSwitchBanner";
import { SubagentReadonlyComposer } from "../chat/SubagentReadonlyComposer";
import {
  appendLatestAgentErrorLine,
  markLatestAgentLineCompleted,
  newAssistantLine,
} from "../chat/chatLineUpdates";
import { pendingQuestionFromAgentEvent, type PendingUserQuestion } from "../chat/pendingQuestions";
import { useChatAttachments } from "../chat/useChatAttachments";
import { useChatPanelViewState } from "../chat/useChatPanelViewState";
import { useChatToolPermissions } from "../chat/useChatToolPermissions";
import { useActiveRunTimer } from "../chat/useActiveRunTimer";
import { useModeSwitchPrompt } from "../chat/useModeSwitchPrompt";
import { useProviderModels } from "../chat/useProviderModels";
import "highlight.js/styles/github-dark.css";

type ChatMode = "plain" | "agent" | "flow";
type LibraryContextPicker = "deepResearch";

interface Props {
  // "flow" opens Flow's own separate conversation space (a fundamentally
  // different interaction pattern — parallel lanes, not a linear chat).
  // Omitted (or any other value) opens the unified Chat/Code space; which of
  // the two is active lives in the store's `chatMode`, switchable in place via
  // the mode switcher rendered inside this panel.
  mode?: ChatMode;
}

export function ChatPanel({ mode }: Props) {
  const {
    providers,
    activeProviderId,
    activeModel,
    setActive,
    chat: sharedChat,
    setChat: setSharedChat,
    flowChat,
    setFlowChat,
    chatMessages: sharedChatMessages,
    setChatMessages: setSharedChatMessages,
    chatCompactSummary: sharedChatCompactSummary,
    setChatCompactSummary: setSharedChatCompactSummary,
    flowChatMessages,
    setFlowChatMessages,
    flowCompactSummary,
    setFlowCompactSummary,
    chatMode,
    conversations,
    subagentRuns,
    activeSubagentRunId,
    activeConversationId,
    conversationProjectContext,
    toolPermissions,
    setToolPermissions,
  } = useAppStore();
  const researchRuns = useResearchStore((s) => s.runs);
  const isFlow = mode === "flow";
  // Flow always has full tool access, like Code. For the shared Chat/Code
  // space, whether tools are available depends on the conversation's current
  // sub-mode, which the user (or the AI, with confirmation) can switch at any
  // point without starting a new conversation.
  const isAgentMode = isFlow ? true : chatMode === "agent";
  // Used for brain/pack context tagging and placeholder text below, where a
  // ConversationMode-shaped label is expected rather than the raw prop (which
  // is usually undefined now that Chat and Code share one space).
  const effectiveMode: ChatMode = isFlow ? "flow" : chatMode;
  const chat = isFlow ? flowChat : sharedChat;
  const setChat = isFlow ? setFlowChat : setSharedChat;
  // Raw provider message history (tool calls/results included) for the active
  // conversation, mirrored in the store so it survives conversation switches,
  // mode switches, and app reloads — unlike the old purely-local ref, which
  // got wiped on any of those and forced a lossy rebuild from display text
  // alone (dropping every tool_call/tool_result turn).
  const chatMessages = isFlow ? flowChatMessages : sharedChatMessages;
  const setChatMessages = isFlow ? setFlowChatMessages : setSharedChatMessages;
  const compactSummary = isFlow ? flowCompactSummary : sharedChatCompactSummary;
  const setCompactSummary = isFlow ? setFlowCompactSummary : setSharedChatCompactSummary;

  // Custom instructions for the currently-open project, fed into the agent's
  // system prompt so each project can steer the model differently.
  const projectInstructions = useProjectStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.instructions ?? "",
  );
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const activeProject = useProjectStore((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const createProject = useProjectStore((s) => s.createProject);
  const openProject = useProjectStore((s) => s.openProject);
  const renameProject = useProjectStore((s) => s.renameProject);
  const setProjectPath = useProjectStore((s) => s.setProjectPath);
  const [input, setInput] = useState("");
  const [selectedPackCommandIndex, setSelectedPackCommandIndex] = useState(0);
  const packSuggestionKey = usePackStore((s) =>
    s.packs
      .map((pack) =>
        `${pack.id}:${pack.enabled}:${pack.scope ?? "global"}:${(pack.projectIds ?? []).join(",")}:${pack.updatedAt}:${pack.commands.length}`,
      )
      .join("|"),
  );
  const {
    attachments,
    previewAttachment,
    setPreviewAttachment,
    onPickFile,
    removeAttachment,
    clearAttachments,
  } = useChatAttachments({
    appendToolLine: (line) => setChat((l) => [...l, line]),
  });
  const [contextItems, setContextItems] = useState<LibraryContextItem[]>([]);
  const [contextPicker, setContextPicker] = useState<LibraryContextPicker | null>(null);
  const [contextQuery, setContextQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const { activeRunStartedAt, elapsedNow } = useActiveRunTimer(busy);
  const [pendingUserQuestion, setPendingUserQuestion] = useState<PendingUserQuestion | null>(null);
  const [pendingUserAnswer, setPendingUserAnswer] = useState("");
  const { pendingModeSwitch, resolveModeSwitch } = useModeSwitchPrompt({
    activeConversationId,
    effectiveMode,
    onReset: () => {
      setShowAllMessages(false);
      setPendingUserQuestion(null);
      setPendingUserAnswer("");
    },
  });
  const [effort, setEffort] = useState(1);
  const [showPermissionMenu, setShowPermissionMenu] = useState(false);
  const [showAllMessages, setShowAllMessages] = useState(false);
  // Per-line manual override for the thinking disclosure. When a user clicks to
  // open or close a block we honor that choice; otherwise the block follows the
  // auto rule (open while reasoning streams, closed once the answer begins).
  const [openOverride, setOpenOverride] = useState<Record<number, boolean>>({});
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Pending destructive-action confirmation. When set, a modal asks the user to
  // Allow or Deny; the stored resolver feeds their choice back to the tool gate.
  const [confirm, setConfirm] = useState<
    { req: ConfirmRequest; resolve: (ok: boolean) => void } | null
  >(null);

  // Install the confirmation handler once. The registry calls this for every
  // destructive tool; we surface a modal and resolve with the user's choice.
  useChatToolPermissions({
    toolPermissions,
    requestConfirm: (req, resolve) => setConfirm({ req, resolve }),
  });

  const resolveConfirm = (ok: boolean) => {
    setConfirm((c) => {
      c?.resolve(ok);
      return null;
    });
  };

  // Always include the active model in the options even if the fetch failed or
  // hasn't returned, so the selector never shows an empty/blank value.
  const activeModelAllowed = activeModel ? activeModel : null;
  const showProjectSelector = !conversationProjectContext?.projectRoot;
  const projectChipLabel = activeProject?.name || "Rush Agent";
  const projectChipTitle = activeProject?.path || "Select a project";
  const permissionPreset = presetFromPermissions(toolPermissions);
  const models = useProviderModels({
    providers,
    activeProviderId,
    activeModel,
    setActive,
  });
  const modelOptions = Array.from(new Set([...(activeModelAllowed ? [activeModelAllowed] : []), ...models]));
  const modelGroups = groupModels(modelOptions);
  const contextWindowLimit = modelContextLimit(activeModel);
  const contextWindowTokens = useMemo(() => estimateContextWindowUsage({
    messages: chatMessages,
    input,
    contextItems,
    attachments,
  }), [attachments, chatMessages, contextItems, input]);
  const contextWindowPercent = normalizePercent((contextWindowTokens / contextWindowLimit) * 100);
  const contextWindowLabel = `${formatTokenCount(contextWindowTokens)}/${formatTokenCount(contextWindowLimit)} (${contextWindowPercent.toFixed(1)}%)`;
  const contextWindowTitle = `Estimated context window usage: ${contextWindowTokens.toLocaleString()} / ${contextWindowLimit.toLocaleString()} tokens (${contextWindowPercent.toFixed(1)}%)`;
  const packCommandSuggestions = useMemo(
    () => suggestPackCommands(input, effectiveMode, 6, activeProjectId),
    [input, effectiveMode, packSuggestionKey, activeProjectId],
  );

  useEffect(() => {
    setSelectedPackCommandIndex(0);
  }, [input, packSuggestionKey, activeProjectId]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    const next = Math.min(el.scrollHeight, 180);
    el.style.height = `${Math.max(next, 44)}px`;
    el.style.overflowY = el.scrollHeight > 180 ? "auto" : "hidden";
  }, [input]);

  function submitPendingUserAnswer(answer: string) {
    const trimmed = answer.trim();
    if (!trimmed || !pendingUserQuestion || busy) return;
    const question = pendingUserQuestion.question;
    setPendingUserQuestion(null);
    setPendingUserAnswer("");
    void send(`Answer to your clarification question:\n\nQuestion: ${question}\n\nAnswer: ${trimmed}`);
  }

  function currentAssistantMeta() {
    const provider = providers.find((item) => item.id === activeProviderId);
    const label = activeModel ? modelDisplayName(activeModel) : "Rush";
    return {
      speaker: label,
      model: activeModel ?? undefined,
      modelLabel: label,
      providerId: activeProviderId ?? undefined,
      providerLabel: provider?.label,
      startedAt: Date.now(),
    } satisfies ChatLine["meta"];
  }

  function appendToLatestAgent(patch: Partial<Pick<ChatLine, "text" | "thinking">>) {
    flushSync(() => {
      setChat((l) => {
        const next = l.slice();
        const cur = next[next.length - 1];
        next[next.length - 1] = {
          ...cur,
          role: "agent",
          text: patch.text === undefined ? cur.text : cur.text + patch.text,
          thinking:
            patch.thinking === undefined
              ? cur.thinking
              : (cur.thinking ?? "") + patch.thinking,
          meta: cur.meta ?? currentAssistantMeta(),
        };
        return next;
      });
    });
  }

  function appendLatestAgentError(text: string) {
    setChat((l) => appendLatestAgentErrorLine(l, text));
  }

  function nextPaint(): Promise<void> {
    return new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }

  function applyPermissionPreset(preset: PermissionPreset) {
    setToolPermissions({
      allow: preset.allow,
      ask: preset.ask,
      deny: preset.deny,
    });
    setShowPermissionMenu(false);
  }

  async function openComposerProjectRoot() {
    await openComposerProjectRootWithDeps({
      busy,
      chooseProjectRoot: chooseAndSetProjectRoot,
      projects: useProjectStore.getState().projects,
      createProject,
      setProjectPath,
      renameProject,
      openProject,
      setConversationProjectContext: useAppStore.getState().setConversationProjectContext,
      loadFilesFromDisk: useFileStore.getState().loadFromDisk,
      onError: (text) => setChat((l) => [...l, { role: "tool", text }]),
    });
  }

  async function syncConversationProjectRoot(): Promise<string> {
    return syncConversationProjectRootWithDeps({
      isAgentMode,
      conversationProjectContext,
      setDesktopProjectRoot,
      getFileState: () => useFileStore.getState(),
    });
  }

  function addConversationContext(conversation: Conversation) {
    const item: LibraryContextItem = {
      id: conversation.id,
      kind: "chat",
      title: conversation.title,
      text: conversationText(conversation),
    };
    setContextItems((items) => {
      if (items.some((existing) => existing.kind === item.kind && existing.id === item.id)) return items;
      return [...items, item];
    });
    setContextPicker(null);
    setContextQuery("");
  }

  function addResearchContext(run: ResearchRun) {
    const item: LibraryContextItem = {
      id: run.id,
      kind: "research",
      title: run.title,
      text: researchContextText(run),
    };
    setContextItems((items) => {
      if (items.some((existing) => existing.kind === item.kind && existing.id === item.id)) return items;
      return [...items, item];
    });
    setContextPicker(null);
    setContextQuery("");
  }

  async function send(overrideText?: string) {
    const submittedInput = overrideText ?? input;
    if ((!submittedInput.trim() && attachments.length === 0 && contextItems.length === 0) || busy || activeSubagentRunId) return;
    if (!activeProviderId || !activeModel) {
      setChat((l) => [...l, { role: "tool", text: "Pick a provider + model in Settings first." }]);
      return;
    }
    const cfg = providers.find((p) => p.id === activeProviderId);
    if (!cfg) {
      setChat((l) => [...l, { role: "tool", text: "The selected provider no longer exists. Pick a provider in Settings." }]);
      return;
    }
    const registry = new ProviderRegistry(providers);
    const provider = registry.get(activeProviderId);
    let projectRuntimeContext = "";
    try {
      projectRuntimeContext = await syncConversationProjectRoot();
    } catch (err) {
      setChat((l) => [...l, { role: "tool", text: `Project root sync failed: ${String(err)}` }]);
      return;
    }
    const userText = submittedInput;
    const attached = attachments;
    const { imageAttachments, fileAttachments, hasImages, hasFiles } = splitAttachments(attached);
    const brainContext = buildBrainContext(userText, effectiveMode, activeProjectId);
    const packRuntimeContext = buildPackRuntimeContext(effectiveMode, activeProjectId);
    const packCommandInvocation = resolvePackCommandInvocation(userText, effectiveMode, activeProjectId);
    const selectedLibraryContext = libraryContextText(contextItems);
    const modelUserText = userTextWithPackCommandInvocation(
      userTextWithLibraryContext(userText, selectedLibraryContext),
      packCommandInvocation,
    );
    let flowContext = isFlow ? buildFlowRuntimeInstructions() : "";
    const effortThinking = cfg?.supportsThinking ? thinkingForEffort(effort) : undefined;
    const toolNamesUsed: string[] = [];
    let assistantText = "";
    const flowPrompt = flowPromptForTurn({
      userText,
      hasSelectedLibraryContext: Boolean(selectedLibraryContext),
      contextItems,
    });
    const flowRun = isFlow && attached.length === 0 ? useFlowStore.getState().startRun(flowPrompt) : null;
    if (flowRun) {
      useFlowStore.getState().setLaneStatus(flowRun.id, "planner", "running", "Planning the work lanes.");
    }
    const imagePrompt = buildImagePrompt({ modelUserText, imageAttachments });
    const userContent: string | ChatContentPart[] = buildUserContent({
      hasImages,
      imagePrompt,
      imageAttachments,
      modelUserText,
    });
    // Prefer the persisted raw message history (includes tool_call/tool_result
    // turns). Falling back to display text only applies to conversations saved
    // before this history was tracked — reconstructing from `chat` lines drops
    // every tool exchange, which is what previously made the model think it
    // had hallucinated tool results a few rounds in: the evidence was simply
    // never sent back to it.
    const history: ChatMessage[] = chatMessages.length > 0
      ? chatMessages
      : fallbackChatHistory(chat);
    const unsupportedAttachmentMessage = attachmentUnsupportedMessage({
      hasImages,
      hasFiles,
      supportsImageChatEndpoint: cfg?.supportsImageChatEndpoint,
      supportsFileChatEndpoint: cfg?.supportsFileChatEndpoint,
      supportsNativeImages: supportsNativeImageContent(cfg),
    });
    if (unsupportedAttachmentMessage) {
      setChat((l) => [...l, { role: "tool", text: unsupportedAttachmentMessage }]);
      return;
    }
    if (overrideText === undefined) setInput("");
    clearAttachments();
    setContextItems([]);
    const visibleUserText = buildVisibleUserText({
      userText,
      hasImages,
      hasFiles,
      imageAttachments,
      fileAttachments,
      hasSelectedLibraryContext: Boolean(selectedLibraryContext),
      contextItems,
    });
    const assistantMeta = currentAssistantMeta();
    setChat((l) => [...l, { role: "user", text: visibleUserText }, newAssistantLine(assistantMeta)]);
    setBusy(true);
    abortRef.current = new AbortController();

    if (flowRun) {
      const flowRuntime = await prepareFlowSendRuntime({
        provider,
        model: activeModel,
        tools: codeTools,
        flowRunId: flowRun.id,
        userText,
        signal: abortRef.current.signal,
        baseFlowContext: flowContext,
        projectInstructions: [projectRuntimeContext, projectInstructions, packRuntimeContext].filter(Boolean).join("\n\n"),
        ...flowSendStoreCallbacks(flowRun.id),
      });
      if (!flowRuntime.ok) {
        const message = flowRuntime.error ?? "Flow planner failed.";
        appendLatestAgentError(message);

        markLatestAgentCompleted();
        setBusy(false);
        return;
      }
      flowContext = flowRuntime.flowContext;
    }

    const hasEndpointAttachmentPath = hasImages && cfg?.supportsImageChatEndpoint || hasFiles && cfg?.supportsFileChatEndpoint;

    if (!isAgentMode) {
      const chatNewMsgs: ChatMessage[] = [];
      const chatUserMsg: ChatMessage = { role: "user", content: userContent };
      try {
        if (hasEndpointAttachmentPath) {
          const text = await runAttachmentSendRuntime({
            cfg,
            imageAttachments,
            fileAttachments,
            hasImages,
            hasFiles,
            supportsImageChatEndpoint: cfg?.supportsImageChatEndpoint,
            supportsFileChatEndpoint: cfg?.supportsFileChatEndpoint,
            question: modelUserText,
            model: activeModel,
            signal: abortRef.current?.signal,
            appendText: (text) => appendToLatestAgent({ text }),
            appendError: appendLatestAgentError,
            afterDelta: nextPaint,
          });
          assistantText += text;
        } else {
          for await (const ev of runAgent(
            provider,
            activeModel,
            chatTools,
            [...history, chatUserMsg],
            abortRef.current.signal,
            8,
            [
              projectRuntimeContext,
              "You are Rush in Chat mode. You may answer, explain, plan, use Brain memories, search saved Library chats, run or read Deep Research, inspect websites with the passive Website Environment tool, and analyze images attached directly to the current message. You do not have filesystem, terminal, Git, package-manager, MCP, or Flow-agent access in Chat. Do not claim to inspect workspace files, run commands, edit projects, save files, or view the user's screen from Chat. Attached images are visible message content, not filesystem or screen access. Website Environment is passive fetch only: do not run exploit payloads, credential attacks, brute force, load tests, stealth, or destructive checks.",
              brainContext,
            ].filter(Boolean).join("\n\n"),
            effortThinking,
            chatNewMsgs,
            { summary: compactSummary, onSummary: setCompactSummary },
          )) {
            const shouldContinue = await handleChatModeAgentEvent({
              event: ev,
              assistantMeta,
              appendText: (text) => appendToLatestAgent({ text }),
              appendThinking: (text) => appendToLatestAgent({ thinking: text }),
              appendToolLine: (line) => setChat((l) => [...l, line]),
              newAssistantLine,
              nextPaint,
              pendingQuestionFromEvent: pendingQuestionFromAgentEvent,
              setPendingUserQuestion,
              setBusy,
              trackToolName: (toolName) => toolNamesUsed.push(toolName),
              addAssistantText: (text) => { assistantText += text; },
            });
            if (!shouldContinue) break;
          }
        }
      } catch (err) {
        appendLatestAgentError(`Error: ${String(err)}`);
      } finally {
        setChatMessages([...history, chatUserMsg, ...chatNewMsgs]);
        extractBrainFromTurn({ userText, assistantText, mode: effectiveMode });
        markLatestAgentCompleted();
        setBusy(false);
      }
      return;
    }

    if (hasEndpointAttachmentPath) {
      try {
        const text = await runAttachmentSendRuntime({
          cfg,
          imageAttachments,
          fileAttachments,
          hasImages,
          hasFiles,
          supportsImageChatEndpoint: cfg?.supportsImageChatEndpoint,
          supportsFileChatEndpoint: cfg?.supportsFileChatEndpoint,
          question: modelUserText,
          model: activeModel,
          signal: abortRef.current?.signal,
          appendText: (text) => appendToLatestAgent({ text }),
          appendError: appendLatestAgentError,
          afterDelta: nextPaint,
        });
        assistantText += text;
      } finally {
        extractBrainFromTurn({ userText, assistantText, mode: effectiveMode, toolNames: toolNamesUsed });
        markLatestAgentCompleted();
        setBusy(false);
      }
      return;
    }

    const handleAndPaint = createCodeFlowAgentEventHandler({
      assistantMeta,
      isFlow,
      hasFlowRun: Boolean(flowRun),
      appendText: (text) => appendToLatestAgent({ text }),
      appendThinking: (text) => appendToLatestAgent({ thinking: text }),
      appendToolLine: (line) => setChat((l) => [...l, line]),
      newAssistantLine,
      nextPaint,
      pendingQuestionFromEvent: pendingQuestionFromAgentEvent,
      setPendingUserQuestion,
      setBusy,
      trackToolName: (toolName) => toolNamesUsed.push(toolName),
      addAssistantText: (text) => { assistantText += text; },
      getAssistantText: () => assistantText,
      flow: flowAgentEventStoreCallbacks(flowRun?.id ?? null),
    });

    const agentNewMsgs: ChatMessage[] = [];
    const agentUserMsg: ChatMessage = { role: "user", content: userContent };
    try {
      for await (const ev of runAgent(
        provider,
        activeModel,
        isFlow ? flowTools : codeTools,
        [...history, agentUserMsg],
        abortRef.current.signal,
        undefined,
        [projectRuntimeContext, projectInstructions, brainContext, packRuntimeContext, flowContext].filter(Boolean).join("\n\n"),
        effortThinking,
        agentNewMsgs,
        { summary: compactSummary, onSummary: setCompactSummary },
      )) {
        await handleAndPaint(ev);
      }
    } finally {
      setChatMessages([...history, agentUserMsg, ...agentNewMsgs]);
      if (flowRun && useFlowStore.getState().runs.find((run) => run.id === flowRun.id)?.status === "running") {
        useFlowStore.getState().completeRun(flowRun.id, "cancelled");
      }
      extractBrainFromTurn({ userText, assistantText, mode: effectiveMode, toolNames: toolNamesUsed });
      setBusy(false);
    }
  }

  function cancelStreaming() {
    abortRef.current?.abort();
    abortRef.current = null;
    markLatestAgentCompleted();
    setBusy(false);
  }

  function completePackCommand(name: string) {
    const args = input.trim().match(/^\/[^\s]+(?:\s+([\s\S]*))?$/)?.[1]?.trim() ?? "";
    setInput(args ? `/${name} ${args}` : `/${name} `);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function markLatestAgentCompleted() {
    const completedAt = Date.now();
    setChat((lines) => markLatestAgentLineCompleted(lines, completedAt));
  }

  const {
    pickerConversations,
    pickerResearchRuns,
    attachmentAccept,
    activeSubagent,
    renderedItems,
    hiddenMessageCount,
  } = useChatPanelViewState({
    conversations,
    activeConversationId,
    contextQuery,
    researchRuns,
    providers,
    activeProviderId,
    isAgentMode,
    subagentRuns,
    activeSubagentRunId,
    chat,
    showAllMessages,
  });

  return (
    <div className="chat-panel">
      {pendingModeSwitch && (
        <ModeSwitchBanner
          mode={pendingModeSwitch.mode}
          reason={pendingModeSwitch.reason}
          resolve={resolveModeSwitch}
        />
      )}
      <ChatMessages
        renderedItems={renderedItems}
        hiddenMessageCount={hiddenMessageCount}
        busy={busy}
        activeSubagent={activeSubagent}
        chatLength={chat.length}
        activeRunStartedAt={activeRunStartedAt}
        elapsedNow={elapsedNow}
        activeModel={activeModel}
        openOverride={openOverride}
        setOpenOverride={setOpenOverride}
        onShowAllMessages={() => setShowAllMessages(true)}
      />
      {pendingUserQuestion && (
        <PendingUserQuestionCard
          question={pendingUserQuestion.question}
          choices={pendingUserQuestion.choices}
          answer={pendingUserAnswer}
          busy={busy}
          setAnswer={setPendingUserAnswer}
          submitAnswer={submitPendingUserAnswer}
        />
      )}
      {activeSubagent ? (
        <SubagentReadonlyComposer status={activeSubagent.status} />
      ) : (
        <ChatComposer
          showProjectSelector={showProjectSelector}
          projectChipTitle={projectChipTitle}
          projectChipLabel={projectChipLabel}
          busy={busy}
          openProjectRoot={openComposerProjectRoot}
          attachments={attachments}
          previewAttachment={setPreviewAttachment}
          removeAttachment={removeAttachment}
          textareaRef={textareaRef}
          fileRef={fileRef}
          input={input}
          setInput={setInput}
          isAgentMode={isAgentMode}
          isFlow={isFlow}
          packCommandSuggestions={packCommandSuggestions}
          selectedPackCommandIndex={selectedPackCommandIndex}
          setSelectedPackCommandIndex={setSelectedPackCommandIndex}
          completePackCommand={completePackCommand}
          contextItems={contextItems}
          removeContextItem={(item) => setContextItems((items) => items.filter((x) => x !== item))}
          attachmentAccept={attachmentAccept}
          onPickFile={onPickFile}
          permissionPreset={permissionPreset}
          showPermissionMenu={showPermissionMenu}
          setShowPermissionMenu={setShowPermissionMenu}
          applyPermissionPreset={applyPermissionPreset}
          openContextPicker={() => setContextPicker("deepResearch")}
          contextWindowTitle={contextWindowTitle}
          contextWindowPercent={contextWindowPercent}
          contextWindowLabel={contextWindowLabel}
          contextWindowTokens={contextWindowTokens}
          contextWindowLimit={contextWindowLimit}
          modelGroups={modelGroups}
          activeModel={activeModel}
          activeProviderId={activeProviderId}
          setActive={setActive}
          effort={effort}
          setEffort={setEffort}
          send={() => void send()}
          cancel={cancelStreaming}
        />
      )}

      {previewAttachment?.dataUrl && (
        <ImagePreviewModal attachment={previewAttachment} close={() => setPreviewAttachment(null)} />
      )}

      {confirm && <ConfirmActionModal request={confirm.req} resolve={resolveConfirm} />}

      {contextPicker && (
        <ChatContextPicker
          query={contextQuery}
          setQuery={setContextQuery}
          conversations={pickerConversations}
          researchRuns={pickerResearchRuns}
          close={() => setContextPicker(null)}
          addConversation={addConversationContext}
          addResearch={addResearchContext}
        />
      )}
    </div>
  );
}
