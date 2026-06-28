import { useEffect, useMemo, useState } from "react";
import { useFileStore } from "../../core/fileStore";

interface TreeEntry {
  path: string;
  name: string;
  isDir: boolean;
}

interface MemoryNode {
  path: string;
  name: string;
  children: Map<string, MemoryNode>;
  isFile: boolean;
}

function entryName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function parseEntry(raw: string): TreeEntry | null {
  const isDir = raw.startsWith("dir ");
  const isFile = raw.startsWith("file ");
  if (!isDir && !isFile) return null;
  const path = raw.slice(isDir ? 4 : 5);
  if (!path) return null;
  return { path, name: entryName(path), isDir };
}

function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function buildMemoryTree(paths: string[]): MemoryNode {
  const root: MemoryNode = { path: "", name: "", children: new Map(), isFile: false };

  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      const childPath = parts.slice(0, index + 1).join("/");
      let child = node.children.get(part);
      if (!child) {
        child = { path: childPath, name: part, children: new Map(), isFile: false };
        node.children.set(part, child);
      }
      if (index === parts.length - 1) child.isFile = true;
      node = child;
    });
  }

  return root;
}

export function FileTree() {
  const tree = useFileStore((s) => s.tree);
  const activeFile = useFileStore((s) => s.activeFile);
  const open = useFileStore((s) => s.open);
  const mode = useFileStore((s) => s.mode);
  const backend = useFileStore((s) => s.backend);
  const root = useFileStore((s) => s.root);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [children, setChildren] = useState<Record<string, TreeEntry[]>>({});
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [failed, setFailed] = useState<Record<string, string>>({});

  const memoryTree = useMemo(() => buildMemoryTree(tree), [tree]);

  useEffect(() => {
    setExpanded(new Set());
    setChildren({});
    setLoading(new Set());
    setFailed({});
  }, [root, mode]);

  useEffect(() => {
    if (mode !== "disk" || !backend) return;
    void loadDir("");
    // loadDir intentionally depends on state; root/mode reset above forces a
    // fresh one-level listing when the project changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, mode, root]);

  async function loadDir(path: string) {
    if (!backend || loading.has(path) || children[path]) return;
    setLoading((prev) => new Set(prev).add(path));
    setFailed((prev) => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
    try {
      const raw = await backend.listDir(path || ".");
      const entries = sortEntries(raw.flatMap((entry) => {
        const parsed = parseEntry(entry);
        return parsed ? [parsed] : [];
      }));
      setChildren((prev) => ({ ...prev, [path]: entries }));
    } catch (err) {
      setFailed((prev) => ({ ...prev, [path]: String(err) }));
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }

  function toggleDiskDir(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        void loadDir(path);
      }
      return next;
    });
  }

  function toggleMemoryDir(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderDiskEntries(path = "", depth = 0): JSX.Element[] {
    const entries = children[path] ?? [];
    return entries.flatMap((entry) => {
      const isOpen = expanded.has(entry.path);
      const row = (
        <button
          key={entry.path}
          className={"tree-item tree-row" + (!entry.isDir && entry.path === activeFile ? " active" : "")}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => entry.isDir ? toggleDiskDir(entry.path) : open(entry.path)}
          title={entry.path}
        >
          <span className="tree-caret">{entry.isDir ? (isOpen ? "v" : ">") : ""}</span>
          <span className="tree-icon" aria-hidden="true">{entry.isDir ? "[D]" : "[F]"}</span>
          <span className="tree-label">{entry.name}</span>
        </button>
      );
      if (!entry.isDir || !isOpen) return [row];
      const status = loading.has(entry.path)
        ? [<div key={`${entry.path}:loading`} className="tree-status" style={{ paddingLeft: 22 + (depth + 1) * 14 }}>Loading...</div>]
        : failed[entry.path]
          ? [<div key={`${entry.path}:error`} className="tree-status error" style={{ paddingLeft: 22 + (depth + 1) * 14 }}>Could not load folder</div>]
          : [];
      return [row, ...status, ...renderDiskEntries(entry.path, depth + 1)];
    });
  }

  function renderMemoryNode(node: MemoryNode, depth = 0): JSX.Element[] {
    const entries = [...node.children.values()].sort((a, b) => {
      const aDir = a.children.size > 0;
      const bDir = b.children.size > 0;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    return entries.flatMap((entry) => {
      const isDir = entry.children.size > 0;
      const isOpen = expanded.has(entry.path);
      const row = (
        <button
          key={entry.path}
          className={"tree-item tree-row" + (!isDir && entry.path === activeFile ? " active" : "")}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => isDir ? toggleMemoryDir(entry.path) : open(entry.path)}
          title={entry.path}
        >
          <span className="tree-caret">{isDir ? (isOpen ? "v" : ">") : ""}</span>
          <span className="tree-icon" aria-hidden="true">{isDir ? "[D]" : "[F]"}</span>
          <span className="tree-label">{entry.name}</span>
        </button>
      );
      return isDir && isOpen ? [row, ...renderMemoryNode(entry, depth + 1)] : [row];
    });
  }

  const diskRows = mode === "disk" ? renderDiskEntries() : [];
  const isRootLoading = mode === "disk" && loading.has("") && diskRows.length === 0;
  const rootError = mode === "disk" ? failed[""] : "";

  return (
    <div className="file-tree">
      <div className="tree-header">Workspace</div>
      {mode === "disk" ? (
        <>
          {isRootLoading && <div className="tree-status">Loading...</div>}
          {rootError && <div className="tree-status error">Could not load workspace</div>}
          {!isRootLoading && !rootError && diskRows.length === 0 && (
            <div className="tree-status">No files</div>
          )}
          {diskRows}
        </>
      ) : (
        renderMemoryNode(memoryTree)
      )}
    </div>
  );
}
