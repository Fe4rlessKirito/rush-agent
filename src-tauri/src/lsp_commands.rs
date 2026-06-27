// Real LSP client for Rush. Spawns a language server (rust-analyzer or
// typescript-language-server), speaks JSON-RPC over stdio with Content-Length
// framing, and exposes definition/references/rename through it. This mirrors the
// spawn-and-pipe pattern in terminal_commands.rs but adds proper JSON-RPC
// request/response correlation by id.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// One running language-server connection.
struct LspServer {
    _child: Child,
    stdin: Mutex<ChildStdin>,
    next_id: AtomicI64,
    // request id -> response result (or error). Filled by the reader thread.
    pending: Arc<(Mutex<HashMap<i64, Value>>, Condvar)>,
}

#[derive(Default)]
pub struct LspState {
    // language key ("rust" | "typescript") -> server
    servers: Mutex<HashMap<String, Arc<LspServer>>>,
}

fn write_message(stdin: &Mutex<ChildStdin>, msg: &Value) -> Result<(), String> {
    let body = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    let header = format!("Content-Length: {}\r\n\r\n", body.as_bytes().len());
    let mut guard = stdin.lock().map_err(|e| e.to_string())?;
    guard
        .write_all(header.as_bytes())
        .map_err(|e| e.to_string())?;
    guard.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    guard.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Reader thread: parse Content-Length framed JSON-RPC messages, route responses
/// (those with an `id`) into the pending map and wake any waiter.
fn spawn_reader<R: Read + Send + 'static>(
    reader: R,
    pending: Arc<(Mutex<HashMap<i64, Value>>, Condvar)>,
) {
    std::thread::spawn(move || {
        let mut buf = BufReader::new(reader);
        loop {
            // Read headers up to the blank line.
            let mut content_length: usize = 0;
            loop {
                let mut line = String::new();
                match buf.read_line(&mut line) {
                    Ok(0) => return, // EOF: server exited
                    Ok(_) => {}
                    Err(_) => return,
                }
                let trimmed = line.trim_end();
                if trimmed.is_empty() {
                    break; // end of headers
                }
                if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
                    content_length = rest.trim().parse().unwrap_or(0);
                }
            }
            if content_length == 0 {
                continue;
            }
            let mut body = vec![0u8; content_length];
            if buf.read_exact(&mut body).is_err() {
                return;
            }
            let parsed: Value = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(_) => continue,
            };
            // Only correlate responses that carry a numeric id. Notifications and
            // server-initiated requests are ignored for this slice.
            if let Some(id) = parsed.get("id").and_then(|v| v.as_i64()) {
                let (lock, cvar) = &*pending;
                if let Ok(mut map) = lock.lock() {
                    map.insert(id, parsed);
                    cvar.notify_all();
                }
            }
        }
    });
}

impl LspServer {
    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let msg = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        write_message(&self.stdin, &msg)?;

        let (lock, cvar) = &*self.pending;
        let deadline = Instant::now() + timeout;
        let mut map = lock.lock().map_err(|e| e.to_string())?;
        loop {
            if let Some(resp) = map.remove(&id) {
                if let Some(err) = resp.get("error") {
                    return Err(format!("LSP error: {}", err));
                }
                return Ok(resp.get("result").cloned().unwrap_or(Value::Null));
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(format!("LSP request '{}' timed out", method));
            }
            let (g, _) = cvar
                .wait_timeout(map, deadline - now)
                .map_err(|e| e.to_string())?;
            map = g;
        }
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let msg = json!({"jsonrpc": "2.0", "method": method, "params": params});
        write_message(&self.stdin, &msg)
    }
}

fn path_to_uri(path: &str) -> String {
    // Minimal file URI for Windows-style paths. Good enough for the handshake
    // and document sync; a full RFC 3986 encoder can come later.
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/') {
        format!("file://{}", normalized)
    } else {
        format!("file:///{}", normalized)
    }
}

fn binary_for(language: &str) -> Result<(String, Vec<String>), String> {
    match language {
        "rust" => Ok(("rust-analyzer".to_string(), vec![])),
        "typescript" | "ts" | "javascript" | "js" => {
            // On Windows the npm shim is typescript-language-server.cmd, resolved via PATH.
            Ok(("typescript-language-server".to_string(), vec!["--stdio".to_string()]))
        }
        other => Err(format!("unsupported language for LSP: {}", other)),
    }
}

#[tauri::command]
pub fn lsp_start(
    state: tauri::State<LspState>,
    language: String,
    root_path: String,
) -> Result<Value, String> {
    {
        let servers = state.servers.lock().map_err(|e| e.to_string())?;
        if servers.contains_key(&language) {
            return Ok(json!({"status": "already_running", "language": language}));
        }
    }

    let (bin, args) = binary_for(&language)?;
    let mut cmd = Command::new(&bin);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        // Allow PATH resolution of .cmd shims (typescript-language-server.cmd).
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {}", bin, e))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;

    let pending: Arc<(Mutex<HashMap<i64, Value>>, Condvar)> =
        Arc::new((Mutex::new(HashMap::new()), Condvar::new()));
    spawn_reader(stdout, pending.clone());

    let root_uri = path_to_uri(&root_path);
    let server = Arc::new(LspServer {
        _child: child,
        stdin: Mutex::new(stdin),
        next_id: AtomicI64::new(1),
        pending,
    });

    // initialize handshake
    let init_params = json!({
        "processId": std::process::id(),
        "rootUri": root_uri,
        "capabilities": {
            "textDocument": {
                "definition": {"dynamicRegistration": false},
                "references": {"dynamicRegistration": false},
                "rename": {"dynamicRegistration": false}
            }
        }
    });
    let init_result = server.request("initialize", init_params, Duration::from_secs(30))?;
    server.notify("initialized", json!({}))?;

    let caps = init_result.get("capabilities").cloned().unwrap_or(Value::Null);

    state
        .servers
        .lock()
        .map_err(|e| e.to_string())?
        .insert(language.clone(), server);

    Ok(json!({"status": "initialized", "language": language, "capabilities": caps}))
}

fn get_server(
    state: &tauri::State<LspState>,
    language: &str,
) -> Result<Arc<LspServer>, String> {
    state
        .servers
        .lock()
        .map_err(|e| e.to_string())?
        .get(language)
        .cloned()
        .ok_or_else(|| format!("LSP for '{}' not started", language))
}

fn did_open(server: &LspServer, file_path: &str) -> Result<(), String> {
    let text = std::fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let language_id = if file_path.ends_with(".rs") {
        "rust"
    } else if file_path.ends_with(".ts") || file_path.ends_with(".tsx") {
        "typescript"
    } else {
        "plaintext"
    };
    server.notify(
        "textDocument/didOpen",
        json!({"textDocument": {
            "uri": path_to_uri(file_path),
            "languageId": language_id,
            "version": 1,
            "text": text
        }}),
    )
}

#[tauri::command]
pub fn lsp_definition(
    state: tauri::State<LspState>,
    language: String,
    file_path: String,
    line: u32,
    character: u32,
) -> Result<Value, String> {
    let server = get_server(&state, &language)?;
    did_open(&server, &file_path)?;
    server.request(
        "textDocument/definition",
        json!({
            "textDocument": {"uri": path_to_uri(&file_path)},
            "position": {"line": line, "character": character}
        }),
        Duration::from_secs(20),
    )
}

#[tauri::command]
pub fn lsp_references(
    state: tauri::State<LspState>,
    language: String,
    file_path: String,
    line: u32,
    character: u32,
) -> Result<Value, String> {
    let server = get_server(&state, &language)?;
    did_open(&server, &file_path)?;
    server.request(
        "textDocument/references",
        json!({
            "textDocument": {"uri": path_to_uri(&file_path)},
            "position": {"line": line, "character": character},
            "context": {"includeDeclaration": true}
        }),
        Duration::from_secs(20),
    )
}

#[tauri::command]
pub fn lsp_rename(
    state: tauri::State<LspState>,
    language: String,
    file_path: String,
    line: u32,
    character: u32,
    new_name: String,
) -> Result<Value, String> {
    let server = get_server(&state, &language)?;
    did_open(&server, &file_path)?;
    server.request(
        "textDocument/rename",
        json!({
            "textDocument": {"uri": path_to_uri(&file_path)},
            "position": {"line": line, "character": character},
            "newName": new_name
        }),
        Duration::from_secs(20),
    )
}

#[tauri::command]
pub fn lsp_stop(state: tauri::State<LspState>, language: String) -> Result<Value, String> {
    let removed = state
        .servers
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&language)
        .is_some();
    Ok(json!({"stopped": removed, "language": language}))
}
