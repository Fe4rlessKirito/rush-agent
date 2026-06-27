import { useState, useEffect } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { Sidebar } from "./components/Sidebar";
import { ProjectsView } from "./components/ProjectsView";
import { ProjectSettings } from "./components/ProjectSettings";
import { FileTree } from "./components/FileTree";
import { EditorTabs } from "./components/EditorTabs";
import { EditorPane } from "./components/EditorPane";
import { TerminalPanel } from "./components/TerminalPanel";
import { checkForUpdates } from "../core/updater";
import { useAppStore } from "../core/store";
import { useProjectStore } from "../core/projectStore";
import { useFileStore } from "../core/fileStore";
import { setDesktopProjectRoot } from "../core/projectRoot";
import appIcon from "../../src-tauri/icons/32x32.png";

type View = "chat" | "workspace" | "flow";

export function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [showEditor, setShowEditor] = useState(true);
  const [view, setView] = useState<View>("chat");
  const [inProject, setInProject] = useState(false);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const autoUpdateEnabled = useAppStore((s) => s.autoUpdateEnabled);
  const openProject = useProjectStore((s) => s.openProject);
  const saveActiveFiles = useProjectStore((s) => s.saveActiveFiles);
  const activeProject = useProjectStore((s) =>
    s.projects.find((p) => p.id === s.activeProjectId),
  );

  const enterProject = async (id: string) => {
    openProject(id);
    const project = useProjectStore.getState().projects.find((p) => p.id === id);
    if (project?.path) {
      await setDesktopProjectRoot(project.path).catch((err) => {
        console.warn("set_project_root failed", err);
      });
    }
    setInProject(true);
  };

  const leaveProject = () => {
    saveActiveFiles();
    setInProject(false);
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

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <img className="brand-mark" src={appIcon} alt="" aria-hidden="true" />
          <span className="brand-name">Rush</span>
        </div>
        <button
          className={"settings-cog-btn" + (showSettings ? " active" : "")}
          onClick={() => setShowSettings((s) => !s)}
          title={showSettings ? "Close settings" : "Settings"}
          aria-label={showSettings ? "Close settings" : "Settings"}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
            <path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.05.05a2.1 2.1 0 0 1-2.97 2.97l-.05-.05a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.09 1.65V21.3a2.1 2.1 0 0 1-4.2 0v-.07a1.8 1.8 0 0 0-1.09-1.65 1.8 1.8 0 0 0-1.98.36l-.05.05a2.1 2.1 0 1 1-2.97-2.97l.05-.05A1.8 1.8 0 0 0 4.6 15a1.8 1.8 0 0 0-1.65-1.09H2.7a2.1 2.1 0 0 1 0-4.2h.25A1.8 1.8 0 0 0 4.6 8.62a1.8 1.8 0 0 0-.36-1.98l-.05-.05A2.1 2.1 0 0 1 7.16 3.6l.05.05a1.8 1.8 0 0 0 1.98.36A1.8 1.8 0 0 0 10.28 2.36V2.3a2.1 2.1 0 0 1 4.2 0v.07a1.8 1.8 0 0 0 1.09 1.65 1.8 1.8 0 0 0 1.98-.36l.05-.05a2.1 2.1 0 0 1 2.97 2.97l-.05.05a1.8 1.8 0 0 0-.36 1.98 1.8 1.8 0 0 0 1.65 1.09h.19a2.1 2.1 0 0 1 0 4.2h-.19A1.8 1.8 0 0 0 19.4 15Z" />
          </svg>
        </button>
      </header>

      <div className="app-body">
        <Sidebar view={view} onSelectView={setView} />

        {view === "chat" && (
          <main className="chat-view">
            <div className="chat-center">
              <ChatPanel mode="plain" />
            </div>
          </main>
        )}

        {view === "workspace" && !inProject && (
          <ProjectsView onOpenProject={enterProject} />
        )}

        {view === "workspace" && inProject && (
          <div className="workspace code-workspace">
            <aside className="sidebar">
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
              <FileTree />
            </aside>

            <main className="code-agent-panel">
              <ChatPanel mode="agent" />
            </main>

            <aside className={"editor-panel dock-right" + (showEditor ? "" : " collapsed")}>
              <main className="editor">
                <EditorTabs />
                <div className="editor-surface">
                  <EditorPane />
                </div>
                <TerminalPanel />
              </main>
            </aside>

            <button
              className="editor-fab dock-right"
              onClick={() => setShowEditor((v) => !v)}
              title={showEditor ? "Hide editor" : "Show editor"}
            >
              {showEditor ? "Hide editor" : "Show editor"}
            </button>
          </div>
        )}

        {view === "flow" && (
          <main className="flow-view">
            <div className="flow-shell">
              <div className="flow-head">
                <span className="flow-title">Flow</span>
                <span className="flow-tag">multi-agent</span>
              </div>
              <div className="flow-agents" aria-label="Flow agents">
                <div className="flow-agent">
                  <span className="flow-agent-dot" />
                  <strong>Planner</strong>
                  <span>Idle</span>
                </div>
                <div className="flow-agent">
                  <span className="flow-agent-dot" />
                  <strong>Workers</strong>
                  <span>0 active</span>
                </div>
                <div className="flow-agent">
                  <span className="flow-agent-dot" />
                  <strong>Verifier</strong>
                  <span>Waiting</span>
                </div>
              </div>
              <div className="flow-composer">
                <textarea placeholder="Command multiple agents..." disabled />
                <button disabled>Start flow</button>
              </div>
            </div>
          </main>
        )}
      </div>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showProjectSettings && (
        <ProjectSettings onClose={() => setShowProjectSettings(false)} />
      )}
    </div>
  );
}
