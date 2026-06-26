import Editor from "@monaco-editor/react";
import { useFileStore } from "../../core/fileStore";
import { PreviewPane } from "./PreviewPane";

export function EditorPane() {
  const activeFile = useFileStore((s) => s.activeFile);
  const files = useFileStore((s) => s.files);
  const setContent = useFileStore((s) => s.setContent);
  const langFor = useFileStore((s) => s.langFor);
  const showPreview = useFileStore((s) => s.showPreview);

  // The Preview tab takes over the surface when active.
  if (showPreview) return <PreviewPane />;

  if (!activeFile) {
    return (
      <div className="editor-empty">
        <div className="editor-empty-icon">⌘</div>
        <p>Select a file from the tree to start editing.</p>
      </div>
    );
  }

  return (
    <Editor
      // path gives each file its own Monaco model → real per-file undo + state.
      path={activeFile}
      height="100%"
      theme="vs-dark"
      language={langFor(activeFile)}
      value={files[activeFile] ?? ""}
      onChange={(val) => setContent(activeFile, val ?? "")}
      options={{
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        padding: { top: 10 },
      }}
    />
  );
}
