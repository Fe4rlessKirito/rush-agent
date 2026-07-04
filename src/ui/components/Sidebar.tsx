import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../core/store";
import type { Conversation, ConversationProjectContext } from "../../core/store";
import { useProjectStore } from "../../core/projectStore";
import { chooseAndSetProjectRoot } from "../../core/projectRoot";
import { isTauriRuntime } from "../../core/agent/tauriFs";

type View = "chat" | "projects" | "library" | "flow";

interface Props {
  view: View;
  onSelectView: (v: View) => void;
  projectContext?: ConversationProjectContext | null;
  onOpenProject?: (id: string) => void;
  onOpenRoot?: () => void;
}

interface ProcessMemoryReport {
  total_bytes: number;
  processes: Array<{
    pid: number;
    name: string;
    memory_bytes: number;
  }>;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mib = bytes / 1024 / 1024;
  if (mib < 1024) return `${mib.toFixed(mib >= 100 ? 0 : 1)} MB`;
  return `${(mib / 1024).toFixed(2)} GB`;
}

export function Sidebar({ view, onSelectView, projectContext = null, onOpenProject, onOpenRoot }: Props) {
  const conversations = useAppStore((s) => s.conversations);
  const activeId = useAppStore((s) => s.activeConversationId);
  const newConversation = useAppStore((s) => s.newConversation);
  const selectConversation = useAppStore((s) => s.selectConversation);
  const deleteConversation = useAppStore((s) => s.deleteConversation);
  const projects = useProjectStore((s) => s.projects);
  const createProject = useProjectStore((s) => s.createProject);
  const renameProject = useProjectStore((s) => s.renameProject);
  const setProjectPath = useProjectStore((s) => s.setProjectPath);
  const newMode = view === "flow" ? "flow" : projectContext ? "agent" : "plain";
  const newLabel = newMode === "agent" ? "New task" : newMode === "flow" ? "New flow" : "New chat";
  const [memory, setMemory] = useState<ProcessMemoryReport | null>(null);
  const [openingFolder, setOpeningFolder] = useState(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let alive = true;
    async function refresh() {
      try {
        const report = await invoke<ProcessMemoryReport>("process_memory_status");
        if (alive) setMemory(report);
      } catch {
        if (alive) setMemory(null);
      }
    }
    refresh();
    const id = window.setInterval(refresh, 2000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const memoryTitle = useMemo(() => {
    if (!memory) return "RAM usage unavailable";
    const top = memory.processes
      .slice(0, 8)
      .map((process) => `${process.name} (${process.pid}): ${formatBytes(process.memory_bytes)}`)
      .join("\n");
    return [`Rush process tree RAM: ${formatBytes(memory.total_bytes)}`, top].filter(Boolean).join("\n");
  }, [memory]);

  const rootConversations = conversations
    .filter((conversation) => !conversation.projectId)
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);
  const projectGroups = projects.map((project) => ({
    project,
    conversations: conversations
      .filter((conversation) => conversation.projectId === project.id)
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt),
  }));

  const openFolder = async () => {
    if (openingFolder) return;
    setOpeningFolder(true);
    try {
      const picked = await chooseAndSetProjectRoot();
      if (!picked) return;
      const folderName = picked.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Project";
      const id = createProject(folderName);
      setProjectPath(id, picked);
      renameProject(id, folderName);
      onOpenProject?.(id);
    } finally {
      setOpeningFolder(false);
    }
  };

  const renderConversation = (c: Conversation) => (
    <div
      key={c.id}
      className={"sb-chat-row" + (c.id === activeId ? " active" : "")}
      onClick={() => {
        const mode = selectConversation(c.id);
        onSelectView(mode === "flow" ? "flow" : "chat");
      }}
      title={c.title}
    >
      <span className="sb-chat-title">{c.title}</span>
      <span className={"sb-chat-mode " + c.mode}>
        {c.mode === "agent" ? "Code" : c.mode === "flow" ? "Flow" : "Chat"}
      </span>
      <span
        className="sb-row-menu"
        onClick={(e) => {
          e.stopPropagation();
          deleteConversation(c.id);
        }}
        title="Delete chat"
      >
        x
      </span>
    </div>
  );

  const folderIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );

  return (
    <aside className="app-sidebar">
      <nav className="sb-nav">
        <button
          className="sb-item"
          onClick={() => {
            newConversation(newMode);
            onSelectView(projectContext ? "projects" : newMode === "flow" ? "flow" : "chat");
          }}
          title={newLabel}
        >
          <span className="sb-ico sb-ico-new">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </span>
          <span className="sb-label">{newLabel}</span>
        </button>

        <button
          className={"sb-item" + (view === "library" ? " active" : "")}
          onClick={() => onSelectView("library")}
          title="Library"
        >
          <span className="sb-ico sb-ico-library">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 4h10a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4V4Z" />
              <path d="M9 4v12a4 4 0 0 0 4 4" />
              <path d="M10 8h5M10 12h4" />
            </svg>
          </span>
          <span className="sb-label">Library</span>
        </button>
      </nav>

      <div className="sb-recents sb-project-groups">
        <div className="sb-recents-head sb-project-groups-head">
          <span>Projects</span>
          <button type="button" onClick={openFolder} disabled={openingFolder} title="Open folder">
            +
          </button>
        </div>
        <div className="sb-history">
          <section className="sb-project-group">
            <button
              type="button"
              className={"sb-project-head" + (!projectContext ? " active" : "")}
              onClick={() => {
                onOpenRoot?.();
                onSelectView("chat");
              }}
              title="Application root"
            >
              <span className="sb-project-icon">{folderIcon}</span>
              <span className="sb-project-name">rush-agent</span>
            </button>
            <div className="sb-project-conversations">
              {rootConversations.length === 0 ? (
                <div className="sb-empty-recents">Start a new chat</div>
              ) : (
                rootConversations.map(renderConversation)
              )}
            </div>
          </section>

          {projectGroups.map(({ project, conversations }) => (
            <section className="sb-project-group" key={project.id}>
              <button
                type="button"
                className={"sb-project-head" + (projectContext?.projectId === project.id ? " active" : "")}
                onClick={() => onOpenProject?.(project.id)}
                title={project.path || project.name}
              >
                <span className="sb-project-icon">{folderIcon}</span>
                <span className="sb-project-name">{project.name}</span>
              </button>
              <div className="sb-project-conversations">
                {conversations.map(renderConversation)}
              </div>
            </section>
          ))}
        </div>
      </div>

      <div className="sb-status-line" title={memoryTitle}>
        <span className="sb-version">v{__APP_VERSION__}</span>
        <span className="sb-ram">{memory ? formatBytes(memory.total_bytes) : "-- RAM"}</span>
      </div>
    </aside>
  );
}

export function getVisibleSidebarConversations(
  conversations: Conversation[],
  projectContext: ConversationProjectContext | null,
): Conversation[] {
  return conversations
    .filter((conversation) =>
      projectContext
        ? conversation.projectId === projectContext.projectId
        : true,
    )
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);
}
