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

fn npm_bin() -> &'static str {
    if cfg!(windows) {
        "npm.cmd"
    } else {
        "npm"
    }
}

fn cargo_bin() -> &'static str {
    if cfg!(windows) {
        "cargo.exe"
    } else {
        "cargo"
    }
}

fn python_bin() -> &'static str {
    if cfg!(windows) {
        "python.exe"
    } else {
        "python3"
    }
}

fn winget_bin() -> &'static str {
    if cfg!(windows) {
        "winget.exe"
    } else {
        "winget"
    }
}

fn run_in_project(
    state: State<ProjectRoot>,
    program: &str,
    args: &[String],
) -> Result<String, String> {
    let cwd = work_dir(&state)?;
    let output = Command::new(program)
        .args(args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("failed to run {program}: {e}"))?;

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
        Err(format!("{program} {} failed: {detail}", args.join(" ")))
    }
}

fn require_nonempty(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(format!("{label} is required"))
    } else {
        Ok(trimmed.to_string())
    }
}

fn clean_values(values: Vec<String>, label: &str) -> Result<Vec<String>, String> {
    let cleaned: Vec<String> = values
        .into_iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect();
    if cleaned.is_empty() {
        Err(format!("at least one {label} is required"))
    } else {
        Ok(cleaned)
    }
}

#[tauri::command]
pub fn npm_scripts(state: State<ProjectRoot>) -> Result<String, String> {
    run_in_project(state, npm_bin(), &["run".to_string(), "--json".to_string()])
}

#[tauri::command]
pub fn npm_run_script(
    state: State<ProjectRoot>,
    script: String,
    args: Option<Vec<String>>,
) -> Result<String, String> {
    let script = require_nonempty(&script, "script")?;
    let mut command_args = vec!["run".to_string(), script];
    if let Some(extra) = args {
        let extra = clean_values(extra, "script argument")?;
        command_args.push("--".to_string());
        command_args.extend(extra);
    }
    run_in_project(state, npm_bin(), &command_args)
}

#[tauri::command]
pub fn npm_install(
    state: State<ProjectRoot>,
    packages: Vec<String>,
    dev: bool,
) -> Result<String, String> {
    let packages = clean_values(packages, "package")?;
    let mut args = vec!["install".to_string()];
    if dev {
        args.push("--save-dev".to_string());
    }
    args.extend(packages);
    run_in_project(state, npm_bin(), &args)
}

#[tauri::command]
pub fn npm_ci(state: State<ProjectRoot>) -> Result<String, String> {
    run_in_project(state, npm_bin(), &["ci".to_string()])
}

#[tauri::command]
pub fn cargo_check_cmd(state: State<ProjectRoot>) -> Result<String, String> {
    run_in_project(state, cargo_bin(), &["check".to_string()])
}

#[tauri::command]
pub fn cargo_test_cmd(state: State<ProjectRoot>) -> Result<String, String> {
    run_in_project(state, cargo_bin(), &["test".to_string()])
}

#[tauri::command]
pub fn cargo_build_cmd(state: State<ProjectRoot>, release: bool) -> Result<String, String> {
    let mut args = vec!["build".to_string()];
    if release {
        args.push("--release".to_string());
    }
    run_in_project(state, cargo_bin(), &args)
}

#[tauri::command]
pub fn pip_install(state: State<ProjectRoot>, packages: Vec<String>) -> Result<String, String> {
    let packages = clean_values(packages, "package")?;
    let mut args = vec!["-m".to_string(), "pip".to_string(), "install".to_string()];
    args.extend(packages);
    run_in_project(state, python_bin(), &args)
}

#[tauri::command]
pub fn winget_search(state: State<ProjectRoot>, query: String) -> Result<String, String> {
    let query = require_nonempty(&query, "query")?;
    run_in_project(state, winget_bin(), &["search".to_string(), query])
}
