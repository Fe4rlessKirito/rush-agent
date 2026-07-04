use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{atomic::{AtomicU64, Ordering}, Mutex},
};

#[derive(Default)]
pub struct BrowserState {
    worker: Mutex<Option<BrowserWorker>>,
    next_id: AtomicU64,
}

impl Drop for BrowserState {
    fn drop(&mut self) {
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.as_mut() {
                let _ = worker.child.kill();
            }
        }
    }
}

struct BrowserWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserArgs {
    pub session_id: Option<String>,
    pub url: Option<String>,
    pub selector: Option<String>,
    pub text: Option<String>,
    pub key: Option<String>,
    pub script: Option<String>,
    pub destination: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub timeout: Option<u64>,
    pub headless: Option<bool>,
    pub full_page: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct WorkerResponse {
    id: u64,
    ok: bool,
    result: Option<BrowserActionResult>,
    error: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionResult {
    pub session_id: Option<String>,
    pub content: String,
    pub path: Option<String>,
}

fn validate_url(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("Missing URL.".to_string());
    }
    let lower = trimmed.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || !lower.contains("://") {
        return Ok(());
    }
    Err("Only http:// and https:// URLs are supported.".to_string())
}

fn worker_path() -> Result<PathBuf, String> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let path = cwd.join("src-tauri").join("sidecars").join("browser-worker").join("index.mjs");
    if path.exists() {
        return Ok(path);
    }
    let alt = cwd.join("sidecars").join("browser-worker").join("index.mjs");
    if alt.exists() {
        return Ok(alt);
    }
    Err("Browser worker was not found.".to_string())
}

impl BrowserState {
    fn request(&self, command: &str, args: BrowserArgs) -> Result<BrowserActionResult, String> {
        if matches!(command, "browser_open" | "browser_navigate") {
            validate_url(args.url.as_deref().unwrap_or_default())?;
        }
        let mut guard = self.worker.lock().map_err(|_| "Browser worker lock poisoned.".to_string())?;
        if guard.as_ref().and_then(|worker| worker.child.id().checked_sub(0)).is_none() {
            *guard = Some(start_worker()?);
        }
        let worker = guard.as_mut().ok_or_else(|| "Browser worker did not start.".to_string())?;
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let payload = json!({ "id": id, "command": command, "args": args });
        writeln!(worker.stdin, "{}", payload).map_err(|e| format!("Browser worker write failed: {e}"))?;
        worker.stdin.flush().map_err(|e| format!("Browser worker flush failed: {e}"))?;
        let mut line = String::new();
        worker.stdout.read_line(&mut line).map_err(|e| format!("Browser worker read failed: {e}"))?;
        if line.trim().is_empty() {
            *guard = None;
            return Err("Browser worker stopped unexpectedly.".to_string());
        }
        let response: WorkerResponse = serde_json::from_str(&line).map_err(|e| format!("Invalid browser worker response: {e}"))?;
        if response.id != id {
            return Err("Browser worker response id mismatch.".to_string());
        }
        if response.ok {
            response.result.ok_or_else(|| "Browser worker returned no result.".to_string())
        } else {
            Err(response.error.unwrap_or_else(|| "Browser command failed.".to_string()))
        }
    }
}

fn start_worker() -> Result<BrowserWorker, String> {
    let script = worker_path()?;
    let mut child = Command::new("node")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start browser worker. Ensure Node.js and Playwright are installed: {e}"))?;
    let stdin = child.stdin.take().ok_or_else(|| "Browser worker stdin unavailable.".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "Browser worker stdout unavailable.".to_string())?;
    Ok(BrowserWorker { child, stdin, stdout: BufReader::new(stdout) })
}

fn call_browser(state: tauri::State<'_, BrowserState>, command: &str, args: BrowserArgs) -> Result<BrowserActionResult, String> {
    state.request(command, args)
}

#[tauri::command]
pub fn browser_open(state: tauri::State<'_, BrowserState>, args: BrowserArgs) -> Result<BrowserActionResult, String> {
    call_browser(state, "browser_open", args)
}

#[tauri::command]
pub fn browser_navigate(state: tauri::State<'_, BrowserState>, args: BrowserArgs) -> Result<BrowserActionResult, String> {
    call_browser(state, "browser_navigate", args)
}

#[tauri::command]
pub fn browser_click(state: tauri::State<'_, BrowserState>, args: BrowserArgs) -> Result<BrowserActionResult, String> {
    call_browser(state, "browser_click", args)
}

#[tauri::command]
pub fn browser_fill(state: tauri::State<'_, BrowserState>, args: BrowserArgs) -> Result<BrowserActionResult, String> {
    call_browser(state, "browser_fill", args)
}

#[tauri::command]
pub fn browser_press(state: tauri::State<'_, BrowserState>, args: BrowserArgs) -> Result<BrowserActionResult, String> {
    call_browser(state, "browser_press", args)
}

#[tauri::command]
pub fn browser_get_text(state: tauri::State<'_, BrowserState>, args: BrowserArgs) -> Result<BrowserActionResult, String> {
    call_browser(state, "browser_get_text", args)
}

#[tauri::command]
pub fn browser_get_html(state: tauri::State<'_, BrowserState>, args: BrowserArgs) -> Result<BrowserActionResult, String> {
    call_browser(state, "browser_get_html", args)
}

#[tauri::command]
pub fn browser_eval(state: tauri::State<'_, BrowserState>, args: BrowserArgs) -> Result<BrowserActionResult, String> {
    call_browser(state, "browser_eval", args)
}

#[tauri::command]
pub fn browser_screenshot(state: tauri::State<'_, BrowserState>, args: BrowserArgs) -> Result<BrowserActionResult, String> {
    call_browser(state, "browser_screenshot", args)
}

#[tauri::command]
pub fn browser_links(state: tauri::State<'_, BrowserState>, args: BrowserArgs) -> Result<BrowserActionResult, String> {
    call_browser(state, "browser_links", args)
}

#[tauri::command]
pub fn browser_close(state: tauri::State<'_, BrowserState>, args: BrowserArgs) -> Result<BrowserActionResult, String> {
    call_browser(state, "browser_close", args)
}
