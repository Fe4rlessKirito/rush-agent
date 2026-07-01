import { lazy, Suspense, useState, useEffect } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChatPanel } from "./components/ChatPanel";
import { Sidebar } from "./components/Sidebar";
import type { LibraryFilter } from "./components/LibraryView";
import { ToastHost } from "./components/ToastHost";
import { checkForUpdates } from "../core/updater";
import { useAppStore, type ConversationMode } from "../core/store";
import { useProjectStore } from "../core/projectStore";
import { useFileStore } from "../core/fileStore";
import { setDesktopProjectRoot } from "../core/projectRoot";

const SettingsPanel = lazy(() => import("./components/SettingsPanel").then((m) => ({ default: m.SettingsPanel })));
const ProjectsView = lazy(() => import("./components/ProjectsView").then((m) => ({ default: m.ProjectsView })));
const LibraryView = lazy(() => import("./components/LibraryView").then((m) => ({ default: m.LibraryView })));
const BrainView = lazy(() => import("./components/BrainView").then((m) => ({ default: m.BrainView })));
const DeepResearchView = lazy(() => import("./components/DeepResearchView").then((m) => ({ default: m.DeepResearchView })));
const FlowView = lazy(() => import("./components/FlowView").then((m) => ({ default: m.FlowView })));
const ProjectSettings = lazy(() => import("./components/ProjectSettings").then((m) => ({ default: m.ProjectSettings })));
const EditorTabs = lazy(() => import("./components/EditorTabs").then((m) => ({ default: m.EditorTabs })));
const EditorPane = lazy(() => import("./components/EditorPane").then((m) => ({ default: m.EditorPane })));
const TerminalPanel = lazy(() => import("./components/TerminalPanel").then((m) => ({ default: m.TerminalPanel })));

type View = "chat" | "code" | "projects" | "library" | "flow";
type ProjectAiMode = "agent" | "flow";
type SettingsTab = "general" | "providers" | "proxies" | "tools" | "packs" | "lsp" | "mcp";
type LspToast = {
  language: "rust" | "typescript";
  message: string;
  installJob?: string;
};

function normalizeProjectRoot(path: string): string {
  return path.trim().replace(/[\\/]+$/, "");
}

export function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [showBrain, setShowBrain] = useState(false);
  const [showResearch, setShowResearch] = useState(false);
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>("chats");
  const [view, setView] = useState<View>("chat");
  const [inProject, setInProject] = useState(false);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [projectPaneWidths, setProjectPaneWidths] = useState({
    ai: 420,
  });
  const [projectAiMode, setProjectAiMode] = useState<ProjectAiMode>("agent");
  const [projectEditorMinimized, setProjectEditorMinimized] = useState(false);
  const [lspToast, setLspToast] = useState<LspToast | null>(null);
  const [dismissedLspToasts, setDismissedLspToasts] = useState<Set<string>>(() => new Set());
  const autoUpdateEnabled = useAppStore((s) => s.autoUpdateEnabled);
  const selectConversation = useAppStore((s) => s.selectConversation);
  const setConversationProjectContext = useAppStore((s) => s.setConversationProjectContext);
  const openProject = useProjectStore((s) => s.openProject);
  const saveActiveFiles = useProjectStore((s) => s.saveActiveFiles);
  const activeProject = useProjectStore((s) =>
    s.projects.find((p) => p.id === s.activeProjectId),
  );
  const topbarLabel =
    view === "library"
      ? "Library"
      : view === "projects"
        ? "Projects"
        : "";

  const enterProject = async (id: string) => {
    openProject(id);
    const project = useProjectStore.getState().projects.find((p) => p.id === id);
    if (project) {
      setConversationProjectContext({
        projectId: project.id,
        projectRoot: normalizeProjectRoot(project.path),
        projectName: project.name,
      });
    }
    if (project?.path) {
      try {
        await setDesktopProjectRoot(project.path);
        await useFileStore.getState().loadFromDisk(project.path);
      } catch (err) {
        console.warn("set_project_root failed", err);
      }
    }
    setInProject(true);
  };

  const leaveProject = () => {
    saveActiveFiles();
    setConversationProjectContext(null);
    setInProject(false);
  };

  const openLibraryConversation = (id: string, mode: ConversationMode) => {
    const selectedMode = selectConversation(id) ?? mode;
    setView(selectedMode === "agent" ? "code" : selectedMode === "flow" ? "flow" : "chat");
  };

  const openResearchLibrary = () => {
    setLibraryFilter("research");
    setView("library");
    setShowResearch(false);
  };

  const openSettings = (tab: SettingsTab = "general") => {
    setSettingsTab(tab);
    setShowSettings(true);
  };

  const startProjectResize =
    (pane: "ai") => (e: ReactMouseEvent<HTMLDivElement>) => {
      const startX = e.clientX;
      const start = projectPaneWidths[pane];

      const move = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        const min = 300;
        const max = 760;
        const next = Math.max(min, Math.min(max, start + delta));
        setProjectPaneWidths((widths) => ({ ...widths, [pane]: next }));
      };

      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };

      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      e.preventDefault();
    };

  useEffect(() => {
    if (!inProject) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useFileStore.subscribe((state, prev) => {
      if (state.files === prev.files) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => saveActiveFiles(), 600);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
      saveActiveFiles();
    };
  }, [inProject, saveActiveFiles]);

  useEffect(() => {
    if (!autoUpdateEnabled) return;
    void checkForUpdates(true);
  }, [autoUpdateEnabled]);

  useEffect(() => {
    const root = normalizeProjectRoot(activeProject?.path ?? "");
    if (!root) return;

    let cancelled = false;
    async function syncProjectRoot() {
      try {
        await setDesktopProjectRoot(root);
        if (cancelled) return;
        const fileState = useFileStore.getState();
        if (fileState.mode !== "disk" || normalizeProjectRoot(fileState.root) !== root) {
          await fileState.loadFromDisk(root);
        }
      } catch (err) {
        console.warn("sync project root failed", err);
      }
    }

    void syncProjectRoot();
    return () => {
      cancelled = true;
    };
  }, [activeProject?.path]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ language?: string; message?: string }>).detail;
      const language = detail?.language === "rust" ? "rust" : "typescript";
      if (dismissedLspToasts.has(language)) return;
      setLspToast({
        language,
        message: detail?.message ?? "Language server is missing.",
      });
    };
    window.addEventListener("rush:lsp-missing", handler);
    return () => window.removeEventListener("rush:lsp-missing", handler);
  }, [dismissedLspToasts]);

  const dismissLspToast = (language: "rust" | "typescript") => {
    setDismissedLspToasts((items) => new Set(items).add(language));
    setLspToast((toast) => (toast?.language === language ? null : toast));
  };

  const installLanguageServer = async (language: "rust" | "typescript") => {
    const command = language === "typescript"
      ? "npm install -g typescript-language-server typescript"
      : "rustup component add rust-analyzer";
    const ok = window.confirm(`Run this install/update command?\n\n${command}`);
    if (!ok) return;
    try {
      const result = await invoke<{ id: string }>("background_start", {
        command,
        shell: "powershell",
      });
      setLspToast((toast) => toast && toast.language === language
        ? { ...toast, installJob: result.id }
        : toast);
    } catch (err) {
      setLspToast((toast) => toast && toast.language === language
        ? { ...toast, message: `Install failed: ${String(err)}` }
        : toast);
    }
  };

  return (
    <div className="app">
      <header className="titlebar">
        <nav className="top-mode-tabs" aria-label="AI modes">
          <button
            className={"top-mode-tab" + (view === "chat" ? " active" : "")}
            onClick={() => setView("chat")}
            title="Chat"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 6.5h14v9H9l-4 3.5z" />
            </svg>
            <span>Chat</span>
          </button>
          <button
            className={"top-mode-tab" + (view === "code" ? " active" : "")}
            onClick={() => setView("code")}
            title="Code"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="5" y="7" width="14" height="10" rx="1.5" />
              <path d="M9.5 10.5 7.5 12l2 1.5M14.5 10.5l2 1.5-2 1.5" />
            </svg>
            <span>Code</span>
          </button>
          <button
            className={"top-mode-tab" + (view === "flow" ? " active" : "")}
            onClick={() => setView("flow")}
            title="Flow"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="7" cy="12" r="2.2" />
              <circle cx="17" cy="7" r="2.2" />
              <circle cx="17" cy="17" r="2.2" />
              <path d="M9 11.2 15 8M9 12.8 15 16" />
            </svg>
            <span>Flow</span>
          </button>
        </nav>
        {topbarLabel && <div className="titlebar-view-title">{topbarLabel}</div>}
        <div className="titlebar-actions">
          <button
            className={"settings-cog-btn research-topbar-btn" + (showResearch ? " active" : "")}
            onClick={() => setShowResearch((s) => !s)}
            title={showResearch ? "Close Deep Research" : "Deep Research"}
            aria-label={showResearch ? "Close Deep Research" : "Deep Research"}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="5.5" />
              <path d="m15 15 4 4" />
              <path d="M10.5 8v5M8 10.5h5" />
            </svg>
          </button>
          <button
            className={"settings-cog-btn brain-topbar-btn" + (showBrain ? " active" : "")}
            onClick={() => setShowBrain((s) => !s)}
            title={showBrain ? "Close Brain" : "Brain"}
            aria-label={showBrain ? "Close Brain" : "Brain"}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 4.5a3.5 3.5 0 0 0-4 3.45A3.8 3.8 0 0 0 3.5 11a3.7 3.7 0 0 0 1.1 2.63A3.5 3.5 0 0 0 8 19.5" />
              <path d="M15 4.5a3.5 3.5 0 0 1 4 3.45A3.8 3.8 0 0 1 20.5 11a3.7 3.7 0 0 1-1.1 2.63A3.5 3.5 0 0 1 16 19.5" />
              <path d="M9 4.5v15M15 4.5v15M9 9h6M9 14h6" />
            </svg>
          </button>
          <button
            className={"settings-cog-btn" + (showSettings ? " active" : "")}
            onClick={() => {
              setSettingsTab("general");
              setShowSettings((s) => !s);
            }}
            title={showSettings ? "Close settings" : "Settings"}
            aria-label={showSettings ? "Close settings" : "Settings"}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
              <path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.05.05a2.1 2.1 0 0 1-2.97 2.97l-.05-.05a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.09 1.65V21.3a2.1 2.1 0 0 1-4.2 0v-.07a1.8 1.8 0 0 0-1.09-1.65 1.8 1.8 0 0 0-1.98.36l-.05.05a2.1 2.1 0 1 1-2.97-2.97l.05-.05A1.8 1.8 0 0 0 4.6 15a1.8 1.8 0 0 0-1.65-1.09H2.7a2.1 2.1 0 0 1 0-4.2h.25A1.8 1.8 0 0 0 4.6 8.62a1.8 1.8 0 0 0-.36-1.98l-.05-.05A2.1 2.1 0 0 1 7.16 3.6l.05.05a1.8 1.8 0 0 0 1.98.36A1.8 1.8 0 0 0 10.28 2.36V2.3a2.1 2.1 0 0 1 4.2 0v.07a1.8 1.8 0 0 0 1.09 1.65 1.8 1.8 0 0 0 1.98-.36l.05-.05a2.1 2.1 0 0 1 2.97 2.97l-.05.05a1.8 1.8 0 0 0-.36 1.98 1.8 1.8 0 0 0 1.65 1.09h.19a2.1 2.1 0 0 1 0 4.2h-.19A1.8 1.8 0 0 0 19.4 15Z" />
            </svg>
          </button>
        </div>
      </header>

      <div className="app-body">
        <Sidebar
          view={view}
          onSelectView={setView}
          projectContext={inProject && activeProject ? {
            projectId: activeProject.id,
            projectRoot: normalizeProjectRoot(activeProject.path),
            projectName: activeProject.name,
          } : null}
        />

        {view === "chat" && (
          <main className="chat-view">
            <div className="chat-center">
              <ChatPanel mode="plain" />
            </div>
          </main>
        )}

        {view === "code" && (
          <main className="chat-view">
            <div className="chat-center">
              <ChatPanel mode="agent" />
            </div>
          </main>
        )}

        {view === "projects" && !inProject && (
          <Suspense fallback={null}>
            <ProjectsView onOpenProject={enterProject} />
          </Suspense>
        )}

        {view === "library" && (
          <Suspense fallback={null}>
            <LibraryView
              filter={libraryFilter}
              onFilterChange={setLibraryFilter}
              onOpenConversation={openLibraryConversation}
            />
          </Suspense>
        )}

        {view === "projects" && inProject && (
          <div className="workspace project-workspace">
            <section
              className="project-ai-pane"
              style={{
                flexBasis: projectEditorMinimized ? "auto" : projectPaneWidths.ai,
                flexGrow: projectEditorMinimized ? 1 : 0,
              }}
            >
              <div className="project-ai-chat">
                <div className="project-ai-toolbar">
                  <div className="project-ai-toolbar-project">
                    <button className="projects-back" onClick={leaveProject}>
                      Projects
                    </button>
                    {activeProject && (
                      <div className="project-name-tag">
                        <span>{activeProject.name}</span>
                        <button
                          className="project-settings-btn settings-cog-btn"
                          onClick={() => setShowProjectSettings(true)}
                          title="Project settings"
                          aria-label="Project settings"
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
                            <path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.05.05a2.1 2.1 0 0 1-2.97 2.97l-.05-.05a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.09 1.65V21.3a2.1 2.1 0 0 1-4.2 0v-.07a1.8 1.8 0 0 0-1.09-1.65 1.8 1.8 0 0 0-1.98.36l-.05.05a2.1 2.1 0 1 1-2.97-2.97l.05-.05A1.8 1.8 0 0 0 4.6 15a1.8 1.8 0 0 0-1.65-1.09H2.7a2.1 2.1 0 0 1 0-4.2h.25A1.8 1.8 0 0 0 4.6 8.62a1.8 1.8 0 0 0-.36-1.98l-.05-.05A2.1 2.1 0 0 1 7.16 3.6l.05.05a1.8 1.8 0 0 0 1.98.36A1.8 1.8 0 0 0 10.28 2.36V2.3a2.1 2.1 0 0 1 4.2 0v.07a1.8 1.8 0 0 0 1.09 1.65 1.8 1.8 0 0 0 1.98-.36l.05-.05a2.1 2.1 0 0 1 2.97 2.97l-.05.05a1.8 1.8 0 0 0-.36 1.98 1.8 1.8 0 0 0 1.65 1.09h.19a2.1 2.1 0 0 1 0 4.2h-.19A1.8 1.8 0 0 0 19.4 15Z" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="project-ai-mode-tabs" role="tablist" aria-label="Project AI mode">
                    <button
                      className={projectAiMode === "agent" ? "active" : ""}
                      onClick={() => setProjectAiMode("agent")}
                      role="tab"
                      aria-selected={projectAiMode === "agent"}
                    >
                      Code
                    </button>
                    <button
                      className={projectAiMode === "flow" ? "active" : ""}
                      onClick={() => setProjectAiMode("flow")}
                      role="tab"
                      aria-selected={projectAiMode === "flow"}
                    >
                      Flow
                    </button>
                  </div>
                  <button
                    className="project-editor-toggle"
                    onClick={() => setProjectEditorMinimized((minimized) => !minimized)}
                    title={projectEditorMinimized ? "Show code editor" : "Minimize code editor"}
                    aria-label={projectEditorMinimized ? "Show code editor" : "Minimize code editor"}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      {projectEditorMinimized ? (
                        <>
                          <rect x="4" y="5" width="16" height="14" rx="2" />
                          <path d="M8 9h8M8 13h5M15 16l3-3-3-3" />
                        </>
                      ) : (
                        <>
                          <rect x="4" y="5" width="16" height="14" rx="2" />
                          <path d="M8 9h8M8 13h5M17 9v6" />
                        </>
                      )}
                    </svg>
                  </button>
                </div>
                <div className="project-ai-chat-body">
                  {projectAiMode === "flow" ? (
                    <Suspense fallback={null}>
                      <FlowView embedded />
                    </Suspense>
                  ) : (
                    <ChatPanel mode="agent" />
                  )}
                </div>
              </div>
              <Suspense fallback={null}>
                <TerminalPanel />
              </Suspense>
            </section>

            {!projectEditorMinimized && (
              <div
                className="pane-resizer"
                role="separator"
                aria-orientation="vertical"
                onMouseDown={startProjectResize("ai")}
              />
            )}

            {!projectEditorMinimized && (
              <section className="editor-panel dock-right project-editor-pane">
                <main className="editor">
                  <Suspense fallback={null}>
                    <EditorTabs />
                  </Suspense>
                  <div className="editor-surface">
                    <Suspense fallback={null}>
                      <EditorPane />
                    </Suspense>
                  </div>
                </main>
              </section>
            )}
          </div>
        )}

        {view === "flow" && (
          <Suspense fallback={null}>
            <FlowView />
          </Suspense>
        )}
      </div>

      {lspToast && (view === "code" || view === "flow" || (view === "projects" && inProject)) && (
        <div className="lsp-toast" role="status">
          <div>
            <strong>{lspToast.language === "rust" ? "Rust" : "TypeScript"} language server missing</strong>
            <span>
              Rush will use heuristic code search.
              {lspToast.installJob ? ` Install job started: ${lspToast.installJob}` : ""}
            </span>
          </div>
          <button onClick={() => installLanguageServer(lspToast.language)}>Install</button>
          <button className="ghost" onClick={() => openSettings("lsp")}>Settings</button>
          <button className="lsp-toast-close" onClick={() => dismissLspToast(lspToast.language)} aria-label="Dismiss LSP warning">
            x
          </button>
        </div>
      )}

      {showSettings && (
        <Suspense fallback={null}>
          <SettingsPanel onClose={() => setShowSettings(false)} initialTab={settingsTab} />
        </Suspense>
      )}
      {showBrain && (
        <Suspense fallback={null}>
          <BrainView onClose={() => setShowBrain(false)} />
        </Suspense>
      )}
      {showResearch && (
        <Suspense fallback={null}>
          <DeepResearchView onClose={() => setShowResearch(false)} onOpenLibrary={openResearchLibrary} />
        </Suspense>
      )}
      {showProjectSettings && (
        <Suspense fallback={null}>
          <ProjectSettings onClose={() => setShowProjectSettings(false)} />
        </Suspense>
      )}
      <ToastHost />
    </div>
  );
}
