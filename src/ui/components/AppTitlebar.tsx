import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import rushLogoSrc from "../../../Rush-app-logo.png";

type View = "chat" | "projects" | "library" | "flow" | "webProbing" | "bugBounty";

interface Props {
  view: View;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  sessionTitle: string;
  projectName?: string;
  branchName?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  showResearch: boolean;
  onToggleResearch: () => void;
  showBrain: boolean;
  onToggleBrain: () => void;
  showSettings: boolean;
  onToggleSettings: () => void;
}

interface BranchItem {
  name: string;
  label: string;
  remote: boolean;
  current: boolean;
}

interface GraphCommit {
  decorations: string[];
  message: string;
  date: string;
  author: string;
  hash: string;
}

const appWindow = getCurrentWindow();

function startTitlebarDrag(event: MouseEvent<HTMLElement>) {
  if (event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("button, input, select, textarea, a")) return;
  void appWindow.startDragging();
}

function toggleTitlebarMaximize(event: MouseEvent<HTMLElement>) {
  const target = event.target as HTMLElement | null;
  if (target?.closest("button, input, select, textarea, a")) return;
  void appWindow.toggleMaximize();
}

function parseBranches(raw: string, currentBranch?: string): BranchItem[] {
  const seen = new Set<string>();
  const branches: BranchItem[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const current = trimmed.startsWith("*");
    const withoutMarker = trimmed.replace(/^\*\s*/, "");
    const name = withoutMarker.split(/\s+/)[0];
    if (!name || name.includes("->")) continue;
    const label = name.replace(/^remotes\//, "");
    const localName = label.replace(/^origin\//, "");
    const key = localName || label;
    if (seen.has(key)) continue;
    seen.add(key);
    branches.push({ name: key, label, remote: name.startsWith("remotes/"), current: current || key === currentBranch });
  }
  return branches.sort((a, b) => Number(b.current) - Number(a.current) || a.label.localeCompare(b.label));
}

function parseGraph(raw: string): GraphCommit[] {
  return raw.split(/\r?\n/).filter(Boolean).map((line) => {
    const parts = line.split("\t");
    const hash = parts[0] ?? "";
    const decorations = (parts[1] ?? "")
      .replace(/^\(|\)$/g, "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return {
      hash,
      decorations,
      message: parts[2] || line,
      date: parts[3] ?? "",
      author: parts[4] ?? "",
    };
  });
}

export function AppTitlebar({
  sidebarCollapsed,
  onToggleSidebar,
  sessionTitle,
  projectName,
  branchName,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  showResearch,
  onToggleResearch,
  showBrain,
  onToggleBrain,
  showSettings,
  onToggleSettings,
}: Props) {
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [branches, setBranches] = useState<BranchItem[]>([]);
  const [graphOpen, setGraphOpen] = useState(false);
  const [graphCommits, setGraphCommits] = useState<GraphCommit[]>([]);
  const branchMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!branchMenuOpen) return;
    let cancelled = false;
    invoke<string>("git_branch")
      .then((raw) => {
        if (!cancelled) setBranches(parseBranches(raw, branchName));
      })
      .catch(() => {
        if (!cancelled) setBranches(branchName ? [{ name: branchName, label: branchName, remote: false, current: true }] : []);
      });
    return () => {
      cancelled = true;
    };
  }, [branchMenuOpen, branchName]);

  useEffect(() => {
    if (!branchMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!branchMenuRef.current?.contains(event.target as Node)) setBranchMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [branchMenuOpen]);

  const filteredBranches = useMemo(() => {
    const q = branchQuery.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((branch) => branch.label.toLowerCase().includes(q));
  }, [branchQuery, branches]);

  const refreshGraph = async () => {
    const raw = await invoke<string>("git_log", { limit: 80 });
    setGraphCommits(parseGraph(raw));
  };

  const switchBranch = async (branch: string) => {
    await invoke<string>("git_switch_branch", { branch });
    window.location.reload();
  };

  const createBranch = async () => {
    const branch = window.prompt("Create and switch to new branch");
    if (!branch?.trim()) return;
    await invoke<string>("git_create_branch", { branch: branch.trim() });
    window.location.reload();
  };

  const openGraph = async () => {
    setBranchMenuOpen(false);
    setGraphOpen(true);
    await refreshGraph();
  };

  return (
    <header
      className={"titlebar app-titlebar" + (sidebarCollapsed ? " sidebar-collapsed" : "")}
      data-tauri-drag-region
      onMouseDown={startTitlebarDrag}
      onDoubleClick={toggleTitlebarMaximize}
    >
      <div className="titlebar-left" data-tauri-drag-region>
        <button
          type="button"
          className={"titlebar-app-btn" + (sidebarCollapsed ? " collapsed" : "")}
          onClick={onToggleSidebar}
          title={sidebarCollapsed ? "Show sidebar" : "Minimize sidebar"}
          aria-label={sidebarCollapsed ? "Show sidebar" : "Minimize sidebar"}
        >
          <img className="titlebar-app-logo" src={rushLogoSrc} alt="" draggable={false} />
        </button>
        <button type="button" className="titlebar-nav-btn" onClick={onBack} disabled={!canGoBack} title="Back" aria-label="Back">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18 9 12l6-6" /></svg>
        </button>
        <button type="button" className="titlebar-nav-btn" onClick={onForward} disabled={!canGoForward} title="Forward" aria-label="Forward">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
        </button>
      </div>

      <div className="titlebar-session" data-tauri-drag-region>
        <span className="titlebar-session-title" title={sessionTitle}>{sessionTitle}</span>
        <span className="titlebar-chip project" title={projectName || "rush-agent"}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
          <span>{projectName || "rush-agent"}</span>
        </span>
        {branchName && (
          <div className="titlebar-branch-wrap" ref={branchMenuRef}>
            <button type="button" className="titlebar-chip branch" title={`Current branch: ${branchName}`} onClick={() => setBranchMenuOpen((open) => !open)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v12" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="6" r="3" /><path d="M9 18h3a6 6 0 0 0 6-6V9" /></svg>
              <span>{branchName}</span>
              <svg className="titlebar-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
            </button>
            {branchMenuOpen && (
              <div className="branch-menu">
                <div className="branch-search">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4 4" /></svg>
                  <input value={branchQuery} onChange={(event) => setBranchQuery(event.target.value)} placeholder="Search branches" autoFocus />
                </div>
                <div className="branch-menu-label">Branches</div>
                <div className="branch-list">
                  {filteredBranches.map((branch) => (
                    <button key={branch.name} type="button" className={branch.current ? "active" : ""} onClick={() => !branch.current && void switchBranch(branch.name)}>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v12" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="6" r="3" /><path d="M9 18h3a6 6 0 0 0 6-6V9" /></svg>
                      <span>{branch.label}</span>
                      {branch.current && <span className="branch-check">✓</span>}
                    </button>
                  ))}
                </div>
                <button type="button" className="branch-menu-action" onClick={() => void createBranch()}>+ Create and switch to new branch...</button>
                <button type="button" className="branch-menu-action" onClick={() => void openGraph()}>⑂ Git Graph</button>
              </div>
            )}
          </div>
        )}
        <button type="button" className="titlebar-ghost-btn" title="More" aria-label="More">
          ...
        </button>
      </div>

      <div className="titlebar-spacer" data-tauri-drag-region />

      <div className="titlebar-actions">
        <button className={"settings-cog-btn research-topbar-btn" + (showResearch ? " active" : "")} onClick={onToggleResearch} title={showResearch ? "Close Deep Research" : "Deep Research"} aria-label={showResearch ? "Close Deep Research" : "Deep Research"}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4 4" /><path d="M10.5 8v5M8 10.5h5" /></svg>
        </button>
        <button className={"settings-cog-btn brain-topbar-btn" + (showBrain ? " active" : "")} onClick={onToggleBrain} title={showBrain ? "Close Brain" : "Brain"} aria-label={showBrain ? "Close Brain" : "Brain"}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4.5a3.5 3.5 0 0 0-4 3.45A3.8 3.8 0 0 0 3.5 11a3.7 3.7 0 0 0 1.1 2.63A3.5 3.5 0 0 0 8 19.5" /><path d="M15 4.5a3.5 3.5 0 0 1 4 3.45A3.8 3.8 0 0 1 20.5 11a3.7 3.7 0 0 1-1.1 2.63A3.5 3.5 0 0 1 16 19.5" /><path d="M9 4.5v15M15 4.5v15M9 9h6M9 14h6" /></svg>
        </button>
        <button className={"settings-cog-btn" + (showSettings ? " active" : "")} onClick={onToggleSettings} title={showSettings ? "Close settings" : "Settings"} aria-label={showSettings ? "Close settings" : "Settings"}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.05.05a2.1 2.1 0 0 1-2.97 2.97l-.05-.05a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.09 1.65V21.3a2.1 2.1 0 0 1-4.2 0v-.07a1.8 1.8 0 0 0-1.09-1.65 1.8 1.8 0 0 0-1.98.36l-.05.05a2.1 2.1 0 1 1-2.97-2.97l.05-.05A1.8 1.8 0 0 0 4.6 15a1.8 1.8 0 0 0-1.65-1.09H2.7a2.1 2.1 0 0 1 0-4.2h.25A1.8 1.8 0 0 0 4.6 8.62a1.8 1.8 0 0 0-.36-1.98l-.05-.05A2.1 2.1 0 0 1 7.16 3.6l.05.05a1.8 1.8 0 0 0 1.98.36A1.8 1.8 0 0 0 10.28 2.36V2.3a2.1 2.1 0 0 1 4.2 0v.07a1.8 1.8 0 0 0 1.09 1.65 1.8 1.8 0 0 0 1.98-.36l.05-.05a2.1 2.1 0 0 1 2.97 2.97l-.05.05a1.8 1.8 0 0 0-.36 1.98 1.8 1.8 0 0 0 1.65 1.09h.19a2.1 2.1 0 0 1 0 4.2h-.19A1.8 1.8 0 0 0 19.4 15Z" /></svg>
        </button>
      </div>

      <div className="window-controls">
        <button type="button" onClick={() => void appWindow.minimize()} title="Minimize" aria-label="Minimize">-</button>
        <button type="button" onClick={() => void appWindow.toggleMaximize()} title="Maximize" aria-label="Maximize">□</button>
        <button type="button" className="close" onClick={() => void appWindow.close()} title="Close" aria-label="Close">×</button>
      </div>

      {graphOpen && (
        <div className="git-graph-panel">
          <div className="git-graph-head">
            <strong>Git Graph</strong>
            <button type="button" onClick={() => void refreshGraph()} title="Refresh" aria-label="Refresh">⟳</button>
            <button type="button" onClick={() => setGraphOpen(false)} title="Close" aria-label="Close">×</button>
          </div>
          <div className="git-graph-table">
            <div className="git-graph-header">Graph</div>
            <div className="git-graph-header">Description</div>
            <div className="git-graph-header">Date</div>
            <div className="git-graph-header">Author</div>
            <div className="git-graph-header">Commit</div>
            {graphCommits.map((commit, index) => (
              <div className="git-graph-row" key={`${commit.hash}-${index}`}>
                <div className="git-graph-line"><span /></div>
                <div className="git-graph-desc">
                  <div className="git-graph-decorations">
                    {commit.decorations.map((decoration) => <span key={decoration}>{decoration}</span>)}
                  </div>
                  <span>{commit.message}</span>
                </div>
                <div>{commit.date}</div>
                <div>{commit.author}</div>
                <div>{commit.hash}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </header>
  );
}
