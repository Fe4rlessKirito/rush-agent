use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use std::{env, fmt::Write as _};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const PROXY_URL: &str = "http://localhost:8000";

pub struct LocalProxyState {
    child: Mutex<Option<Child>>,
    status: Mutex<LocalProxyStatus>,
}

impl Default for LocalProxyState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            status: Mutex::new(LocalProxyStatus {
                running: false,
                ready: false,
                enabled: true,
                url: PROXY_URL.to_string(),
                path: None,
                error: None,
            }),
        }
    }
}

impl Drop for LocalProxyState {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut child) = child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[derive(Clone, Serialize)]
pub struct LocalProxyStatus {
    running: bool,
    ready: bool,
    enabled: bool,
    url: String,
    path: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct LocalProxyConfig {
    enabled: bool,
}

impl Default for LocalProxyConfig {
    fn default() -> Self {
        Self { enabled: true }
    }
}

fn set_status(state: &LocalProxyState, patch: impl FnOnce(&mut LocalProxyStatus)) {
    if let Ok(mut status) = state.status.lock() {
        patch(&mut status);
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("local-proxy.json"))
}

fn read_config(app: &AppHandle) -> LocalProxyConfig {
    let Ok(path) = config_path(app) else {
        return LocalProxyConfig::default();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return LocalProxyConfig::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_config(app: &AppHandle, config: &LocalProxyConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

fn stop_owned_proxy(state: &LocalProxyState) {
    if let Ok(mut child) = state.child.lock() {
        if let Some(mut child) = child.take() {
            #[cfg(windows)]
            {
                let mut command = Command::new("taskkill");
                command
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                command.creation_flags(CREATE_NO_WINDOW);
                let _ = command.status();
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn proxy_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("local-proxy"))
        .filter(|p| p.exists());
    if let Some(path) = dev_path {
        return Ok(path);
    }

    let mut bases = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        bases.push(resource_dir.clone());
        if let Some(parent) = resource_dir.parent() {
            bases.push(parent.to_path_buf());
        }
    }
    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            bases.push(exe_dir.to_path_buf());
        }
    }

    let mut searched = String::new();
    for base in bases {
        for bundled in [
            base.join("local-proxy"),
            base.join("_up_").join("local-proxy"),
        ] {
            let _ = writeln!(&mut searched, "- {}", bundled.display());
            if bundled.join("leech-rs.exe").exists() || bundled.join("start-rush.bat").exists() {
                return Ok(bundled);
            }
        }
    }

    Err(format!(
        "bundled local proxy not found. Searched:\n{}",
        searched.trim_end()
    ))
}

fn health_ready() -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &"127.0.0.1:8000".parse().expect("valid local proxy address"),
        Duration::from_millis(400),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    let request = b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
    if stream.write_all(request).is_err() {
        return false;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

fn spawn_proxy(proxy_dir: PathBuf) -> Result<Child, String> {
    let rust_proxy = proxy_dir.join("leech-rs.exe");
    if rust_proxy.exists() {
        let mut command = Command::new(&rust_proxy);
        command
            .current_dir(&proxy_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        return command
            .spawn()
            .map_err(|e| format!("failed to start Rust local proxy: {e}"));
    }

    let start_bat = proxy_dir.join("start-rush.bat");
    if !start_bat.exists() {
        return Err(format!(
            "local proxy launcher not found. Expected {} or {}",
            rust_proxy.display(),
            start_bat.display()
        ));
    }

    let mut command = Command::new("cmd");
    command
        .args(["/C", "start-rush.bat"])
        .current_dir(&proxy_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
        .spawn()
        .map_err(|e| format!("failed to start local proxy: {e}"))
}

pub fn start_local_proxy(app: AppHandle) {
    let state = app.state::<LocalProxyState>();
    if !read_config(&app).enabled {
        stop_owned_proxy(&state);
        set_status(&state, |status| {
            status.enabled = false;
            status.running = false;
            status.ready = false;
            status.error = None;
        });
        return;
    }

    if health_ready() {
        set_status(&state, |status| {
            status.enabled = true;
            status.running = true;
            status.ready = true;
            status.error = None;
        });
        return;
    }

    let proxy_dir = match proxy_dir(&app) {
        Ok(path) => path,
        Err(err) => {
            set_status(&state, |status| {
                status.enabled = true;
                status.running = false;
                status.ready = false;
                status.error = Some(err);
            });
            return;
        }
    };

    let child = match spawn_proxy(proxy_dir.clone()) {
        Ok(child) => child,
        Err(err) => {
            set_status(&state, |status| {
                status.enabled = true;
                status.running = false;
                status.ready = false;
                status.path = Some(proxy_dir.display().to_string());
                status.error = Some(err);
            });
            return;
        }
    };

    if let Ok(mut slot) = state.child.lock() {
        *slot = Some(child);
    }
    set_status(&state, |status| {
        status.enabled = true;
        status.running = true;
        status.ready = false;
        status.path = Some(proxy_dir.display().to_string());
        status.error = None;
    });

    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if health_ready() {
                let state = app.state::<LocalProxyState>();
                set_status(&state, |status| {
                    status.enabled = true;
                    status.running = true;
                    status.ready = true;
                    status.error = None;
                });
                return;
            }
            thread::sleep(Duration::from_millis(500));
        }
        let state = app.state::<LocalProxyState>();
        set_status(&state, |status| {
            status.ready = false;
            status.error = Some(
                "local proxy did not become ready on http://localhost:8000/health".to_string(),
            );
        });
    });
}

#[tauri::command]
pub fn local_proxy_status(app: AppHandle) -> Result<LocalProxyStatus, String> {
    let state = app.state::<LocalProxyState>();
    let enabled = read_config(&app).enabled;
    if enabled && health_ready() {
        set_status(&state, |status| {
            status.enabled = true;
            status.running = true;
            status.ready = true;
            status.error = None;
        });
    } else if !enabled {
        set_status(&state, |status| {
            status.enabled = false;
            status.running = false;
            status.ready = false;
            status.error = None;
        });
    }
    state
        .status
        .lock()
        .map(|s| s.clone())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn local_proxy_restart(app: AppHandle) -> Result<LocalProxyStatus, String> {
    let state = app.state::<LocalProxyState>();
    stop_owned_proxy(&state);
    start_local_proxy(app.clone());
    local_proxy_status(app)
}

#[tauri::command]
pub fn local_proxy_set_enabled(app: AppHandle, enabled: bool) -> Result<LocalProxyStatus, String> {
    write_config(&app, &LocalProxyConfig { enabled })?;
    let state = app.state::<LocalProxyState>();
    if enabled {
        start_local_proxy(app.clone());
    } else {
        stop_owned_proxy(&state);
        set_status(&state, |status| {
            status.enabled = false;
            status.running = false;
            status.ready = false;
            status.error = None;
        });
    }
    local_proxy_status(app)
}
