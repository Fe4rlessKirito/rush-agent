import type { Conversation } from "../../core/store";
import type { ResearchRun } from "../../core/researchStore";

interface ChatContextPickerProps {
  query: string;
  setQuery: (query: string) => void;
  conversations: Conversation[];
  researchRuns: ResearchRun[];
  close: () => void;
  addConversation: (conversation: Conversation) => void;
  addResearch: (run: ResearchRun) => void;
}

export function ChatContextPicker({
  query,
  setQuery,
  conversations,
  researchRuns,
  close,
  addConversation,
  addResearch,
}: ChatContextPickerProps) {
  return (
    <div className="context-picker-overlay" role="dialog" aria-modal="true" onMouseDown={close}>
      <div className="context-picker" onMouseDown={(e) => e.stopPropagation()}>
        <div className="context-picker-head">
          <div>
            <strong>Add Deep Research Context</strong>
            <span>Pick one Library chat or deep research run to attach to this turn.</span>
          </div>
          <button onClick={close} aria-label="Close context picker">x</button>
        </div>
        <label className="context-picker-search">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M16.5 16.5 21 21" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats and deep research..."
            autoFocus
          />
        </label>
        <div className="context-picker-list">
          {conversations.length > 0 && (
            <div className="context-picker-section-label">Chats</div>
          )}
          {conversations.map((conversation) => (
            <button key={`chat-${conversation.id}`} onClick={() => addConversation(conversation)}>
              <strong>{conversation.title}</strong>
              <span>{conversation.lines.length} messages</span>
            </button>
          ))}
          {researchRuns.length > 0 && (
            <div className="context-picker-section-label">Deep Research</div>
          )}
          {researchRuns.map((run) => (
            <button key={`research-${run.id}`} onClick={() => addResearch(run)}>
              <strong>{run.title}</strong>
              <span>{run.status} · {run.content ? `${run.content.length} chars` : "No report yet"}</span>
            </button>
          ))}
          {conversations.length === 0 && researchRuns.length === 0 && (
            <div className="context-picker-empty">No saved chats or deep research runs match this search.</div>
          )}
        </div>
      </div>
    </div>
  );
}
