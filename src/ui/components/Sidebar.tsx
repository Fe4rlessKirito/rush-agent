import { useAppStore } from "../../core/store";

type View = "chat" | "code" | "projects" | "library" | "flow";

interface Props {
  view: View;
  onSelectView: (v: View) => void;
}

export function Sidebar({ view, onSelectView }: Props) {
  const conversations = useAppStore((s) => s.conversations);
  const activeId = useAppStore((s) => s.activeConversationId);
  const newConversation = useAppStore((s) => s.newConversation);
  const selectConversation = useAppStore((s) => s.selectConversation);
  const deleteConversation = useAppStore((s) => s.deleteConversation);

  return (
    <aside className="app-sidebar">
      <nav className="sb-nav">
        <button
          className="sb-item"
          onClick={() => {
            const mode = view === "code" ? "agent" : view === "flow" ? "flow" : "plain";
            newConversation(mode);
            onSelectView(mode === "agent" ? "code" : mode === "flow" ? "flow" : "chat");
          }}
          title={view === "code" ? "New task" : view === "flow" ? "New flow" : "New chat"}
        >
          <span className="sb-ico sb-ico-new">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </span>
          <span className="sb-label">{view === "code" ? "New task" : view === "flow" ? "New flow" : "New chat"}</span>
        </button>

        <button
          className={"sb-item" + (view === "chat" ? " active" : "")}
          onClick={() => onSelectView("chat")}
          title="Chats"
        >
          <span className="sb-ico sb-ico-chats">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 11.5a8.5 8.5 0 0 1-9.5 8.4L7 21l1-3.2A8.5 8.5 0 1 1 21 11.5z" />
            </svg>
          </span>
          <span className="sb-label">Chats</span>
        </button>

        <button
          className={"sb-item" + (view === "projects" ? " active" : "")}
          onClick={() => onSelectView("projects")}
          title="Projects"
        >
          <span className="sb-ico sb-ico-projects">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path className="folder-lid" d="M3 7V6a2 2 0 0 1 2-2h4l2 3" />
              <rect x="3" y="7" width="18" height="13" rx="2" />
            </svg>
          </span>
          <span className="sb-label">Projects</span>
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

      <div className="sb-recents">
        <div className="sb-recents-head">Recents</div>
        <div className="sb-history">
          {conversations.length === 0 ? (
            <div className="sb-empty-recents">Start a new chat</div>
          ) : (
            conversations.map((c) => (
              <div
                key={c.id}
                className={"sb-chat-row" + (c.id === activeId ? " active" : "")}
                onClick={() => {
                  const mode = selectConversation(c.id);
                  onSelectView(mode === "agent" ? "code" : mode === "flow" ? "flow" : "chat");
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
            ))
          )}
        </div>
      </div>

      <div className="sb-version">v{__APP_VERSION__}</div>
    </aside>
  );
}
