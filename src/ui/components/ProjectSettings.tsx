import { useEffect, useState } from "react";
import { useProjectStore } from "../../core/projectStore";
import { setDesktopProjectRoot } from "../../core/projectRoot";

interface Props {
  onClose: () => void;
}

// Per-project settings drawer: edit the project's name and custom instructions.
// Instructions feed into the agent's system prompt (see ChatPanel/agentLoop).
export function ProjectSettings({ onClose }: Props) {
  const project = useProjectStore((s) =>
    s.projects.find((p) => p.id === s.activeProjectId),
  );
  const renameProject = useProjectStore((s) => s.renameProject);
  const setProjectPath = useProjectStore((s) => s.setProjectPath);
  const setInstructions = useProjectStore((s) => s.setInstructions);

  const [name, setName] = useState(project?.name ?? "");
  const [path, setPath] = useState(project?.path ?? "");
  const [instructions, setLocalInstructions] = useState(project?.instructions ?? "");

  // Re-sync local fields if the active project changes underneath the drawer.
  useEffect(() => {
    setName(project?.name ?? "");
    setPath(project?.path ?? "");
    setLocalInstructions(project?.instructions ?? "");
  }, [project?.id]);

  if (!project) return null;

  const save = async () => {
    renameProject(project.id, name);
    setProjectPath(project.id, path);
    setInstructions(project.id, instructions);
    await setDesktopProjectRoot(path).catch((err) => {
      console.warn("set_project_root failed", err);
    });
    onClose();
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>Project settings</h2>
          <button className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <label className="drawer-field">
          <span>Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name"
          />
        </label>

        <label className="drawer-field">
          <span>Project path</span>
          <div className="path-field">
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="C:\\Users\\marko\\Projects\\my-app"
            />
          </div>
          <small className="drawer-hint">
            Used as the working folder for project tools when this project is active.
          </small>
        </label>

        <label className="drawer-field">
          <span>Custom instructions</span>
          <textarea
            value={instructions}
            onChange={(e) => setLocalInstructions(e.target.value)}
            placeholder="Standing guidance for the agent in this project — coding style, stack, conventions, things to always or never do."
            rows={8}
          />
          <small className="drawer-hint">
            Added to the agent's system prompt for every chat in this project.
          </small>
        </label>

        <div className="drawer-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="projects-new" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
