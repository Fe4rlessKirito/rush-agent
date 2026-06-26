import { useState, useEffect } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { Sidebar } from "./components/Sidebar";
import { ProjectsView } from "./components/ProjectsView";
import { ProjectSettings } from "./components/ProjectSettings";
import { FileTree } from "./components/FileTree";
import { EditorTabs } from "./components/EditorTabs";
import { EditorPane } from "./components/EditorPane";
import { checkForUpdates } from "../core/updater";
import { useAppStore } from "../core/store";
import { useProjectStore } from "../core/projectStore";
import { useFileStore } from "../core/fileStore";
import appIcon from "../../src-tauri/icons/32x32.png";

type View = "chat" | "workspace";

export function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [showEditor, setShowEditor] = useState(true);
  const [view, setView] = useState<View>("chat");
  // Within the workspace view: land on the Projects screen, or open the editor.
  const [inProject, setInProject] = useState(false);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const autoUpdateEnabled = useAppStore((s) => s.autoUpdateEnabled);
  const openProject = useProjectStore((s) => s.openProject);
  const saveActiveFiles = useProjectStore((s) => s.saveActiveFiles);
  const activeProject = useProjectStore((s) =>
    s.projects.find((p) => p.id === s.activeProjectId),
  );

  // Open a project: load its files into the editor, then enter the workspace.
  const enterProject = (id: string) => {
    openProject(id);
    setInProject(true);
  };

  // Leave a project: snapshot the live files back into it first.
  const leaveProject = () => {
    saveActiveFiles();
    setInProject(false);
  };

  // Autosave: while inside a project, debounce-snapshot live file edits back
  // into the active project so a refresh mid-edit doesn't lose work.
  useEffect(() => {
    if (!inProject) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useFileStore.subscribe((state, prev) => {
      if (state.files === prev.files) return; // only react to file changes
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => saveActiveFiles(), 600);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
      saveActiveFiles(); // final flush on unmount/leave
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
        <button className="ghost" onClick={() => setShowSettings((s) => !s)}>
          {showSettings ? "Close" : "Settings"}
        </button>
      </header>

      <div className="app-body">
        <Sidebar view={view} onSelectView={setView} />

        {/* Chat view — Claude-style centered conversation. */}
        {view === "chat" && (
          <main className="chat-view">
            <div className="chat-center">
              <ChatPanel />
            </div>
          </main>
        )}

        {/* Workspace view — Projects landing, or the editor once in a project. */}
        {view === "workspace" && !inProject && (
          <ProjectsView onOpenProject={enterProject} />
        )}

        {view === "workspace" && inProject && (
          <div className="workspace">
            <aside className="sidebar">
              <button className="projects-back" onClick={leaveProject}>
                ← Projects
              </button>
              {activeProject && (
                <div className="project-name-tag">
                  <span>{activeProject.name}</span>
                  <button
                    className="project-settings-btn"
                    onClick={() => setShowProjectSettings(true)}
                    title="Project settings"
                    aria-label="Project settings"
                  >
                    ⚙
                  </button>
                </div>
              )}
              <FileTree />
            </aside>

            <aside className={"editor-panel dock-right" + (showEditor ? "" : " collapsed")}>
              <main className="editor">
                <EditorTabs />
                <div className="editor-surface">
                  <EditorPane />
                </div>
              </main>
            </aside>

            <button
              className="editor-fab dock-right"
              onClick={() => setShowEditor((v) => !v)}
              title={showEditor ? "Hide editor" : "Show editor"}
            >
              {showEditor ? "⟨/⟩ ✕" : "⟨/⟩"}
            </button>
          </div>
        )}
      </div>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showProjectSettings && (
        <ProjectSettings onClose={() => setShowProjectSettings(false)} />
      )}
    </div>
  );
}
