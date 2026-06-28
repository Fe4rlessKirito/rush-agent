import { create } from "zustand";
import type { FsBackend } from "./agent/fsTools";
import { createTauriFs, isTauriRuntime } from "./agent/tauriFs";

// Shared file store. The editor, file tree, and agent tools all read and write
// through this so they stay in sync. In "memory" mode it holds an in-memory map
// (dev/seeded projects). In "disk" mode it is a write-through cache over the
// real Tauri FS backend: directory contents and file contents are loaded lazily,
// and edits are written through to disk.

function langFor(path: string): string {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".html")) return "html";
  if (path.endsWith(".md")) return "markdown";
  return "plaintext";
}

// Debounce handles for write-through-to-disk, keyed by path.
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();

const SEED: Record<string, string> = {
  "src/main.tsx": `import { createRoot } from "react-dom/client";\nimport { App } from "./ui/App";\n\ncreateRoot(document.getElementById("root")!).render(<App />);\n`,
  "src/ui/App.tsx": `// Rush workspace shell.\nexport function App() {\n  return <div>Rush</div>;\n}\n`,
  "package.json": `{\n  "name": "rush-agent",\n  "version": "0.1.0"\n}\n`,
};

// The editor panel can sit on the left or right of the workspace, and its main
// surface shows either a file (Monaco) or the live Preview.
export type EditorSide = "left" | "right";

// "memory" = in-memory seed/dev projects (unchanged legacy behavior).
// "disk"   = a real folder-backed project; files read/written through Tauri FS.
export type FileMode = "memory" | "disk";

export interface FileStore {
  files: Record<string, string>;
  tree: string[];         // known workspace-relative file paths
  mode: FileMode;
  backend: FsBackend | null;
  root: string;           // absolute disk root when mode === "disk"
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
  loadFromDisk: (root: string) => Promise<void>;
}

export const useFileStore = create<FileStore>((set, get) => ({
  files: { ...SEED },
  tree: Object.keys(SEED).sort(),
  mode: "memory",
  backend: null,
  root: "",
  openTabs: [],
  activeFile: null,
  showPreview: false,
  editorSide: "right",
  langFor,

  open: (path) => {
    const s = get();
    // Disk mode: if this file isn't cached yet, lazy-load its contents from disk.
    if (s.mode === "disk" && s.backend && !(path in s.files)) {
      const backend = s.backend;
      backend
        .readFile(path)
        .then((content) =>
          set((st) =>
            st.mode === "disk" ? { files: { ...st.files, [path]: content } } : {},
          ),
        )
        .catch(() => {
          /* file may not exist yet; leave it absent until written */
        });
    }
    set((st) => {
      const files = path in st.files ? st.files : { ...st.files, [path]: "" };
      const openTabs = st.openTabs.includes(path) ? st.openTabs : [...st.openTabs, path];
      // Opening a file switches the surface away from Preview to that file.
      return { files, openTabs, activeFile: path, showPreview: false };
    });
  },

  close: (path) =>
    set((s) => {
      const openTabs = s.openTabs.filter((p) => p !== path);
      const activeFile =
        s.activeFile === path ? openTabs[openTabs.length - 1] ?? null : s.activeFile;
      return { openTabs, activeFile };
    }),

  setActive: (path) => set({ activeFile: path, showPreview: false }),

  setContent: (path, content) => {
    set((s) => ({ files: { ...s.files, [path]: content } }));
    // Disk mode: write-through to the real file, debounced so rapid keystrokes
    // don't hammer the FS. The in-memory cache stays the instant source of truth.
    const s = get();
    if (s.mode === "disk" && s.backend) {
      const backend = s.backend;
      const existing = writeTimers.get(path);
      if (existing) clearTimeout(existing);
      writeTimers.set(
        path,
        setTimeout(() => {
          writeTimers.delete(path);
          backend.writeFile(path, content).catch(() => {
            /* surface write failures elsewhere; don't crash the editor */
          });
        }, 250),
      );
      if (!s.tree.includes(path)) {
        set((st) => ({ tree: [...st.tree, path].sort() }));
      }
    }
  },

  setShowPreview: (showPreview) => set({ showPreview }),

  toggleSide: () =>
    set((s) => ({ editorSide: s.editorSide === "left" ? "right" : "left" })),

  // Replace the working file set (used when opening a memory-backed project) and
  // reset editor tabs so stale files from a previous project don't linger.
  loadFiles: (files) =>
    set({
      files: { ...files },
      tree: Object.keys(files).sort(),
      mode: "memory",
      backend: null,
      root: "",
      openTabs: [],
      activeFile: null,
      showPreview: false,
    }),

  // Open a real on-disk folder. Directory contents are listed lazily by the
  // explorer, and file contents are lazy-loaded on open. Falls back to memory
  // mode if not running under Tauri.
  loadFromDisk: async (root) => {
    if (!isTauriRuntime()) {
      get().loadFiles({});
      return;
    }
    const backend = createTauriFs();
    const rootClean = root.replace(/[\\/]+$/, "");
    set({
      files: {},
      tree: [],
      mode: "disk",
      backend,
      root: rootClean,
      openTabs: [],
      activeFile: null,
      showPreview: false,
    });
  },
}));

// Convenience for non-React callers (agent tools) to reach the same store.
export const fileStore = {
  list: () => {
    const s = useFileStore.getState();
    return s.mode === "disk" ? [...s.tree].sort() : Object.keys(s.files).sort();
  },
  read: (path: string) => useFileStore.getState().files[path],
  write: (path: string, content: string) => {
    const s = useFileStore.getState();
    s.setContent(path, content);
    // The editor follows the AI: any file the agent writes auto-opens and
    // becomes the active tab so you watch edits land in real time.
    s.open(path);
  },
};
