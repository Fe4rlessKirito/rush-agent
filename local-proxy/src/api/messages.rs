//! Anthropic Messages API compatibility.

use axum::{
    extract::State,
    response::{IntoResponse, Response, Sse},
    Json,
};
use futures::StreamExt;
use serde::Deserialize;
use std::convert::Infallible;

use crate::account_pool::AccountPool;
use crate::models::resolve_model;
use crate::pool::acquire_direct_permit;
use crate::providers::{
    complete_completion, provider_for_model, requires_use_ai_account, stream_completion,
    CompletionRequest,
};

// Thinking level to budget (same as chat.rs)
const THINKING_LEVELS: &[(&str, usize)] = &[
    ("low", 1024),
    ("medium", 5000),
    ("high", 16000),
    ("max", 32000),
];

const TOOL_PROMPT: &str = r#"You may be given tools.

When tools are available and the task requires reading, searching, creating, editing, patching, or inspecting files, respond with one or more tool calls.

Rules:
- Output tool calls using the supported format below.
- You may include one short user-visible status line before the thinking/tool call sequence only when it adds meaningful progress, an assumption, or a blocker.
- Do not narrate routine reads, searches, edits, or obvious next steps.
- Do not say you lack tool access.
- Do not describe limitations.
- Do not wrap the tool call in markdown fences.
- Do not include any prose after a tool call.
- The tool call must be valid JSON.
- Escape backslashes in Windows paths.
- Escape quotes and newlines correctly in JSON strings.

Use this exact tool-call format:

<tool_use>
{"name":"tool_name","input":{"key":"value"}}
</tool_use>

If you need to communicate before continuing to tool calls, use this supported pattern:

Short user-visible status line.
<thinking>brief private reasoning about the next tool step</thinking>
<tool_use>
{"name":"tool_name","input":{"key":"value"}}
</tool_use>

After a tool result is provided, either output one or more next tool calls in the same format or answer the user normally if no more tools are needed."#;

#[derive(Debug, Deserialize)]
pub struct AnthropicRequest {
    pub model: String,
    pub messages: Vec<serde_json::Value>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub system: Option<serde_json::Value>,
    #[serde(default)]
    pub max_tokens: Option<usize>,
    #[serde(default)]
    pub thinking: Option<ThinkingParam>,
    #[serde(default)]
    pub tools: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub tool_choice: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum ThinkingParam {
    Bool(bool),
    Level(String),
    Object {
        #[serde(rename = "type")]
        type_: String,
        #[serde(default)]
        budget_tokens: Option<usize>,
    },
}

pub fn routes() -> axum::Router<AccountPool> {
    axum::Router::new().route("/messages", axum::routing::post(handler))
}

fn anthropic_session_id(req: &AnthropicRequest) -> String {
    req.metadata
        .as_ref()
        .and_then(|m| m.get("session_id").or_else(|| m.get("user_id")))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("default")
        .to_string()
}

fn tools_prompt(tools: &[serde_json::Value], tool_choice: Option<&serde_json::Value>) -> String {
    let mut prompt = String::from(TOOL_PROMPT);
    prompt.push_str("\n\nAvailable tools:\n");
    prompt.push_str(&serde_json::to_string_pretty(tools).unwrap_or_else(|_| "[]".to_string()));
    if let Some(choice) = tool_choice {
        prompt.push_str("\n\nTool choice:\n");
        prompt.push_str(&choice.to_string());
    }
    prompt
}

fn looks_like_tool_prompt(value: &serde_json::Value) -> bool {
    let text = value
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| value.to_string())
        .to_lowercase();

    text.contains("available tools")
        || text.contains("<tool_use>")
        || text.contains("tool_choice")
        || text.contains("tool call")
        || text.contains("function_call")
}

fn has_trusted_tool_prompt(messages: &[serde_json::Value]) -> bool {
    messages.iter().any(|message| {
        message
            .get("metadata")
            .and_then(|m| m.get("leech_proxy_tool_prompt"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    })
}

fn summarize_anthropic_messages(messages: &[serde_json::Value]) -> String {
    messages
        .iter()
        .enumerate()
        .map(|(idx, msg)| {
            let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("?");
            let content = msg
                .get("content")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let preview = content.to_string().chars().take(80).collect::<String>();
            format!("{}:{}:{}", idx, role, preview)
        })
        .collect::<Vec<_>>()
        .join(" | ")
}
fn convert_anthropic_content(content: Option<&serde_json::Value>) -> serde_json::Value {
    match content {
        Some(serde_json::Value::String(s)) => serde_json::Value::String(s.clone()),
        Some(serde_json::Value::Array(arr)) => {
            let parts = arr
                .iter()
                .filter_map(|item| match item.get("type").and_then(|v| v.as_str()) {
                    Some("text") => item.get("text").and_then(|v| v.as_str()).map(|text| {
                        serde_json::json!({
                            "type": "text",
                            "text": text,
                        })
                    }),
                    Some("image") => {
                        let source = item.get("source")?;
                        let media_type = source
                            .get("media_type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("image/png");
                        let data = source.get("data").and_then(|v| v.as_str())?;
                        Some(serde_json::json!({
                            "type": "image_url",
                            "image_url": {
                                "url": format!("data:{};base64,{}", media_type, data),
                            },
                            "filename": "image.png",
                        }))
                    }
                    Some("document") | Some("file") => {
                        let filename = item
                            .get("name")
                            .and_then(|v| v.as_str())
                            .or_else(|| item.get("filename").and_then(|v| v.as_str()))
                            .unwrap_or("file");
                        if let Some(source) = item.get("source").and_then(|v| v.as_object()) {
                            let media_type = source
                                .get("media_type")
                                .and_then(|v| v.as_str())
                                .or_else(|| item.get("media_type").and_then(|v| v.as_str()))
                                .unwrap_or("application/octet-stream");
                            if let Some(data) = source.get("data").and_then(|v| v.as_str()) {
                                Some(serde_json::json!({
                                    "type": "file",
                                    "file": {
                                        "data": format!("data:{};base64,{}", media_type, data),
                                        "filename": filename,
                                        "media_type": media_type,
                                    }
                                }))
                            } else if let Some(url) = source.get("url").and_then(|v| v.as_str()) {
                                Some(serde_json::json!({
                                    "type": "file",
                                    "file": {
                                        "url": url,
                                        "filename": filename,
                                        "media_type": media_type,
                                    }
                                }))
                            } else {
                                None
                            }
                        } else if let Some(url) = item.get("url").and_then(|v| v.as_str()) {
                            Some(serde_json::json!({
                                "type": "file",
                                "file": {
                                    "url": url,
                                    "filename": filename,
                                    "media_type": item
                                        .get("media_type")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("application/octet-stream"),
                                }
                            }))
                        } else {
                            None
                        }
                    }
                    Some("tool_result") => {
                        let tool_use_id = item
                            .get("tool_use_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        let result_content = item
                            .get("content")
                            .map(|v| {
                                v.as_str()
                                    .map(ToOwned::to_owned)
                                    .unwrap_or_else(|| v.to_string())
                            })
                            .unwrap_or_default();
                        Some(serde_json::json!({
                            "type": "text",
                            "text": format!(
                                "Tool result for {} has completed. Continue the user's task using this result:\n{}",
                                tool_use_id,
                                result_content
                            ),
                        }))
                    }
                    Some("tool_use") => {
                        let name = item
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        let input = item
                            .get("input")
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!({}));
                        Some(serde_json::json!({
                            "type": "text",
                            "text": format!(
                                "<tool_use>\n{}\n</tool_use>",
                                serde_json::json!({
                                    "name": name,
                                    "input": input
                                })
                            ),
                        }))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            serde_json::Value::Array(parts)
        }
        Some(other) => other.clone(),
        None => serde_json::Value::String(String::new()),
    }
}

fn strip_runtime_tags(reply: &str) -> String {
    let mut cleaned = reply.to_string();
    for tag in [
        "system_reminder",
        "system-reminder",
        "system",
        "reminder",
        "context",
    ] {
        let pattern = format!(r"(?is)<{tag}[^>]*>.*?</{tag}>");
        cleaned = regex::Regex::new(&pattern)
            .unwrap()
            .replace_all(&cleaned, "")
            .to_string();
    }
    cleaned.trim().to_string()
}

fn extract_first_json_object(text: &str) -> Option<serde_json::Value> {
    let mut start_idx = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escape = false;

    for (idx, ch) in text.char_indices() {
        if start_idx.is_none() {
            if ch == '{' {
                start_idx = Some(idx);
                depth = 1;
                in_string = false;
                escape = false;
            }
            continue;
        }

        if in_string {
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let start = start_idx?;
                    let candidate = &text[start..=idx];
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(candidate) {
                        return Some(value);
                    }
                    start_idx = None;
                }
            }
            _ => {}
        }
    }

    None
}

fn extract_fenced_json(text: &str) -> Option<serde_json::Value> {
    let trimmed = text.trim();
    let stripped = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```JSON"))
        .or_else(|| trimmed.strip_prefix("```"))?;
    let body = stripped.trim();
    let body = body.strip_suffix("```")?.trim();
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .or_else(|| extract_first_json_object(body))
}

fn tool_value_to_call(value: &serde_json::Value) -> Option<(String, serde_json::Value)> {
    let name = value.get("name")?.as_str()?.to_string();
    let input = value
        .get("input")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    Some((name, input))
}

fn parse_all_tagged_json(reply: &str, tag: &str) -> Vec<serde_json::Value> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let mut out = Vec::new();
    let mut cursor = 0usize;

    while let Some(start_rel) = reply[cursor..].find(&open) {
        let start = cursor + start_rel + open.len();
        let Some(end_rel) = reply[start..].find(&close) else {
            break;
        };
        let end = start + end_rel;
        let body = reply[start..end].trim();
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
            out.push(value);
        }
        cursor = end + close.len();
    }

    out
}

fn parse_tool_uses(reply: &str) -> Vec<(String, serde_json::Value)> {
    let cleaned = strip_runtime_tags(reply);
    let mut calls = Vec::new();

    for value in parse_all_tagged_json(&cleaned, "tool_use") {
        if let Some(call) = tool_value_to_call(&value) {
            calls.push(call);
        }
    }

    if !calls.is_empty() {
        return calls;
    }

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(cleaned.trim()) {
        if let Some(call) = tool_value_to_call(&value) {
            calls.push(call);
        }
    }

    if calls.is_empty() {
        if let Some(value) = extract_fenced_json(&cleaned) {
            if let Some(call) = tool_value_to_call(&value) {
                calls.push(call);
            }
        }
    }

    if calls.is_empty() {
        if let Some(value) = extract_first_json_object(&cleaned) {
            if let Some(call) = tool_value_to_call(&value) {
                calls.push(call);
            }
        }
    }

    calls
}

fn parse_tool_use(reply: &str) -> Option<(String, serde_json::Value)> {
    parse_tool_uses(reply).into_iter().next()
}

fn looks_like_tool_call(reply: &str) -> bool {
    let cleaned = strip_runtime_tags(reply);
    let lower = cleaned.to_lowercase();
    lower.contains("\"name\"")
        && (lower.contains("\"input\"")
            || lower.contains("\"filepath\"")
            || lower.contains("\"patchtext\"")
            || lower.contains("\"old_string\"")
            || lower.contains("\"new_string\""))
        || lower.contains("<tool_use>")
        || lower.contains("```json")
}

fn looks_like_tool_refusal(reply: &str) -> bool {
    let cleaned = strip_runtime_tags(reply);
    let lower = cleaned.to_lowercase();
    lower.contains("i can't inspect")
        || lower.contains("i cant inspect")
        || lower.contains("i canâ€™t inspect")
        || lower.contains("i can't access")
        || lower.contains("i cant access")
        || lower.contains("i canâ€™t access")
        || lower.contains("i don't have access")
        || lower.contains("i dont have access")
        || lower.contains("i do not have access")
        || lower.contains("available in this workspace")
        || lower.contains("from here unless")
}

fn is_tool_call_incomplete(reply: &str) -> bool {
    let trimmed = strip_runtime_tags(reply);
    (trimmed.contains("<tool_use>") && !trimmed.contains("</tool_use>"))
        || (looks_like_tool_call(&trimmed) && parse_tool_use(&trimmed).is_none())
}

fn normalize_openai_tool_schema(tool: &serde_json::Value) -> Option<serde_json::Value> {
    let function = tool.get("function")?;
    let name = function.get("name")?.as_str()?;
    Some(serde_json::json!({
        "name": name,
        "description": function
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
        "input_schema": function
            .get("parameters")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({ "type": "object", "properties": {} })),
    }))
}

fn normalize_tools_for_prompt(tools: &[serde_json::Value]) -> Vec<serde_json::Value> {
    tools
        .iter()
        .map(|tool| {
            let tool_type = tool.get("type").and_then(|v| v.as_str());
            if tool_type == Some("function") {
                normalize_openai_tool_schema(tool).unwrap_or_else(|| tool.clone())
            } else {
                tool.clone()
            }
        })
        .collect()
}

fn tool_choice_to_prompt_value(
    tool_choice: Option<&serde_json::Value>,
) -> Option<serde_json::Value> {
    match tool_choice {
        Some(serde_json::Value::Object(map)) => {
            if map.get("type").and_then(|v| v.as_str()) == Some("function") {
                if let Some(name) = map
                    .get("function")
                    .and_then(|v| v.get("name"))
                    .and_then(|v| v.as_str())
                {
                    return Some(serde_json::json!({ "type": "tool", "name": name }));
                }
            }
            Some(serde_json::Value::Object(map.clone()))
        }
        Some(other) => Some(other.clone()),
        None => None,
    }
}

fn truncate_to_token_budget(text: String, max_tokens: Option<usize>) -> String {
    let Some(max_tokens) = max_tokens else {
        return text;
    };
    let max_chars = max_tokens.saturating_mul(4);
    if text.len() <= max_chars {
        return text;
    }

    let mut end = 0;
    for (idx, _) in text.char_indices() {
        if idx > max_chars {
            break;
        }
        end = idx;
    }
    text[..end].to_string()
}

async fn handler(State(pool): State<AccountPool>, Json(req): Json<AnthropicRequest>) -> Response {
    let _permit = match acquire_direct_permit().await {
        Ok(p) => p,
        Err(e) => {
            return Json(serde_json::json!({
                "error": format!("Concurrency limit: {}", e)
            }))
            .into_response();
        }
    };
    let session_id = anthropic_session_id(&req);
    if crate::usage::cap_exceeded(&session_id) {
        return Json(serde_json::json!({
            "error": format!("Usage cap reached for session '{}'", session_id)
        }))
        .into_response();
    }

    let thinking_requested = match req.thinking {
        Some(ThinkingParam::Bool(enabled)) => enabled,
        Some(ThinkingParam::Level(level)) => {
            let _budget = THINKING_LEVELS
                .iter()
                .find(|(k, _)| *k == level)
                .map(|(_, v)| *v);
            true
        }
        Some(ThinkingParam::Object {
            type_,
            budget_tokens,
        }) => {
            let _budget = budget_tokens;
            type_ == "enabled"
        }
        None => false,
    };
    let raw_tools = req.tools.clone().unwrap_or_default();
    let tools = normalize_tools_for_prompt(&raw_tools);
    let tools_enabled = !tools.is_empty();
    let tool_choice = tool_choice_to_prompt_value(req.tool_choice.as_ref());
    tracing::debug!(
        "anthropic request summary: model={}, stream={}, tools_enabled={}, raw_tools={}, tool_choice_present={}, system_present={}, messages={}",
        req.model,
        req.stream,
        tools_enabled,
        raw_tools.len(),
        tool_choice.is_some(),
        req.system.is_some(),
        summarize_anthropic_messages(&req.messages)
    );

    // Convert Anthropic messages to OpenAI format
    let mut openai_messages = Vec::new();

    if tools_enabled {
        openai_messages.push(serde_json::json!({
            "role": "system",
            "content": tools_prompt(&tools, tool_choice.as_ref()),
            "metadata": {
                "leech_proxy_tool_prompt": true
            }
        }));
    } else if let Some(system) = req.system.as_ref() {
        if looks_like_tool_prompt(system) {
            tracing::debug!(
                "Preserving Anthropic tool-like system field as trusted proxy prompt: {}",
                system.to_string()
            );
            openai_messages.push(serde_json::json!({
                "role": "system",
                "content": system,
                "metadata": {
                    "leech_proxy_tool_prompt": true
                }
            }));
        } else {
            tracing::debug!(
                "Dropping Anthropic system field before upstream frame: {}",
                system.to_string()
            );
        }
    }

    for msg in req.messages {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("user");
        let content = convert_anthropic_content(msg.get("content"));
        openai_messages.push(serde_json::json!({
            "role": role,
            "content": content,
        }));
    }
    let tool_mode_expected = tools_enabled || has_trusted_tool_prompt(&openai_messages);
    tracing::debug!(
        "anthropic tool mode summary: explicit_tools={}, trusted_prompt_present={}, tool_mode_expected={}",
        tools_enabled,
        has_trusted_tool_prompt(&openai_messages),
        tool_mode_expected
    );
    tracing::debug!(
        "anthropic converted openai summary: {}",
        summarize_anthropic_messages(&openai_messages)
    );
    let input_tokens = crate::usage::estimate_messages_tokens(&openai_messages);

    let model = resolve_model(&req.model);
    let provider = provider_for_model(&model);

    let account = if requires_use_ai_account(&model) {
        match pool.acquire().await {
            Ok(acc) => Some(acc),
            Err(e) => {
                return Json(serde_json::json!({
                    "error": format!("Failed to acquire account: {}", e)
                }))
                .into_response();
            }
        }
    } else {
        None
    };

    let proxy_url = provider_proxy_url(provider, &pool).await;

    // ---- STREAMING ----
    if req.stream {
        let msg_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
        let model_clone = model.clone();

        if tool_mode_expected {
            let sse_stream = async_stream::stream! {
                let start_event = serde_json::json!({
                    "type": "message_start",
                    "message": {
                        "id": msg_id,
                        "type": "message",
                        "role": "assistant",
                        "content": [],
                        "model": model_clone,
                        "stop_reason": null,
                        "stop_sequence": null,
                        "usage": {
                            "input_tokens": 0,
                            "output_tokens": 0,
                        }
                    }
                });
                yield Ok::<_, Infallible>(axum::response::sse::Event::default().data(start_event.to_string()));
                let ping_event = serde_json::json!({
                    "type": "ping",
                });
                yield Ok(axum::response::sse::Event::default().data(ping_event.to_string()));

                let text_block_start = serde_json::json!({
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {
                        "type": "text",
                        "text": "",
                    }
                });
                let mut text_block_open = false;

                let mut stream = stream_completion(CompletionRequest {
                    model: model.clone(),
                    messages: openai_messages.clone(),
                    proxy_url: proxy_url.clone(),
                    account: account.clone(),
                }).await;
                let mut reply = String::new();
                let mut stream_error = None;
                while let Some(chunk) = stream.next().await {
                    match chunk {
                        Ok(text) => {
                            reply.push_str(&text);
                            if !text.is_empty() {
                                if !text_block_open {
                                    yield Ok(axum::response::sse::Event::default().data(text_block_start.to_string()));
                                    text_block_open = true;
                                }
                                let delta = serde_json::json!({
                                    "type": "content_block_delta",
                                    "index": 0,
                                    "delta": {
                                        "type": "text_delta",
                                        "text": text,
                                    }
                                });
                                yield Ok(axum::response::sse::Event::default().data(delta.to_string()));
                            }
                        }
                        Err(e) => {
                            stream_error = Some(e.to_string());
                            break;
                        }
                    }
                }

                if let Some(error) = stream_error.as_ref() {
                    if !text_block_open {
                        yield Ok(axum::response::sse::Event::default().data(text_block_start.to_string()));
                        text_block_open = true;
                    }
                    let delta = serde_json::json!({
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {
                            "type": "text_delta",
                            "text": format!("[ERROR] {}", error),
                        }
                    });
                    yield Ok(axum::response::sse::Event::default().data(delta.to_string()));
                } else {
                    let _ = crate::usage::record_tokens(
                        &session_id,
                        &model,
                        input_tokens,
                        crate::usage::estimate_tokens(&reply),
                    );
                }

                if text_block_open {
                    let text_block_stop = serde_json::json!({
                        "type": "content_block_stop",
                        "index": 0,
                    });
                    yield Ok(axum::response::sse::Event::default().data(text_block_stop.to_string()));
                }

                if stream_error.is_none() {
                    let parsed_calls = parse_tool_uses(&reply);
                    if !parsed_calls.is_empty() {
                        for (idx, (name, input)) in parsed_calls.iter().enumerate() {
                            let block_index = idx + 1;
                            let tool_id = format!("toolu_{}", uuid::Uuid::new_v4().simple());
                            let block_start = serde_json::json!({
                                "type": "content_block_start",
                                "index": block_index,
                                "content_block": {
                                    "type": "tool_use",
                                    "id": tool_id,
                                    "name": name,
                                    "input": {},
                                }
                            });
                            yield Ok(axum::response::sse::Event::default().data(block_start.to_string()));
                            let input_json = input.to_string();
                            for partial_json in input_json.as_bytes().chunks(32) {
                                let delta = serde_json::json!({
                                    "type": "content_block_delta",
                                    "index": block_index,
                                    "delta": {
                                        "type": "input_json_delta",
                                        "partial_json": String::from_utf8_lossy(partial_json),
                                    }
                                });
                                yield Ok(axum::response::sse::Event::default().data(delta.to_string()));
                            }
                            let block_stop = serde_json::json!({
                                "type": "content_block_stop",
                                "index": block_index,
                            });
                            yield Ok(axum::response::sse::Event::default().data(block_stop.to_string()));
                        }
                        let message_delta = serde_json::json!({
                            "type": "message_delta",
                            "delta": {
                                "stop_reason": "tool_use",
                                "stop_sequence": null,
                            },
                            "usage": {
                                "output_tokens": 0,
                            }
                        });
                        yield Ok(axum::response::sse::Event::default().data(message_delta.to_string()));
                    }
                }

                let message_stop = serde_json::json!({
                    "type": "message_stop",
                });
                yield Ok(axum::response::sse::Event::default().data(message_stop.to_string()));
                yield Ok(axum::response::sse::Event::default().data("[DONE]"));
            };

            return Sse::new(sse_stream).into_response();
        }

        let sse_stream = async_stream::stream! {
            // 1. message_start
            let start_event = serde_json::json!({
                "type": "message_start",
                "message": {
                    "id": msg_id,
                    "type": "message",
                    "role": "assistant",
                    "content": [],
                    "model": model_clone,
                    "stop_reason": null,
                    "stop_sequence": null,
                    "usage": {
                        "input_tokens": 0,
                        "output_tokens": 0,
                    }
                }
            });
            yield Ok::<_, Infallible>(axum::response::sse::Event::default().data(start_event.to_string()));

            // 2. content_block_start
            let block_start = serde_json::json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": {
                    "type": "text",
                    "text": "",
                }
            });
            yield Ok(axum::response::sse::Event::default().data(block_start.to_string()));

            // 3. Stream text deltas, with thinking-aware splitting
            let mut stream = stream_completion(CompletionRequest {
                model: model.clone(),
                messages: openai_messages.clone(),
                proxy_url: proxy_url.clone(),
                account: account.clone(),
            }).await;

            // We'll use a state machine to split thinking and response
            let mut buffer = String::new();
            let mut mode = "unknown"; // "unknown", "thinking", "response"

            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(text) => {
                        buffer.push_str(&text);

                        // Process buffer to extract thinking/response tags
                        while !buffer.is_empty() {
                            if mode == "unknown" {
                                if let Some(idx) = buffer.find("<thinking>") {
                                    // Emit anything before the tag as response (should be empty)
                                    let before = &buffer[..idx];
                                    if !before.is_empty() {
                                        let delta = serde_json::json!({
                                            "type": "content_block_delta",
                                            "index": 0,
                                            "delta": {
                                                "type": "text_delta",
                                                "text": before,
                                            }
                                        });
                                        yield Ok(axum::response::sse::Event::default().data(delta.to_string()));
                                    }
                                    buffer = buffer[idx + 10..].to_string(); // skip "<thinking>"
                                    mode = "thinking";
                                } else if let Some(idx) = buffer.find("<response>") {
                                    let before = &buffer[..idx];
                                    if !before.is_empty() {
                                        let delta = serde_json::json!({
                                            "type": "content_block_delta",
                                            "index": 0,
                                            "delta": {
                                                "type": "text_delta",
                                                "text": before,
                                            }
                                        });
                                        yield Ok(axum::response::sse::Event::default().data(delta.to_string()));
                                    }
                                    buffer = buffer[idx + 10..].to_string(); // skip "<response>"
                                    mode = "response";
                                } else {
                                    // No tags found; safe to emit everything except a small tail
                                    let guard = 20;
                                    if buffer.len() > guard {
                                        let safe = &buffer[..buffer.len() - guard];
                                        let delta = serde_json::json!({
                                            "type": "content_block_delta",
                                            "index": 0,
                                            "delta": {
                                                "type": "text_delta",
                                                "text": safe,
                                            }
                                        });
                                        yield Ok(axum::response::sse::Event::default().data(delta.to_string()));
                                        buffer = buffer[buffer.len() - guard..].to_string();
                                    }
                                    break; // wait for more data
                                }
                            } else if mode == "thinking" {
                                if let Some(idx) = buffer.find("</thinking>") {
                                    let thinking_content = &buffer[..idx];
                                    if !thinking_content.is_empty() {
                                        // Emit thinking_delta
                                        let delta = serde_json::json!({
                                            "type": "thinking_delta",
                                            "index": 0,
                                            "delta": {
                                                "type": "thinking_delta",
                                                "thinking": thinking_content,
                                            }
                                        });
                                        yield Ok(axum::response::sse::Event::default().data(delta.to_string()));
                                    }
                                    buffer = buffer[idx + 11..].to_string(); // skip "</thinking>"
                                    mode = "unknown";
                                    // Continue to check for response tag
                                } else {
                                    // Keep a guard, but we can't emit thinking safely without knowing if it will continue
                                    // We'll accumulate and emit in chunks, but for simplicity we'll just hold until closing tag.
                                    // Better: emit thinking_delta events incrementally.
                                    // But to keep it simple, we'll wait for the full thinking.
                                    // However, if buffer grows large, we can flush partial thinking.
                                    // For safety, if buffer len > 1024, we can emit.
                                    if buffer.len() > 1024 {
                                        let safe = &buffer[..buffer.len() - 20];
                                        let delta = serde_json::json!({
                                            "type": "thinking_delta",
                                            "index": 0,
                                            "delta": {
                                                "type": "thinking_delta",
                                                "thinking": safe,
                                            }
                                        });
                                        yield Ok(axum::response::sse::Event::default().data(delta.to_string()));
                                        buffer = buffer[buffer.len() - 20..].to_string();
                                    }
                                    break;
                                }
                            } else if mode == "response" {
                                if let Some(idx) = buffer.find("</response>") {
                                    let response_content = &buffer[..idx];
                                    if !response_content.is_empty() {
                                        let delta = serde_json::json!({
                                            "type": "content_block_delta",
                                            "index": 0,
                                            "delta": {
                                                "type": "text_delta",
                                                "text": response_content,
                                            }
                                        });
                                        yield Ok(axum::response::sse::Event::default().data(delta.to_string()));
                                    }
                                    buffer = buffer[idx + 11..].to_string(); // skip "</response>"
                                    mode = "unknown";
                                } else {
                                    // Emit response text progressively
                                    if buffer.len() > 20 {
                                        let safe = &buffer[..buffer.len() - 20];
                                        let delta = serde_json::json!({
                                            "type": "content_block_delta",
                                            "index": 0,
                                            "delta": {
                                                "type": "text_delta",
                                                "text": safe,
                                            }
                                        });
                                        yield Ok(axum::response::sse::Event::default().data(delta.to_string()));
                                        buffer = buffer[buffer.len() - 20..].to_string();
                                    }
                                    break;
                                }
                            }
                        }
                    }
                    Err(e) => {
                        // Send error as text delta (or just stop)
                        let delta = serde_json::json!({
                            "type": "content_block_delta",
                            "index": 0,
                            "delta": {
                                "type": "text_delta",
                                "text": format!("[ERROR] {}", e),
                            }
                        });
                        yield Ok(axum::response::sse::Event::default().data(delta.to_string()));
                        break;
                    }
                }
            }

            // Flush any remaining buffer
            if !buffer.is_empty() {
                if mode == "thinking" {
                    // Emit thinking_delta
                    let delta = serde_json::json!({
                        "type": "thinking_delta",
                        "index": 0,
                        "delta": {
                            "type": "thinking_delta",
                            "thinking": buffer,
                        }
                    });
                    yield Ok(axum::response::sse::Event::default().data(delta.to_string()));
                    // Emit thinking_block_stop
                    let stop = serde_json::json!({
                        "type": "thinking_block_stop",
                        "index": 0,
                    });
                    yield Ok(axum::response::sse::Event::default().data(stop.to_string()));
                } else {
                    let delta = serde_json::json!({
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {
                            "type": "text_delta",
                            "text": buffer,
                        }
                    });
                    yield Ok(axum::response::sse::Event::default().data(delta.to_string()));
                }
            }

            // 4. content_block_stop
            let block_stop = serde_json::json!({
                "type": "content_block_stop",
                "index": 0,
            });
            yield Ok(axum::response::sse::Event::default().data(block_stop.to_string()));

            // 5. message_stop
            let message_stop = serde_json::json!({
                "type": "message_stop",
            });
            yield Ok(axum::response::sse::Event::default().data(message_stop.to_string()));

            // 6. [DONE] (optional but useful for clients)
            yield Ok(axum::response::sse::Event::default().data("[DONE]"));
        };

        return Sse::new(sse_stream).into_response();
    }

    // ---- NON-STREAMING ----
    let result = complete_completion(CompletionRequest {
        model: model.clone(),
        messages: openai_messages.clone(),
        proxy_url: proxy_url.clone(),
        account: account.clone(),
    })
    .await;

    match result {
        Ok(reply) => {
            let _ = crate::usage::record_tokens(
                &session_id,
                &model,
                input_tokens,
                crate::usage::estimate_tokens(&reply),
            );
            if tool_mode_expected {
                let parsed_calls = parse_tool_uses(&reply);
                if !parsed_calls.is_empty() {
                    let resp = serde_json::json!({
                        "id": format!("msg_{}", uuid::Uuid::new_v4().simple()),
                        "type": "message",
                        "role": "assistant",
                        "content": parsed_calls.iter().map(|(name, input)| serde_json::json!({
                            "type": "tool_use",
                            "id": format!("toolu_{}", uuid::Uuid::new_v4().simple()),
                            "name": name,
                            "input": input,
                        })).collect::<Vec<_>>(),
                        "model": model,
                        "stop_reason": "tool_use",
                        "stop_sequence": null,
                        "usage": {
                            "input_tokens": 0,
                            "output_tokens": 0,
                        },
                    });
                    return Json(resp).into_response();
                }
                if looks_like_tool_call(&reply) {
                    tracing::debug!(
                        "Tool-like Anthropic reply leaked past conversion in non-stream path. raw reply: {}",
                        reply
                    );
                    return Json(serde_json::json!({
                        "error": "Tool call was detected but could not be converted safely"
                    }))
                    .into_response();
                }
            }

            let (thinking, response) = parse_thinking(&reply);
            let response = truncate_to_token_budget(response, req.max_tokens);

            let mut resp = serde_json::json!({
                "id": format!("msg_{}", uuid::Uuid::new_v4().simple()),
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "text",
                    "text": response,
                }],
                "model": model,
                "stop_reason": "end_turn",
                "stop_sequence": null,
                "usage": {
                    "input_tokens": 0,
                    "output_tokens": response.len() / 4,
                },
            });

            if thinking_requested {
                resp["thinking"] = thinking
                    .map(serde_json::Value::String)
                    .unwrap_or(serde_json::Value::Null);
            }

            Json(resp).into_response()
        }
        Err(e) => Json(serde_json::json!({
            "error": format!("Completion failed: {}", e)
        }))
        .into_response(),
    }
}

async fn provider_proxy_url(provider: &str, pool: &AccountPool) -> Option<String> {
    match provider {
        "use_ai" => pool.next_proxy().await,
        "sakana" => None,
        "faceb" => crate::provider_proxies::next_proxy(provider).await,
        _ => None,
    }
}

/// Parse `<thinking>...</thinking>` and `<response>...</response>` from reply.
fn parse_thinking(reply: &str) -> (Option<String>, String) {
    let thinking_re = regex::Regex::new(r"(?s)<thinking>(.*?)</thinking>").unwrap();
    let response_re = regex::Regex::new(r"(?s)<response>(.*?)</response>").unwrap();
    let thinking = thinking_re
        .captures(reply)
        .map(|cap| cap[1].trim().to_string());
    let response = response_re
        .captures(reply)
        .map(|cap| cap[1].trim().to_string())
        .unwrap_or_else(|| reply.trim().to_string());
    (thinking, response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_content_preserves_prior_tool_use_and_keeps_tool_result() {
        let content = serde_json::json!([
            {
                "type": "tool_use",
                "id": "toolu_1",
                "name": "Bash",
                "input": {"command": "mkdir games"}
            },
            {
                "type": "tool_result",
                "tool_use_id": "toolu_1",
                "content": "Created folders"
            }
        ]);

        let converted = convert_anthropic_content(Some(&content));
        let parts = converted.as_array().unwrap();

        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["type"].as_str().unwrap(), "text");
        assert!(parts[0]["text"].as_str().unwrap().contains("<tool_use>"));
        assert!(parts[0]["text"]
            .as_str()
            .unwrap()
            .contains("\"name\":\"Bash\""));
        assert_eq!(parts[1]["type"].as_str().unwrap(), "text");
        assert!(parts[1]["text"]
            .as_str()
            .unwrap()
            .contains("Tool result for toolu_1 has completed"));
    }

    #[test]
    fn anthropic_file_block_converts_to_internal_file_payload() {
        let content = serde_json::json!([
            {
                "type": "file",
                "name": "notes.txt",
                "source": {
                    "type": "base64",
                    "media_type": "text/plain",
                    "data": "aGVsbG8="
                }
            }
        ]);

        let converted = convert_anthropic_content(Some(&content));
        let parts = converted.as_array().unwrap();

        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0]["type"].as_str().unwrap(), "file");
        assert_eq!(parts[0]["file"]["filename"].as_str().unwrap(), "notes.txt");
        assert!(parts[0]["file"]["data"]
            .as_str()
            .unwrap()
            .starts_with("data:text/plain;base64,aGVsbG8="));
    }

    #[test]
    fn anthropic_session_id_prefers_metadata_session_id() {
        let req = AnthropicRequest {
            model: "claude-sonnet-4-6".to_string(),
            messages: vec![],
            metadata: Some(serde_json::json!({
                "session_id": "session-123",
                "user_id": "fallback-user"
            })),
            stream: false,
            system: None,
            max_tokens: None,
            thinking: None,
            tools: None,
            tool_choice: None,
        };

        assert_eq!(anthropic_session_id(&req), "session-123");
    }

    #[test]
    fn detects_anthropic_tool_like_system_prompt() {
        let system = serde_json::json!(
            "You may be given tools. Available tools: read_file. Use <tool_use> JSON."
        );

        assert!(looks_like_tool_prompt(&system));
    }

    #[test]
    fn anthropic_tool_prompt_allows_status_before_thinking_and_tool_use() {
        let prompt = tools_prompt(
            &[serde_json::json!({
                "name": "read_file",
                "input_schema": {"type": "object"}
            })],
            None,
        );

        assert!(prompt.contains("one short user-visible status line"));
        assert!(prompt.contains("Short user-visible status line."));
        assert!(prompt.contains("<thinking>brief private reasoning about the next tool step</thinking>"));
        assert!(prompt.contains("<tool_use>"));
        assert!(!prompt.contains("Do not include any text before or after the tool call"));
    }
}
