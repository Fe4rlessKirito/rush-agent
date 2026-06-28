// Real LSP client for Rush. Spawns a language server (rust-analyzer or
// typescript-language-server), speaks JSON-RPC over stdio with Content-Length
// framing, and exposes definition/references/rename through it. This mirrors the
// spawn-and-pipe pattern in terminal_commands.rs but adds proper JSON-RPC
// request/response correlation by id.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

#[derive(Clone)]
struct LspCommand {
    bin: String,
    args: Vec<String>,
    source: &'static str,
}

/// One running language-server connection.
struct LspServer {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    next_id: AtomicI64,
    opened_documents: Mutex<HashMap<String, i32>>,
    // request id -> response result (or error). Filled by the reader thread.
    pending: Arc<(Mutex<HashMap<i64, Value>>, Condvar)>,
}

#[derive(Default)]
pub struct LspState {
    // normalized language key ("rust" | "typescript") -> server
    servers: Mutex<HashMap<String, Arc<LspServer>>>,
}

fn write_message(stdin: &Mutex<ChildStdin>, msg: &Value) -> Result<(), String> {
    let body = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    let header = format!("Content-Length: {}\r\n\r\n", body.as_bytes().len());
    let mut guard = stdin.lock().map_err(|e| e.to_string())?;
    guard
        .write_all(header.as_bytes())
        .map_err(|e| e.to_string())?;
    guard
        .write_all(body.as_bytes())
        .map_err(|e| e.to_string())?;
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

    fn shutdown(&self) {
        let _ = self.request("shutdown", Value::Null, Duration::from_secs(3));
        let _ = self.notify("exit", json!({}));
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
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

fn normalize_language(language: &str) -> Result<String, String> {
    match language.trim().to_ascii_lowercase().as_str() {
        "rust" | "rs" => Ok("rust".to_string()),
        "typescript" | "ts" | "tsx" | "javascript" | "js" | "jsx" => Ok("typescript".to_string()),
        other => Err(format!("unsupported language for LSP: {}", other)),
    }
}

fn bundled_binary_path(language: &str) -> Option<PathBuf> {
    let file_name = match language {
        "rust" => {
            #[cfg(windows)]
            {
                "rust-analyzer.exe"
            }
            #[cfg(not(windows))]
            {
                "rust-analyzer"
            }
        }
        "typescript" => {
            #[cfg(windows)]
            {
                "typescript-language-server.cmd"
            }
            #[cfg(not(windows))]
            {
                "typescript-language-server"
            }
        }
        _ => return None,
    };
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    [
        exe_dir.join("language-servers").join(file_name),
        exe_dir
            .join("resources")
            .join("language-servers")
            .join(file_name),
    ]
    .into_iter()
    .find(|path| path.exists())
}

fn command_from_path(language: &str, path: PathBuf, source: &'static str) -> LspCommand {
    let path_text = path.to_string_lossy().to_string();
    let mut args = if language == "typescript" {
        vec!["--stdio".to_string()]
    } else {
        vec![]
    };

    #[cfg(windows)]
    {
        let extension = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if extension == "cmd" || extension == "bat" {
            let mut cmd_args = vec!["/C".to_string(), path_text];
            cmd_args.append(&mut args);
            return LspCommand {
                bin: "cmd".to_string(),
                args: cmd_args,
                source,
            };
        }
    }

    LspCommand {
        bin: path_text,
        args,
        source,
    }
}

fn path_command(language: &str) -> Result<LspCommand, String> {
    match language {
        "rust" => Ok(LspCommand {
            bin: "rust-analyzer".to_string(),
            args: vec![],
            source: "path",
        }),
        "typescript" => {
            // On Windows the npm shim is typescript-language-server.cmd, resolved via PATH.
            #[cfg(windows)]
            return Ok(LspCommand {
                bin: "cmd".to_string(),
                args: vec![
                    "/C".to_string(),
                    "typescript-language-server".to_string(),
                    "--stdio".to_string(),
                ],
                source: "path",
            });

            #[cfg(not(windows))]
            return Ok(LspCommand {
                bin: "typescript-language-server".to_string(),
                args: vec!["--stdio".to_string()],
                source: "path",
            });
        }
        other => Err(format!("unsupported language for LSP: {}", other)),
    }
}

fn binary_for(
    language: &str,
    binary_path: Option<String>,
    prefer_bundled: Option<bool>,
) -> Result<LspCommand, String> {
    if let Some(path) = binary_path
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
    {
        return Ok(command_from_path(language, PathBuf::from(path), "custom"));
    }
    if prefer_bundled.unwrap_or(false) {
        if let Some(path) = bundled_binary_path(language) {
            return Ok(command_from_path(language, path, "bundled"));
        }
    }
    path_command(language)
}

#[tauri::command]
pub fn lsp_start(
    state: tauri::State<LspState>,
    language: String,
    root_path: String,
    binary_path: Option<String>,
    prefer_bundled: Option<bool>,
) -> Result<Value, String> {
    let language = normalize_language(&language)?;
    {
        let servers = state.servers.lock().map_err(|e| e.to_string())?;
        if servers.contains_key(&language) {
            return Ok(json!({"status": "already_running", "language": language}));
        }
    }

    let command = binary_for(&language, binary_path, prefer_bundled)?;
    let mut cmd = Command::new(&command.bin);
    cmd.args(&command.args)
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
        .map_err(|e| format!("failed to spawn {}: {}", command.bin, e))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;

    let pending: Arc<(Mutex<HashMap<i64, Value>>, Condvar)> =
        Arc::new((Mutex::new(HashMap::new()), Condvar::new()));
    spawn_reader(stdout, pending.clone());

    let root_uri = path_to_uri(&root_path);
    let server = Arc::new(LspServer {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        next_id: AtomicI64::new(1),
        opened_documents: Mutex::new(HashMap::new()),
        pending,
    });

    // initialize handshake
    let init_params = json!({
        "processId": std::process::id(),
        "rootUri": root_uri.clone(),
        "workspaceFolders": [{"uri": root_uri, "name": "workspace"}],
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

    let caps = init_result
        .get("capabilities")
        .cloned()
        .unwrap_or(Value::Null);

    state
        .servers
        .lock()
        .map_err(|e| e.to_string())?
        .insert(language.clone(), server);

    Ok(
        json!({"status": "initialized", "language": language, "source": command.source, "command": command.bin, "capabilities": caps}),
    )
}

#[tauri::command]
pub fn lsp_probe(
    language: String,
    binary_path: Option<String>,
    prefer_bundled: Option<bool>,
) -> Result<Value, String> {
    let language = normalize_language(&language)?;
    let command = binary_for(&language, binary_path, prefer_bundled)?;
    let mut probe_args: Vec<String> = command
        .args
        .iter()
        .filter(|arg| arg.as_str() != "--stdio")
        .cloned()
        .collect();
    probe_args.push("--version".to_string());
    let output = Command::new(&command.bin).args(&probe_args).output();
    match output {
        Ok(result) => {
            let stdout = String::from_utf8_lossy(&result.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
            Ok(json!({
                "language": language,
                "available": result.status.success(),
                "source": command.source,
                "command": command.bin,
                "version": if stdout.is_empty() { stderr } else { stdout },
                "error": if result.status.success() { Value::Null } else { json!(format!("exited with {}", result.status)) }
            }))
        }
        Err(err) => Ok(json!({
            "language": language,
            "available": false,
            "source": command.source,
            "command": command.bin,
            "version": "",
            "error": err.to_string()
        })),
    }
}

fn get_server(state: &tauri::State<LspState>, language: &str) -> Result<Arc<LspServer>, String> {
    let language = normalize_language(language)?;
    state
        .servers
        .lock()
        .map_err(|e| e.to_string())?
        .get(&language)
        .cloned()
        .ok_or_else(|| format!("LSP for '{}' not started", language))
}

fn language_id_for(file_path: &str) -> &'static str {
    if file_path.ends_with(".rs") {
        "rust"
    } else if file_path.ends_with(".ts") || file_path.ends_with(".tsx") {
        "typescript"
    } else if file_path.ends_with(".js") || file_path.ends_with(".jsx") {
        "javascript"
    } else {
        "plaintext"
    }
}

fn sync_document(server: &LspServer, file_path: &str) -> Result<(), String> {
    let text = std::fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let uri = path_to_uri(file_path);
    let version = {
        let mut opened = server.opened_documents.lock().map_err(|e| e.to_string())?;
        let current = opened.entry(uri.clone()).or_insert(0);
        *current += 1;
        *current
    };

    if version == 1 {
        server.notify(
            "textDocument/didOpen",
            json!({"textDocument": {
                "uri": uri,
                "languageId": language_id_for(file_path),
                "version": version,
                "text": text
            }}),
        )
    } else {
        server.notify(
            "textDocument/didChange",
            json!({
                "textDocument": {"uri": uri, "version": version},
                "contentChanges": [{"text": text}]
            }),
        )
    }
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
    sync_document(&server, &file_path)?;
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
    sync_document(&server, &file_path)?;
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
    sync_document(&server, &file_path)?;
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
    let language = normalize_language(&language)?;
    let removed = state
        .servers
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&language);
    let stopped = removed.is_some();
    if let Some(server) = removed {
        server.shutdown();
    }
    Ok(json!({"stopped": stopped, "language": language}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_language_aliases() {
        assert_eq!(normalize_language("ts").unwrap(), "typescript");
        assert_eq!(normalize_language("JSX").unwrap(), "typescript");
        assert_eq!(normalize_language("rs").unwrap(), "rust");
    }

    #[test]
    fn rejects_unsupported_language() {
        assert!(normalize_language("python").is_err());
    }

    #[test]
    fn uses_custom_binary_path_when_provided() {
        let command = binary_for(
            "rust",
            Some("C:/tools/rust-analyzer.exe".to_string()),
            Some(true),
        )
        .unwrap();
        assert_eq!(command.source, "custom");
        assert!(command.bin.contains("rust-analyzer"));
    }

    #[test]
    fn maps_language_ids_from_file_names() {
        assert_eq!(language_id_for("src/main.rs"), "rust");
        assert_eq!(language_id_for("src/App.tsx"), "typescript");
        assert_eq!(language_id_for("src/app.jsx"), "javascript");
        assert_eq!(language_id_for("README.md"), "plaintext");
    }
}
