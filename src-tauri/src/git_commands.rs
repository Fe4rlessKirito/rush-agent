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

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_: &mut Command) {}

fn run_git(state: State<ProjectRoot>, args: &[&str]) -> Result<String, String> {
    let cwd = work_dir(&state)?;
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(&cwd);
    hide_window(&mut cmd);
    let output = cmd
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
pub fn git_diff(
    state: State<ProjectRoot>,
    staged: bool,
    path: Option<String>,
) -> Result<String, String> {
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
pub fn git_log(state: State<ProjectRoot>, limit: Option<u32>) -> Result<String, String> {
    let limit = limit.unwrap_or(10).clamp(1, 100).to_string();
    run_git(
        state,
        &[
            "log",
            "--oneline",
            "--decorate",
            "--max-count",
            limit.as_str(),
        ],
    )
}

#[tauri::command]
pub fn git_show(
    state: State<ProjectRoot>,
    rev: Option<String>,
    path: Option<String>,
) -> Result<String, String> {
    let rev = rev.unwrap_or_else(|| "HEAD".to_string());
    let rev = rev.trim();
    if rev.is_empty() {
        return Err("rev is required".to_string());
    }
    if let Some(path) = path.as_deref() {
        let path = path.trim();
        if !path.is_empty() {
            return run_git(state, &["show", "--stat", "--patch", rev, "--", path]);
        }
    }
    run_git(state, &["show", "--stat", "--patch", rev])
}

#[tauri::command]
pub fn git_blame(
    state: State<ProjectRoot>,
    path: String,
    start_line: Option<u32>,
    end_line: Option<u32>,
) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("path is required".to_string());
    }
    if let (Some(start), Some(end)) = (start_line, end_line) {
        let range = format!("{},{}", start.max(1), end.max(start.max(1)));
        return run_git(state, &["blame", "-L", range.as_str(), "--", path]);
    }
    run_git(state, &["blame", "--", path])
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
pub fn git_push(
    state: State<ProjectRoot>,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<String, String> {
    let remote = remote.as_deref().unwrap_or("origin").trim();
    let branch = branch.as_deref().unwrap_or("").trim();
    if branch.is_empty() {
        run_git(state, &["push", remote])
    } else {
        run_git(state, &["push", remote, branch])
    }
}

#[tauri::command]
pub fn git_pull(
    state: State<ProjectRoot>,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<String, String> {
    let remote = remote.as_deref().unwrap_or("origin").trim();
    let branch = branch.as_deref().unwrap_or("").trim();
    if branch.is_empty() {
        run_git(state, &["pull", remote])
    } else {
        run_git(state, &["pull", remote, branch])
    }
}

#[tauri::command]
pub fn git_reset(
    state: State<ProjectRoot>,
    mode: Option<String>,
    target: Option<String>,
) -> Result<String, String> {
    let mode = mode.unwrap_or_else(|| "mixed".to_string()).to_lowercase();
    let flag = match mode.as_str() {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        other => return Err(format!("unsupported git reset mode: {other}")),
    };
    let target = target.as_deref().unwrap_or("HEAD").trim();
    if target.is_empty() {
        run_git(state, &["reset", flag])
    } else {
        run_git(state, &["reset", flag, target])
    }
}
