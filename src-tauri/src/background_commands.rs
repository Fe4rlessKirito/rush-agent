use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;

use crate::fs_commands::ProjectRoot;

const MAX_BUFFER_BYTES: usize = 300_000;
static NEXT_JOB_SEQ: AtomicU64 = AtomicU64::new(1);

pub struct BackgroundState(pub Mutex<HashMap<String, BackgroundJob>>);

impl Default for BackgroundState {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

pub struct BackgroundJob {
    child: Child,
    output: Arc<Mutex<String>>,
    command: String,
    shell: String,
    created_at: u128,
    exit_status: Option<String>,
}

impl Drop for BackgroundJob {
    fn drop(&mut self) {
        if self.exit_status.is_none() {
            let _ = self.child.kill();
        }
    }
}

#[derive(Serialize)]
pub struct BackgroundJobSummary {
    id: String,
    command: String,
    shell: String,
    status: String,
    created_at: u128,
}

#[derive(Serialize)]
pub struct BackgroundReadResult {
    id: String,
    status: String,
    output: String,
}

fn timestamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn job_id() -> String {
    let seq = NEXT_JOB_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("job_{}_{}", timestamp(), seq)
}

fn project_dir(root: &State<ProjectRoot>) -> Result<std::path::PathBuf, String> {
    let guard = root.0.lock().map_err(|_| "root lock poisoned")?;
    if let Some(path) = guard.as_ref() {
        return Ok(path.clone());
    }
    std::env::current_dir().map_err(|e| format!("current_dir: {e}"))
}

fn append_output(output: &Arc<Mutex<String>>, text: &str) {
    let Ok(mut buf) = output.lock() else {
        return;
    };
    buf.push_str(text);
    if buf.len() > MAX_BUFFER_BYTES {
        let excess = buf.len() - MAX_BUFFER_BYTES;
        let split = buf
            .char_indices()
            .find(|(idx, _)| *idx >= excess)
            .map(|(idx, _)| idx)
            .unwrap_or(excess);
        buf.drain(..split);
    }
}

fn spawn_reader<R>(mut reader: R, output: Arc<Mutex<String>>)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut bytes = [0_u8; 4096];
        loop {
            match reader.read(&mut bytes) {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&bytes[..n]);
                    append_output(&output, &text);
                }
                Err(_) => break,
            }
        }
    });
}

fn shell_command(shell: Option<String>, command: &str) -> Result<(String, Vec<String>), String> {
    let requested = shell.unwrap_or_else(|| {
        if cfg!(windows) {
            "powershell".to_string()
        } else {
            "sh".to_string()
        }
    });
    let normalized = requested.trim().to_ascii_lowercase();

    match normalized.as_str() {
        "powershell" | "pwsh" => Ok((
            if normalized == "pwsh" {
                "pwsh"
            } else {
                "powershell"
            }
            .to_string(),
            vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-Command".to_string(),
                command.to_string(),
            ],
        )),
        "cmd" => Ok((
            "cmd".to_string(),
            vec!["/C".to_string(), command.to_string()],
        )),
        "sh" => Ok((
            "sh".to_string(),
            vec!["-lc".to_string(), command.to_string()],
        )),
        "bash" => Ok((
            "bash".to_string(),
            vec!["-lc".to_string(), command.to_string()],
        )),
        _ => Err(format!("unsupported shell: {requested}")),
    }
}

fn refresh_status(job: &mut BackgroundJob) -> String {
    if let Some(status) = &job.exit_status {
        return status.clone();
    }
    match job.child.try_wait() {
        Ok(Some(status)) => {
            let text = if status.success() {
                "completed".to_string()
            } else {
                format!(
                    "failed({})",
                    status
                        .code()
                        .map_or_else(|| "signal".to_string(), |c| c.to_string())
                )
            };
            job.exit_status = Some(text.clone());
            text
        }
        Ok(None) => "running".to_string(),
        Err(err) => {
            let text = format!("unknown({err})");
            job.exit_status = Some(text.clone());
            text
        }
    }
}

#[tauri::command]
pub fn background_start(
    state: State<BackgroundState>,
    root: State<ProjectRoot>,
    command: String,
    shell: Option<String>,
) -> Result<BackgroundJobSummary, String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("command is required".to_string());
    }

    let cwd = project_dir(&root)?;
    let (program, args) = shell_command(shell, &command)?;
    let mut child = Command::new(&program)
        .args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start {program}: {e}"))?;

    let stdout = child.stdout.take().ok_or("failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("failed to capture stderr")?;
    let output = Arc::new(Mutex::new(String::new()));
    spawn_reader(stdout, Arc::clone(&output));
    spawn_reader(stderr, Arc::clone(&output));

    let id = job_id();
    let created_at = timestamp();
    let mut guard = state.0.lock().map_err(|_| "background lock poisoned")?;
    guard.insert(
        id.clone(),
        BackgroundJob {
            child,
            output,
            command: command.clone(),
            shell: program.clone(),
            created_at,
            exit_status: None,
        },
    );

    Ok(BackgroundJobSummary {
        id,
        command,
        shell: program,
        status: "running".to_string(),
        created_at,
    })
}

#[tauri::command]
pub fn background_read(
    state: State<BackgroundState>,
    id: String,
) -> Result<BackgroundReadResult, String> {
    let mut guard = state.0.lock().map_err(|_| "background lock poisoned")?;
    let job = guard
        .get_mut(&id)
        .ok_or_else(|| format!("unknown background job: {id}"))?;
    let status = refresh_status(job);
    let mut output = job.output.lock().map_err(|_| "output lock poisoned")?;
    let text = if output.is_empty() {
        "No new output.".to_string()
    } else {
        let text = output.clone();
        output.clear();
        text
    };
    Ok(BackgroundReadResult {
        id,
        status,
        output: text,
    })
}

#[tauri::command]
pub fn background_list(state: State<BackgroundState>) -> Result<Vec<BackgroundJobSummary>, String> {
    let mut guard = state.0.lock().map_err(|_| "background lock poisoned")?;
    let mut jobs = Vec::new();
    for (id, job) in guard.iter_mut() {
        let status = refresh_status(job);
        jobs.push(BackgroundJobSummary {
            id: id.clone(),
            command: job.command.clone(),
            shell: job.shell.clone(),
            status,
            created_at: job.created_at,
        });
    }
    jobs.sort_by_key(|job| job.created_at);
    Ok(jobs)
}

#[tauri::command]
pub fn background_stop(state: State<BackgroundState>, id: String) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|_| "background lock poisoned")?;
    let mut job = guard
        .remove(&id)
        .ok_or_else(|| format!("unknown background job: {id}"))?;
    let _ = job.child.kill();
    job.exit_status = Some("cancelled".to_string());
    Ok(format!("Stopped {id}."))
}
