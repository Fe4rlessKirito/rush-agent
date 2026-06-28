import { useMemo, useRef, useState } from "react";
import { isTauriRuntime } from "../../core/agent/tauriFs";
import { useProjectStore } from "../../core/projectStore";
import {
  importScannedPack,
  previewPackFolder,
  type PackFolderPreviewResult,
} from "../../core/packs/packFolderImport";
import { usePackStore } from "../../core/packs/packStore";
import type { InstalledPack, PackScope } from "../../core/packs/packCatalog";
import {
  parsePackBackupJson,
  stringifyPackBackup,
  type PackBackupFile,
  type PackBackupImportMode,
} from "../../core/packs/packBackup";

type ImportStatus = {
  kind: "idle" | "loading" | "success" | "error";
  message: string;
};

type PackItemSelection = {
  packId: string;
  kind: "skill" | "command" | "rule" | "manifest";
  id: string;
};

type PackItemPreview = {
  label: string;
  meta: string[];
  body: string;
};

async function pickFolder(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false, title: "Import Pack Folder" });
  return typeof selected === "string" && selected.trim() ? selected.trim() : null;
}

function packItemPreview(pack: InstalledPack, selection: PackItemSelection | null): PackItemPreview | null {
  if (!selection || selection.packId !== pack.id) return null;
  if (selection.kind === "skill") {
    const skill = pack.skills.find((item) => item.id === selection.id);
    if (!skill) return null;
    return {
      label: skill.title,
      meta: compactStrings([
        `Skill`,
        `Confidence ${skill.confidence}`,
        skill.approved ? "Approved" : "Needs approval",
        skill.sourcePath,
      ]),
      body: [`When:\n${skill.when}`, `Workflow:\n${skill.how}`].join("\n\n"),
    };
  }
  if (selection.kind === "command") {
    const command = pack.commands.find((item) => item.id === selection.id);
    if (!command) return null;
    return {
      label: `/${command.name}`,
      meta: compactStrings(["Command", command.argumentHint ? `Args ${command.argumentHint}` : "", command.sourcePath]),
      body: [command.description, command.body].filter(Boolean).join("\n\n"),
    };
  }
  if (selection.kind === "rule") {
    const rule = pack.rules.find((item) => item.id === selection.id);
    if (!rule) return null;
    return {
      label: rule.name,
      meta: compactStrings(["Rule", rule.category ?? "", rule.sourcePath]),
      body: rule.body,
    };
  }
  const manifest = pack.manifests.find((item) => item.id === selection.id);
  if (!manifest) return null;
  return {
    label: `Manifest v${manifest.version}`,
    meta: ["Manifest", `${manifest.entries.length} entries`],
    body: manifest.entries.length ? manifest.entries.join("\n") : "No entries detected.",
  };
}

function truncateLabel(value: string, max = 48): string {
  const clean = value.trim();
  return clean.length > max ? `${clean.slice(0, max - 3).trimEnd()}...` : clean;
}

function compactStrings(values: Array<string | undefined>): string[] {
  return values.map((value) => value?.trim() ?? "").filter(Boolean);
}

export function PackManager() {
  const packs = usePackStore((state) => state.packs);
  const setPackEnabled = usePackStore((state) => state.setPackEnabled);
  const setPackScope = usePackStore((state) => state.setPackScope);
  const updatePackItem = usePackStore((state) => state.updatePackItem);
  const importBackup = usePackStore((state) => state.importBackup);
  const removePack = usePackStore((state) => state.removePack);
  const clearPacks = usePackStore((state) => state.clearPacks);
  const projects = useProjectStore((state) => state.projects);
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const backupInputRef = useRef<HTMLInputElement | null>(null);
  const [folderPath, setFolderPath] = useState("");
  const [status, setStatus] = useState<ImportStatus>({ kind: "idle", message: "" });
  const [preview, setPreview] = useState<PackFolderPreviewResult | null>(null);
  const [selectedItem, setSelectedItem] = useState<PackItemSelection | null>(null);
  const [backupPreview, setBackupPreview] = useState<PackBackupFile | null>(null);
  const [backupMode, setBackupMode] = useState<PackBackupImportMode>("merge");
  const totals = useMemo(() => ({
    packs: packs.length,
    enabled: packs.filter((pack) => pack.enabled).length,
    skills: packs.reduce((sum, pack) => sum + (pack.enabled ? pack.skills.length : 0), 0),
    commands: packs.reduce((sum, pack) => sum + (pack.enabled ? pack.commands.length : 0), 0),
    rules: packs.reduce((sum, pack) => sum + (pack.enabled ? pack.rules.length : 0), 0),
  }), [packs]);
  const recommendations = useMemo(() => {
    if (!activeProject) return [];
    const text = [
      activeProject.name,
      activeProject.path,
      activeProject.instructions,
      Object.keys(activeProject.files ?? {}).join(" "),
    ].join(" ").toLowerCase();
    return packs
      .map((pack) => {
        const searchable = [
          pack.name,
          pack.description ?? "",
          pack.commands.map((command) => `${command.name} ${command.description}`).join(" "),
          pack.skills.map((skill) => `${skill.title} ${skill.when} ${skill.tags.join(" ")}`).join(" "),
          pack.rules.map((rule) => `${rule.category ?? ""} ${rule.name}`).join(" "),
        ].join(" ").toLowerCase();
        const score = [
          "react", "typescript", "tauri", "rust", "research", "release", "git", "test", "frontend", "backend",
        ].reduce((sum, token) => sum + (text.includes(token) && searchable.includes(token) ? 1 : 0), 0);
        const active = pack.enabled && ((pack.scope ?? "global") === "global" || (pack.projectIds ?? []).includes(activeProject.id));
        return { pack, score, active };
      })
      .filter((item) => item.score > 0 && !item.active)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
  }, [activeProject, packs]);

  async function chooseFolder() {
    const selected = await pickFolder();
    if (selected) {
      setFolderPath(selected);
      setPreview(null);
      setStatus({ kind: "idle", message: "" });
    }
  }

  async function previewFolder(path: string) {
    const clean = path.trim();
    if (!clean) {
      setStatus({ kind: "error", message: "Choose or enter a pack folder first." });
      return;
    }
    setPreview(null);
    setStatus({ kind: "loading", message: "Scanning and validating pack folder..." });
    try {
      const result = await previewPackFolder(clean, {
        approveImportedSkills: true,
        defaultConfidence: 88,
      });
      setPreview(result);
      setStatus({
        kind: "success",
        message: `Preview ready: ${result.imported.stats.accepted} accepted, ${result.imported.stats.rejected} rejected, ${result.scanned.skipped_count} skipped.`,
      });
      setFolderPath(result.scanned.root);
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    }
  }

  function installPreview() {
    if (!preview) return;
    const result = importScannedPack(preview.scanned, {
      approveImportedSkills: true,
      defaultConfidence: 88,
    }, {
      name: preview.suggestedName,
      sourcePath: preview.suggestedSourcePath,
    });
    setStatus({
      kind: "success",
      message: `Installed ${result.imported.stats.accepted} items as ${preview.suggestedName}.`,
    });
    setPreview(null);
  }

  function removeInstalledPack(id: string, name: string) {
    if (!window.confirm(`Remove pack "${name}" from Rush?`)) return;
    setSelectedItem((current) => (current?.packId === id ? null : current));
    removePack(id);
  }

  function clearInstalledPacks() {
    if (!packs.length) return;
    if (!window.confirm("Remove all imported packs from Rush?")) return;
    setSelectedItem(null);
    clearPacks();
  }

  function exportBackup() {
    if (!packs.length) return;
    const blob = new Blob([stringifyPackBackup(packs)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `rush-pack-backup-${stamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStatus({ kind: "success", message: `Exported ${packs.length} pack${packs.length === 1 ? "" : "s"} to a backup file.` });
  }

  async function importBackupFile(file: File | null) {
    if (!file) return;
    try {
      const text = await file.text();
      const backup = parsePackBackupJson(text);
      setBackupPreview(backup);
      setStatus({
        kind: "success",
        message: `Backup ready: ${backup.packs.length} pack${backup.packs.length === 1 ? "" : "s"}, ${backup.packs.filter((pack) => packs.some((existing) => existing.id === pack.id)).length} conflict${backup.packs.filter((pack) => packs.some((existing) => existing.id === pack.id)).length === 1 ? "" : "s"}.`,
      });
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    } finally {
      if (backupInputRef.current) backupInputRef.current.value = "";
    }
  }

  function applyBackupImport() {
    if (!backupPreview) return;
    const conflicts = backupPreview.packs.filter((pack) => packs.some((existing) => existing.id === pack.id)).length;
    if (backupMode === "replace" && packs.length > 0 && !window.confirm("Replace all installed packs with this backup?")) return;
    importBackup(backupPreview, backupMode);
    setSelectedItem(null);
    setStatus({
      kind: "success",
      message: `${backupMode === "replace" ? "Replaced catalog" : "Imported backup"} with ${backupPreview.packs.length} pack${backupPreview.packs.length === 1 ? "" : "s"}${conflicts ? `, ${conflicts} overwritten` : ""}.`,
    });
    setBackupPreview(null);
  }

  function changeScope(packId: string, scope: PackScope, projectIds: string[]) {
    setPackScope(packId, scope, projectIds);
  }

  function toggleProject(packId: string, projectId: string, projectIds: string[]) {
    const next = projectIds.includes(projectId)
      ? projectIds.filter((id) => id !== projectId)
      : [...projectIds, projectId];
    setPackScope(packId, "projects", next);
  }

  function enableForActiveProject(pack: InstalledPack) {
    if (!activeProject) return;
    setPackEnabled(pack.id, true);
    setPackScope(pack.id, "projects", [...new Set([...(pack.projectIds ?? []), activeProject.id])]);
  }

  function packSafetyCount(pack: InstalledPack): number {
    return pack.rejected.length + pack.warnings.reduce((sum, warning) => sum + warning.issues.length, 0);
  }

  function editSelectedItem(pack: InstalledPack, selection: PackItemSelection) {
    if (selection.kind === "manifest") return;
    if (selection.kind === "skill") {
      const skill = pack.skills.find((item) => item.id === selection.id);
      if (!skill) return;
      const next = window.prompt(`Edit workflow for "${skill.title}"`, skill.how);
      if (next === null) return;
      updatePackItem(pack.id, "skill", skill.id, { how: next });
      return;
    }
    if (selection.kind === "command") {
      const command = pack.commands.find((item) => item.id === selection.id);
      if (!command) return;
      const next = window.prompt(`Edit procedure for /${command.name}`, command.body);
      if (next === null) return;
      updatePackItem(pack.id, "command", command.id, { body: next });
      return;
    }
    const rule = pack.rules.find((item) => item.id === selection.id);
    if (!rule) return;
    const next = window.prompt(`Edit rule "${rule.name}"`, rule.body);
    if (next === null) return;
    updatePackItem(pack.id, "rule", rule.id, { body: next });
  }

  function toggleSelectedSkillApproval(pack: InstalledPack, selection: PackItemSelection) {
    if (selection.kind !== "skill") return;
    const skill = pack.skills.find((item) => item.id === selection.id);
    if (!skill) return;
    updatePackItem(pack.id, "skill", skill.id, { approved: !skill.approved });
  }

  return (
    <div className="settings-body">
      <div className="pack-manager-head">
        <div>
          <h3>Imported packs</h3>
          <p className="hint">
            Import ECC-style skills, commands, rules, and manifests from a local folder.
          </p>
        </div>
        <div className="pack-manager-stats">
          <span>{totals.packs} packs</span>
          <span>{totals.enabled} enabled</span>
          <span>{totals.skills} skills</span>
          <span>{totals.commands} commands</span>
          <span>{totals.rules} rules</span>
        </div>
      </div>

      <section className="pack-import-card">
        <label>
          <span>Pack folder</span>
          <input
            value={folderPath}
            placeholder="C:\\Users\\marko\\Downloads\\ECC-2.0.0"
            onChange={(event) => {
              setFolderPath(event.target.value);
              setPreview(null);
            }}
          />
        </label>
        <div className="row">
          <button onClick={chooseFolder} disabled={!isTauriRuntime() || status.kind === "loading"}>
            Choose folder
          </button>
          <button onClick={() => previewFolder(folderPath)} disabled={status.kind === "loading"}>
            {status.kind === "loading" ? "Scanning..." : "Preview pack"}
          </button>
          <button onClick={installPreview} disabled={!preview || status.kind === "loading" || preview.imported.stats.accepted === 0}>
            Install preview
          </button>
          <button onClick={exportBackup} disabled={!packs.length || status.kind === "loading"}>
            Export backup
          </button>
          <button onClick={() => backupInputRef.current?.click()} disabled={status.kind === "loading"}>
            Import backup
          </button>
          <input
            ref={backupInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden-file-input"
            onChange={(event) => void importBackupFile(event.target.files?.[0] ?? null)}
          />
          {status.message && (
            <span className={`pack-import-status ${status.kind}`}>
              {status.message}
            </span>
          )}
        </div>
      </section>

      {preview && (
        <section className="pack-preview-card">
          <div className="pack-preview-head">
            <div>
              <strong>{preview.suggestedName}</strong>
              <span>{preview.scanned.root}</span>
            </div>
            <button onClick={installPreview} disabled={preview.imported.stats.accepted === 0}>
              Install
            </button>
          </div>
          <div className="pack-metrics">
            <span><strong>{preview.scanned.files.length}</strong> files scanned</span>
            <span><strong>{preview.imported.skills.length}</strong> skills</span>
            <span><strong>{preview.imported.commands.length}</strong> commands</span>
            <span><strong>{preview.imported.rules.length}</strong> rules</span>
            <span><strong>{preview.imported.manifests.length}</strong> manifests</span>
            <span><strong>{preview.imported.rejected.length}</strong> rejected</span>
            <span><strong>{preview.imported.warnings.length + preview.scanned.warnings.length}</strong> warnings</span>
            <span><strong>{preview.scanned.skipped_count}</strong> skipped</span>
          </div>
          {preview.imported.commands.length > 0 && (
            <details className="pack-details" open>
              <summary>Commands</summary>
              {preview.imported.commands.slice(0, 8).map((command) => (
                <div key={command.name}>
                  <code>/{command.name}</code>
                  <span>{command.description}</span>
                </div>
              ))}
            </details>
          )}
          {preview.imported.rejected.length > 0 && (
            <details className="pack-details" open>
              <summary>Rejected files</summary>
              {preview.imported.rejected.slice(0, 8).map((file) => (
                <div key={file.path}>
                  <code>{file.path}</code>
                  <span>{file.issues.map((issue) => issue.message).join("; ")}</span>
                </div>
              ))}
            </details>
          )}
          {(preview.imported.warnings.length > 0 || preview.scanned.warnings.length > 0) && (
            <details className="pack-details">
              <summary>Warnings</summary>
              {preview.scanned.warnings.slice(0, 6).map((warning) => (
                <div key={warning}>
                  <code>scan</code>
                  <span>{warning}</span>
                </div>
              ))}
              {preview.imported.warnings.slice(0, 8).map((warning) => (
                <div key={warning.path}>
                  <code>{warning.path}</code>
                  <span>{warning.issues.map((issue) => issue.message).join("; ")}</span>
                </div>
              ))}
            </details>
          )}
        </section>
      )}

      {backupPreview && (
        <section className="pack-preview-card">
          <div className="pack-preview-head">
            <div>
              <strong>Backup import preview</strong>
              <span>Exported {new Date(backupPreview.exportedAt).toLocaleString()}</span>
            </div>
            <button onClick={applyBackupImport}>
              Import
            </button>
          </div>
          <div className="pack-metrics">
            <span><strong>{backupPreview.packs.length}</strong> packs</span>
            <span><strong>{backupPreview.packs.filter((pack) => packs.some((existing) => existing.id === pack.id)).length}</strong> conflicts</span>
            <span><strong>{backupPreview.packs.reduce((sum, pack) => sum + pack.commands.length, 0)}</strong> commands</span>
            <span><strong>{backupPreview.packs.reduce((sum, pack) => sum + pack.skills.length, 0)}</strong> skills</span>
            <span><strong>{backupPreview.packs.reduce((sum, pack) => sum + pack.rules.length, 0)}</strong> rules</span>
          </div>
          <div className="pack-backup-mode">
            <label>
              <input
                type="radio"
                checked={backupMode === "merge"}
                onChange={() => setBackupMode("merge")}
              />
              <span>Merge and overwrite matching pack ids</span>
            </label>
            <label>
              <input
                type="radio"
                checked={backupMode === "replace"}
                onChange={() => setBackupMode("replace")}
              />
              <span>Replace all installed packs</span>
            </label>
          </div>
          <details className="pack-details" open>
            <summary>Packs in backup</summary>
            {backupPreview.packs.slice(0, 12).map((pack) => (
              <div key={pack.id}>
                <code>{pack.id}</code>
                <span>{pack.name}{packs.some((existing) => existing.id === pack.id) ? " - will overwrite installed pack" : ""}</span>
              </div>
            ))}
          </details>
        </section>
      )}

      {recommendations.length > 0 && activeProject && (
        <section className="pack-preview-card">
          <div className="pack-preview-head">
            <div>
              <strong>Recommended for {activeProject.name}</strong>
              <span>Based on project files, path, and instructions.</span>
            </div>
          </div>
          <div className="pack-recommendations">
            {recommendations.map(({ pack, score }) => (
              <button type="button" key={pack.id} onClick={() => enableForActiveProject(pack)}>
                <strong>{pack.name}</strong>
                <span>{score} match{score === 1 ? "" : "es"} - enable for this project</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="pack-list-head">
        <strong>Installed</strong>
        <button className="ghost small danger" onClick={clearInstalledPacks} disabled={!packs.length}>
          Remove all
        </button>
      </div>

      <div className="pack-list">
        {packs.length === 0 ? (
          <div className="pack-empty">
            <strong>No packs imported.</strong>
            <span>Import a local ECC folder to make its approved skills available to Rush prompts.</span>
          </div>
        ) : (
          packs.map((pack) => (
            <article className={`pack-card ${pack.enabled ? "enabled" : "disabled"}`} key={pack.id}>
              {(() => {
                const itemPreview = packItemPreview(pack, selectedItem);
                return (
                  <>
              <div className="pack-card-head">
                <div>
                  <strong>{pack.name}</strong>
                  <span>{pack.sourcePath || pack.origin}</span>
                </div>
                <label className="toggle-row pack-toggle">
                  <span>
                    <strong>{pack.enabled ? "Enabled" : "Disabled"}</strong>
                    <small>{pack.enabled ? "Injected when relevant" : "Stored but inactive"}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={pack.enabled}
                    onChange={(event) => setPackEnabled(pack.id, event.target.checked)}
                  />
                </label>
              </div>

              {pack.description && <p className="pack-description">{pack.description}</p>}

              <div className="pack-metrics">
                <span><strong>{pack.skills.length}</strong> skills</span>
                <span><strong>{pack.commands.length}</strong> commands</span>
                <span><strong>{pack.rules.length}</strong> rules</span>
                <span><strong>{pack.manifests.length}</strong> manifests</span>
                <span><strong>{pack.rejected.length}</strong> rejected</span>
                <span><strong>{pack.warnings.length}</strong> warnings</span>
              </div>

              {packSafetyCount(pack) > 0 && (
                <details className="pack-safety-review" open>
                  <summary>Safety review required - {packSafetyCount(pack)} issue{packSafetyCount(pack) === 1 ? "" : "s"}</summary>
                  <div>
                    <span>Review rejected files and warnings before enabling this pack globally.</span>
                    <button type="button" className="ghost small" onClick={() => setPackEnabled(pack.id, false)}>
                      Disable pack
                    </button>
                  </div>
                </details>
              )}

              {(pack.skills.length > 0 || pack.commands.length > 0 || pack.rules.length > 0 || pack.manifests.length > 0) && (
                <div className="pack-item-browser">
                  {pack.commands.length > 0 && (
                    <details open>
                      <summary>Commands</summary>
                      <div>
                        {pack.commands.map((command) => (
                          <button
                            type="button"
                            key={command.id}
                            className={selectedItem?.id === command.id ? "active" : ""}
                            onClick={() => setSelectedItem({ packId: pack.id, kind: "command", id: command.id })}
                            title={command.description}
                          >
                            <code>/{command.name}</code>
                            <span>{truncateLabel(command.description || command.name)}</span>
                          </button>
                        ))}
                      </div>
                    </details>
                  )}
                  {pack.skills.length > 0 && (
                    <details>
                      <summary>Skills</summary>
                      <div>
                        {pack.skills.map((skill) => (
                          <button
                            type="button"
                            key={skill.id}
                            className={selectedItem?.id === skill.id ? "active" : ""}
                            onClick={() => setSelectedItem({ packId: pack.id, kind: "skill", id: skill.id })}
                            title={skill.when}
                          >
                            <code>{skill.title}</code>
                            <span>{truncateLabel(skill.when)}</span>
                          </button>
                        ))}
                      </div>
                    </details>
                  )}
                  {pack.rules.length > 0 && (
                    <details>
                      <summary>Rules</summary>
                      <div>
                        {pack.rules.map((rule) => (
                          <button
                            type="button"
                            key={rule.id}
                            className={selectedItem?.id === rule.id ? "active" : ""}
                            onClick={() => setSelectedItem({ packId: pack.id, kind: "rule", id: rule.id })}
                            title={rule.body}
                          >
                            <code>{rule.category || "rule"}</code>
                            <span>{truncateLabel(rule.name)}</span>
                          </button>
                        ))}
                      </div>
                    </details>
                  )}
                  {pack.manifests.length > 0 && (
                    <details>
                      <summary>Manifests</summary>
                      <div>
                        {pack.manifests.map((manifest) => (
                          <button
                            type="button"
                            key={manifest.id}
                            className={selectedItem?.id === manifest.id ? "active" : ""}
                            onClick={() => setSelectedItem({ packId: pack.id, kind: "manifest", id: manifest.id })}
                          >
                            <code>v{manifest.version}</code>
                            <span>{manifest.entries.length} entries</span>
                          </button>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}

              {itemPreview && (
                <section className="pack-item-preview">
                  <div>
                    <strong>{itemPreview.label}</strong>
                    <span className="pack-item-preview-actions">
                      {selectedItem?.kind === "skill" && (
                        <button type="button" className="ghost small" onClick={() => toggleSelectedSkillApproval(pack, selectedItem)}>
                          Toggle approval
                        </button>
                      )}
                      {selectedItem?.kind !== "manifest" && selectedItem && (
                        <button type="button" className="ghost small" onClick={() => editSelectedItem(pack, selectedItem)}>
                          Edit
                        </button>
                      )}
                      <button type="button" className="ghost small" onClick={() => setSelectedItem(null)}>
                        Close
                      </button>
                    </span>
                  </div>
                  <div className="pack-item-meta">
                    {itemPreview.meta.map((item) => (
                      <span key={item}>{item}</span>
                    ))}
                  </div>
                  <pre>{itemPreview.body}</pre>
                </section>
              )}

              <div className="pack-scope-panel">
                <label>
                  <span>Scope</span>
                  <select
                    value={pack.scope ?? "global"}
                    onChange={(event) => changeScope(pack.id, event.target.value as PackScope, pack.projectIds ?? [])}
                  >
                    <option value="global">Global</option>
                    <option value="projects">Selected projects</option>
                  </select>
                </label>
                {(pack.scope ?? "global") === "projects" && (
                  <div className="pack-project-list">
                    {projects.length === 0 ? (
                      <span className="pack-project-empty">No projects exist yet.</span>
                    ) : projects.map((project) => (
                      <label key={project.id}>
                        <input
                          type="checkbox"
                          checked={(pack.projectIds ?? []).includes(project.id)}
                          onChange={() => toggleProject(pack.id, project.id, pack.projectIds ?? [])}
                        />
                        <span>{project.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {pack.rejected.length > 0 && (
                <details className="pack-details">
                  <summary>Rejected files</summary>
                  {pack.rejected.slice(0, 8).map((file) => (
                    <div key={file.path}>
                      <code>{file.path}</code>
                      <span>{file.issues.map((issue) => issue.message).join("; ")}</span>
                    </div>
                  ))}
                </details>
              )}

              {pack.warnings.length > 0 && (
                <details className="pack-details">
                  <summary>Warnings</summary>
                  {pack.warnings.slice(0, 8).map((warning) => (
                    <div key={warning.path}>
                      <code>{warning.path}</code>
                      <span>{warning.issues.map((issue) => issue.message).join("; ")}</span>
                    </div>
                  ))}
                </details>
              )}

              <div className="pack-actions">
                <span>Updated {new Date(pack.updatedAt).toLocaleString()}</span>
                <button className="ghost small danger" onClick={() => removeInstalledPack(pack.id, pack.name)}>
                  Remove
                </button>
              </div>
                  </>
                );
              })()}
            </article>
          ))
        )}
      </div>
    </div>
  );
}
