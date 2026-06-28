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

import { DEFAULT_LANGUAGE_SERVER_SETTINGS, useAppStore } from "./store";
import { DEFAULT_PROVIDERS } from "./providers/defaults";

function resetStore() {
  useAppStore.setState({
    providers: DEFAULT_PROVIDERS,
    conversations: [],
    activeConversationId: "",
    activeConversationIds: { plain: "", agent: "", flow: "" },
    chat: [],
    plainChat: [],
    flowChat: [],
    activeProviderId: null,
    activeModel: null,
    toolPermissions: {
      allow: [],
      ask: [],
      deny: [],
    },
    languageServerSettings: DEFAULT_LANGUAGE_SERVER_SETTINGS,
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

  it("clears the active model when the active provider is removed", () => {
    const id = useAppStore.getState().providers[0].id;
    useAppStore.getState().setActive(id, "model-a");
    useAppStore.getState().removeProvider(id);
    expect(useAppStore.getState().activeProviderId).toBeNull();
    expect(useAppStore.getState().activeModel).toBeNull();
  });

  it("clears a stale active provider when the provider list is replaced", () => {
    useAppStore.getState().setActive("missing-provider", "model-a");
    useAppStore.getState().setProviders([
      {
        id: "replacement",
        label: "Replacement",
        kind: "custom",
        baseUrl: "http://localhost:9999/v1",
        defaultModel: "model-b",
        enabled: true,
      },
    ]);
    expect(useAppStore.getState().activeProviderId).toBeNull();
    expect(useAppStore.getState().activeModel).toBeNull();
  });

  it("setActive records the active provider and model", () => {
    useAppStore.getState().setActive("openai-default", "gpt-4o");
    expect(useAppStore.getState().activeProviderId).toBe("openai-default");
    expect(useAppStore.getState().activeModel).toBe("gpt-4o");
  });
});

describe("useAppStore conversations", () => {
  beforeEach(resetStore);

  it("starts with no saved conversations", () => {
    expect(useAppStore.getState().conversations).toEqual([]);
    expect(useAppStore.getState().activeConversationIds).toEqual({ plain: "", agent: "", flow: "" });
  });

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

  it("newConversation starts an unsaved blank draft", () => {
    useAppStore.getState().setChat([{ role: "user", text: "old" }]);
    useAppStore.getState().newConversation("agent");
    expect(useAppStore.getState().chat).toEqual([]);
    expect(useAppStore.getState().activeConversationIds.agent).toBe("");
    expect(useAppStore.getState().conversations).toHaveLength(1);
  });

  it("selectConversation restores that conversation's lines into the chat mirror", () => {
    useAppStore.getState().setChat([{ role: "user", text: "convo one" }]);
    const first = useAppStore.getState().activeConversationIds.agent;
    useAppStore.getState().newConversation("agent");
    const mode = useAppStore.getState().selectConversation(first);
    expect(mode).toBe("agent");
    expect(useAppStore.getState().chat[0].text).toBe("convo one");
  });

  it("keeps plain chat conversations separate from code agent tasks", () => {
    useAppStore.getState().setPlainChat([{ role: "user", text: "plain question" }]);
    const plain = useAppStore.getState().activeConversationIds.plain;
    useAppStore.getState().setChat([{ role: "user", text: "code task" }]);
    const agent = useAppStore.getState().activeConversationIds.agent;

    expect(plain).not.toBe(agent);
    expect(useAppStore.getState().conversations.find((c) => c.id === plain)?.mode).toBe("plain");
    expect(useAppStore.getState().conversations.find((c) => c.id === agent)?.mode).toBe("agent");
  });

  it("new plain conversations do not wipe the active agent task", () => {
    useAppStore.getState().setChat([{ role: "user", text: "agent work" }]);
    useAppStore.getState().newConversation("plain");
    expect(useAppStore.getState().plainChat).toEqual([]);
    expect(useAppStore.getState().chat[0].text).toBe("agent work");
  });

  it("keeps flow conversations separate from code agent tasks", () => {
    useAppStore.getState().setChat([{ role: "user", text: "code task" }]);
    const agent = useAppStore.getState().activeConversationIds.agent;
    useAppStore.getState().setFlowChat([{ role: "user", text: "flow task" }]);
    const flow = useAppStore.getState().activeConversationIds.flow;

    expect(flow).not.toBe(agent);
    expect(useAppStore.getState().conversations.find((c) => c.id === flow)?.mode).toBe("flow");
    expect(useAppStore.getState().chat[0].text).toBe("code task");
    expect(useAppStore.getState().flowChat[0].text).toBe("flow task");
  });

  it("clearChat removes the saved active task", () => {
    useAppStore.getState().setChat([{ role: "user", text: "something" }]);
    useAppStore.getState().clearChat();
    expect(useAppStore.getState().chat).toEqual([]);
    expect(useAppStore.getState().activeConversationIds.agent).toBe("");
    expect(useAppStore.getState().conversations).toEqual([]);
  });

  it("can leave zero conversations after deleting the last saved task", () => {
    useAppStore.getState().setChat([{ role: "user", text: "delete me" }]);
    const onlyAgent = useAppStore.getState().activeConversationIds.agent;
    useAppStore.getState().deleteConversation(onlyAgent);
    expect(useAppStore.getState().conversations).toEqual([]);
    expect(useAppStore.getState().activeConversationIds.agent).toBe("");
  });

  it("persists settings to localStorage under its store key", () => {
    useAppStore.getState().setActive("openai-default", "gpt-4o");
    const raw = globalThis.localStorage.getItem("rush-agent-settings");
    expect(raw).toBeTruthy();
  });

  it("stores tool permission rules", () => {
    useAppStore.getState().setToolPermissions({
      allow: ["Bash(npm test)"],
      ask: ["Write(src/**)"],
      deny: ["Read(secrets/**)"],
    });

    expect(useAppStore.getState().toolPermissions).toEqual({
      allow: ["Bash(npm test)"],
      ask: ["Write(src/**)"],
      deny: ["Read(secrets/**)"],
    });
  });

  it("stores language server preferences", () => {
    useAppStore.getState().setLanguageServerConfig("typescript", {
      mode: "custom",
      customPath: "C:/tools/typescript-language-server.cmd",
    });

    expect(useAppStore.getState().languageServerSettings.typescript).toEqual({
      mode: "custom",
      customPath: "C:/tools/typescript-language-server.cmd",
    });
    expect(useAppStore.getState().languageServerSettings.rust).toEqual({ mode: "path", customPath: "" });
  });
});
