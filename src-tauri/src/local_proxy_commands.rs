use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
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
    url: String,
    path: Option<String>,
    error: Option<String>,
}

fn set_status(state: &LocalProxyState, patch: impl FnOnce(&mut LocalProxyStatus)) {
    if let Ok(mut status) = state.status.lock() {
        patch(&mut status);
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

    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let candidates = [
        resource_dir.join("local-proxy"),
        resource_dir.join("_up_").join("local-proxy"),
    ];
    for bundled in candidates {
        if bundled.exists() {
            return Ok(bundled);
        }
    }

    Err(format!(
        "bundled local proxy not found under {}",
        resource_dir.display()
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
    let start_bat = proxy_dir.join("start-rush.bat");
    if !start_bat.exists() {
        return Err(format!("start-rush.bat not found at {}", start_bat.display()));
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
    if health_ready() {
        set_status(&state, |status| {
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
            status.error = Some("local proxy did not become ready on http://localhost:8000/health".to_string());
        });
    });
}

#[tauri::command]
pub fn local_proxy_status(state: tauri::State<LocalProxyState>) -> Result<LocalProxyStatus, String> {
    if health_ready() {
        set_status(&state, |status| {
            status.running = true;
            status.ready = true;
            status.error = None;
        });
    }
    state.status.lock().map(|s| s.clone()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn local_proxy_restart(app: AppHandle) -> Result<LocalProxyStatus, String> {
    let state = app.state::<LocalProxyState>();
    if let Ok(mut child) = state.child.lock() {
        if let Some(mut child) = child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    start_local_proxy(app.clone());
    local_proxy_status(app.state::<LocalProxyState>())
}
