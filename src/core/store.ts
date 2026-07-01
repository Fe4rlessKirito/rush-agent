import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProviderConfig, ChatMessage } from "./providers/types";
import { DEFAULT_PROVIDERS } from "./providers/defaults";
import type { PermissionConfig } from "./agent/toolPermissions";

// App settings store. Persisted to localStorage for the dev build. NOTE: API
// keys here are NOT yet encrypted. Before shipping stable, move apiKey fields
// into Tauri's secure store and keep only ids here.

export interface ChatLine {
  role: "user" | "agent" | "tool";
  text: string;
  thinking?: string;
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

function newId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function emptyTitle(mode: ConversationMode): string {
  if (mode === "flow") return "New flow";
  return mode === "agent" ? "New task" : "New chat";
}

// Derive a short title from the first user message of a conversation.
function titleFrom(lines: ChatLine[], mode: ConversationMode): string {
  const firstUser = lines.find((l) => l.role === "user");
  if (!firstUser) return emptyTitle(mode);
  const t = firstUser.text.trim().replace(/\s+/g, " ");
  return t.length > 40 ? t.slice(0, 40) + "\u2026" : t || emptyTitle(mode);
}

export interface AppState {
  providers: ProviderConfig[];
  activeProviderId: string | null;
  activeModel: string | null;
  autoUpdateEnabled: boolean;
  toolPermissions: PermissionConfig;
  languageServerSettings: LanguageServerSettings;

  conversations: Conversation[];
  activeConversationId: string;
  activeConversationIds: Record<ConversationMode, string>;
  conversationProjectContext: ConversationProjectContext | null;
  // Mirrors of each mode's active conversation lines. ChatPanel keeps using
  // chat/setChat for agent mode and plainChat/setPlainChat for plain chat.
  chat: ChatLine[];
  plainChat: ChatLine[];
  flowChat: ChatLine[];
  // Raw message history mirrors, kept in lockstep with chat/plainChat/flowChat
  // above. These carry the full tool_call/tool_result turns the model needs to
  // avoid losing track of — and doubting — its own prior tool use. See
  // Conversation.messages for details.
  chatMessages: ChatMessage[];
  plainChatMessages: ChatMessage[];
  flowChatMessages: ChatMessage[];

  setProviders: (p: ProviderConfig[]) => void;
  upsertProvider: (p: ProviderConfig) => void;
  removeProvider: (id: string) => void;
  setActive: (providerId: string, model: string) => void;
  setAutoUpdateEnabled: (enabled: boolean) => void;
  setToolPermissions: (permissions: PermissionConfig) => void;
  setLanguageServerConfig: (language: LanguageServerKey, config: Partial<LanguageServerConfig>) => void;

  setChat: (updater: ChatLine[] | ((prev: ChatLine[]) => ChatLine[])) => void;
  setPlainChat: (updater: ChatLine[] | ((prev: ChatLine[]) => ChatLine[])) => void;
  setFlowChat: (updater: ChatLine[] | ((prev: ChatLine[]) => ChatLine[])) => void;
  setChatMessages: (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  setPlainChatMessages: (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  setFlowChatMessages: (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  clearChat: () => void;
  clearPlainChat: () => void;
  clearFlowChat: () => void;
  setConversationProjectContext: (context: ConversationProjectContext | null) => void;
  newConversation: (mode?: ConversationMode) => void;
  selectConversation: (id: string) => ConversationMode | undefined;
  deleteConversation: (id: string) => void;
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
      if (p.baseUrl === "http://localhost:8000/v1") merged.baseUrl = def.baseUrl;
      if (p.defaultModel === "claude-opus-4-8") merged.defaultModel = def.defaultModel;
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
  activeConversationId: string;
  activeConversationIds: Record<ConversationMode, string>;
  chat: ChatLine[];
  plainChat: ChatLine[];
  flowChat: ChatLine[];
  chatMessages: ChatMessage[];
  plainChatMessages: ChatMessage[];
  flowChatMessages: ChatMessage[];
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
        createdAt: c.createdAt ?? Date.now(),
        projectId: c.projectId,
        projectRoot: c.projectRoot,
        projectName: c.projectName,
      };
    })
    .filter((c) => c.lines.length > 0);

  const activePlain =
    conversations.find((c) => c.id === state.activeConversationIds?.plain) ??
    conversations.find((c) => c.mode === "plain");
  const activeAgent =
    conversations.find((c) => c.id === state.activeConversationIds?.agent) ??
    conversations.find((c) => c.mode === "agent");
  const activeFlow =
    conversations.find((c) => c.id === state.activeConversationIds?.flow) ??
    conversations.find((c) => c.mode === "flow");
  const active =
    conversations.find((c) => c.id === state.activeConversationId) ??
    activePlain ??
    activeAgent ??
    activeFlow;

  return {
    conversations,
    activeConversationId: active?.id ?? "",
    activeConversationIds: {
      plain: activePlain?.id ?? "",
      agent: activeAgent?.id ?? "",
      flow: activeFlow?.id ?? "",
    },
    chat: activeAgent?.lines ?? [],
    plainChat: activePlain?.lines ?? [],
    flowChat: activeFlow?.lines ?? [],
    chatMessages: activeAgent?.messages ?? [],
    plainChatMessages: activePlain?.messages ?? [],
    flowChatMessages: activeFlow?.messages ?? [],
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
  const sameProject =
    !projectContext ||
    (current?.projectId === projectContext.projectId && current?.mode === mode);
  const nextId = sameProject && id ? id : newId();
  const idx = conversations.findIndex((c) => c.id === nextId);
  // setChat/setPlainChat/setFlowChat fire on every streamed token, well before
  // the end-of-turn setChatMessages call lands. Since this rebuilds the
  // conversation record from scratch, carry the existing `messages` forward
  // (when we're still the same conversation) so mid-stream updates to the
  // display transcript never clobber the raw tool-call/tool-result history
  // that's already been saved.
  const carriedMessages = sameProject && id ? current?.messages ?? [] : [];
  const next: Conversation = {
    id: nextId,
    mode,
    lines,
    messages: carriedMessages,
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
      activeConversationId: "",
      activeConversationIds: {
        plain: "",
        agent: "",
        flow: "",
      },
      conversationProjectContext: null,
      chat: [],
      plainChat: [],
      flowChat: [],
      chatMessages: [],
      plainChatMessages: [],
      flowChatMessages: [],

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
            s.activeConversationIds.agent,
            "agent",
            lines,
            s.conversationProjectContext,
          );
          return {
            chat: lines,
            conversations: saved.conversations,
            activeConversationId: saved.id,
            activeConversationIds: { ...s.activeConversationIds, agent: saved.id },
          };
        }),

      clearChat: () =>
        set((s) => {
          const activeId = s.activeConversationIds.agent;
          return {
            chat: [],
            chatMessages: [],
            conversations: activeId
              ? s.conversations.filter((c) => c.id !== activeId)
              : s.conversations,
            activeConversationId: s.activeConversationId === activeId ? "" : s.activeConversationId,
            activeConversationIds: { ...s.activeConversationIds, agent: "" },
          };
        }),

      setChatMessages: (updater) =>
        set((s) => {
          const messages =
            typeof updater === "function" ? updater(s.chatMessages) : updater;
          return {
            chatMessages: messages,
            conversations: updateConversationMessages(s.conversations, s.activeConversationIds.agent, messages),
          };
        }),

      setPlainChat: (updater) =>
        set((s) => {
          const lines =
            typeof updater === "function" ? updater(s.plainChat) : updater;
          const saved = upsertConversation(
            s.conversations,
            s.activeConversationIds.plain,
            "plain",
            lines,
            null,
          );
          return {
            plainChat: lines,
            conversations: saved.conversations,
            activeConversationId: saved.id,
            activeConversationIds: { ...s.activeConversationIds, plain: saved.id },
          };
        }),

      clearPlainChat: () =>
        set((s) => {
          const activeId = s.activeConversationIds.plain;
          return {
            plainChat: [],
            plainChatMessages: [],
            conversations: activeId
              ? s.conversations.filter((c) => c.id !== activeId)
              : s.conversations,
            activeConversationId: s.activeConversationId === activeId ? "" : s.activeConversationId,
            activeConversationIds: { ...s.activeConversationIds, plain: "" },
          };
        }),

      setPlainChatMessages: (updater) =>
        set((s) => {
          const messages =
            typeof updater === "function" ? updater(s.plainChatMessages) : updater;
          return {
            plainChatMessages: messages,
            conversations: updateConversationMessages(s.conversations, s.activeConversationIds.plain, messages),
          };
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
            conversations: activeId
              ? s.conversations.filter((c) => c.id !== activeId)
              : s.conversations,
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

      setConversationProjectContext: (context) =>
        set((s) => {
          if (!context) {
            const activeAgent = s.conversations.find((c) => c.mode === "agent" && !c.projectId);
            const activeFlow = s.conversations.find((c) => c.mode === "flow" && !c.projectId);
            return {
              conversationProjectContext: null,
              activeConversationId:
                s.activeConversationId && s.conversations.find((c) => c.id === s.activeConversationId && !c.projectId)
                  ? s.activeConversationId
                  : activeAgent?.id ?? activeFlow?.id ?? s.activeConversationIds.plain,
              activeConversationIds: {
                ...s.activeConversationIds,
                agent: activeAgent?.id ?? "",
                flow: activeFlow?.id ?? "",
              },
              chat: activeAgent?.lines ?? [],
              flowChat: activeFlow?.lines ?? [],
              chatMessages: activeAgent?.messages ?? [],
              flowChatMessages: activeFlow?.messages ?? [],
            };
          }

          const activeAgent = s.conversations.find((c) => c.mode === "agent" && c.projectId === context.projectId);
          const activeFlow = s.conversations.find((c) => c.mode === "flow" && c.projectId === context.projectId);
          return {
            conversationProjectContext: context,
            activeConversationId: activeAgent?.id ?? activeFlow?.id ?? s.activeConversationIds.plain,
            activeConversationIds: {
              ...s.activeConversationIds,
              agent: activeAgent?.id ?? "",
              flow: activeFlow?.id ?? "",
            },
            chat: activeAgent?.lines ?? [],
            flowChat: activeFlow?.lines ?? [],
            chatMessages: activeAgent?.messages ?? [],
            flowChatMessages: activeFlow?.messages ?? [],
          };
        }),

      newConversation: (mode = "plain") =>
        set((s) => ({
          activeConversationId: "",
          activeConversationIds: { ...s.activeConversationIds, [mode]: "" },
          ...(mode === "agent"
            ? { chat: [], chatMessages: [] }
            : mode === "flow"
              ? { flowChat: [], flowChatMessages: [] }
              : { plainChat: [], plainChatMessages: [] }),
        })),

      selectConversation: (id) => {
        const convo = get().conversations.find((c) => c.id === id);
        if (!convo) return undefined;
        set((s) => ({
          activeConversationId: id,
          activeConversationIds: { ...s.activeConversationIds, [convo.mode]: id },
          conversationProjectContext: convo.projectId
            ? {
                projectId: convo.projectId,
                projectRoot: convo.projectRoot ?? "",
                projectName: convo.projectName ?? "Project",
              }
            : null,
          ...(convo.mode === "agent"
            ? { chat: convo.lines, chatMessages: convo.messages ?? [] }
            : convo.mode === "flow"
              ? { flowChat: convo.lines, flowChatMessages: convo.messages ?? [] }
              : { plainChat: convo.lines, plainChatMessages: convo.messages ?? [] }),
        }));
        return convo.mode;
      },

      deleteConversation: (id) =>
        set((s) => {
          const deleted = s.conversations.find((c) => c.id === id);
          const deletedMode = deleted?.mode ?? "plain";
          const remaining = s.conversations.filter((c) => c.id !== id);
          const replacement = remaining.find((c) =>
            c.mode === deletedMode &&
            (deletedMode === "plain"
              ? !c.projectId
              : c.projectId === s.conversationProjectContext?.projectId),
          );
          const activeConversationIds = { ...s.activeConversationIds };
          if (activeConversationIds[deletedMode] === id) {
            activeConversationIds[deletedMode] = replacement?.id ?? "";
          }
          const activeConversationId =
            s.activeConversationId === id ? replacement?.id ?? "" : s.activeConversationId;
          return {
            conversations: remaining,
            activeConversationId,
            activeConversationIds,
            ...(deletedMode === "agent"
              ? { chat: replacement?.lines ?? [], chatMessages: replacement?.messages ?? [] }
              : deletedMode === "flow"
                ? { flowChat: replacement?.lines ?? [], flowChatMessages: replacement?.messages ?? [] }
                : { plainChat: replacement?.lines ?? [], plainChatMessages: replacement?.messages ?? [] }),
          };
        }),
    }),
    {
      name: "rush-agent-settings",
      partialize: (state) => {
        const {
          chat: _chat,
          plainChat: _plainChat,
          flowChat: _flowChat,
          chatMessages: _chatMessages,
          plainChatMessages: _plainChatMessages,
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
