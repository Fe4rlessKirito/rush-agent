use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use crate::fs_commands::ProjectRoot;

#[derive(Default)]
pub struct WorktreeState {
    previous_roots: Mutex<Vec<PathBuf>>,
}

#[derive(Serialize)]
pub struct WorktreeInfo {
    path: String,
    previous_root: String,
    branch: String,
}

fn active_root(root: &State<ProjectRoot>) -> Result<PathBuf, String> {
    let guard = root.0.lock().map_err(|_| "root lock poisoned")?;
    if let Some(path) = guard.as_ref() {
        return Ok(path.clone());
    }
    std::env::current_dir().map_err(|e| format!("current_dir: {e}"))
}

fn set_root(root: &State<ProjectRoot>, path: PathBuf) -> Result<(), String> {
    let mut guard = root.0.lock().map_err(|_| "root lock poisoned")?;
    *guard = Some(path);
    Ok(())
}

fn git_output(cwd: &Path, args: &[String]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        if stdout.is_empty() {
            Ok(stderr)
        } else if stderr.is_empty() {
            Ok(stdout)
        } else {
            Ok(format!("{stdout}\n{stderr}"))
        }
    } else {
        let detail = if stderr.is_empty() { stdout } else { stderr };
        Err(format!("git {} failed: {detail}", args.join(" ")))
    }
}

fn repo_root(cwd: &Path) -> Result<PathBuf, String> {
    let out = git_output(
        cwd,
        &["rev-parse".to_string(), "--show-toplevel".to_string()],
    )?;
    Ok(PathBuf::from(out))
}

fn safe_name(name: &str) -> Result<String, String> {
    let cleaned = name
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if cleaned.is_empty() {
        Err("worktree name is required".to_string())
    } else {
        Ok(cleaned)
    }
}

fn safe_relative_path(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut clean = PathBuf::new();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(c) => clean.push(c),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "worktree path must stay under {}: {rel}",
                    base.display()
                ));
            }
        }
    }
    Ok(base.join(clean))
}

#[tauri::command]
pub fn enter_worktree(
    state: State<WorktreeState>,
    root: State<ProjectRoot>,
    name: Option<String>,
    branch: Option<String>,
    base: Option<String>,
    path: Option<String>,
) -> Result<WorktreeInfo, String> {
    let current = active_root(&root)?;
    let repo = repo_root(&current)?;
    let worktree_base = repo.join(".rush").join("worktrees");
    std::fs::create_dir_all(&worktree_base).map_err(|e| format!("mkdir worktrees: {e}"))?;

    let target = if let Some(path) = path.as_deref().filter(|p| !p.trim().is_empty()) {
        safe_relative_path(&worktree_base, path)?
    } else {
        worktree_base.join(safe_name(name.as_deref().unwrap_or("flow"))?)
    };
    let branch_name = branch
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "rush/{}",
                target
                    .file_name()
                    .map(|v| v.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "worktree".to_string())
            )
        });
    let base_ref = base
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("HEAD");

    if !target.exists() {
        git_output(
            &repo,
            &[
                "worktree".to_string(),
                "add".to_string(),
                "-b".to_string(),
                branch_name.clone(),
                target.to_string_lossy().into_owned(),
                base_ref.to_string(),
            ],
        )?;
    }

    {
        let mut guard = state
            .previous_roots
            .lock()
            .map_err(|_| "worktree lock poisoned")?;
        guard.push(current.clone());
    }
    set_root(&root, target.clone())?;

    Ok(WorktreeInfo {
        path: target.to_string_lossy().into_owned(),
        previous_root: current.to_string_lossy().into_owned(),
        branch: branch_name,
    })
}

#[tauri::command]
pub fn exit_worktree(
    state: State<WorktreeState>,
    root: State<ProjectRoot>,
    remove: Option<bool>,
) -> Result<WorktreeInfo, String> {
    let current = active_root(&root)?;
    let previous = {
        let mut guard = state
            .previous_roots
            .lock()
            .map_err(|_| "worktree lock poisoned")?;
        guard.pop().ok_or("not currently inside a Rush worktree")?
    };

    let branch = git_output(
        &current,
        &["branch".to_string(), "--show-current".to_string()],
    )
    .unwrap_or_else(|_| "".to_string());
    set_root(&root, previous.clone())?;

    if remove.unwrap_or(false) {
        let repo = repo_root(&previous)?;
        let _ = git_output(
            &repo,
            &[
                "worktree".to_string(),
                "remove".to_string(),
                current.to_string_lossy().into_owned(),
            ],
        );
    }

    Ok(WorktreeInfo {
        path: previous.to_string_lossy().into_owned(),
        previous_root: current.to_string_lossy().into_owned(),
        branch,
    })
}
