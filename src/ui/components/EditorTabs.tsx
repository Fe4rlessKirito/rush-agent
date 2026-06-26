import { useFileStore } from "../../core/fileStore";

function baseName(path: string) {
  return path.split("/").pop() ?? path;
}

export function EditorTabs() {
  const openTabs = useFileStore((s) => s.openTabs);
  const activeFile = useFileStore((s) => s.activeFile);
  const showPreview = useFileStore((s) => s.showPreview);
  const editorSide = useFileStore((s) => s.editorSide);
  const setActive = useFileStore((s) => s.setActive);
  const close = useFileStore((s) => s.close);
  const setShowPreview = useFileStore((s) => s.setShowPreview);
  const toggleSide = useFileStore((s) => s.toggleSide);

  if (openTabs.length === 0) return null;

  return (
    <div className="tabs">
      {openTabs.map((path) => (
        <div
          key={path}
          className={"tab" + (path === activeFile && !showPreview ? " active" : "")}
          onClick={() => setActive(path)}
          title={path}
        >
          <span className="tab-name">{baseName(path)}</span>
          <span
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation();
              close(path);
            }}
          >
            ×
          </span>
        </div>
      ))}
      <div
        className={"tab preview-tab" + (showPreview ? " active" : "")}
        onClick={() => setShowPreview(true)}
        title="Live preview"
      >
        <span className="tab-name">▶ Preview</span>
      </div>
      <button
        className="side-toggle"
        onClick={toggleSide}
        title="Move editor to the other side"
        aria-label="Move editor to the other side"
      >
        {editorSide === "left" ? "Editor ⇄ right" : "Editor ⇄ left"}
      </button>
    </div>
  );
}
