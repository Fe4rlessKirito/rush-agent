import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../core/store";
import type { Conversation } from "../../core/store";
import { isTauriRuntime } from "../../core/agent/tauriFs";

type View = "chat" | "library" | "flow" | "webProbing";

interface Props {
  view: View;
  onSelectView: (v: View) => void;
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

export function Sidebar({ view, onSelectView }: Props) {
  const conversations = useAppStore((s) => s.conversations);
  const subagentRuns = useAppStore((s) => s.subagentRuns);
  const activeSubagentRunId = useAppStore((s) => s.activeSubagentRunId);
  const selectSubagentRun = useAppStore((s) => s.selectSubagentRun);
  const activeId = useAppStore((s) => s.activeConversationId);
  const newConversation = useAppStore((s) => s.newConversation);
  const selectConversation = useAppStore((s) => s.selectConversation);
  const deleteConversation = useAppStore((s) => s.deleteConversation);
  const newMode = view === "flow" ? "flow" : "plain";
  const newLabel = newMode === "flow" ? "New flow" : "New chat";
  const [memory, setMemory] = useState<ProcessMemoryReport | null>(null);
  const [openSubagentParents, setOpenSubagentParents] = useState<Record<string, boolean>>({});

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

  const visibleConversations = conversations
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);

  const renderConversation = (c: Conversation) => {
    const children = subagentRuns
      .filter((run) => run.parentConversationId === c.id)
      .sort((a, b) => b.createdAt - a.createdAt);
    const expanded = openSubagentParents[c.id] ?? children.length > 0;
    return (
      <div key={c.id} className="sb-chat-wrap">
        <div
          className={"sb-chat-row" + (c.id === activeId ? " active" : "")}
          onClick={() => {
            const mode = selectConversation(c.id);
            selectSubagentRun(null);
            onSelectView(mode === "flow" ? "flow" : "chat");
          }}
          title={c.title}
        >
          {children.length > 0 && (
            <button
              type="button"
              className="sb-subagent-toggle"
              onClick={(e) => {
                e.stopPropagation();
                setOpenSubagentParents((items) => ({ ...items, [c.id]: !expanded }));
              }}
              title="Show subagents"
            >
              {expanded ? "v" : ">"}
            </button>
          )}
          <span className="sb-chat-title">{c.title}</span>
          <span className={"sb-chat-mode " + c.mode}>
            {c.mode === "agent" ? "Code" : c.mode === "flow" ? "Flow" : "Chat"}
          </span>
          <button
            type="button"
            className="sb-row-remove"
            onClick={(e) => {
              e.stopPropagation();
              deleteConversation(c.id);
            }}
            title="Delete chat"
            aria-label={`Delete ${c.title}`}
          >
            x
          </button>
        </div>
        {expanded && children.length > 0 && (
          <div className="sb-subagent-list">
            {children.map((run) => (
              <button
                key={run.id}
                type="button"
                className={"sb-subagent-row" + (run.id === activeSubagentRunId ? " active" : "")}
                onClick={() => {
                  selectConversation(c.id);
                  selectSubagentRun(run.id);
                  onSelectView("chat");
                }}
                title={run.task}
              >
                <span className={"sb-subagent-dot " + run.status} />
                <span className="sb-subagent-title">{run.title}</span>
                <span className="sb-chat-mode subagent">Subagent</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="app-sidebar">
      <nav className="sb-nav">
        <button
          className="sb-item"
          onClick={() => {
            newConversation(newMode);
            onSelectView(newMode === "flow" ? "flow" : "chat");
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

        <button
          className={"sb-item" + (view === "webProbing" ? " active" : "")}
          onClick={() => onSelectView("webProbing")}
          title="Web Probing"
        >
          <span className="sb-ico sb-ico-web-probing">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="8" />
              <path d="M4 12h16M12 4a12 12 0 0 1 0 16M12 4a12 12 0 0 0 0 16" />
              <path d="m15.5 15.5 3 3" />
            </svg>
          </span>
          <span className="sb-label">Web Probing</span>
        </button>
      </nav>

      <div className="sb-recents">
        <div className="sb-recents-head">
          <span>Chats</span>
        </div>
        <div className="sb-history">
          {visibleConversations.length === 0 ? (
            <div className="sb-empty-recents">Start a new chat</div>
          ) : (
            visibleConversations.map(renderConversation)
          )}
        </div>
      </div>

      <div className="sb-status-line" title={memoryTitle}>
        <span className="sb-version">v{__APP_VERSION__}</span>
        <span className="sb-ram">{memory ? formatBytes(memory.total_bytes) : "-- RAM"}</span>
      </div>
    </aside>
  );
}

export function getVisibleSidebarConversations(conversations: Conversation[]): Conversation[] {
  return conversations
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);
}
