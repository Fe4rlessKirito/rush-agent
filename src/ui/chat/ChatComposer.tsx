import type { RefObject } from "react";
import { EFFORT_TIERS } from "../../core/effort";
import { modelDisplayName, type ModelGroup } from "../../core/providers/modelGroups";
import type { PackCatalogCommand } from "../../core/packs/packCatalog";
import type { Attachment } from "./chatAttachments";
import { extensionOf } from "./chatAttachments";
import { PERMISSION_PRESETS, type PermissionPreset } from "./chatPanelHelpers";
import type { LibraryContextItem } from "./libraryContext";

interface ChatComposerProps {
  showProjectSelector: boolean;
  projectChipTitle: string;
  projectChipLabel: string;
  busy: boolean;
  openProjectRoot: () => void;
  attachments: Attachment[];
  previewAttachment: (attachment: Attachment) => void;
  removeAttachment: (id: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  fileRef: RefObject<HTMLInputElement>;
  input: string;
  setInput: (value: string) => void;
  isAgentMode: boolean;
  isFlow: boolean;
  packCommandSuggestions: PackCatalogCommand[];
  selectedPackCommandIndex: number;
  setSelectedPackCommandIndex: React.Dispatch<React.SetStateAction<number>>;
  completePackCommand: (name: string) => void;
  contextItems: LibraryContextItem[];
  removeContextItem: (item: LibraryContextItem) => void;
  attachmentAccept?: string;
  onPickFile: (event: React.ChangeEvent<HTMLInputElement>) => void;
  permissionPreset: PermissionPreset;
  showPermissionMenu: boolean;
  setShowPermissionMenu: React.Dispatch<React.SetStateAction<boolean>>;
  applyPermissionPreset: (preset: PermissionPreset) => void;
  openContextPicker: () => void;
  contextWindowTitle: string;
  contextWindowPercent: number;
  contextWindowLabel: string;
  contextWindowTokens: number;
  contextWindowLimit: number;
  modelGroups: ModelGroup[];
  activeModel: string | null;
  activeProviderId: string | null;
  setActive: (providerId: string, model: string) => void;
  effort: number;
  setEffort: (effort: number) => void;
  send: () => void;
  cancel: () => void;
}

function attachmentTypeLabel(item: Attachment): string {
  if (item.dataUrl) return "Image";
  const ext = extensionOf(item.name).toUpperCase();
  return ext || "File";
}

function attachmentFileIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 3h6l4 4v14H7z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M13 3v5h5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

export function ChatComposer({
  showProjectSelector,
  projectChipTitle,
  projectChipLabel,
  busy,
  openProjectRoot,
  attachments,
  previewAttachment,
  removeAttachment,
  textareaRef,
  fileRef,
  input,
  setInput,
  isAgentMode,
  isFlow,
  packCommandSuggestions,
  selectedPackCommandIndex,
  setSelectedPackCommandIndex,
  completePackCommand,
  contextItems,
  removeContextItem,
  attachmentAccept,
  onPickFile,
  permissionPreset,
  showPermissionMenu,
  setShowPermissionMenu,
  applyPermissionPreset,
  openContextPicker,
  contextWindowTitle,
  contextWindowPercent,
  contextWindowLabel,
  contextWindowTokens,
  contextWindowLimit,
  modelGroups,
  activeModel,
  activeProviderId,
  setActive,
  effort,
  setEffort,
  send,
  cancel,
}: ChatComposerProps) {
  return (
    <div className="composer">
      {showProjectSelector && (
        <div className="composer-context-bar">
          <button type="button" className="composer-project-chip" title={projectChipTitle} onClick={openProjectRoot} disabled={busy}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 7V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <span>{projectChipLabel}</span>
            <svg viewBox="0 0 24 24" aria-hidden="true" className="composer-chip-caret">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="attachment-tray" aria-label="Attachments">
          {attachments.map((item) => (
            <div className="attachment-preview" key={item.id} title={item.name}>
              <div className="attachment-preview-media">
                {item.dataUrl ? (
                  <button
                    type="button"
                    className="attachment-preview-button"
                    onClick={() => previewAttachment(item)}
                    aria-label={`Preview ${item.name}`}
                    title="Preview image"
                  >
                    <img src={item.dataUrl} alt={item.name} />
                  </button>
                ) : (
                  attachmentFileIcon()
                )}
              </div>
              <div className="attachment-preview-meta">
                <span className="attachment-preview-name">{item.name}</span>
                <span className="attachment-preview-type">{attachmentTypeLabel(item)}</span>
              </div>
              <button
                type="button"
                className="attachment-remove"
                onClick={() => removeAttachment(item.id)}
                aria-label={`Remove ${item.name}`}
                title="Remove attachment"
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        rows={1}
        value={input}
        placeholder={
          isAgentMode
            ? isFlow
              ? "Command the Flow agents..."
              : "Ask Rush to inspect, edit, run, or explain code..."
            : "Message Rush..."
        }
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (packCommandSuggestions.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setSelectedPackCommandIndex((index) => {
              const delta = e.key === "ArrowDown" ? 1 : -1;
              return (index + delta + packCommandSuggestions.length) % packCommandSuggestions.length;
            });
            return;
          }
          if (packCommandSuggestions.length > 0 && (e.key === "Tab" || e.key === "Enter")) {
            e.preventDefault();
            completePackCommand(packCommandSuggestions[selectedPackCommandIndex]?.name ?? packCommandSuggestions[0].name);
            return;
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!busy) send();
          }
        }}
      />
      {isAgentMode && packCommandSuggestions.length > 0 && (
        <div className="pack-command-suggestions" role="listbox" aria-label="Imported pack commands">
          {packCommandSuggestions.map((command, index) => (
            <button
              type="button"
              key={command.id}
              className={index === selectedPackCommandIndex ? "active" : ""}
              aria-selected={index === selectedPackCommandIndex}
              onClick={() => completePackCommand(command.name)}
              title={command.description}
            >
              <code>/{command.name}</code>
              <span>{command.description || "Imported pack command"}</span>
              {command.argumentHint && <em>{command.argumentHint}</em>}
            </button>
          ))}
        </div>
      )}
      {contextItems.length > 0 && (
        <div className="context-chip-row">
          {contextItems.map((item) => (
            <div className="context-chip" key={`${item.kind}-${item.id}`}>
              <span>{item.kind === "chat" ? "Chat" : "Research"}: {item.title}</span>
              <button
                type="button"
                onClick={() => removeContextItem(item)}
                aria-label={`Remove ${item.title} context`}
                title="Remove context"
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-bar">
        <button
          className="icon-btn attach-btn"
          onClick={() => fileRef.current?.click()}
          aria-label="Attach file"
          title="Attach file"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          </svg>
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          multiple
          accept={attachmentAccept}
          onChange={onPickFile}
        />

        <div className="permission-menu-wrap">
          <button
            type="button"
            className={`permission-mode-btn ${permissionPreset.id}`}
            onClick={() => setShowPermissionMenu((open) => !open)}
            title={permissionPreset.description}
            aria-label={`Permission mode: ${permissionPreset.label}`}
            aria-expanded={showPermissionMenu}
          >
            <span className="permission-mode-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                {permissionPreset.id === "ask" ? (
                  <path d="M8 11V7a2 2 0 1 1 4 0v4M12 10V6a2 2 0 1 1 4 0v6M16 11V8a2 2 0 1 1 4 0v5a7 7 0 0 1-7 7h-1a6 6 0 0 1-6-6v-2a2 2 0 1 1 4 0v1" />
                ) : permissionPreset.id === "edit" ? (
                  <path d="M12 3 5 6v5c0 4.5 3 7.6 7 9 4-1.4 7-4.5 7-9V6l-7-3ZM9 12l2 2 4-5" />
                ) : permissionPreset.id === "plan" ? (
                  <path d="M7 4h10v16H7zM9 8h6M9 12h6M9 16h4" />
                ) : (
                  <path d="M12 3 5 6v5c0 4.5 3 7.6 7 9 4-1.4 7-4.5 7-9V6l-7-3ZM12 8v5M12 16h.01" />
                )}
              </svg>
            </span>
            <span>{permissionPreset.label}</span>
            <svg className="permission-mode-caret" viewBox="0 0 24 24" aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>

          {showPermissionMenu && (
            <div className="permission-menu" role="menu">
              {PERMISSION_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={preset.id === permissionPreset.id ? "active" : ""}
                  onClick={() => applyPermissionPreset(preset)}
                  role="menuitem"
                >
                  <span className={`permission-menu-icon ${preset.id}`} aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      {preset.id === "ask" ? (
                        <path d="M8 11V7a2 2 0 1 1 4 0v4M12 10V6a2 2 0 1 1 4 0v6M16 11V8a2 2 0 1 1 4 0v5a7 7 0 0 1-7 7h-1a6 6 0 0 1-6-6v-2a2 2 0 1 1 4 0v1" />
                      ) : preset.id === "edit" ? (
                        <path d="M12 3 5 6v5c0 4.5 3 7.6 7 9 4-1.4 7-4.5 7-9V6l-7-3ZM9 12l2 2 4-5" />
                      ) : preset.id === "plan" ? (
                        <path d="M7 4h10v16H7zM9 8h6M9 12h6M9 16h4" />
                      ) : (
                        <path d="M12 3 5 6v5c0 4.5 3 7.6 7 9 4-1.4 7-4.5 7-9V6l-7-3ZM12 8v5M12 16h.01" />
                      )}
                    </svg>
                  </span>
                  <span>
                    <strong>{preset.label}</strong>
                    <small>{preset.description}</small>
                  </span>
                  {preset.id === permissionPreset.id && <span className="permission-menu-check">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="library-context-actions" aria-label="Add Library context">
          <button
            type="button"
            onClick={openContextPicker}
            title="Add chat or deep research from Library"
            aria-label="Add chat or deep research from Library"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="5.5" />
              <path d="m15 15 4 4" />
              <path d="M10.5 8v5M8 10.5h5" />
            </svg>
            <span>Deep Research</span>
          </button>
        </div>

        <div className="composer-right-controls">
          <div
            className="context-window-control"
            title={contextWindowTitle}
            aria-label={contextWindowTitle}
            tabIndex={0}
            style={{ "--context-window-percent": `${contextWindowPercent}%` } as React.CSSProperties}
          >
            <span className="context-window-ring" aria-hidden="true" />
            <div className="context-window-popover" role="tooltip">
              <div className="context-window-head">
                <span>Context windows</span>
                <strong>{contextWindowLabel}</strong>
              </div>
              <div className="context-window-detail">
                {contextWindowTokens.toLocaleString()} of {contextWindowLimit.toLocaleString()} estimated tokens used
              </div>
              <div className="context-window-track" aria-hidden="true">
                <span style={{ width: `${contextWindowPercent}%` }} />
              </div>
            </div>
          </div>
          <select
            className="model-select"
            value={activeModel ?? ""}
            disabled={!activeProviderId}
            onChange={(e) => activeProviderId && setActive(activeProviderId, e.target.value)}
          >
            {modelGroups.length === 0 ? (
              <option value="">No model</option>
            ) : (
              modelGroups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.models.map((m) => (
                    <option key={m} value={m}>{modelDisplayName(m)}</option>
                  ))}
                </optgroup>
              ))
            )}
          </select>

          <label className="effort-control" title={`Effort: ${EFFORT_TIERS[effort]}`}>
            <span className="effort-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M8 3 5 7l3 4 3-4-3-4Z" />
                <path d="M16 3l-3 4 3 4 3-4-3-4Z" />
                <path d="M12 13l-3 4 3 4 3-4-3-4Z" />
              </svg>
            </span>
            <select
              value={effort}
              aria-label="Effort"
              onChange={(e) => setEffort(Number(e.target.value))}
            >
              {EFFORT_TIERS.map((tier, index) => (
                <option key={tier} value={index}>{tier}</option>
              ))}
            </select>
          </label>
        </div>

        <button
          className="send-btn"
          onClick={busy ? cancel : send}
          aria-label={busy ? "Cancel" : "Send"}
          title={busy ? "Cancel" : "Send"}
        >
          {busy ? (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M8 8h8v8H8z" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M12 19V5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
              <path d="M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
