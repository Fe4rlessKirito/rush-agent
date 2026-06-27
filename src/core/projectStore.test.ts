import { describe, it, expect, beforeEach, vi } from "vitest";

// Install an in-memory localStorage before the persist-backed store imports,
// so zustand's persist middleware has somewhere to write in the node test env.
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

import { selectProjects, useProjectStore, type Project } from "./projectStore";
import { useFileStore } from "./fileStore";

function project(over: Partial<Project>): Project {
  return {
    id: "id",
    name: "Name",
    path: "",
    instructions: "",
    files: {},
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe("selectProjects", () => {
  const a = project({ id: "a", name: "Alpha", updatedAt: 100 });
  const b = project({ id: "b", name: "beta", updatedAt: 300 });
  const c = project({ id: "c", name: "Gamma", updatedAt: 200 });

  it("sorts by most-recently-updated by default", () => {
    const out = selectProjects([a, b, c], "updated", "");
    expect(out.map((p) => p.id)).toEqual(["b", "c", "a"]);
  });

  it("sorts by name case-insensitively", () => {
    const out = selectProjects([a, b, c], "name", "");
    expect(out.map((p) => p.name)).toEqual(["Alpha", "beta", "Gamma"]);
  });

  it("filters by a case-insensitive name query", () => {
    const out = selectProjects([a, b, c], "updated", "GA");
    expect(out.map((p) => p.id)).toEqual(["c"]);
  });

  it("does not mutate the input array", () => {
    const input = [a, b, c];
    const snapshot = input.slice();
    selectProjects(input, "name", "");
    expect(input).toEqual(snapshot);
  });

  it("returns everything for an empty/whitespace query", () => {
    expect(selectProjects([a, b, c], "updated", "   ")).toHaveLength(3);
  });
});

describe("useProjectStore actions", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], activeProjectId: null, sortBy: "updated" });
  });

  it("createProject prepends a project with starter files and returns its id", () => {
    const id = useProjectStore.getState().createProject("My App");
    const projects = useProjectStore.getState().projects;
    expect(projects[0].id).toBe(id);
    expect(projects[0].name).toBe("My App");
    expect(Object.keys(projects[0].files)).toContain("index.html");
  });

  it("falls back to 'Untitled project' for a blank name", () => {
    const id = useProjectStore.getState().createProject("   ");
    const p = useProjectStore.getState().projects.find((x) => x.id === id)!;
    expect(p.name).toBe("Untitled project");
  });

  it("openProject loads files into the live fileStore and marks it active", () => {
    const id = useProjectStore.getState().createProject("App");
    useProjectStore.getState().openProject(id);
    expect(useProjectStore.getState().activeProjectId).toBe(id);
    expect(useFileStore.getState().files["index.html"]).toBeDefined();
    expect(useFileStore.getState().mode).toBe("memory");
  });

  it("saveActiveFiles snapshots edited files back into the active project", () => {
    const id = useProjectStore.getState().createProject("App");
    useProjectStore.getState().openProject(id);
    useFileStore.getState().setContent("main.js", "console.log('edited');\n");
    useProjectStore.getState().saveActiveFiles();
    const p = useProjectStore.getState().projects.find((x) => x.id === id)!;
    expect(p.files["main.js"]).toContain("edited");
  });

  it("renameProject ignores a blank name and keeps the old one", () => {
    const id = useProjectStore.getState().createProject("Keep Me");
    useProjectStore.getState().renameProject(id, "   ");
    const p = useProjectStore.getState().projects.find((x) => x.id === id)!;
    expect(p.name).toBe("Keep Me");
  });

  it("deleteProject removes it and clears activeProjectId when it was active", () => {
    const id = useProjectStore.getState().createProject("Doomed");
    useProjectStore.getState().openProject(id);
    useProjectStore.getState().deleteProject(id);
    expect(useProjectStore.getState().projects.find((x) => x.id === id)).toBeUndefined();
    expect(useProjectStore.getState().activeProjectId).toBeNull();
  });

  it("persists projects to localStorage under its store key", () => {
    useProjectStore.getState().createProject("Persisted");
    const raw = globalThis.localStorage.getItem("rush-agent-projects");
    expect(raw).toBeTruthy();
    expect(raw!).toContain("Persisted");
  });
});
