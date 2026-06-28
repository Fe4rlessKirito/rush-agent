import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProviderConfig } from "./providers/types";
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
    return def ? { ...def, ...p } : p;
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
  const next: Conversation = {
    id: nextId,
    mode,
    lines,
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
            conversations: activeId
              ? s.conversations.filter((c) => c.id !== activeId)
              : s.conversations,
            activeConversationId: s.activeConversationId === activeId ? "" : s.activeConversationId,
            activeConversationIds: { ...s.activeConversationIds, agent: "" },
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
            conversations: activeId
              ? s.conversations.filter((c) => c.id !== activeId)
              : s.conversations,
            activeConversationId: s.activeConversationId === activeId ? "" : s.activeConversationId,
            activeConversationIds: { ...s.activeConversationIds, plain: "" },
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
            conversations: activeId
              ? s.conversations.filter((c) => c.id !== activeId)
              : s.conversations,
            activeConversationId: s.activeConversationId === activeId ? "" : s.activeConversationId,
            activeConversationIds: { ...s.activeConversationIds, flow: "" },
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
          };
        }),

      newConversation: (mode = "plain") =>
        set((s) => ({
          activeConversationId: "",
          activeConversationIds: { ...s.activeConversationIds, [mode]: "" },
          ...(mode === "agent" ? { chat: [] } : mode === "flow" ? { flowChat: [] } : { plainChat: [] }),
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
            ? { chat: convo.lines }
            : convo.mode === "flow"
              ? { flowChat: convo.lines }
              : { plainChat: convo.lines }),
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
              ? { chat: replacement?.lines ?? [] }
              : deletedMode === "flow"
                ? { flowChat: replacement?.lines ?? [] }
                : { plainChat: replacement?.lines ?? [] }),
          };
        }),
    }),
    {
      name: "rush-agent-settings",
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
