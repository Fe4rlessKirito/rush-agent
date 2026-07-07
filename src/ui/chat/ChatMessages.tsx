import type { ChatLine } from "../../core/store";
import { modelDisplayName } from "../../core/providers/modelGroups";
import {
  activityGroupLabel,
  compactToolAction,
  elapsedLabel,
  fileEditReviewItems,
  fileEditReviewSummary,
  formatElapsed,
  type ToolActivityDisplay,
  type RenderedChatItem,
} from "./chatPanelHelpers";
import { Markdown } from "../components/Markdown";

const THINKING_PREVIEW_CHARS = 600;

function ActivityIcon({ kind }: { kind: ToolActivityDisplay["kind"] }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {kind === "explore" && <><circle {...common} cx="10.5" cy="10.5" r="5.5" /><path {...common} d="m15 15 4 4" /></>}
      {kind === "edit" && <><path {...common} d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z" /><path {...common} d="m14 7 3 3" /></>}
      {kind === "run" && <><path {...common} d="m8 5 10 7-10 7z" /></>}
      {kind === "web" && <><circle {...common} cx="12" cy="12" r="8" /><path {...common} d="M4 12h16M12 4a12 12 0 0 1 0 16M12 4a12 12 0 0 0 0 16" /></>}
      {kind === "mode" && <><path {...common} d="M7 7h10v10H7z" /><path {...common} d="M4 12h3M17 12h3M12 4v3M12 17v3" /></>}
      {(kind === "read" || kind === "done" || kind === "other") && <><path {...common} d="M7 3h7l4 4v14H7z" /><path {...common} d="M14 3v5h5" /></>}
    </svg>
  );
}

function thinkingPreview(text: string): string {
  const clean = text
    .slice(0, THINKING_PREVIEW_CHARS)
    .replace(/[`*_>#-]/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!clean) return "Thinking...";
  return clean.length > 72 ? `Thinking about ${clean.slice(0, 72)}...` : `Thinking about ${clean}`;
}

interface ChatMessagesProps {
  renderedItems: RenderedChatItem[];
  hiddenMessageCount: number;
  busy: boolean;
  activeSubagent: unknown;
  chatLength: number;
  activeRunStartedAt: number | null;
  elapsedNow: number;
  activeModel: string | null;
  openOverride: Record<number, boolean>;
  setOpenOverride: React.Dispatch<React.SetStateAction<Record<number, boolean>>>;
  onShowAllMessages: () => void;
}

export function ChatMessages({
  renderedItems,
  hiddenMessageCount,
  busy,
  activeSubagent,
  chatLength,
  activeRunStartedAt,
  elapsedNow,
  activeModel,
  openOverride,
  setOpenOverride,
  onShowAllMessages,
}: ChatMessagesProps) {
  const isOpen = (line: ChatLine, i: number): boolean => {
    if (i in openOverride) return openOverride[i];
    return !line.text.trim();
  };

  return (
    <div className="messages">
      {hiddenMessageCount > 0 && (
        <button className="messages-window-notice" onClick={onShowAllMessages}>
          Show {hiddenMessageCount} older message{hiddenMessageCount === 1 ? "" : "s"}
        </button>
      )}
      {renderedItems.map((item) => {
        if (item.type === "user" && item.user) {
          return (
            <div key={item.startIndex} className="msg user">
              <Markdown>{item.user.text}</Markdown>
            </div>
          );
        }

        const lines = item.lines ?? [];
        const activityLines = lines.filter(({ line }) => line.role === "tool" && line.text.trim());
        const activityItems = activityLines.map(({ line, index }) => ({ line, index, display: compactToolAction(line.text) }));
        const answerLines = lines.filter(({ line, index }) => {
          const isActiveEmptyAgent =
            busy && index === chatLength - 1 && line.role === "agent" && !line.text.trim() && !line.thinking?.trim();
          return line.role === "agent" && (line.text.trim() || line.thinking?.trim() || isActiveEmptyAgent);
        });
        const isActiveRun = busy && !activeSubagent && lines.some(({ index }) => index === chatLength - 1);
        const timedLine = [...lines].reverse().find(({ line }) => line.meta?.startedAt || line.meta?.completedAt)?.line;
        const runStatusLabel = isActiveRun && activeRunStartedAt
          ? `Working for ${formatElapsed(elapsedNow - activeRunStartedAt)}`
          : elapsedLabel(timedLine?.meta?.startedAt, timedLine?.meta?.completedAt, "Worked");
        const editReviewItems = fileEditReviewItems(lines);
        const editReviewSummary = fileEditReviewSummary(editReviewItems);
        if (activityLines.length === 0 && answerLines.length === 0 && editReviewItems.length === 0 && !isActiveRun) return null;

        return (
          <div key={item.startIndex} className={"agent-run" + (isActiveRun ? " active" : "") }>
            <div className="agent-run-head">
              <span className="agent-run-model">{lines.find(({ line }) => line.meta?.modelLabel || line.meta?.speaker)?.line.meta?.modelLabel ?? lines.find(({ line }) => line.meta?.speaker)?.line.meta?.speaker ?? (activeModel ? modelDisplayName(activeModel) : "Rush")}</span>
              <span className="agent-run-status">{runStatusLabel}</span>
            </div>

            {activityItems.length > 0 && (
              <details className="agent-activity-details" open={isActiveRun}>
                <summary>
                  <span className="agent-activity-summary-icon"><ActivityIcon kind={activityGroupLabel(activityItems.map((item) => item.display)).kind} /></span>
                  <span className="agent-activity-summary-label">{activityGroupLabel(activityItems.map((item) => item.display)).action}</span>
                  <span className="agent-activity-dot">•</span>
                  <span className="agent-activity-summary-count">{activityGroupLabel(activityItems.map((item) => item.display)).count}</span>
                  {isActiveRun && <span className="agent-activity-summary-status">running</span>}
                </summary>
                <div className="agent-activity-list">
                  {activityItems.map(({ line, index, display }) => (
                    <details key={index} className={`agent-activity-row ${display.kind}`}>
                      <summary>
                        <span className="agent-activity-action">{display.action}</span>
                        {display.badge && <span className={`agent-file-badge ${display.badge}`}>{display.badge.slice(0, 4)}</span>}
                        <span className="agent-activity-title">{display.title}</span>
                        {display.detail && <span className="agent-activity-detail">{display.detail}</span>}
                      </summary>
                      <div className="agent-activity-detail-body">
                        <Markdown>{line.text}</Markdown>
                      </div>
                    </details>
                  ))}
                </div>
              </details>
            )}

            {answerLines.map(({ line, index }) => {
              const isActiveEmptyAgent =
                busy && index === chatLength - 1 && line.role === "agent" && !line.text.trim() && !line.thinking?.trim();
              const thinkingOpen = Boolean(line.thinking?.trim()) && isOpen(line, index);
              return (
                <div key={index} className="agent-run-message">
                  {isActiveEmptyAgent && (
                    <div className="thinking-status">
                      <span className="thinking-pulse" aria-hidden="true" />
                      <span>Thinking...</span>
                    </div>
                  )}
                  {line.thinking && line.thinking.trim() && (
                    <>
                      {!line.text.trim() && (
                        <div className="thinking-status">
                          <span className="thinking-pulse" aria-hidden="true" />
                          <span>{thinkingPreview(line.thinking)}</span>
                        </div>
                      )}
                      <details
                        className="thinking-block"
                        open={thinkingOpen}
                        onToggle={(e) =>
                          setOpenOverride((o) => ({ ...o, [index]: (e.target as HTMLDetailsElement).open }))
                        }
                      >
                        <summary>Thinking</summary>
                        {thinkingOpen && <Markdown>{line.thinking}</Markdown>}
                      </details>
                    </>
                  )}
                  {line.text.trim() && <Markdown>{line.text}</Markdown>}
                </div>
              );
            })}

            {editReviewItems.length > 0 && !isActiveRun && (
              <details className="agent-edit-review">
                <summary>
                  <span className="agent-edit-review-icon"><ActivityIcon kind="edit" /></span>
                  <span className="agent-edit-review-label">{editReviewSummary.label}</span>
                  {(editReviewSummary.added > 0 || editReviewSummary.removed > 0) && (
                    <>
                      <span className="agent-edit-review-added">+{editReviewSummary.added}</span>
                      <span className="agent-edit-review-removed">-{editReviewSummary.removed}</span>
                    </>
                  )}
                </summary>
                <div className="agent-edit-review-list">
                  {editReviewItems.map((edit) => (
                    <details key={edit.key} className="agent-edit-review-row">
                      <summary>
                        <span className={`agent-file-badge ${edit.ext}`}>{edit.ext.slice(0, 4)}</span>
                        <span className="agent-edit-review-file">{edit.name}</span>
                        {edit.dir && <span className="agent-edit-review-dir">{edit.dir}</span>}
                        {(edit.added > 0 || edit.removed > 0) && (
                          <span className="agent-edit-review-stats">
                            <span className="agent-edit-review-added">+{edit.added}</span>
                            <span className="agent-edit-review-removed">-{edit.removed}</span>
                          </span>
                        )}
                      </summary>
                      <div className="agent-edit-review-body">
                        <button type="button">Review</button>
                        <button type="button">Open</button>
                        <code>{edit.path}</code>
                      </div>
                    </details>
                  ))}
                </div>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
