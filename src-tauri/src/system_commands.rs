use std::process::Command;

use serde::Serialize;

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_: &mut Command) {}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("unsupported URL: {url}"));
    }

    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", url]);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(url);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    };

    hide_window(&mut command);
    command
        .spawn()
        .map_err(|e| format!("failed to open URL: {e}"))?;
    Ok(())
}

#[derive(Serialize)]
pub struct ProcessMemoryEntry {
    pid: u32,
    parent_pid: u32,
    name: String,
    memory_bytes: u64,
}

#[derive(Serialize)]
pub struct ProcessMemoryReport {
    root_pid: u32,
    total_bytes: u64,
    processes: Vec<ProcessMemoryEntry>,
}

struct ProcessRow {
    pid: u32,
    parent_pid: u32,
    name: String,
    memory_bytes: u64,
}

#[cfg(windows)]
fn process_rows() -> Result<Vec<ProcessRow>, String> {
    let script = "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)|$($_.ParentProcessId)|$($_.WorkingSetSize)|$($_.Name)\" }";
    let mut command = Command::new("powershell");
    command.args(["-NoLogo", "-NoProfile", "-Command", script]);
    hide_window(&mut command);
    let output = command
        .output()
        .map_err(|e| format!("failed to query process memory: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text.lines().filter_map(parse_process_row).collect())
}

#[cfg(not(windows))]
fn process_rows() -> Result<Vec<ProcessRow>, String> {
    let output = Command::new("ps")
        .args(["-eo", "pid=,ppid=,rss=,comm="])
        .output()
        .map_err(|e| format!("failed to query process memory: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let parent_pid = parts.next()?.parse().ok()?;
            let rss_kib: u64 = parts.next()?.parse().ok()?;
            let name = parts.collect::<Vec<_>>().join(" ");
            Some(ProcessRow {
                pid,
                parent_pid,
                name,
                memory_bytes: rss_kib.saturating_mul(1024),
            })
        })
        .collect())
}

fn parse_process_row(line: &str) -> Option<ProcessRow> {
    let mut parts = line.splitn(4, '|');
    let pid = parts.next()?.trim().parse().ok()?;
    let parent_pid = parts.next()?.trim().parse().ok()?;
    let memory_bytes = parts.next()?.trim().parse().unwrap_or(0);
    let name = parts.next()?.trim().to_string();
    Some(ProcessRow {
        pid,
        parent_pid,
        name,
        memory_bytes,
    })
}

fn is_descendant(pid: u32, root_pid: u32, rows: &[ProcessRow]) -> bool {
    if pid == root_pid {
        return true;
    }
    let mut current = pid;
    for _ in 0..64 {
        let Some(row) = rows.iter().find(|item| item.pid == current) else {
            return false;
        };
        if row.parent_pid == root_pid {
            return true;
        }
        if row.parent_pid == 0 || row.parent_pid == current {
            return false;
        }
        current = row.parent_pid;
    }
    false
}

#[tauri::command]
pub fn process_memory_status() -> Result<ProcessMemoryReport, String> {
    let root_pid = std::process::id();
    let rows = process_rows()?;
    let mut processes: Vec<ProcessMemoryEntry> = rows
        .iter()
        .filter(|row| is_descendant(row.pid, root_pid, &rows))
        .map(|row| ProcessMemoryEntry {
            pid: row.pid,
            parent_pid: row.parent_pid,
            name: row.name.clone(),
            memory_bytes: row.memory_bytes,
        })
        .collect();
    processes.sort_by(|a, b| b.memory_bytes.cmp(&a.memory_bytes));
    let total_bytes = processes.iter().map(|entry| entry.memory_bytes).sum();
    Ok(ProcessMemoryReport {
        root_pid,
        total_bytes,
        processes,
    })
}
