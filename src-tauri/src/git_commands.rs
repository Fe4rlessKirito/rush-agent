use std::path::PathBuf;
use std::process::Command;

use tauri::State;

use crate::fs_commands::ProjectRoot;

fn work_dir(state: &State<ProjectRoot>) -> Result<PathBuf, String> {
    let guard = state.0.lock().map_err(|_| "root lock poisoned")?;
    if let Some(root) = guard.as_ref() {
        return Ok(root.clone());
    }
    std::env::current_dir().map_err(|e| format!("current_dir: {e}"))
}

fn run_git(state: State<ProjectRoot>, args: &[&str]) -> Result<String, String> {
    let cwd = work_dir(&state)?;
    let output = Command::new("git")
        .args(args)
        .current_dir(&cwd)
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

#[tauri::command]
pub fn git_status(state: State<ProjectRoot>) -> Result<String, String> {
    let output = run_git(state, &["status", "--short", "--branch"])?;
    Ok(if output.is_empty() {
        "Working tree clean.".to_string()
    } else {
        output
    })
}

#[tauri::command]
pub fn git_diff(state: State<ProjectRoot>, staged: bool, path: Option<String>) -> Result<String, String> {
    let mut args = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    if let Some(path) = path.as_deref() {
        if !path.trim().is_empty() {
            args.push("--");
            args.push(path);
        }
    }

    let output = run_git(state, &args)?;
    Ok(if output.is_empty() {
        "No diff.".to_string()
    } else {
        output
    })
}

#[tauri::command]
pub fn git_branch(state: State<ProjectRoot>) -> Result<String, String> {
    run_git(state, &["branch", "--all", "--verbose", "--no-abbrev"])
}

#[tauri::command]
pub fn git_current_branch(state: State<ProjectRoot>) -> Result<String, String> {
    run_git(state, &["branch", "--show-current"])
}

#[tauri::command]
pub fn git_commit(state: State<ProjectRoot>, message: String, all: bool) -> Result<String, String> {
    let msg = message.trim();
    if msg.is_empty() {
        return Err("commit message is required".to_string());
    }

    if all {
        run_git(state.clone(), &["add", "--all"])?;
    }
    run_git(state, &["commit", "-m", msg])
}

#[tauri::command]
pub fn git_push(state: State<ProjectRoot>, remote: Option<String>, branch: Option<String>) -> Result<String, String> {
    let remote = remote.as_deref().unwrap_or("origin").trim();
    let branch = branch.as_deref().unwrap_or("").trim();
    if branch.is_empty() {
        run_git(state, &["push", remote])
    } else {
        run_git(state, &["push", remote, branch])
    }
}

#[tauri::command]
pub fn git_pull(state: State<ProjectRoot>, remote: Option<String>, branch: Option<String>) -> Result<String, String> {
    let remote = remote.as_deref().unwrap_or("origin").trim();
    let branch = branch.as_deref().unwrap_or("").trim();
    if branch.is_empty() {
        run_git(state, &["pull", remote])
    } else {
        run_git(state, &["pull", remote, branch])
    }
}
