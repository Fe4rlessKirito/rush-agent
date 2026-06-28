use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::State;

use crate::fs_commands::ProjectRoot;

const MAX_BUFFER_BYTES: usize = 200_000;

pub struct TerminalState(pub Mutex<Option<TerminalSession>>);

impl Default for TerminalState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

pub struct TerminalSession {
    child: Child,
    stdin: ChildStdin,
    output: Arc<Mutex<String>>,
    shell: String,
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
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

fn project_dir(root: &State<ProjectRoot>) -> Result<std::path::PathBuf, String> {
    let guard = root.0.lock().map_err(|_| "root lock poisoned")?;
    if let Some(path) = guard.as_ref() {
        return Ok(path.clone());
    }
    std::env::current_dir().map_err(|e| format!("current_dir: {e}"))
}

fn shell_command(shell: Option<String>) -> Result<(String, Vec<String>), String> {
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
            vec!["-NoLogo".to_string(), "-NoProfile".to_string()],
        )),
        "cmd" => Ok(("cmd".to_string(), vec!["/Q".to_string()])),
        "sh" => Ok(("sh".to_string(), vec![])),
        "bash" => Ok(("bash".to_string(), vec!["-i".to_string()])),
        _ => Err(format!("unsupported shell: {requested}")),
    }
}

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_: &mut Command) {}

#[tauri::command]
pub fn terminal_start(
    terminal: State<TerminalState>,
    root: State<ProjectRoot>,
    shell: Option<String>,
) -> Result<String, String> {
    let mut guard = terminal.0.lock().map_err(|_| "terminal lock poisoned")?;
    if let Some(session) = guard.as_ref() {
        return Ok(format!("Terminal already running: {}", session.shell));
    }

    let cwd = project_dir(&root)?;
    let (program, args) = shell_command(shell)?;
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to start {program}: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or("failed to capture terminal stdin")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("failed to capture terminal stdout")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("failed to capture terminal stderr")?;
    let output = Arc::new(Mutex::new(String::new()));
    spawn_reader(stdout, Arc::clone(&output));
    spawn_reader(stderr, Arc::clone(&output));

    *guard = Some(TerminalSession {
        child,
        stdin,
        output,
        shell: program.clone(),
    });

    Ok(format!("Started {program} in {}.", cwd.display()))
}

#[tauri::command]
pub fn terminal_write(terminal: State<TerminalState>, input: String) -> Result<String, String> {
    let mut guard = terminal.0.lock().map_err(|_| "terminal lock poisoned")?;
    let session = guard.as_mut().ok_or("no terminal session is running")?;
    session
        .stdin
        .write_all(input.as_bytes())
        .map_err(|e| format!("write terminal stdin: {e}"))?;
    session
        .stdin
        .flush()
        .map_err(|e| format!("flush terminal stdin: {e}"))?;
    Ok("Wrote to terminal.".to_string())
}

#[tauri::command]
pub fn terminal_send_line(terminal: State<TerminalState>, line: String) -> Result<String, String> {
    let newline = if cfg!(windows) { "\r\n" } else { "\n" };
    terminal_write(terminal, format!("{line}{newline}"))
}

#[tauri::command]
pub fn terminal_read(terminal: State<TerminalState>) -> Result<String, String> {
    let guard = terminal.0.lock().map_err(|_| "terminal lock poisoned")?;
    let session = guard.as_ref().ok_or("no terminal session is running")?;
    let mut output = session.output.lock().map_err(|_| "output lock poisoned")?;
    if output.is_empty() {
        return Ok("No new terminal output.".to_string());
    }
    let text = output.clone();
    output.clear();
    Ok(text)
}

#[tauri::command]
pub fn terminal_wait_for_output(
    terminal: State<TerminalState>,
    timeout_ms: Option<u64>,
) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.unwrap_or(1500).min(30_000));
    loop {
        {
            let guard = terminal.0.lock().map_err(|_| "terminal lock poisoned")?;
            let session = guard.as_ref().ok_or("no terminal session is running")?;
            let mut output = session.output.lock().map_err(|_| "output lock poisoned")?;
            if !output.is_empty() {
                let text = output.clone();
                output.clear();
                return Ok(text);
            }
        }

        if Instant::now() >= deadline {
            return Ok("No terminal output before timeout.".to_string());
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[tauri::command]
pub fn terminal_interrupt(terminal: State<TerminalState>) -> Result<String, String> {
    terminal_write(terminal, "\u{3}".to_string())
}

#[tauri::command]
pub fn terminal_stop(terminal: State<TerminalState>) -> Result<String, String> {
    let mut guard = terminal.0.lock().map_err(|_| "terminal lock poisoned")?;
    if let Some(mut session) = guard.take() {
        let _ = session.child.kill();
        return Ok("Stopped terminal.".to_string());
    }
    Ok("No terminal session was running.".to_string())
}
