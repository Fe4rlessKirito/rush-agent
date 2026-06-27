import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory localStorage so the persist middleware has a backing store in node.
vi.hoisted(() => {
  const store = new Map<string, string>();
  const mem: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    key: (i) => [...store.keys()][i] ?? null,
    removeItem: (k) => void store.delete(k),
    setItem: (k, v) => void store.set(k, String(v)),
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage = mem;
});

import { useAppStore, type ChatLine } from "./store";
import { DEFAULT_PROVIDERS } from "./providers/defaults";

function resetStore() {
  const convo = { id: "seed", title: "New chat", lines: [] as ChatLine[], createdAt: 0 };
  useAppStore.setState({
    conversations: [convo],
    activeConversationId: "seed",
    chat: [],
    plainChat: [],
    activeProviderId: null,
    activeModel: null,
  });
}

describe("useAppStore providers", () => {
  beforeEach(resetStore);

  it("seeds with the full set of default providers", () => {
    const ids = useAppStore.getState().providers.map((p) => p.id);
    for (const def of DEFAULT_PROVIDERS) expect(ids).toContain(def.id);
  });

  it("upsertProvider updates in place when the id already exists", () => {
    const existing = useAppStore.getState().providers[0];
    useAppStore.getState().upsertProvider({ ...existing, label: "Renamed" });
    const matches = useAppStore.getState().providers.filter((p) => p.id === existing.id);
    expect(matches).toHaveLength(1);
    expect(matches[0].label).toBe("Renamed");
  });

  it("upsertProvider appends when the id is new", () => {
    const before = useAppStore.getState().providers.length;
    useAppStore.getState().upsertProvider({
      id: "brand-new",
      label: "New",
      kind: "custom",
      baseUrl: "http://localhost:9999/v1",
      defaultModel: "x",
      enabled: true,
    });
    expect(useAppStore.getState().providers.length).toBe(before + 1);
  });

  it("removeProvider drops the matching provider", () => {
    const id = useAppStore.getState().providers[0].id;
    useAppStore.getState().removeProvider(id);
    expect(useAppStore.getState().providers.find((p) => p.id === id)).toBeUndefined();
  });

  it("setActive records the active provider and model", () => {
    useAppStore.getState().setActive("openai-default", "gpt-4o");
    expect(useAppStore.getState().activeProviderId).toBe("openai-default");
    expect(useAppStore.getState().activeModel).toBe("gpt-4o");
  });
});

describe("useAppStore conversations", () => {
  beforeEach(resetStore);

  it("derives a conversation title from the first user message", () => {
    useAppStore.getState().setChat([{ role: "user", text: "Fix the login bug" }]);
    const active = useAppStore
      .getState()
      .conversations.find((c) => c.id === useAppStore.getState().activeConversationId)!;
    expect(active.title).toBe("Fix the login bug");
  });

  it("truncates a long title with an ellipsis", () => {
    const long = "x".repeat(60);
    useAppStore.getState().setChat([{ role: "user", text: long }]);
    const active = useAppStore
      .getState()
      .conversations.find((c) => c.id === useAppStore.getState().activeConversationId)!;
    expect(active.title.length).toBeLessThanOrEqual(41);
    expect(active.title.endsWith("\u2026")).toBe(true);
  });

  it("setChat accepts a functional updater over the previous lines", () => {
    useAppStore.getState().setChat([{ role: "user", text: "first" }]);
    useAppStore.getState().setChat((prev) => [...prev, { role: "agent", text: "reply" }]);
    expect(useAppStore.getState().chat).toHaveLength(2);
  });

  it("newConversation creates a fresh active chat at the front", () => {
    useAppStore.getState().setChat([{ role: "user", text: "old" }]);
    useAppStore.getState().newConversation();
    expect(useAppStore.getState().chat).toEqual([]);
    expect(useAppStore.getState().conversations[0].id).toBe(
      useAppStore.getState().activeConversationId,
    );
  });

  it("selectConversation restores that conversation's lines into the chat mirror", () => {
    useAppStore.getState().setChat([{ role: "user", text: "convo one" }]);
    const first = useAppStore.getState().activeConversationId;
    useAppStore.getState().newConversation();
    useAppStore.getState().selectConversation(first);
    expect(useAppStore.getState().chat[0].text).toBe("convo one");
  });

  it("clearChat empties the active conversation and resets its title", () => {
    useAppStore.getState().setChat([{ role: "user", text: "something" }]);
    useAppStore.getState().clearChat();
    expect(useAppStore.getState().chat).toEqual([]);
    const active = useAppStore
      .getState()
      .conversations.find((c) => c.id === useAppStore.getState().activeConversationId)!;
    expect(active.title).toBe("New chat");
  });

  it("never leaves zero conversations after deleting the last one", () => {
    const only = useAppStore.getState().activeConversationId;
    useAppStore.getState().deleteConversation(only);
    expect(useAppStore.getState().conversations.length).toBeGreaterThanOrEqual(1);
    expect(useAppStore.getState().activeConversationId).toBeTruthy();
  });

  it("persists settings to localStorage under its store key", () => {
    useAppStore.getState().setActive("openai-default", "gpt-4o");
    const raw = globalThis.localStorage.getItem("rush-agent-settings");
    expect(raw).toBeTruthy();
  });
});
