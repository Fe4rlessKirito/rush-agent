import { lazy, Suspense, useState, useEffect } from "react";
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
const LibraryView = lazy(() => import("./components/LibraryView").then((m) => ({ default: m.LibraryView })));
const BrainView = lazy(() => import("./components/BrainView").then((m) => ({ default: m.BrainView })));
const DeepResearchView = lazy(() => import("./components/DeepResearchView").then((m) => ({ default: m.DeepResearchView })));
const WebProbingView = lazy(() => import("./components/WebProbingView").then((m) => ({ default: m.WebProbingView })));
const BugBountyView = lazy(() => import("./components/BugBountyView").then((m) => ({ default: m.BugBountyView })));
const FlowView = lazy(() => import("./components/FlowView").then((m) => ({ default: m.FlowView })));

type View = "chat" | "projects" | "library" | "flow" | "webProbing" | "bugBounty";
type SettingsTab = "general" | "providers" | "proxies" | "tools" | "packs" | "lsp" | "mcp";
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
  const [currentBranch] = useState("");
  const autoUpdateEnabled = useAppStore((s) => s.autoUpdateEnabled);
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const conversations = useAppStore((s) => s.conversations);
  const conversationProjectContext = useAppStore((s) => s.conversationProjectContext);
  const selectConversation = useAppStore((s) => s.selectConversation);
  const setConversationProjectContext = useAppStore((s) => s.setConversationProjectContext);
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
        : view === "bugBounty"
          ? "Bug Bounty"
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

        {view === "projects" && (
          <main className="chat-view">
            <div className="chat-center">
              <ChatPanel />
            </div>
          </main>
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

        {view === "bugBounty" && (
          <Suspense fallback={null}>
            <BugBountyView />
          </Suspense>
        )}


        {view === "flow" && (
          <Suspense fallback={null}>
            <FlowView />
          </Suspense>
        )}
      </div>


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
      <ToastHost />
    </div>
  );
}
