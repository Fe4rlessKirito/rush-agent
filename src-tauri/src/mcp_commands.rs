use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::fs_commands::ProjectRoot;

pub struct McpSessionState(pub Mutex<HashMap<String, McpSession>>);

impl Default for McpSessionState {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

pub struct McpSession {
    child: Child,
    stdin: ChildStdin,
    rx: mpsc::Receiver<Value>,
    stderr: Arc<Mutex<String>>,
    next_id: i64,
}

impl Drop for McpSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[derive(Serialize)]
pub struct McpProbeResource {
    uri: String,
    name: Option<String>,
    description: Option<String>,
    mime_type: Option<String>,
    text: Option<String>,
}

#[derive(Serialize)]
pub struct McpProbeTool {
    name: String,
    description: Option<String>,
    input_schema: Option<Value>,
}

#[derive(Serialize)]
pub struct McpProbeResult {
    resources: Vec<McpProbeResource>,
    tools: Vec<McpProbeTool>,
    stderr: String,
}

#[derive(Serialize)]
pub struct McpToolCallResult {
    content: String,
    is_error: bool,
    raw: Value,
    stderr: String,
}

#[derive(Serialize)]
pub struct McpStopResult {
    id: String,
    stderr: String,
}

fn project_dir(root: &State<ProjectRoot>) -> Result<std::path::PathBuf, String> {
    let guard = root.0.lock().map_err(|_| "root lock poisoned")?;
    if let Some(path) = guard.as_ref() {
        return Ok(path.clone());
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

fn append_stderr(output: &Arc<Mutex<String>>, text: &str) {
    let Ok(mut buf) = output.lock() else {
        return;
    };
    buf.push_str(text);
    if buf.len() > 20_000 {
        let excess = buf.len() - 20_000;
        buf.drain(..excess);
    }
}

fn read_framed_message<R: Read>(reader: &mut BufReader<R>) -> Result<Value, String> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("read header: {e}"))?;
        if n == 0 {
            return Err("MCP server closed stdout".to_string());
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = Some(
                    value
                        .trim()
                        .parse::<usize>()
                        .map_err(|e| format!("bad content-length: {e}"))?,
                );
            }
        }
    }

    let len = content_length.ok_or("missing content-length")?;
    let mut body = vec![0_u8; len];
    reader
        .read_exact(&mut body)
        .map_err(|e| format!("read body: {e}"))?;
    serde_json::from_slice(&body).map_err(|e| format!("parse json-rpc body: {e}"))
}

fn write_framed_message<W: Write>(writer: &mut W, value: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|e| format!("serialize json-rpc: {e}"))?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())
        .map_err(|e| format!("write header: {e}"))?;
    writer
        .write_all(&body)
        .map_err(|e| format!("write body: {e}"))?;
    writer.flush().map_err(|e| format!("flush mcp stdin: {e}"))
}

fn wait_for_id(rx: &mpsc::Receiver<Value>, id: i64, timeout: Duration) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(format!("timed out waiting for MCP response {id}"));
        }
        let remaining = deadline.saturating_duration_since(now);
        let msg = rx
            .recv_timeout(remaining.min(Duration::from_millis(250)))
            .map_err(|_| format!("timed out waiting for MCP response {id}"))?;
        if msg.get("id").and_then(Value::as_i64) == Some(id) {
            return Ok(msg);
        }
    }
}

fn parse_resources(response: &Value) -> Vec<McpProbeResource> {
    response
        .get("result")
        .and_then(|r| r.get("resources"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(McpProbeResource {
                        uri: item.get("uri")?.as_str()?.to_string(),
                        name: item.get("name").and_then(Value::as_str).map(str::to_string),
                        description: item
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        mime_type: item
                            .get("mimeType")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        text: item.get("text").and_then(Value::as_str).map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_tools(response: &Value) -> Vec<McpProbeTool> {
    response
        .get("result")
        .and_then(|r| r.get("tools"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(McpProbeTool {
                        name: item.get("name")?.as_str()?.to_string(),
                        description: item
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        input_schema: item
                            .get("inputSchema")
                            .or_else(|| item.get("input_schema"))
                            .cloned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn spawn_mcp(
    root: State<ProjectRoot>,
    command: String,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
) -> Result<
    (
        std::process::Child,
        std::process::ChildStdin,
        mpsc::Receiver<Value>,
        Arc<Mutex<String>>,
    ),
    String,
> {
    let command = command.trim();
    if command.is_empty() {
        return Err("command is required".to_string());
    }
    let cwd = project_dir(&root)?;
    let mut cmd = Command::new(command);
    cmd.args(args.unwrap_or_default())
        .envs(env.unwrap_or_default())
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to start MCP server {command}: {e}"))?;

    let stdin = child.stdin.take().ok_or("failed to capture MCP stdin")?;
    let stdout = child.stdout.take().ok_or("failed to capture MCP stdout")?;
    let stderr = child.stderr.take().ok_or("failed to capture MCP stderr")?;
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    let stderr_target = Arc::clone(&stderr_buf);
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        while reader.read_line(&mut line).unwrap_or(0) > 0 {
            append_stderr(&stderr_target, &line);
            line.clear();
        }
    });

    let (tx, rx) = mpsc::channel::<Value>();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Ok(msg) = read_framed_message(&mut reader) {
            if tx.send(msg).is_err() {
                break;
            }
        }
    });

    Ok((child, stdin, rx, stderr_buf))
}

fn initialize_mcp(
    child: &mut std::process::Child,
    stdin: &mut std::process::ChildStdin,
    rx: &mpsc::Receiver<Value>,
    timeout: Duration,
) -> Result<(), String> {
    write_framed_message(
        stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "Rush Agent", "version": "0.10.0" }
            }
        }),
    )?;
    let init = wait_for_id(rx, 1, timeout)?;
    if let Some(error) = init.get("error") {
        let _ = child.kill();
        return Err(format!("MCP initialize failed: {error}"));
    }
    write_framed_message(
        stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }),
    )
}

fn result_content(result: &Value) -> String {
    let Some(content) = result
        .get("result")
        .and_then(|r| r.get("content"))
        .and_then(Value::as_array)
    else {
        return result
            .get("result")
            .map(Value::to_string)
            .unwrap_or_else(|| result.to_string());
    };
    content
        .iter()
        .map(|item| {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                text.to_string()
            } else if let Some(data) = item.get("data").and_then(Value::as_str) {
                data.to_string()
            } else {
                item.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn discover_mcp(
    stdin: &mut ChildStdin,
    rx: &mpsc::Receiver<Value>,
    timeout: Duration,
    start_id: i64,
) -> Result<(Vec<McpProbeResource>, Vec<McpProbeTool>, i64), String> {
    let resources_id = start_id;
    write_framed_message(
        stdin,
        &json!({ "jsonrpc": "2.0", "id": resources_id, "method": "resources/list", "params": {} }),
    )?;
    let resources_response = wait_for_id(rx, resources_id, timeout).ok();

    let tools_id = resources_id + 1;
    write_framed_message(
        stdin,
        &json!({ "jsonrpc": "2.0", "id": tools_id, "method": "tools/list", "params": {} }),
    )?;
    let tools_response = wait_for_id(rx, tools_id, timeout).ok();

    Ok((
        resources_response
            .as_ref()
            .map(parse_resources)
            .unwrap_or_default(),
        tools_response.as_ref().map(parse_tools).unwrap_or_default(),
        tools_id + 1,
    ))
}

#[tauri::command]
pub fn mcp_probe_stdio(
    root: State<ProjectRoot>,
    command: String,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    timeout_ms: Option<u64>,
) -> Result<McpProbeResult, String> {
    let (mut child, mut stdin, rx, stderr_buf) = spawn_mcp(root, command, args, env)?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(3_000).clamp(500, 15_000));
    initialize_mcp(&mut child, &mut stdin, &rx, timeout)?;
    let (resources, tools, _) = discover_mcp(&mut stdin, &rx, timeout, 2)?;

    let _ = child.kill();
    let stderr = stderr_buf.lock().map(|buf| buf.clone()).unwrap_or_default();
    Ok(McpProbeResult {
        resources,
        tools,
        stderr,
    })
}

#[tauri::command]
pub fn mcp_call_tool_stdio(
    root: State<ProjectRoot>,
    command: String,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    tool_name: String,
    arguments: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<McpToolCallResult, String> {
    let tool_name = tool_name.trim();
    if tool_name.is_empty() {
        return Err("tool_name is required".to_string());
    }
    let (mut child, mut stdin, rx, stderr_buf) = spawn_mcp(root, command, args, env)?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(5_000).clamp(500, 30_000));
    initialize_mcp(&mut child, &mut stdin, &rx, timeout)?;

    write_framed_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments.unwrap_or_else(|| json!({}))
            }
        }),
    )?;
    let response = wait_for_id(&rx, 2, timeout)?;
    let _ = child.kill();
    let stderr = stderr_buf.lock().map(|buf| buf.clone()).unwrap_or_default();
    if let Some(error) = response.get("error") {
        return Ok(McpToolCallResult {
            content: format!("MCP tool error: {error}"),
            is_error: true,
            raw: response,
            stderr,
        });
    }
    let is_error = response
        .get("result")
        .and_then(|r| r.get("isError"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let content = result_content(&response);
    Ok(McpToolCallResult {
        content,
        is_error,
        raw: response,
        stderr,
    })
}

#[tauri::command]
pub fn mcp_start_stdio_session(
    state: State<McpSessionState>,
    root: State<ProjectRoot>,
    id: String,
    command: String,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    timeout_ms: Option<u64>,
) -> Result<McpProbeResult, String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("id is required".to_string());
    }
    {
        let mut guard = state.0.lock().map_err(|_| "mcp session lock poisoned")?;
        if let Some(mut old) = guard.remove(&id) {
            let _ = old.child.kill();
        }
    }

    let (mut child, mut stdin, rx, stderr_buf) = spawn_mcp(root, command, args, env)?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(3_000).clamp(500, 15_000));
    initialize_mcp(&mut child, &mut stdin, &rx, timeout)?;
    let (resources, tools, next_id) = discover_mcp(&mut stdin, &rx, timeout, 2)?;
    let stderr = stderr_buf.lock().map(|buf| buf.clone()).unwrap_or_default();

    let mut guard = state.0.lock().map_err(|_| "mcp session lock poisoned")?;
    guard.insert(
        id,
        McpSession {
            child,
            stdin,
            rx,
            stderr: stderr_buf,
            next_id,
        },
    );

    Ok(McpProbeResult {
        resources,
        tools,
        stderr,
    })
}

#[tauri::command]
pub fn mcp_call_tool_session(
    state: State<McpSessionState>,
    id: String,
    tool_name: String,
    arguments: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<McpToolCallResult, String> {
    let id = id.trim();
    let tool_name = tool_name.trim();
    if id.is_empty() {
        return Err("id is required".to_string());
    }
    if tool_name.is_empty() {
        return Err("tool_name is required".to_string());
    }

    let mut guard = state.0.lock().map_err(|_| "mcp session lock poisoned")?;
    let session = guard
        .get_mut(id)
        .ok_or_else(|| format!("MCP session is not running: {id}"))?;
    let call_id = session.next_id;
    session.next_id += 1;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(5_000).clamp(500, 30_000));

    write_framed_message(
        &mut session.stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": call_id,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments.unwrap_or_else(|| json!({}))
            }
        }),
    )?;
    let response = wait_for_id(&session.rx, call_id, timeout)?;
    let stderr = session
        .stderr
        .lock()
        .map(|buf| buf.clone())
        .unwrap_or_default();
    if let Some(error) = response.get("error") {
        return Ok(McpToolCallResult {
            content: format!("MCP tool error: {error}"),
            is_error: true,
            raw: response,
            stderr,
        });
    }
    let is_error = response
        .get("result")
        .and_then(|r| r.get("isError"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let content = result_content(&response);
    Ok(McpToolCallResult {
        content,
        is_error,
        raw: response,
        stderr,
    })
}

#[tauri::command]
pub fn mcp_stop_session(
    state: State<McpSessionState>,
    id: String,
) -> Result<McpStopResult, String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("id is required".to_string());
    }
    let mut guard = state.0.lock().map_err(|_| "mcp session lock poisoned")?;
    let mut session = guard
        .remove(&id)
        .ok_or_else(|| format!("MCP session is not running: {id}"))?;
    let _ = session.child.kill();
    let stderr = session
        .stderr
        .lock()
        .map(|buf| buf.clone())
        .unwrap_or_default();
    Ok(McpStopResult { id, stderr })
}
