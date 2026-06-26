import { create } from "zustand";

// Shared, in-memory file store. The editor, file tree, and agent tools all read
// and write through this so they stay in sync. In the Tauri build the same
// interface is backed by the Rust FS layer; the UI doesn't need to change.

function langFor(path: string): string {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".html")) return "html";
  if (path.endsWith(".md")) return "markdown";
  return "plaintext";
}

const SEED: Record<string, string> = {
  "src/main.tsx": `import { createRoot } from "react-dom/client";\nimport { App } from "./ui/App";\n\ncreateRoot(document.getElementById("root")!).render(<App />);\n`,
  "src/ui/App.tsx": `// Rush workspace shell.\nexport function App() {\n  return <div>Rush</div>;\n}\n`,
  "package.json": `{\n  "name": "rush-agent",\n  "version": "0.1.0"\n}\n`,
};

// The editor panel can sit on the left or right of the workspace, and its main
// surface shows either a file (Monaco) or the live Preview.
export type EditorSide = "left" | "right";

export interface FileStore {
  files: Record<string, string>;
  openTabs: string[];
  activeFile: string | null;
  showPreview: boolean;   // is the Preview tab the active surface?
  editorSide: EditorSide; // which side the editor panel docks to

  open: (path: string) => void;
  close: (path: string) => void;
  setActive: (path: string) => void;
  setContent: (path: string, content: string) => void;
  langFor: (path: string) => string;
  setShowPreview: (show: boolean) => void;
  toggleSide: () => void;
  loadFiles: (files: Record<string, string>) => void;
}

export const useFileStore = create<FileStore>((set) => ({
  files: { ...SEED },
  openTabs: [],
  activeFile: null,
  showPreview: false,
  editorSide: "right",
  langFor,

  open: (path) =>
    set((s) => {
      const files = path in s.files ? s.files : { ...s.files, [path]: "" };
      const openTabs = s.openTabs.includes(path) ? s.openTabs : [...s.openTabs, path];
      // Opening a file switches the surface away from Preview to that file.
      return { files, openTabs, activeFile: path, showPreview: false };
    }),

  close: (path) =>
    set((s) => {
      const openTabs = s.openTabs.filter((p) => p !== path);
      const activeFile =
        s.activeFile === path ? openTabs[openTabs.length - 1] ?? null : s.activeFile;
      return { openTabs, activeFile };
    }),

  setActive: (path) => set({ activeFile: path, showPreview: false }),

  setContent: (path, content) =>
    set((s) => ({ files: { ...s.files, [path]: content } })),

  setShowPreview: (showPreview) => set({ showPreview }),

  toggleSide: () =>
    set((s) => ({ editorSide: s.editorSide === "left" ? "right" : "left" })),

  // Replace the working file set (used when opening a project) and reset the
  // editor tabs so stale files from a previous project don't linger.
  loadFiles: (files) =>
    set({ files: { ...files }, openTabs: [], activeFile: null, showPreview: false }),
}));

// Convenience for non-React callers (agent tools) to reach the same store.
export const fileStore = {
  list: () => Object.keys(useFileStore.getState().files).sort(),
  read: (path: string) => useFileStore.getState().files[path],
  write: (path: string, content: string) => {
    const s = useFileStore.getState();
    s.setContent(path, content);
    // The editor follows the AI: any file the agent writes auto-opens and
    // becomes the active tab so you watch edits land in real time.
    s.open(path);
  },
};
