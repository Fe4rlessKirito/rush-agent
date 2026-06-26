import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProviderConfig } from "./providers/types";
import { DEFAULT_PROVIDERS } from "./providers/defaults";

// App settings store. Persisted to localStorage for the dev build. NOTE: API
// keys here are NOT yet encrypted — before shipping the Tauri build, move the
// apiKey fields into Tauri's secure store (keyring) and keep only ids here.
// Flagged intentionally so we don't forget.

export interface ChatLine {
  role: "user" | "agent" | "tool";
  text: string;
  thinking?: string;
}

export interface Conversation {
  id: string;
  title: string;
  lines: ChatLine[];
  createdAt: number;
}

function newId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function freshConversation(): Conversation {
  return { id: newId(), title: "New chat", lines: [], createdAt: Date.now() };
}

// Derive a short title from the first user message of a conversation.
function titleFrom(lines: ChatLine[]): string {
  const firstUser = lines.find((l) => l.role === "user");
  if (!firstUser) return "New chat";
  const t = firstUser.text.trim().replace(/\s+/g, " ");
  return t.length > 40 ? t.slice(0, 40) + "\u2026" : t || "New chat";
}

export interface AppState {
  providers: ProviderConfig[];
  activeProviderId: string | null;
  activeModel: string | null;

  conversations: Conversation[];
  activeConversationId: string;
  // Mirror of the active conversation's lines — keeps ChatPanel's existing
  // chat/setChat/clearChat API working unchanged.
  chat: ChatLine[];

  setProviders: (p: ProviderConfig[]) => void;
  upsertProvider: (p: ProviderConfig) => void;
  removeProvider: (id: string) => void;
  setActive: (providerId: string, model: string) => void;

  setChat: (updater: ChatLine[] | ((prev: ChatLine[]) => ChatLine[])) => void;
  clearChat: () => void;
  newConversation: () => void;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
}

const SEED_CONVO = freshConversation();

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      providers: DEFAULT_PROVIDERS,
      activeProviderId: null,
      activeModel: null,

      conversations: [SEED_CONVO],
      activeConversationId: SEED_CONVO.id,
      chat: [],

      setProviders: (providers) => set({ providers }),
      upsertProvider: (p) =>
        set((s) => {
          const idx = s.providers.findIndex((x) => x.id === p.id);
          if (idx === -1) return { providers: [...s.providers, p] };
          const next = s.providers.slice();
          next[idx] = p;
          return { providers: next };
        }),
      removeProvider: (id) =>
        set((s) => ({ providers: s.providers.filter((p) => p.id !== id) })),
      setActive: (activeProviderId, activeModel) =>
        set({ activeProviderId, activeModel }),

      setChat: (updater) =>
        set((s) => {
          const lines =
            typeof updater === "function" ? updater(s.chat) : updater;
          const conversations = s.conversations.map((c) =>
            c.id === s.activeConversationId
              ? { ...c, lines, title: titleFrom(lines) }
              : c,
          );
          return { chat: lines, conversations };
        }),

      clearChat: () =>
        set((s) => ({
          chat: [],
          conversations: s.conversations.map((c) =>
            c.id === s.activeConversationId
              ? { ...c, lines: [], title: "New chat" }
              : c,
          ),
        })),

      newConversation: () =>
        set((s) => {
          const convo = freshConversation();
          return {
            conversations: [convo, ...s.conversations],
            activeConversationId: convo.id,
            chat: [],
          };
        }),

      selectConversation: (id) =>
        set((s) => {
          const convo = s.conversations.find((c) => c.id === id);
          if (!convo) return {};
          return { activeConversationId: id, chat: convo.lines };
        }),

      deleteConversation: (id) =>
        set((s) => {
          const remaining = s.conversations.filter((c) => c.id !== id);
          // Never leave zero conversations — seed a fresh one if needed.
          const conversations = remaining.length ? remaining : [freshConversation()];
          const stillActive = conversations.some(
            (c) => c.id === s.activeConversationId,
          );
          const activeConversationId = stillActive
            ? s.activeConversationId
            : conversations[0].id;
          const active = conversations.find((c) => c.id === activeConversationId)!;
          return { conversations, activeConversationId, chat: active.lines };
        }),
    }),
    {
      name: "rush-agent-settings",
      // Restore the active conversation's lines into the `chat` mirror on load.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const active = state.conversations?.find(
          (c) => c.id === state.activeConversationId,
        );
        if (active) state.chat = active.lines;
      },
    },
  ),
);
