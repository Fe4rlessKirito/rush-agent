import { useMemo, useState } from "react";
import { useAppStore, type Conversation, type ConversationMode } from "../../core/store";
import { useResearchStore, type ResearchRun } from "../../core/researchStore";

interface Props {
  onOpenConversation: (id: string, mode: ConversationMode) => void;
  filter: LibraryFilter;
  onFilterChange: (filter: LibraryFilter) => void;
}

type SortBy = "updated" | "title" | "mode";
export type LibraryFilter = "chats" | "research";

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return day === 1 ? "yesterday" : `${day}d ago`;
}

function modeLabel(mode: ConversationMode): string {
  if (mode === "agent") return "Code";
  if (mode === "flow") return "Flow";
  return "Chat";
}

function modeIcon(mode: ConversationMode) {
  if (mode === "flow") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="6" cy="12" r="2" />
        <circle cx="18" cy="6" r="2" />
        <circle cx="18" cy="18" r="2" />
        <path d="M8 12h3a3 3 0 0 0 3-3V8" />
        <path d="M8 12h3a3 3 0 0 1 3 3v1" />
      </svg>
    );
  }
  if (mode === "agent") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="5" width="16" height="14" rx="2" />
        <path d="M8 9h8M8 13h5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.5 8.5 0 0 1-9.5 8.4L7 21l1-3.2A8.5 8.5 0 1 1 21 11.5z" />
    </svg>
  );
}

function sortItems(items: Conversation[], sortBy: SortBy): Conversation[] {
  return items.slice().sort((a, b) => {
    if (sortBy === "title") return a.title.localeCompare(b.title);
    if (sortBy === "mode") return a.mode.localeCompare(b.mode) || b.createdAt - a.createdAt;
    return b.createdAt - a.createdAt;
  });
}

export function LibraryView({ onOpenConversation, filter, onFilterChange }: Props) {
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("updated");
  const [selectedRun, setSelectedRun] = useState<ResearchRun | null>(null);
  const conversations = useAppStore((s) => s.conversations);
  const deleteConversation = useAppStore((s) => s.deleteConversation);
  const researchRuns = useResearchStore((s) => s.runs);
  const deleteRun = useResearchStore((s) => s.deleteRun);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (filter === "research") return [];
    const filtered = conversations.filter((item) => {
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        modeLabel(item.mode).toLowerCase().includes(q) ||
        item.lines.some((line) => line.text.toLowerCase().includes(q))
      );
    });
    return sortItems(filtered, sortBy);
  }, [conversations, filter, query, sortBy]);

  const visibleResearch = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = researchRuns.filter((run) => {
      if (!q) return true;
      return (
        run.title.toLowerCase().includes(q) ||
        run.prompt.toLowerCase().includes(q) ||
        run.content.toLowerCase().includes(q) ||
        run.status.toLowerCase().includes(q)
      );
    });
    return filtered.slice().sort((a, b) => {
      if (sortBy === "title") return a.title.localeCompare(b.title);
      if (sortBy === "mode") return a.status.localeCompare(b.status) || b.updatedAt - a.updatedAt;
      return b.updatedAt - a.updatedAt;
    });
  }, [query, researchRuns, sortBy]);

  const nextSort = () => setSortBy((current) => (current === "updated" ? "title" : current === "title" ? "mode" : "updated"));

  return (
    <div className="library-view">
      <div className="library-inner">
        <div className="library-header">
          <h1 className="library-title">Library</h1>
          <div className="library-actions">
            <button className="library-sort" onClick={nextSort} title="Toggle sort">
              Sort by <strong>{sortBy === "updated" ? "Last updated" : sortBy === "title" ? "Title" : "Type"}</strong>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>
        </div>

        <div className="library-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <line x1="16.5" y1="16.5" x2="21" y2="21" />
          </svg>
          <input
            type="text"
            placeholder={filter === "research" ? "Search deep research..." : "Search chats..."}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="library-filter" aria-label="Library filter">
            <button
              className={filter === "chats" ? "active" : ""}
              onClick={() => onFilterChange("chats")}
            >
              Chats
            </button>
            <button
              className={filter === "research" ? "active" : ""}
              onClick={() => onFilterChange("research")}
            >
              Deep Research
            </button>
          </div>
        </div>

        {filter === "research" && researchRuns.length > 0 ? (
          <div className="library-grid">
            {visibleResearch.map((run) => (
              <div
                key={run.id}
                className="library-card"
                onClick={() => setSelectedRun(run)}
              >
                <div className="library-card-top">
                  <span className="library-card-icon research">{modeIcon("flow")}</span>
                  <button
                    className="library-card-del"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteRun(run.id);
                    }}
                    title="Delete research run"
                  >
                    x
                  </button>
                </div>
                <div className="library-card-name">{run.title}</div>
                <div className="library-card-meta">
                  Deep Research · {run.status} · {run.sources.length} sources · {relTime(run.updatedAt)}
                </div>
              </div>
            ))}
            {visibleResearch.length === 0 && (
              <div className="library-noresults">No deep research runs match "{query}".</div>
            )}
          </div>
        ) : filter === "research" ? (
          <div className="library-empty">
            <div className="library-empty-icon">
              <svg viewBox="0 0 80 80" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round">
                <circle cx="34" cy="34" r="14" />
                <path d="m45 45 14 14" />
                <path d="M34 26v16M26 34h16" />
              </svg>
            </div>
            <div className="library-empty-title">No deep research runs yet.</div>
            <p className="library-empty-text">
              Finished research runs will appear here once Deep Research is connected to saved run history.
            </p>
          </div>
        ) : conversations.length > 0 ? (
          <div className="library-grid">
            {visible.map((item) => (
              <div
                key={item.id}
                className="library-card"
                onClick={() => onOpenConversation(item.id, item.mode)}
              >
                <div className="library-card-top">
                  <span className={`library-card-icon ${item.mode}`}>{modeIcon(item.mode)}</span>
                  <button
                    className="library-card-del"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteConversation(item.id);
                    }}
                    title="Delete library item"
                  >
                    x
                  </button>
                </div>
                <div className="library-card-name">{item.title}</div>
                <div className="library-card-meta">
                  {modeLabel(item.mode)} · {item.lines.length} messages · {relTime(item.createdAt)}
                </div>
              </div>
            ))}
            {visible.length === 0 && (
              <div className="library-noresults">No chats match "{query}".</div>
            )}
          </div>
        ) : (
          <div className="library-empty">
            <div className="library-empty-icon">
              <svg viewBox="0 0 80 80" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round">
                <path d="M18 16h32a8 8 0 0 1 8 8v40H26a8 8 0 0 1-8-8V16Z" />
                <path d="M26 16v40a8 8 0 0 0 8 8" />
                <path d="M32 28h18M32 38h14" />
              </svg>
            </div>
            <div className="library-empty-title">Your saved work will live here.</div>
            <p className="library-empty-text">
              Chats, code tasks, flow runs, and research notes collect in one searchable place.
            </p>
          </div>
        )}
        {selectedRun && (
          <div className="library-preview-overlay" onMouseDown={() => setSelectedRun(null)}>
            <div className="library-preview" onMouseDown={(e) => e.stopPropagation()}>
              <div className="library-preview-head">
                <div>
                  <strong>{selectedRun.title}</strong>
                  <span>{selectedRun.status} · {relTime(selectedRun.updatedAt)}</span>
                </div>
                <button onClick={() => setSelectedRun(null)} aria-label="Close research preview">x</button>
              </div>
              <div className="library-preview-body">
                {selectedRun.sources.length > 0 && (
                  <div className="library-preview-sources">
                    <strong>Sources</strong>
                    {selectedRun.sources.map((source, index) => (
                      <a key={`${source.url}-${index}`} href={source.url || undefined} target="_blank" rel="noreferrer">
                        {index + 1}. {source.title || source.url || source.source}
                      </a>
                    ))}
                  </div>
                )}
                {selectedRun.error ? (
                  <p className="library-preview-error">{selectedRun.error}</p>
                ) : (
                  <pre>{selectedRun.content || selectedRun.prompt}</pre>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
