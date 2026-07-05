import { lazy, Suspense, useState, useEffect } from "react";
import type { LibraryFilter } from "./components/LibraryView";
import { ChatPanel } from "./components/ChatPanel";
import { AppTitlebar } from "./components/AppTitlebar";
import { Sidebar } from "./components/Sidebar";
import { ToastHost } from "./components/ToastHost";
import { checkForUpdates } from "../core/updater";
import { useAppStore, type ConversationMode } from "../core/store";

const SettingsPanel = lazy(() => import("./components/SettingsPanel").then((m) => ({ default: m.SettingsPanel })));
const LibraryView = lazy(() => import("./components/LibraryView").then((m) => ({ default: m.LibraryView })));
const BrainView = lazy(() => import("./components/BrainView").then((m) => ({ default: m.BrainView })));
const DeepResearchView = lazy(() => import("./components/DeepResearchView").then((m) => ({ default: m.DeepResearchView })));
const WebProbingView = lazy(() => import("./components/WebProbingView").then((m) => ({ default: m.WebProbingView })));
const FlowView = lazy(() => import("./components/FlowView").then((m) => ({ default: m.FlowView })));

type View = "chat" | "library" | "flow" | "webProbing";
type SettingsTab = "general" | "providers" | "proxies" | "tools" | "packs" | "lsp" | "mcp";

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
  const autoUpdateEnabled = useAppStore((s) => s.autoUpdateEnabled);
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const conversations = useAppStore((s) => s.conversations);
  const selectConversation = useAppStore((s) => s.selectConversation);
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const sessionTitle = activeConversation?.title && !activeConversation.title.startsWith("New ")
    ? activeConversation.title
    : view === "library"
      ? "Library"
      : view === "webProbing"
        ? "Web Probing"
        : view === "flow"
          ? "Flow"
          : "Untitled session";

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
    if (!autoUpdateEnabled) return;
    void checkForUpdates(true);
  }, [autoUpdateEnabled]);

  return (
    <div className="app">
      <AppTitlebar
        view={view}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((collapsed) => !collapsed)}
        sessionTitle={sessionTitle}
        projectName="Rush"
        branchName=""
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
        <Sidebar view={view} onSelectView={navigateView} />

        {view === "chat" && (
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
