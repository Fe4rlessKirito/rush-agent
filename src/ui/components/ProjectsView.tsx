import { useState } from "react";
import { useProjectStore, selectProjects } from "../../core/projectStore";
import { chooseAndSetProjectRoot } from "../../core/projectRoot";

interface Props {
  onOpenProject: (id: string) => void;
}

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

export function ProjectsView({ onOpenProject }: Props) {
  const [query, setQuery] = useState("");
  const projects = useProjectStore((s) => s.projects);
  const sortBy = useProjectStore((s) => s.sortBy);
  const setSortBy = useProjectStore((s) => s.setSortBy);
  const createProject = useProjectStore((s) => s.createProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const renameProject = useProjectStore((s) => s.renameProject);
  const setProjectPath = useProjectStore((s) => s.setProjectPath);
  const [opening, setOpening] = useState(false);

  const visible = selectProjects(projects, sortBy, query);
  const hasProjects = projects.length > 0;

  const handleNew = () => onOpenProject(createProject());

  // Open a real folder from disk: pick it, register it as the desktop project
  // root, then create a project bound to that path and open it.
  const handleOpenFolder = async () => {
    if (opening) return;
    setOpening(true);
    try {
      const picked = await chooseAndSetProjectRoot();
      if (!picked) return;
      const folderName = picked.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Project";
      const id = createProject(folderName);
      setProjectPath(id, picked);
      renameProject(id, folderName);
      onOpenProject(id);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="projects-view">
      <div className="projects-inner">
        <div className="projects-header">
          <h1 className="projects-title">Projects</h1>
          <div className="projects-actions">
            <button
              className="projects-sort"
              onClick={() => setSortBy(sortBy === "updated" ? "name" : "updated")}
              title="Toggle sort"
            >
              Sort by <strong>{sortBy === "updated" ? "Last updated" : "Name"}</strong>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            <button className="projects-open-folder" onClick={handleOpenFolder} disabled={opening}>
              {opening ? "Opening\u2026" : "Open folder"}
            </button>
            <button className="projects-new" onClick={handleNew}>
              New project
            </button>
          </div>
        </div>

        <div className="projects-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <line x1="16.5" y1="16.5" x2="21" y2="21" />
          </svg>
          <input
            type="text"
            placeholder="Search projects\u2026"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {hasProjects ? (
          <div className="projects-grid">
            {visible.map((p) => (
              <div
                key={p.id}
                className="project-card"
                onClick={() => onOpenProject(p.id)}
              >
                <div className="project-card-top">
                  <span className="project-card-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 7V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                    </svg>
                  </span>
                  <button
                    className="project-card-del"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteProject(p.id);
                    }}
                    title="Delete project"
                  >
                    ×
                  </button>
                </div>
                <div className="project-card-name">{p.name}</div>
                <div className="project-card-meta">
                  {Object.keys(p.files).length} files · {relTime(p.updatedAt)}
                </div>
              </div>
            ))}
            {visible.length === 0 && (
              <div className="projects-noresults">No projects match “{query}”.</div>
            )}
          </div>
        ) : (
          <div className="projects-empty">
            <div className="projects-empty-icon">
              <svg viewBox="0 0 80 80" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round">
                <rect x="14" y="14" width="20" height="20" rx="3" />
                <rect x="46" y="14" width="20" height="20" rx="3" />
                <rect x="14" y="46" width="20" height="20" rx="3" />
                <rect x="46" y="46" width="20" height="20" rx="3" />
              </svg>
            </div>
            <div className="projects-empty-title">Looking to start a project?</div>
            <p className="projects-empty-text">
              Upload materials, set custom instructions, and organize conversations
              in one space.
            </p>
            <button className="projects-new ghost-fill" onClick={handleNew}>
              New project
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
