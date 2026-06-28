import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const store = new Map<string, string>();
  const mem: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => void store.delete(key),
    setItem: (key, value) => void store.set(key, String(value)),
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage = mem;
});

import { importEccPack } from "./eccImport";
import {
  buildPackRuntimeContext,
  resolvePackCommandInvocation,
  suggestPackCommands,
  userTextWithPackCommandInvocation,
} from "./packRuntime";
import { usePackStore } from "./packStore";

const command = [
  "---",
  "description: Review local changes",
  "argument-hint: [scope]",
  "---",
  "# Code Review",
  "",
  "Gather the git diff, inspect changed files, check regressions, and report findings by severity.",
].join("\n");

const rule = [
  "# TypeScript Rules",
  "",
  "Prefer strict types, avoid unsafe any, keep React components focused, and add tests for behavior.",
].join("\n");

function installPack(enabled = true) {
  const pack = importEccPack([
    { path: "commands/code-review.md", content: command },
    { path: "rules/typescript/coding-style.md", content: rule },
  ]);
  usePackStore.getState().installPack(pack, {
    id: "ecc",
    name: "ECC",
    enabled,
  });
}

describe("packRuntime", () => {
  beforeEach(() => {
    usePackStore.setState({ schemaVersion: 1, packs: [] });
    globalThis.localStorage.clear();
  });

  it("keeps imported pack commands and rules out of Chat mode", () => {
    installPack();

    expect(buildPackRuntimeContext("plain")).toBe("");
  });

  it("builds Code and Flow runtime context from enabled commands and rules", () => {
    installPack();

    const context = buildPackRuntimeContext("agent");

    expect(context).toContain("Enabled pack context");
    expect(context).toContain("Imported pack commands");
    expect(context).toContain("/code-review");
    expect(context).toContain("Arguments: [scope]");
    expect(context).toContain("Imported pack rules");
    expect(context).toContain("typescript: TypeScript Rules");
    expect(buildPackRuntimeContext("flow")).toContain("/code-review");
  });

  it("ignores disabled packs", () => {
    installPack(false);

    expect(buildPackRuntimeContext("agent")).toBe("");
  });

  it("resolves explicit pack slash command invocations in Code and Flow", () => {
    installPack();

    const invocation = resolvePackCommandInvocation("/code-review src/core", "agent");

    expect(invocation?.name).toBe("code-review");
    expect(invocation?.args).toBe("src/core");
    expect(invocation?.context).toContain("Invoked pack command");
    expect(invocation?.context).toContain("Expected arguments: [scope]");
    expect(invocation?.context).toContain("User arguments:\nsrc/core");
    expect(resolvePackCommandInvocation("/code-review src/core", "flow")?.name).toBe("code-review");
  });

  it("does not resolve pack slash commands in Chat mode or for unknown commands", () => {
    installPack();

    expect(resolvePackCommandInvocation("/code-review src/core", "plain")).toBeNull();
    expect(resolvePackCommandInvocation("/missing src/core", "agent")).toBeNull();
    expect(resolvePackCommandInvocation("please /code-review src/core", "agent")).toBeNull();
  });

  it("can wrap user text with the invoked command context", () => {
    installPack();
    const invocation = resolvePackCommandInvocation("/code-review src/core", "agent");

    const wrapped = userTextWithPackCommandInvocation("/code-review src/core", invocation);

    expect(wrapped).toContain("Invoked pack command");
    expect(wrapped).toContain("Original user message:");
    expect(wrapped).toContain("/code-review src/core");
  });

  it("suggests enabled pack commands for slash input", () => {
    installPack();

    expect(suggestPackCommands("/", "agent").map((item) => item.name)).toEqual(["code-review"]);
    expect(suggestPackCommands("/code", "flow").map((item) => item.name)).toEqual(["code-review"]);
    expect(suggestPackCommands("/missing", "agent")).toEqual([]);
    expect(suggestPackCommands("/code", "plain")).toEqual([]);
  });

  it("respects project-scoped pack commands and rules", () => {
    const pack = importEccPack([
      { path: "commands/code-review.md", content: command },
      { path: "rules/typescript/coding-style.md", content: rule },
    ]);
    usePackStore.getState().installPack(pack, {
      id: "ecc",
      name: "ECC",
      scope: "projects",
      projectIds: ["project-a"],
    });

    expect(buildPackRuntimeContext("agent")).toBe("");
    expect(buildPackRuntimeContext("agent", "project-a")).toContain("/code-review");
    expect(resolvePackCommandInvocation("/code-review src", "agent", "project-b")).toBeNull();
    expect(suggestPackCommands("/code", "agent", 6, "project-a")).toHaveLength(1);
  });
});
