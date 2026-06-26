import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useFileStore } from "./fileStore";

// Projects each own an isolated file space, a name, and custom instructions.
// The projectStore is the durable source of truth; when a project is opened its
// files are loaded into the live fileStore (what the editor/tree/agent use), and
// saved back on close. Persisted to localStorage for the dev build.

export interface Project {
  id: string;
  name: string;
  instructions: string;
  files: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export type SortKey = "updated" | "name";

function newId() {
  return "p_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Starter files for a brand-new project so the editor isn't empty.
function starterFiles(): Record<string, string> {
  return {
    "index.html": `<!doctype html>\n<html>\n  <head>\n    <meta charset="utf-8" />\n    <title>New Project</title>\n    <link rel="stylesheet" href="style.css" />\n  </head>\n  <body>\n    <h1>Hello from your new project</h1>\n    <script src="main.js"></script>\n  </body>\n</html>\n`,
    "style.css": `body {\n  font-family: system-ui, sans-serif;\n  margin: 40px;\n}\n`,
    "main.js": `console.log("ready");\n`,
  };
}

export interface ProjectState {
  projects: Project[];
  activeProjectId: string | null;
  sortBy: SortKey;

  createProject: (name?: string) => string; // returns new id
  openProject: (id: string) => void;
  saveActiveFiles: () => void;
  renameProject: (id: string, name: string) => void;
  setInstructions: (id: string, instructions: string) => void;
  deleteProject: (id: string) => void;
  setSortBy: (k: SortKey) => void;
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      projects: [],
      activeProjectId: null,
      sortBy: "updated",

      createProject: (name) => {
        const now = Date.now();
        const project: Project = {
          id: newId(),
          name: name?.trim() || "Untitled project",
          instructions: "",
          files: starterFiles(),
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({ projects: [project, ...s.projects] }));
        return project.id;
      },

      // Load a project's files into the live fileStore and mark it active.
      openProject: (id) => {
        const project = get().projects.find((p) => p.id === id);
        if (!project) return;
        useFileStore.getState().loadFiles(project.files);
        set({ activeProjectId: id });
      },

      // Snapshot the live fileStore back into the active project.
      saveActiveFiles: () => {
        const id = get().activeProjectId;
        if (!id) return;
        const files = { ...useFileStore.getState().files };
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? { ...p, files, updatedAt: Date.now() } : p,
          ),
        }));
      },

      renameProject: (id, name) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? { ...p, name: name.trim() || p.name, updatedAt: Date.now() } : p,
          ),
        })),

      setInstructions: (id, instructions) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? { ...p, instructions, updatedAt: Date.now() } : p,
          ),
        })),

      deleteProject: (id) =>
        set((s) => ({
          projects: s.projects.filter((p) => p.id !== id),
          activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
        })),

      setSortBy: (sortBy) => set({ sortBy }),
    }),
    { name: "rush-agent-projects" },
  ),
);

// Sorted + filtered view helper for the landing grid.
export function selectProjects(
  projects: Project[],
  sortBy: SortKey,
  query: string,
): Project[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? projects.filter((p) => p.name.toLowerCase().includes(q))
    : projects.slice();
  filtered.sort((a, b) =>
    sortBy === "name"
      ? a.name.localeCompare(b.name)
      : b.updatedAt - a.updatedAt,
  );
  return filtered;
}
