import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProviderConfig, ChatMessage } from "./providers/types";
import { DEFAULT_PROVIDERS } from "./providers/defaults";
import type { CompactContext } from "./agent/contextCompaction";
import type { PermissionConfig } from "./agent/toolPermissions";

// App settings store. Persisted to localStorage for the dev build. NOTE: API
// keys here are NOT yet encrypted. Before shipping stable, move apiKey fields
// into Tauri's secure store and keep only ids here.

export interface ChatLine {
  role: "user" | "agent" | "tool";
  text: string;
  thinking?: string;
  meta?: {
    speaker?: string;
    startedAt?: number;
    completedAt?: number;
  };
}

export type ConversationMode = "plain" | "agent" | "flow";
export type LanguageServerKey = "rust" | "typescript";
export type LanguageServerMode = "path" | "bundled" | "custom";

export interface LanguageServerConfig {
  mode: LanguageServerMode;
  customPath: string;
}

export type LanguageServerSettings = Record<LanguageServerKey, LanguageServerConfig>;

export const DEFAULT_TOOL_PERMISSIONS: PermissionConfig = {
  deny: ["Read(secrets/**)", "Read(.env*)", "Read(**/*.key)"],
  ask: ["Write(**)", "Edit(**)", "Bash(*)", "PowerShell(*)", "background_start(*)"],
  allow: [],
};

export const DEFAULT_LANGUAGE_SERVER_SETTINGS: LanguageServerSettings = {
  rust: { mode: "path", customPath: "" },
  typescript: { mode: "path", customPath: "" },
};

export interface Conversation {
  id: string;
  mode: ConversationMode;
  title: string;
  lines: ChatLine[];
  // Raw provider-facing message history (system/user/assistant/tool turns,
  // including tool_call args and tool_result content) for this conversation.
  // `lines` is a lossy, human-readable transcript for display only — it does
  // not carry enough detail to reconstruct tool call/result context for the
  // model. `messages` is what actually gets replayed into the next request,
  // so it must be persisted alongside `lines` rather than derived from it.
  messages?: ChatMessage[];
  compactSummary?: CompactContext;
  createdAt: number;
  projectId?: string;
  projectRoot?: string;
  projectName?: string;
}

export interface ConversationProjectContext {
  projectId: string;
  projectRoot: string;
  projectName: string;
}

export type SubagentRunStatus = "running" | "completed" | "blocked" | "cancelled";

export interface SubagentRun {
  id: string;
  parentConversationId: string;
  title: string;
  task: string;
  status: SubagentRunStatus;
  lines: ChatLine[];
  messages: ChatMessage[];
  toolNames: string[];
  startedAt: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
  projectId?: string;
  projectRoot?: string;
  projectName?: string;
}

function newId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function emptyTitle(mode: ConversationMode): string {
  if (mode === "flow") return "New flow";
  return mode === "agent" ? "New task" : "New chat";
}

// Derive a readable title from the first user message of a conversation.
function titleFrom(lines: ChatLine[], mode: ConversationMode): string {
  const firstUser = lines.find((l) => l.role === "user");
  if (!firstUser) return emptyTitle(mode);
  const t = firstUser.text.trim().replace(/\s+/g, " ");
  if (!t) return emptyTitle(mode);
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

export interface AppState {
  providers: ProviderConfig[];
  activeProviderId: string | null;
  activeModel: string | null;
  autoUpdateEnabled: boolean;
  toolPermissions: PermissionConfig;
  languageServerSettings: LanguageServerSettings;

  conversations: Conversation[];
  subagentRuns: SubagentRun[];
  activeSubagentRunId: string | null;
  activeConversationId: string;
  // Chat and Code used to be entirely separate conversation spaces (separate
  // ids, separate line/message arrays). They're now one shared space that the
  // AI can move between — "chat" holds whichever of the two is currently
  // active. Flow keeps its own separate space; it's a fundamentally different
  // interaction pattern (parallel lanes, not a linear chat).
  activeConversationIds: { chat: string; flow: string };
  conversationProjectContext: ConversationProjectContext | null;
  // The current sub-mode of the active chat conversation. This used to be
  // fixed per top-level tab; now it's a mutable attribute of the conversation
  // itself, changeable mid-conversation via the mode switcher or an
  // AI-suggested-and-confirmed switch, without starting a new conversation.
  chatMode: "plain" | "agent";
  // Mirror of the active chat (Chat+Code) conversation's lines, and
  // separately the active Flow conversation's lines.
  chat: ChatLine[];
  flowChat: ChatLine[];
  // Raw message history mirrors, kept in lockstep with chat/flowChat above.
  // These carry the full tool_call/tool_result turns the model needs to avoid
  // losing track of — and doubting — its own prior tool use. See
  // Conversation.messages for details.
  chatMessages: ChatMessage[];
  flowChatMessages: ChatMessage[];
  chatCompactSummary?: CompactContext;
  flowCompactSummary?: CompactContext;

  setProviders: (p: ProviderConfig[]) => void;
  upsertProvider: (p: ProviderConfig) => void;
  removeProvider: (id: string) => void;
  setActive: (providerId: string, model: string) => void;
  setAutoUpdateEnabled: (enabled: boolean) => void;
  setToolPermissions: (permissions: PermissionConfig) => void;
  setLanguageServerConfig: (language: LanguageServerKey, config: Partial<LanguageServerConfig>) => void;

  setChat: (updater: ChatLine[] | ((prev: ChatLine[]) => ChatLine[])) => void;
  setFlowChat: (updater: ChatLine[] | ((prev: ChatLine[]) => ChatLine[])) => void;
  setChatMessages: (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  setFlowChatMessages: (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  setChatCompactSummary: (summary: CompactContext | undefined) => void;
  setFlowCompactSummary: (summary: CompactContext | undefined) => void;
  // Switches the active chat conversation's current sub-mode in place — the
  // conversation, its lines, and its messages are untouched.
  setChatMode: (mode: "plain" | "agent") => void;
  clearChat: () => void;
  clearFlowChat: () => void;
  setConversationProjectContext: (context: ConversationProjectContext | null) => void;
  newConversation: (mode?: ConversationMode) => void;
  selectConversation: (id: string) => ConversationMode | undefined;
  deleteConversation: (id: string) => void;
  startSubagentRun: (args: { parentConversationId: string; task: string; title?: string; coordinator?: string; projectContext?: ConversationProjectContext | null }) => string;
  appendSubagentLine: (id: string, line: ChatLine) => void;
  appendSubagentText: (id: string, patch: Partial<Pick<ChatLine, "text" | "thinking">>) => void;
  setSubagentMessages: (id: string, messages: ChatMessage[]) => void;
  addSubagentToolName: (id: string, toolName: string) => void;
  completeSubagentRun: (id: string, status: SubagentRunStatus) => void;
  selectSubagentRun: (id: string | null) => void;
}

function mergeDefaultProviders(providers: ProviderConfig[] | undefined): ProviderConfig[] {
  const saved = providers ?? [];
  const defaultsById = new Map(DEFAULT_PROVIDERS.map((p) => [p.id, p]));
  const mergedSaved = saved.map((p) => {
    const def = defaultsById.get(p.id);
    if (!def) return p;
    const merged = { ...def, ...p };
    if (p.id === "wman-local-proxy") {
      if (p.label === "Rush Local Proxy") merged.label = def.label;
      if (p.label === "Rush Local Proxy (Rust)") merged.label = def.label;
      if (p.baseUrl === "http://localhost:8000/v1") merged.baseUrl = def.baseUrl;
      if (p.defaultModel === "claude-opus-4-8") merged.defaultModel = def.defaultModel;
      if (p.supportsImageChatEndpoint === true) merged.supportsImageChatEndpoint = def.supportsImageChatEndpoint;
      if (p.supportsFileChatEndpoint === true) merged.supportsFileChatEndpoint = def.supportsFileChatEndpoint;
    }
    return merged;
  });
  const savedIds = new Set(mergedSaved.map((p) => p.id));
  return [
    ...mergedSaved,
    ...DEFAULT_PROVIDERS.filter((p) => !savedIds.has(p.id)),
  ];
}

function activeFromProviders(
  providers: ProviderConfig[],
  activeProviderId: string | null,
  activeModel: string | null,
): Pick<AppState, "activeProviderId" | "activeModel"> {
  if (!activeProviderId) return { activeProviderId: null, activeModel: null };
  const active = providers.find((p) => p.id === activeProviderId);
  if (!active) return { activeProviderId: null, activeModel: null };
  return {
    activeProviderId,
    activeModel: activeModel || active.defaultModel || null,
  };
}

function normalizeLanguageServerSettings(
  settings: Partial<LanguageServerSettings> | undefined,
): LanguageServerSettings {
  return {
    rust: { ...DEFAULT_LANGUAGE_SERVER_SETTINGS.rust, ...(settings?.rust ?? {}) },
    typescript: { ...DEFAULT_LANGUAGE_SERVER_SETTINGS.typescript, ...(settings?.typescript ?? {}) },
  };
}

function normalizeConversations(state: Partial<AppState>): {
  conversations: Conversation[];
  subagentRuns: SubagentRun[];
  activeSubagentRunId: string | null;
  activeConversationId: string;
  activeConversationIds: { chat: string; flow: string };
  chatMode: "plain" | "agent";
  chat: ChatLine[];
  flowChat: ChatLine[];
  chatMessages: ChatMessage[];
  flowChatMessages: ChatMessage[];
  chatCompactSummary?: CompactContext;
  flowCompactSummary?: CompactContext;
} {
  const raw = state.conversations ?? [];
  const conversations = raw
    .map((c) => {
      const mode = (c.mode ?? "agent") as ConversationMode;
      const lines = c.lines ?? [];
      return {
        ...c,
        mode,
        title: c.title || titleFrom(lines, mode),
        lines,
        // Older, pre-fix conversations won't have a saved `messages` array.
        // Default to empty rather than undefined so callers can rely on it
        // always being an array.
        messages: c.messages ?? [],
        compactSummary: c.compactSummary,
        createdAt: c.createdAt ?? Date.now(),
        projectId: c.projectId,
        projectRoot: c.projectRoot,
        projectName: c.projectName,
      };
    })
    .filter((c) => c.lines.length > 0);

  // Older saves may still have separate `activeConversationIds.plain` and
  // `.agent` entries from before Chat/Code were merged into one space. Prefer
  // whichever the record actually points at; either legacy key still resolves
  // correctly since both flavors now share the single `.chat` slot.
  const legacyIds = state.activeConversationIds as unknown as
    | { chat?: string; plain?: string; agent?: string; flow?: string }
    | undefined;
  const activeChat =
    conversations.find((c) => c.id === legacyIds?.chat) ??
    conversations.find((c) => c.id === legacyIds?.plain) ??
    conversations.find((c) => c.id === legacyIds?.agent) ??
    conversations.find((c) => c.mode === "plain" || c.mode === "agent");
  const activeFlow =
    conversations.find((c) => c.id === legacyIds?.flow) ??
    conversations.find((c) => c.mode === "flow");
  const active =
    conversations.find((c) => c.id === state.activeConversationId) ??
    activeChat ??
    activeFlow;

  return {
    conversations,
    subagentRuns: (state.subagentRuns ?? []).map((run) => ({
      ...run,
      lines: run.lines ?? [],
      messages: run.messages ?? [],
      toolNames: run.toolNames ?? [],
      startedAt: run.startedAt ?? run.createdAt ?? Date.now(),
      createdAt: run.createdAt ?? Date.now(),
      updatedAt: run.updatedAt ?? run.createdAt ?? Date.now(),
    })),
    activeSubagentRunId: state.activeSubagentRunId ?? null,
    activeConversationId: active?.id ?? "",
    activeConversationIds: {
      chat: activeChat?.id ?? "",
      flow: activeFlow?.id ?? "",
    },
    chatMode: activeChat?.mode === "plain" ? "plain" : "agent",
    chat: activeChat?.lines ?? [],
    flowChat: activeFlow?.lines ?? [],
    chatMessages: activeChat?.messages ?? [],
    flowChatMessages: activeFlow?.messages ?? [],
    chatCompactSummary: activeChat?.compactSummary,
    flowCompactSummary: activeFlow?.compactSummary,
  };
}

function upsertConversation(
  conversations: Conversation[],
  id: string,
  mode: ConversationMode,
  lines: ChatLine[],
  projectContext: ConversationProjectContext | null,
): { conversations: Conversation[]; id: string } {
  if (lines.length === 0) {
    return {
      conversations: id ? conversations.filter((c) => c.id !== id) : conversations,
      id: "",
    };
  }

  const current = id ? conversations.find((c) => c.id === id) : undefined;
  const sameProject = !projectContext || current?.projectId === projectContext.projectId;
  const nextId = sameProject && id ? id : newId();
  const idx = conversations.findIndex((c) => c.id === nextId);
  // setChat/setPlainChat/setFlowChat fire on every streamed token, well before
  // the end-of-turn setChatMessages call lands. Since this rebuilds the
  // conversation record from scratch, carry the existing `messages` forward
  // (when we're still the same conversation) so mid-stream updates to the
  // display transcript never clobber the raw tool-call/tool-result history
  // that's already been saved.
  const carriedMessages = sameProject && id ? current?.messages ?? [] : [];
  const carriedSummary = sameProject && id ? current?.compactSummary : undefined;
  const next: Conversation = {
    id: nextId,
    mode,
    lines,
    messages: carriedMessages,
    compactSummary: carriedSummary,
    title: titleFrom(lines, mode),
    createdAt: Date.now(),
    ...(projectContext
      ? {
          projectId: projectContext.projectId,
          projectRoot: projectContext.projectRoot,
          projectName: projectContext.projectName,
        }
      : {}),
  };
  const rest = idx === -1
    ? conversations
    : conversations.filter((c) => c.id !== nextId);
  return { conversations: [next, ...rest], id: nextId };
}

// Persist the raw provider message history (tool calls/results included) onto
// an already-existing conversation. Unlike upsertConversation, this never
// creates, renames, or deletes a conversation — the lines-driven setters own
// that lifecycle. If the conversation doesn't exist yet (e.g. messages are
// being recorded before the first `setChat` call lands), this is a no-op;
// the next setChat call will create the conversation and the messages will
// be saved on the following turn.
function updateConversationMessages(
  conversations: Conversation[],
  id: string,
  messages: ChatMessage[],
): Conversation[] {
  if (!id) return conversations;
  const idx = conversations.findIndex((c) => c.id === id);
  if (idx === -1) return conversations;
  const next = conversations.slice();
  next[idx] = { ...next[idx], messages };
  return next;
}

function updateConversationSummary(
  conversations: Conversation[],
  id: string,
  compactSummary: CompactContext | undefined,
): Conversation[] {
  if (!id) return conversations;
  const idx = conversations.findIndex((c) => c.id === id);
  if (idx === -1) return conversations;
  const next = conversations.slice();
  next[idx] = { ...next[idx], compactSummary };
  return next;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      providers: mergeDefaultProviders(DEFAULT_PROVIDERS),
      activeProviderId: null,
      activeModel: null,
      autoUpdateEnabled: true,
      toolPermissions: DEFAULT_TOOL_PERMISSIONS,
      languageServerSettings: DEFAULT_LANGUAGE_SERVER_SETTINGS,

      conversations: [],
      subagentRuns: [],
      activeSubagentRunId: null,
      activeConversationId: "",
      activeConversationIds: {
        chat: "",
        flow: "",
      },
      conversationProjectContext: null,
      chatMode: "plain",
      chat: [],
      flowChat: [],
      chatMessages: [],
      flowChatMessages: [],
      chatCompactSummary: undefined,
      flowCompactSummary: undefined,

      setProviders: (providers) =>
        set((s) => ({
          providers,
          ...activeFromProviders(providers, s.activeProviderId, s.activeModel),
        })),
      upsertProvider: (p) =>
        set((s) => {
          const idx = s.providers.findIndex((x) => x.id === p.id);
          if (idx === -1) return { providers: [...s.providers, p] };
          const next = s.providers.slice();
          next[idx] = p;
          return { providers: next };
        }),
      removeProvider: (id) =>
        set((s) => {
          const providers = s.providers.filter((p) => p.id !== id);
          return {
            providers,
            ...activeFromProviders(providers, s.activeProviderId, s.activeModel),
          };
        }),
      setActive: (activeProviderId, activeModel) =>
        set({ activeProviderId, activeModel }),
      setAutoUpdateEnabled: (autoUpdateEnabled) => set({ autoUpdateEnabled }),
      setToolPermissions: (toolPermissions) => set({ toolPermissions }),
      setLanguageServerConfig: (language, config) =>
        set((s) => ({
          languageServerSettings: {
            ...s.languageServerSettings,
            [language]: { ...s.languageServerSettings[language], ...config },
          },
        })),

      setChat: (updater) =>
        set((s) => {
          const lines =
            typeof updater === "function" ? updater(s.chat) : updater;
          const saved = upsertConversation(
            s.conversations,
            s.activeConversationIds.chat,
            s.chatMode,
            lines,
            s.conversationProjectContext,
          );
          return {
            chat: lines,
            conversations: saved.conversations,
            activeConversationId: saved.id,
            activeConversationIds: { ...s.activeConversationIds, chat: saved.id },
          };
        }),

      clearChat: () =>
        set((s) => {
          const activeId = s.activeConversationIds.chat;
          return {
            chat: [],
            chatMessages: [],
            chatCompactSummary: undefined,
            chatMode: "plain",
            conversations: activeId
              ? s.conversations.filter((c) => c.id !== activeId)
              : s.conversations,
            subagentRuns: activeId ? s.subagentRuns.filter((run) => run.parentConversationId !== activeId) : s.subagentRuns,
            activeSubagentRunId: s.activeSubagentRunId && activeId && s.subagentRuns.find((run) => run.id === s.activeSubagentRunId)?.parentConversationId === activeId ? null : s.activeSubagentRunId,
            activeConversationId: s.activeConversationId === activeId ? "" : s.activeConversationId,
            activeConversationIds: { ...s.activeConversationIds, chat: "" },
          };
        }),

      setChatMessages: (updater) =>
        set((s) => {
          const messages =
            typeof updater === "function" ? updater(s.chatMessages) : updater;
          return {
            chatMessages: messages,
            conversations: updateConversationMessages(s.conversations, s.activeConversationIds.chat, messages),
          };
        }),

      setChatCompactSummary: (summary) =>
        set((s) => ({
          chatCompactSummary: summary,
          conversations: updateConversationSummary(s.conversations, s.activeConversationIds.chat, summary),
        })),

      setChatMode: (mode) =>
        set((s) => {
          const activeId = s.activeConversationIds.chat;
          if (!activeId) return { chatMode: mode };
          const idx = s.conversations.findIndex((c) => c.id === activeId);
          if (idx === -1) return { chatMode: mode };
          const next = s.conversations.slice();
          next[idx] = { ...next[idx], mode };
          return { chatMode: mode, conversations: next };
        }),

      setFlowChat: (updater) =>
        set((s) => {
          const lines =
            typeof updater === "function" ? updater(s.flowChat) : updater;
          const saved = upsertConversation(
            s.conversations,
            s.activeConversationIds.flow,
            "flow",
            lines,
            s.conversationProjectContext,
          );
          return {
            flowChat: lines,
            conversations: saved.conversations,
            activeConversationId: saved.id,
            activeConversationIds: { ...s.activeConversationIds, flow: saved.id },
          };
        }),

      clearFlowChat: () =>
        set((s) => {
          const activeId = s.activeConversationIds.flow;
          return {
            flowChat: [],
            flowChatMessages: [],
            flowCompactSummary: undefined,
            conversations: activeId
              ? s.conversations.filter((c) => c.id !== activeId)
              : s.conversations,
            subagentRuns: activeId ? s.subagentRuns.filter((run) => run.parentConversationId !== activeId) : s.subagentRuns,
            activeSubagentRunId: s.activeSubagentRunId && activeId && s.subagentRuns.find((run) => run.id === s.activeSubagentRunId)?.parentConversationId === activeId ? null : s.activeSubagentRunId,
            activeConversationId: s.activeConversationId === activeId ? "" : s.activeConversationId,
            activeConversationIds: { ...s.activeConversationIds, flow: "" },
          };
        }),

      setFlowChatMessages: (updater) =>
        set((s) => {
          const messages =
            typeof updater === "function" ? updater(s.flowChatMessages) : updater;
          return {
            flowChatMessages: messages,
            conversations: updateConversationMessages(s.conversations, s.activeConversationIds.flow, messages),
          };
        }),

      setFlowCompactSummary: (summary) =>
        set((s) => ({
          flowCompactSummary: summary,
          conversations: updateConversationSummary(s.conversations, s.activeConversationIds.flow, summary),
        })),

      setConversationProjectContext: (context) =>
        set((s) => {
          if (!context) {
            const activeChat = s.conversations.find(
              (c) => (c.mode === "agent" || c.mode === "plain") && !c.projectId,
            );
            const activeFlow = s.conversations.find((c) => c.mode === "flow" && !c.projectId);
            return {
              conversationProjectContext: null,
              activeConversationId:
                s.activeConversationId && s.conversations.find((c) => c.id === s.activeConversationId && !c.projectId)
                  ? s.activeConversationId
                  : activeChat?.id ?? activeFlow?.id ?? s.activeConversationIds.chat,
              activeConversationIds: {
                ...s.activeConversationIds,
                chat: activeChat?.id ?? "",
                flow: activeFlow?.id ?? "",
              },
              chatMode: activeChat?.mode === "plain" ? "plain" : "agent",
              chat: activeChat?.lines ?? [],
              flowChat: activeFlow?.lines ?? [],
              chatMessages: activeChat?.messages ?? [],
              flowChatMessages: activeFlow?.messages ?? [],
            };
          }

          const activeChat = s.conversations.find(
            (c) => (c.mode === "agent" || c.mode === "plain") && c.projectId === context.projectId,
          );
          const activeFlow = s.conversations.find((c) => c.mode === "flow" && c.projectId === context.projectId);
          return {
            conversationProjectContext: context,
            activeConversationId: activeChat?.id ?? activeFlow?.id ?? s.activeConversationIds.chat,
            activeConversationIds: {
              ...s.activeConversationIds,
              chat: activeChat?.id ?? "",
              flow: activeFlow?.id ?? "",
            },
            chatMode: activeChat?.mode === "plain" ? "plain" : "agent",
            chat: activeChat?.lines ?? [],
            flowChat: activeFlow?.lines ?? [],
            chatMessages: activeChat?.messages ?? [],
            flowChatMessages: activeFlow?.messages ?? [],
          };
        }),

      newConversation: (mode = "plain") =>
        set((s) => ({
          activeConversationId: "",
          ...(mode === "flow"
            ? {
                activeConversationIds: { ...s.activeConversationIds, flow: "" },
                flowChat: [],
                flowChatMessages: [],
                flowCompactSummary: undefined,
              }
            : {
                activeConversationIds: { ...s.activeConversationIds, chat: "" },
                chatMode: mode,
                chat: [],
                chatMessages: [],
                chatCompactSummary: undefined,
              }),
        })),

      selectConversation: (id) => {
        const convo = get().conversations.find((c) => c.id === id);
        if (!convo) return undefined;
        const slot = convo.mode === "flow" ? "flow" : "chat";
        set((s) => ({
          activeConversationId: id,
          activeConversationIds: { ...s.activeConversationIds, [slot]: id },
          conversationProjectContext: convo.projectId
            ? {
                projectId: convo.projectId,
                projectRoot: convo.projectRoot ?? "",
                projectName: convo.projectName ?? "Project",
              }
            : null,
          ...(slot === "flow"
            ? { flowChat: convo.lines, flowChatMessages: convo.messages ?? [], flowCompactSummary: convo.compactSummary }
            : { chatMode: convo.mode === "plain" ? "plain" : "agent", chat: convo.lines, chatMessages: convo.messages ?? [], chatCompactSummary: convo.compactSummary }),
        }));
        return convo.mode;
      },

      deleteConversation: (id) =>
        set((s) => {
          const deleted = s.conversations.find((c) => c.id === id);
          const deletedSlot = deleted?.mode === "flow" ? "flow" : "chat";
          const remaining = s.conversations.filter((c) => c.id !== id);
          const replacement = remaining.find((c) => {
            const slot = c.mode === "flow" ? "flow" : "chat";
            if (slot !== deletedSlot) return false;
            return deletedSlot === "flow"
              ? c.projectId === s.conversationProjectContext?.projectId
              : c.projectId === deleted?.projectId;
          });
          const activeConversationIds = { ...s.activeConversationIds };
          if (activeConversationIds[deletedSlot] === id) {
            activeConversationIds[deletedSlot] = replacement?.id ?? "";
          }
          const activeConversationId =
            s.activeConversationId === id ? replacement?.id ?? "" : s.activeConversationId;
          return {
            conversations: remaining,
            subagentRuns: s.subagentRuns.filter((run) => run.parentConversationId !== id),
            activeSubagentRunId: s.activeSubagentRunId && s.subagentRuns.find((run) => run.id === s.activeSubagentRunId)?.parentConversationId === id ? null : s.activeSubagentRunId,
            activeConversationId,
            activeConversationIds,
            ...(deletedSlot === "flow"
              ? { flowChat: replacement?.lines ?? [], flowChatMessages: replacement?.messages ?? [], flowCompactSummary: replacement?.compactSummary }
              : {
                  chatMode: replacement?.mode === "plain" ? "plain" : "agent",
                  chat: replacement?.lines ?? [],
                  chatMessages: replacement?.messages ?? [],
                  chatCompactSummary: replacement?.compactSummary,
                }),
          };
        }),

      startSubagentRun: ({ parentConversationId, task, title, coordinator, projectContext }) => {
        const id = newId();
        const trimmedTask = task.trim() || "Subagent task";
        const now = Date.now();
        const shortTitle = (title?.trim() || trimmedTask).replace(/\s+/g, " ");
        const run: SubagentRun = {
          id,
          parentConversationId,
          title: shortTitle.length > 52 ? `${shortTitle.slice(0, 52)}...` : shortTitle,
          task: trimmedTask,
          status: "running",
          lines: [
            {
              role: "agent",
              text: trimmedTask,
              meta: {
                speaker: coordinator?.trim() || "Coordinator",
                startedAt: now,
                completedAt: now,
              },
            },
            { role: "agent", text: "", meta: { startedAt: now } },
          ],
          messages: [],
          toolNames: [],
          startedAt: now,
          createdAt: now,
          updatedAt: now,
          ...(projectContext
            ? {
                projectId: projectContext.projectId,
                projectRoot: projectContext.projectRoot,
                projectName: projectContext.projectName,
              }
            : {}),
        };
        set((s) => ({
          subagentRuns: [run, ...s.subagentRuns],
          activeSubagentRunId: id,
        }));
        return id;
      },

      appendSubagentLine: (id, line) =>
        set((s) => ({
          subagentRuns: s.subagentRuns.map((run) =>
            run.id === id
              ? { ...run, lines: [...run.lines, { ...line, meta: { startedAt: Date.now(), ...line.meta } }], updatedAt: Date.now() }
              : run,
          ),
        })),

      appendSubagentText: (id, patch) =>
        set((s) => ({
          subagentRuns: s.subagentRuns.map((run) => {
            if (run.id !== id) return run;
            const lines = run.lines.slice();
            const cur = lines[lines.length - 1] ?? { role: "agent" as const, text: "", meta: { startedAt: Date.now() } };
            lines[lines.length - 1] = {
              ...cur,
              role: "agent",
              text: patch.text === undefined ? cur.text : cur.text + patch.text,
              thinking: patch.thinking === undefined ? cur.thinking : (cur.thinking ?? "") + patch.thinking,
              meta: cur.meta ?? { startedAt: Date.now() },
            };
            return { ...run, lines, updatedAt: Date.now() };
          }),
        })),

      setSubagentMessages: (id, messages) =>
        set((s) => ({
          subagentRuns: s.subagentRuns.map((run) =>
            run.id === id ? { ...run, messages, updatedAt: Date.now() } : run,
          ),
        })),

      addSubagentToolName: (id, toolName) =>
        set((s) => ({
          subagentRuns: s.subagentRuns.map((run) =>
            run.id === id
              ? { ...run, toolNames: Array.from(new Set([...run.toolNames, toolName])), updatedAt: Date.now() }
              : run,
          ),
        })),

      completeSubagentRun: (id, status) =>
        set((s) => ({
          subagentRuns: s.subagentRuns.map((run) => {
            if (run.id !== id) return run;
            const completedAt = Date.now();
            const lines = run.lines.map((line, index) => {
              if (index !== run.lines.length - 1 || line.role !== "agent") return line;
              return { ...line, meta: { ...(line.meta ?? {}), completedAt } };
            });
            return { ...run, status, lines, completedAt, updatedAt: completedAt };
          }),
        })),

      selectSubagentRun: (id) => set({ activeSubagentRunId: id }),
    }),
    {
      name: "rush-agent-settings",
      partialize: (state) => {
        const {
          chat: _chat,
          flowChat: _flowChat,
          chatMessages: _chatMessages,
          flowChatMessages: _flowChatMessages,
          ...persisted
        } = state;
        return persisted;
      },
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.providers = mergeDefaultProviders(state.providers);
        Object.assign(state, activeFromProviders(state.providers, state.activeProviderId, state.activeModel));
        state.languageServerSettings = normalizeLanguageServerSettings(state.languageServerSettings);
        Object.assign(state, normalizeConversations(state));
      },
    },
  ),
);
