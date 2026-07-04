import { lazy, Suspense, useState, useEffect } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChatPanel } from "./components/ChatPanel";
import { AppTitlebar } from "./components/AppTitlebar";
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
const WebProbingView = lazy(() => import("./components/WebProbingView").then((m) => ({ default: m.WebProbingView })));
const FlowView = lazy(() => import("./components/FlowView").then((m) => ({ default: m.FlowView })));
const ProjectSettings = lazy(() => import("./components/ProjectSettings").then((m) => ({ default: m.ProjectSettings })));
const EditorTabs = lazy(() => import("./components/EditorTabs").then((m) => ({ default: m.EditorTabs })));
const EditorPane = lazy(() => import("./components/EditorPane").then((m) => ({ default: m.EditorPane })));
const FileTree = lazy(() => import("./components/FileTree").then((m) => ({ default: m.FileTree })));
const TerminalPanel = lazy(() => import("./components/TerminalPanel").then((m) => ({ default: m.TerminalPanel })));

type View = "chat" | "projects" | "library" | "flow" | "webProbing";
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
  const [view, setViewState] = useState<View>("chat");
  const [viewHistory, setViewHistory] = useState<View[]>(["chat"]);
  const [viewHistoryIndex, setViewHistoryIndex] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inProject, setInProject] = useState(false);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [projectPaneWidths, setProjectPaneWidths] = useState({
    ai: 420,
  });
  const [projectAiMode, setProjectAiMode] = useState<ProjectAiMode>("agent");
  const [projectEditorMinimized, setProjectEditorMinimized] = useState(false);
  const [showProjectExplorer, setShowProjectExplorer] = useState(true);
  const [lspToast, setLspToast] = useState<LspToast | null>(null);
  const [currentBranch, setCurrentBranch] = useState("");
  const [dismissedLspToasts, setDismissedLspToasts] = useState<Set<string>>(() => new Set());
  const autoUpdateEnabled = useAppStore((s) => s.autoUpdateEnabled);
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const conversations = useAppStore((s) => s.conversations);
  const conversationProjectContext = useAppStore((s) => s.conversationProjectContext);
  const selectConversation = useAppStore((s) => s.selectConversation);
  const setConversationProjectContext = useAppStore((s) => s.setConversationProjectContext);
  const chatMode = useAppStore((s) => s.chatMode);
  const openProject = useProjectStore((s) => s.openProject);
  const saveActiveFiles = useProjectStore((s) => s.saveActiveFiles);
  const activeProject = useProjectStore((s) =>
    s.projects.find((p) => p.id === s.activeProjectId),
  );
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const sessionTitle = activeConversation?.title && !activeConversation.title.startsWith("New ")
    ? activeConversation.title
    : view === "library"
      ? "Library"
      : view === "projects"
        ? "Projects"
        : view === "webProbing"
          ? "Web Probing"
          : view === "flow"
            ? "Flow"
            : "Untitled session";
  const titlebarProjectName = activeProject?.name || conversationProjectContext?.projectName || activeConversation?.projectName || "rush-agent";

  const navigateView = (next: View) => {
    setViewState((current) => {
      if (current === next) return current;
      setViewHistory((history) => {
        const trimmed = history.slice(0, viewHistoryIndex + 1);
        setViewHistoryIndex(trimmed.length);
        return [...trimmed, next];
      });
      return next;
    });
  };

  const goBack = () => {
    setViewHistoryIndex((index) => {
      const next = Math.max(0, index - 1);
      setViewState(viewHistory[next] ?? "chat");
      return next;
    });
  };

  const goForward = () => {
    setViewHistoryIndex((index) => {
      const next = Math.min(viewHistory.length - 1, index + 1);
      setViewState(viewHistory[next] ?? "chat");
      return next;
    });
  };

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
    navigateView(selectedMode === "flow" ? "flow" : "chat");
  };

  const openResearchLibrary = () => {
    setLibraryFilter("research");
    navigateView("library");
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
    const root = normalizeProjectRoot(activeProject?.path ?? conversationProjectContext?.projectRoot ?? "");
    if (!root) {
      setCurrentBranch("");
      return;
    }
    let cancelled = false;
    invoke<string>("git_current_branch")
      .then((branch) => {
        if (!cancelled) setCurrentBranch(branch.trim());
      })
      .catch(() => {
        if (!cancelled) setCurrentBranch("");
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject?.path, conversationProjectContext?.projectRoot]);

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
      <AppTitlebar
        view={view}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((collapsed) => !collapsed)}
        sessionTitle={sessionTitle}
        projectName={titlebarProjectName}
        branchName={currentBranch}
        canGoBack={viewHistoryIndex > 0}
        canGoForward={viewHistoryIndex < viewHistory.length - 1}
        onBack={goBack}
        onForward={goForward}
        showResearch={showResearch}
        onToggleResearch={() => setShowResearch((s) => !s)}
        showBrain={showBrain}
        onToggleBrain={() => setShowBrain((s) => !s)}
        showSettings={showSettings}
        onToggleSettings={() => {
          setSettingsTab("general");
          setShowSettings((s) => !s);
        }}
      />

      <div className={"app-body" + (sidebarCollapsed ? " sidebar-collapsed" : "")}>
        <Sidebar
          view={view}
          onSelectView={navigateView}
          onOpenProject={enterProject}
          onOpenRoot={leaveProject}
          projectContext={inProject && activeProject ? {
            projectId: activeProject.id,
            projectRoot: normalizeProjectRoot(activeProject.path),
            projectName: activeProject.name,
          } : null}
        />

        {view === "chat" && (
          <main className="chat-view">
            <div className="chat-center">
              <ChatPanel />
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

        {view === "webProbing" && (
          <Suspense fallback={null}>
            <WebProbingView />
          </Suspense>
        )}

        {view === "projects" && inProject && (
          <div className="workspace project-workspace">
            {showProjectExplorer && (
              <aside className="project-explorer">
                <Suspense fallback={null}>
                  <FileTree onClose={() => setShowProjectExplorer(false)} />
                </Suspense>
              </aside>
            )}
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
                      Chat
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
                    <ChatPanel />
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

      {lspToast && ((view === "chat" && chatMode === "agent") || view === "flow" || (view === "projects" && inProject)) && (
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
