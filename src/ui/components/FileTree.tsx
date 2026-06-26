import { useFileStore } from "../../core/fileStore";

export function FileTree() {
  const files = useFileStore((s) => Object.keys(s.files).sort());
  const activeFile = useFileStore((s) => s.activeFile);
  const open = useFileStore((s) => s.open);

  return (
    <div className="file-tree">
      <div className="tree-header">Workspace</div>
      {files.map((f) => (
        <button
          key={f}
          className={"tree-item" + (f === activeFile ? " active" : "")}
          onClick={() => open(f)}
        >
          {f}
        </button>
      ))}
    </div>
  );
}
