//! OpenAI-compatible /v1/chat/completions endpoint.

use axum::{
    extract::State,
    response::{sse::Event, IntoResponse, Response, Sse},
    Json,
};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::debug;

use crate::account_pool::AccountPool;
use crate::models::resolve_model;
use crate::pool::acquire_direct_permit;
use crate::providers::{
    complete_completion, provider_for_model, requires_use_ai_account, stream_completion,
    CompletionRequest,
};

const STREAM_CHUNK_CHARS: usize = 32;
const TOOL_PROMPT: &str = r#"You may be given tools.

When tools are available and the task requires reading, searching, creating, editing, patching, or inspecting files, respond with one or more tool calls and nothing else.

Rules:
- Output only tool calls.
- Do not output prose.
- Do not explain what you are doing.
- Do not say you lack tool access.
- Do not describe limitations.
- Do not wrap the tool call in markdown fences.
- Do not include any text before or after the tool call.
- The tool call must be valid JSON.
- Escape backslashes in Windows paths.
- Escape quotes and newlines correctly in JSON strings.

Use exactly this format:

<tool_use>
{"name":"tool_name","input":{"key":"value"}}
</tool_use>

After a tool result is provided, either output one or more next tool calls in the same format or answer the user normally if no more tools are needed."#;

#[derive(Debug, Deserialize, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Value>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub thinking: Option<ThinkingParam>,
    #[serde(default)]
    pub tools: Option<Vec<Value>>,
    #[serde(default)]
    pub tool_choice: Option<Value>,
}

#[derive(Debug, Deserialize, Clone)]
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
    axum::Router::new().route("/chat/completions", axum::routing::post(chat_handler))
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

fn looks_like_tool_prompt(value: &Value) -> bool {
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

fn mark_trusted_tool_prompt(message: &mut Value) {
    if let Some(obj) = message.as_object_mut() {
        let metadata = obj.entry("metadata").or_insert_with(|| json!({}));
        if let Some(metadata_obj) = metadata.as_object_mut() {
            metadata_obj.insert("leech_proxy_tool_prompt".to_string(), Value::Bool(true));
        }
    }
}

fn has_trusted_tool_prompt(messages: &[Value]) -> bool {
    messages.iter().any(|message| {
        message
            .get("metadata")
            .and_then(|m| m.get("leech_proxy_tool_prompt"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    })
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
        || lower.contains("i can’t inspect")
        || lower.contains("i can't access")
        || lower.contains("i cant access")
        || lower.contains("i can’t access")
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

fn normalize_tool_messages(messages: &mut [Value]) {
    for msg in messages {
        if msg.get("role").and_then(|v| v.as_str()) == Some("tool") {
            let tool_call_id = msg
                .get("tool_call_id")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let content = msg
                .get("content")
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned)
                .or_else(|| msg.get("content").map(|v| v.to_string()))
                .unwrap_or_default();
            *msg = json!({
                "role": "user",
                "content": format!("Tool result for {}:\n{}", tool_call_id, content),
            });
        }
    }
}

fn normalize_openai_tool_schema(tool: &Value) -> Option<Value> {
    let function = tool.get("function")?;
    let name = function.get("name")?.as_str()?;
    Some(json!({
        "name": name,
        "description": function
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
        "input_schema": function
            .get("parameters")
            .cloned()
            .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
    }))
}

fn normalize_tools_for_prompt(tools: &[Value]) -> Vec<Value> {
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

fn tool_choice_to_prompt_value(tool_choice: Option<&Value>) -> Option<Value> {
    match tool_choice {
        Some(Value::Object(map)) => {
            if map.get("type").and_then(|v| v.as_str()) == Some("function") {
                if let Some(name) = map
                    .get("function")
                    .and_then(|v| v.get("name"))
                    .and_then(|v| v.as_str())
                {
                    return Some(json!({ "type": "tool", "name": name }));
                }
            }
            Some(Value::Object(map.clone()))
        }
        Some(other) => Some(other.clone()),
        None => None,
    }
}

fn chat_session_id(req: &ChatRequest) -> String {
    req.user
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("default")
        .to_string()
}

async fn chat_handler(State(pool): State<AccountPool>, Json(req): Json<ChatRequest>) -> Response {
    let permit = match acquire_direct_permit().await {
        Ok(p) => p,
        Err(e) => {
            return Json(serde_json::json!({
                "error": format!("Concurrency limit error: {}", e)
            }))
            .into_response();
        }
    };

    let model = resolve_model(&req.model);
    let provider = provider_for_model(&model);
    let session_id = chat_session_id(&req);
    if crate::usage::cap_exceeded(&session_id) {
        return Json(serde_json::json!({
            "error": format!("Usage cap reached for session '{}'", session_id)
        }))
        .into_response();
    }

    let thinking_requested = match req.thinking {
        Some(ThinkingParam::Bool(b)) => b,
        Some(ThinkingParam::Level(level)) => {
            let cfg = crate::config::Config::load().unwrap_or_default();
            let _budget = cfg.thinking.levels.get(&level).copied().unwrap_or(1024);
            true
        }
        Some(ThinkingParam::Object {
            type_,
            budget_tokens,
        }) => {
            let _budget = budget_tokens.unwrap_or(1024);
            type_ == "enabled"
        }
        None => false,
    };

    let raw_tools = req.tools.clone().unwrap_or_default();
    let tools = normalize_tools_for_prompt(&raw_tools);
    let tools_enabled = !tools.is_empty();
    debug!(
        "Incoming request (responses API): {} tools present, tools_enabled={}, message_count={}",
        raw_tools.len(),
        tools_enabled,
        req.messages.len()
    );
    let tool_choice = tool_choice_to_prompt_value(req.tool_choice.as_ref());
    let mut messages = req.messages;
    normalize_tool_messages(&mut messages);

    if tools_enabled {
        messages.insert(
            0,
            serde_json::json!({
                "role": "system",
                "content": tools_prompt(&tools, tool_choice.as_ref()),
                "metadata": {
                    "leech_proxy_tool_prompt": true
                }
            }),
        );
    } else {
        messages.retain_mut(|message| {
            if message.get("role").and_then(|v| v.as_str()) == Some("system") {
                if message
                    .get("content")
                    .map(looks_like_tool_prompt)
                    .unwrap_or(false)
                {
                    tracing::debug!(
                        "Preserving inbound tool-like system prompt as trusted proxy prompt"
                    );
                    mark_trusted_tool_prompt(message);
                    return true;
                }

                tracing::debug!(
                    "Dropping chat system message before direct completion: {}",
                    message
                        .get("content")
                        .and_then(|v| v.as_str())
                        .unwrap_or("<non-string>")
                        .chars()
                        .take(160)
                        .collect::<String>()
                );
                false
            } else {
                true
            }
        });
    }

    let input_tokens = crate::usage::estimate_messages_tokens(&messages);

    let tool_mode_expected = tools_enabled || has_trusted_tool_prompt(&messages);
    debug!(
        "chat tool mode summary: explicit_tools={}, trusted_prompt_present={}, tool_mode_expected={}",
        tools_enabled,
        has_trusted_tool_prompt(&messages),
        tool_mode_expected
    );

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

    if req.stream {
        // Generate a chat completion ID and timestamp (shared for all chunks)
        let id = format!("chatcmpl-{}", uuid::Uuid::new_v4().simple());
        let created = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let model_clone = model.clone();

        let sse_stream = async_stream::stream! {
            let _permit = permit;

            let role_chunk = serde_json::json!({
                "id": id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model_clone,
                "choices": [{
                    "index": 0,
                    "delta": {
                        "role": "assistant"
                    },
                    "finish_reason": null,
                }]
            });
            yield Ok::<_, Infallible>(Event::default().data(role_chunk.to_string()));

            let mut stream = stream_completion(CompletionRequest {
                model: model.clone(),
                messages: messages.clone(),
                proxy_url: proxy_url.clone(),
                account: account.clone(),
            }).await;

            let mut buffered_reply = String::new();
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(text) => {
                        if tool_mode_expected {
                            buffered_reply.push_str(&text);
                            continue;
                        }
                        for text_part in split_stream_text(&text) {
                            let mut delta = serde_json::Map::new();
                            delta.insert("content".to_string(), serde_json::Value::String(text_part));

                            let chunk_obj = serde_json::json!({
                                "id": id,
                                "object": "chat.completion.chunk",
                                "created": created,
                                "model": model_clone,
                                "choices": [{
                                    "index": 0,
                                    "delta": delta,
                                    "finish_reason": null,
                                }]
                            });
                            yield Ok::<_, Infallible>(Event::default().data(chunk_obj.to_string()));
                        }
                    }
                    Err(e) => {
                        let error_chunk = serde_json::json!({
                            "id": id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": model_clone,
                            "choices": [{
                                "index": 0,
                                "delta": {
                                    "content": format!("[ERROR] {}", e)
                                },
                                "finish_reason": null,
                            }]
                        });
                        yield Ok(Event::default().data(error_chunk.to_string()));
                        break;
                    }
                }
            }

            if tool_mode_expected {
                let parsed_calls = parse_tool_uses(&buffered_reply);
                if !parsed_calls.is_empty() {
                    let _ = crate::usage::record_tokens(
                        &session_id,
                        &model,
                        input_tokens,
                        crate::usage::estimate_tokens(&buffered_reply),
                    );
                    let tool_call_ids = parsed_calls
                        .iter()
                        .map(|_| format!("call_{}", uuid::Uuid::new_v4().simple()))
                        .collect::<Vec<_>>();
                    let name_chunk = serde_json::json!({
                        "id": id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model_clone,
                        "choices": [{
                            "index": 0,
                            "delta": {
                                "tool_calls": parsed_calls.iter().enumerate().map(|(idx, (name, _))| serde_json::json!({
                                    "index": idx,
                                    "id": tool_call_ids[idx],
                                    "type": "function",
                                    "function": {
                                        "name": name,
                                        "arguments": "",
                                    }
                                })).collect::<Vec<_>>()
                            },
                            "finish_reason": null,
                        }]
                    });
                    yield Ok::<_, Infallible>(Event::default().data(name_chunk.to_string()));

                    for (idx, (_, input)) in parsed_calls.iter().enumerate() {
                        let arguments = input.to_string();
                        for arg_part in split_stream_text(&arguments) {
                            let arg_chunk = serde_json::json!({
                                "id": id,
                                "object": "chat.completion.chunk",
                                "created": created,
                                "model": model_clone,
                                "choices": [{
                                    "index": 0,
                                    "delta": {
                                        "tool_calls": [{
                                            "index": idx,
                                            "function": {
                                                "arguments": arg_part,
                                            }
                                        }]
                                    },
                                    "finish_reason": null,
                                }]
                            });
                            yield Ok::<_, Infallible>(Event::default().data(arg_chunk.to_string()));
                        }
                    }

                    let final_chunk = serde_json::json!({
                        "id": id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model_clone,
                        "choices": [{
                            "index": 0,
                            "delta": {},
                            "finish_reason": "tool_calls",
                        }]
                    });
                    yield Ok::<_, Infallible>(Event::default().data(final_chunk.to_string()));
                    yield Ok::<_, Infallible>(Event::default().data("[DONE]"));
                    return;
                }

                if is_tool_call_incomplete(&buffered_reply) {
                    debug!("Incomplete tool call from upstream, raw reply: {}", buffered_reply);
                    // Falls through to stream the real text below rather than
                    // injecting a synthetic "[ERROR] ..." string, which the client
                    // would store as a genuine assistant turn (finish_reason=stop)
                    // and replay back on later requests, making the model think
                    // it already gave up on tool calls.
                }

                if looks_like_tool_call(&buffered_reply) {
                    debug!("Unconvertible tool call from upstream, raw reply: {}", buffered_reply);
                    // See note above: fall through instead of faking content.
                }

                if looks_like_tool_refusal(&buffered_reply) {
                    debug!("Upstream refused tool usage, raw reply: {}", buffered_reply);
                    // See note above: fall through instead of faking content.
                }

                for text_part in split_stream_text(&buffered_reply) {
                    let chunk_obj = serde_json::json!({
                        "id": id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model_clone,
                        "choices": [{
                            "index": 0,
                            "delta": {
                                "content": text_part,
                            },
                            "finish_reason": null,
                        }]
                    });
                    yield Ok::<_, Infallible>(Event::default().data(chunk_obj.to_string()));
                }
            }

            let _ = crate::usage::record_tokens(
                &session_id,
                &model,
                input_tokens,
                crate::usage::estimate_tokens(&buffered_reply),
            );

            let final_chunk = serde_json::json!({
                "id": id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model_clone,
                "choices": [{
                    "index": 0,
                    "delta": {},
                    "finish_reason": "stop",
                }]
            });
            yield Ok::<_, Infallible>(Event::default().data(final_chunk.to_string()));

            yield Ok::<_, Infallible>(Event::default().data("[DONE]"));
        };

        Sse::new(sse_stream).into_response()
    } else {
        // Non-streaming (unchanged)
        match complete_completion(CompletionRequest {
            model: model.clone(),
            messages: messages.clone(),
            proxy_url: proxy_url.clone(),
            account: account.clone(),
        })
        .await
        {
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
                        let json_reply = serde_json::json!({
                            "id": format!("chatcmpl-{}", uuid::Uuid::new_v4().simple()),
                            "object": "chat.completion",
                            "created": SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(),
                            "model": model,
                            "choices": [{
                                "index": 0,
                                "message": {
                                    "role": "assistant",
                                    "content": null,
                                    "tool_calls": parsed_calls.iter().map(|(name, input)| serde_json::json!({
                                        "id": format!("call_{}", uuid::Uuid::new_v4().simple()),
                                        "type": "function",
                                        "function": {
                                            "name": name,
                                            "arguments": input.to_string(),
                                        }
                                    })).collect::<Vec<_>>()
                                },
                                "finish_reason": "tool_calls",
                            }],
                        });
                        return Json(json_reply).into_response();
                    }
                    if looks_like_tool_call(&reply) {
                        debug!(
                            "Tool-like reply leaked past conversion in non-stream path. raw reply: {}",
                            reply
                        );
                        return Json(serde_json::json!({
                            "error": "Tool call was detected but could not be converted safely"
                        }))
                        .into_response();
                    }
                    if looks_like_tool_refusal(&reply) {
                        debug!("Upstream refused tool usage, raw reply: {}", reply);
                        // Fall through to the normal completion below instead of
                        // returning a synthetic error -- see streaming handler for
                        // why (poisons later turns if the client stores/replays it).
                    }
                }

                let (thinking, response) = parse_thinking(&reply);
                let mut json_reply = serde_json::json!({
                    "id": format!("chatcmpl-{}", uuid::Uuid::new_v4().simple()),
                    "object": "chat.completion",
                    "created": SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(),
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": response,
                        },
                        "finish_reason": "stop",
                    }],
                });
                if thinking_requested {
                    if let Some(t) = thinking {
                        json_reply["thinking"] = serde_json::Value::String(t);
                    }
                }
                Json(json_reply).into_response()
            }
            Err(e) => Json(serde_json::json!({
                "error": format!("Completion failed: {}", e)
            }))
            .into_response(),
        }
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

fn split_stream_text(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }

    let mut chunks = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        current.push(ch);
        if current.chars().count() >= STREAM_CHUNK_CHARS {
            chunks.push(std::mem::take(&mut current));
        }
    }

    if !current.is_empty() {
        chunks.push(current);
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_session_id_uses_user_when_present() {
        let req = ChatRequest {
            model: "gpt-5-4".to_string(),
            messages: vec![],
            user: Some("session-123".to_string()),
            stream: false,
            thinking: None,
            tools: None,
            tool_choice: None,
        };

        assert_eq!(chat_session_id(&req), "session-123");
    }

    #[test]
    fn detects_and_marks_tool_like_system_prompt() {
        let mut message = json!({
            "role": "system",
            "content": "Available tools:\n<tool_use>{\"name\":\"read_file\",\"input\":{}}</tool_use>"
        });

        assert!(looks_like_tool_prompt(&message["content"]));
        mark_trusted_tool_prompt(&mut message);
        assert_eq!(
            message["metadata"]["leech_proxy_tool_prompt"].as_bool(),
            Some(true)
        );
    }
}
