//! Faceb.ai provider adapter.

use anyhow::{anyhow, Context, Result};
use futures::stream::{self, BoxStream};
use futures::StreamExt;
use rand::seq::SliceRandom;
use rand::Rng;
use regex::Regex;
use reqwest::Client;
use scraper::{Html, Selector};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use super::{CompletionProvider, CompletionRequest, ProviderPoolStats};
const FACEB_BASE: &str = "https://faceb.ai";
const FACEB_API: &str = "https://api.faceb.ai/v1";
const FACEB_POOL_BATCH: usize = 4;
const FACEB_POOL_MAX: usize = 256;
const FACEB_KEY_ATTEMPTS: usize = 50;
const FACEB_POOL_WAIT_MS: u64 = 500;
const FACEB_POOL_FILE: &str = "faceb_pool.json";
const FACEB_WARM_TARGET: usize = 16;
const FACEB_REFILL_INTERVAL_SEC: u64 = 15;

const USER_AGENTS: &[&str] = &[
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

pub struct FacebProvider;

struct FacebKeyPool {
    keys: Mutex<VecDeque<String>>,
    proxies: Mutex<Vec<String>>,
    proxy_index: AtomicU64,
    running: Mutex<bool>,
    refill_task: Mutex<Option<JoinHandle<()>>>,
    refill_lock: Mutex<()>,
    generated: AtomicU64,
    failed: AtomicU64,
    dead: AtomicU64,
    last_error: Mutex<Option<String>>,
}

static FACEB_POOL: once_cell::sync::Lazy<FacebKeyPool> =
    once_cell::sync::Lazy::new(FacebKeyPool::new);

pub fn is_faceb_model(model: &str) -> bool {
    model.starts_with("faceb-")
}

pub async fn pool_stats() -> ProviderPoolStats {
    let ready = FACEB_POOL.keys.lock().await.len();
    let last_error = FACEB_POOL.last_error.lock().await.clone();
    ProviderPoolStats {
        provider: "faceb",
        ready,
        target: Some(FACEB_POOL_MAX),
        generated: Some(FACEB_POOL.generated.load(Ordering::Relaxed)),
        failed: Some(FACEB_POOL.failed.load(Ordering::Relaxed)),
        dead: Some(FACEB_POOL.dead.load(Ordering::Relaxed)),
        cooling: None,
        degraded: ready == 0 || last_error.is_some(),
        last_error,
    }
}

fn faceb_upstream_model(model: &str) -> &str {
    model.strip_prefix("faceb-").unwrap_or(model)
}

impl CompletionProvider for FacebProvider {
    async fn stream_completion(
        &self,
        mut request: CompletionRequest,
    ) -> BoxStream<'static, Result<String>> {
        request.model = faceb_upstream_model(&request.model).to_string();
        let stream = async_stream::stream! {
            match faceb_stream_completion(request).await {
                Ok(mut upstream) => {
                    while let Some(item) = upstream.next().await {
                        yield item;
                    }
                }
                Err(err) => yield Err(err),
            }
        };
        Box::pin(stream)
    }

    async fn complete_completion(&self, mut request: CompletionRequest) -> Result<String> {
        request.model = faceb_upstream_model(&request.model).to_string();
        let payload =
            json!({"model": request.model, "messages": request.messages, "stream": false});
        let response =
            faceb_post_with_rotation(payload, request.proxy_url.as_deref(), false).await?;
        let data = response
            .json::<Value>()
            .await
            .context("Faceb JSON response failed")?;
        if is_dead_response(&data) {
            FACEB_POOL.mark_dead();
            anyhow::bail!("Faceb key exhausted")
        }
        extract_chat_content(&data).ok_or_else(|| anyhow!("Faceb returned no assistant text"))
    }
}

impl FacebKeyPool {
    fn new() -> Self {
        Self {
            keys: Mutex::new(load_keys().into()),
            proxies: Mutex::new(Vec::new()),
            proxy_index: AtomicU64::new(0),
            running: Mutex::new(false),
            refill_task: Mutex::new(None),
            refill_lock: Mutex::new(()),
            generated: AtomicU64::new(0),
            failed: AtomicU64::new(0),
            dead: AtomicU64::new(0),
            last_error: Mutex::new(None),
        }
    }

    async fn get(&self, proxy_url: Option<&str>) -> Option<String> {
        if let Some(key) = self.keys.lock().await.pop_front() {
            return Some(key);
        }
        self.refill(proxy_url).await;
        self.keys.lock().await.pop_front()
    }

    async fn start(&'static self, proxies: Vec<String>) {
        let mut running = self.running.lock().await;
        if *running {
            return;
        }
        *running = true;
        drop(running);

        *self.proxies.lock().await = proxies;

        let handle = tokio::spawn(async move {
            while *self.running.lock().await {
                if self.keys.lock().await.len() < FACEB_WARM_TARGET {
                    let proxy_url = self.next_proxy().await;
                    self.refill(proxy_url.as_deref()).await;
                }
                tokio::time::sleep(Duration::from_secs(FACEB_REFILL_INTERVAL_SEC)).await;
            }
        });
        *self.refill_task.lock().await = Some(handle);
    }

    async fn stop(&self) {
        *self.running.lock().await = false;
        if let Some(handle) = self.refill_task.lock().await.take() {
            handle.abort();
        }
    }

    async fn next_proxy(&self) -> Option<String> {
        let proxies = self.proxies.lock().await;
        if proxies.is_empty() {
            return None;
        }
        let idx = self.proxy_index.fetch_add(1, Ordering::Relaxed) as usize % proxies.len();
        Some(proxies[idx].clone())
    }

    async fn refill(&self, proxy_url: Option<&str>) {
        let _guard = self.refill_lock.lock().await;
        if self.keys.lock().await.len() >= FACEB_POOL_MAX {
            return;
        }
        let tasks = (0..FACEB_POOL_BATCH)
            .map(|_| {
                let proxy_url = proxy_url.map(ToOwned::to_owned);
                tokio::spawn(async move { make_account(proxy_url.as_deref()).await })
            })
            .collect::<Vec<_>>();
        let mut keys = Vec::new();
        for task in tasks {
            match task.await {
                Ok(Ok(Some(key))) => keys.push(key),
                Ok(Ok(None)) | Ok(Err(_)) | Err(_) => {
                    self.failed.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        self.generated
            .fetch_add(keys.len() as u64, Ordering::Relaxed);
        let mut queue = self.keys.lock().await;
        for key in keys {
            if queue.len() >= FACEB_POOL_MAX {
                break;
            }
            queue.push_back(key);
        }
        let _ = save_keys(&queue);
    }

    fn mark_dead(&self) {
        self.dead.fetch_add(1, Ordering::Relaxed);
    }

    async fn set_last_error(&self, error: impl Into<String>) {
        *self.last_error.lock().await = Some(error.into());
    }

    async fn clear_last_error(&self) {
        *self.last_error.lock().await = None;
    }
}

pub async fn start_background_warmup(proxies: Vec<String>) {
    FACEB_POOL.start(proxies).await;
}

pub async fn stop_background_warmup() {
    FACEB_POOL.stop().await;
}

fn faceb_pool_path() -> PathBuf {
    let data_dir = std::env::var("LEECH_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(".leech-rs"));
    data_dir.join(FACEB_POOL_FILE)
}

fn load_keys() -> VecDeque<String> {
    fs::read_to_string(faceb_pool_path())
        .ok()
        .and_then(|data| serde_json::from_str::<VecDeque<String>>(&data).ok())
        .unwrap_or_default()
}

fn save_keys(keys: &VecDeque<String>) -> Result<()> {
    let path = faceb_pool_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(keys)?)?;
    fs::rename(tmp, path)?;
    Ok(())
}

async fn faceb_stream_completion(
    request: CompletionRequest,
) -> Result<BoxStream<'static, Result<String>>> {
    let payload = json!({"model": request.model, "messages": request.messages, "stream": true});
    let response = faceb_post_with_rotation(payload, request.proxy_url.as_deref(), true).await?;
    Ok(Box::pin(stream_faceb_sse_response(response)))
}

async fn faceb_post_with_rotation(
    payload: Value,
    proxy_url: Option<&str>,
    stream: bool,
) -> Result<reqwest::Response> {
    for _ in 0..FACEB_KEY_ATTEMPTS {
        let Some(key) = FACEB_POOL.get(proxy_url).await else {
            tokio::time::sleep(Duration::from_millis(FACEB_POOL_WAIT_MS)).await;
            continue;
        };
        let client = build_client(proxy_url, Duration::from_secs(120))?;
        let response = client
            .post(format!("{}/chat/completions", FACEB_API))
            .bearer_auth(&key)
            .header("Content-Type", "application/json")
            .header(
                "Accept",
                if stream {
                    "text/event-stream"
                } else {
                    "application/json"
                },
            )
            .json(&payload)
            .send()
            .await;
        let Ok(response) = response else {
            FACEB_POOL.set_last_error("Faceb request network error").await;
            continue;
        };
        if matches!(
            response.status().as_u16(),
            401 | 402 | 403 | 429 | 500 | 502 | 503
        ) {
            FACEB_POOL.mark_dead();
            FACEB_POOL
                .set_last_error(format!("Faceb key rejected with HTTP {}", response.status()))
                .await;
            continue;
        }
        if stream {
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_lowercase();
            if content_type.contains("text/event-stream") {
                return Ok(response);
            }
            let status = response.status();
            let data = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
            if is_dead_response(&data) {
                FACEB_POOL.mark_dead();
                FACEB_POOL.set_last_error("Faceb key exhausted").await;
                continue;
            }
            anyhow::bail!(
                "Faceb returned non-SSE stream response {}: {}",
                status,
                data
            );
        }
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("Faceb returned {}: {}", status, body);
        }
        FACEB_POOL.clear_last_error().await;
        return Ok(response);
    }
    FACEB_POOL.set_last_error("all Faceb keys exhausted").await;
    anyhow::bail!("all Faceb keys exhausted")
}

async fn make_account(proxy_url: Option<&str>) -> Result<Option<String>> {
    let user_agent = USER_AGENTS
        .choose(&mut rand::thread_rng())
        .copied()
        .unwrap_or(USER_AGENTS[0]);
    let client = build_client(proxy_url, Duration::from_secs(30))?;
    let signup = client
        .get(format!("{}/signup/", FACEB_BASE))
        .header("User-Agent", user_agent)
        .send()
        .await
        .context("Faceb signup page request failed")?;
    if !signup.status().is_success() {
        return Ok(None);
    }
    let Some(csrf) = extract_csrf(&signup.text().await?) else {
        return Ok(None);
    };
    let email = random_email();
    let password = random_password();
    let signup_response = client
        .post(format!("{}/signup/", FACEB_BASE))
        .header("User-Agent", user_agent)
        .header("Referer", format!("{}/signup/", FACEB_BASE))
        .form(&[
            ("csrfmiddlewaretoken", csrf.as_str()),
            ("email", email.as_str()),
            ("password", password.as_str()),
        ])
        .send()
        .await
        .context("Faceb signup submit failed")?;
    if !signup_response.status().is_success() {
        return Ok(None);
    }
    let api_page = client
        .get(format!("{}/account/api/", FACEB_BASE))
        .header("User-Agent", user_agent)
        .send()
        .await
        .context("Faceb API page request failed")?;
    if !api_page.status().is_success() {
        return Ok(None);
    }
    let Some(csrf) = extract_csrf(&api_page.text().await?) else {
        return Ok(None);
    };
    let key_page = client
        .post(format!("{}/account/api/new/", FACEB_BASE))
        .header("User-Agent", user_agent)
        .header("Referer", format!("{}/account/api/", FACEB_BASE))
        .form(&[("csrfmiddlewaretoken", csrf.as_str()), ("name", "")])
        .send()
        .await
        .context("Faceb API key create failed")?;
    Ok(extract_key(&key_page.text().await.unwrap_or_default()))
}

fn build_client(proxy_url: Option<&str>, timeout: Duration) -> Result<Client> {
    let mut builder = Client::builder()
        .timeout(timeout)
        .cookie_store(true)
        .user_agent(USER_AGENTS[0])
        .no_proxy();
    if let Some(url) = proxy_url {
        builder = builder.proxy(reqwest::Proxy::all(url)?);
    }
    Ok(builder.build()?)
}

fn extract_csrf(html: &str) -> Option<String> {
    let document = Html::parse_document(html);
    let selector = Selector::parse(r#"input[name="csrfmiddlewaretoken"]"#).ok()?;
    document
        .select(&selector)
        .find_map(|element| element.value().attr("value"))
        .map(ToOwned::to_owned)
}

fn extract_key(text: &str) -> Option<String> {
    static KEY_RE: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
        Regex::new(r"sk-faceb-[a-zA-Z0-9_-]+").expect("valid Faceb key regex")
    });
    KEY_RE.find(text).map(|m| m.as_str().to_string())
}

fn random_email() -> String {
    format!("{}@gmail.com", random_alnum(10).to_lowercase())
}

fn random_password() -> String {
    let mut rng = rand::thread_rng();
    let symbols = ['!', '@', '#', '$', '%'];
    format!(
        "{}{}{}{}{}",
        rng.gen_range(b'A'..=b'Z') as char,
        rng.gen_range(b'a'..=b'z') as char,
        rng.gen_range(b'0'..=b'9') as char,
        *symbols.choose(&mut rng).unwrap_or(&'!'),
        random_alnum(8)
    )
}

fn random_alnum(len: usize) -> String {
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char)
        .collect()
}

fn is_dead_response(data: &Value) -> bool {
    let err = match data.get("error") {
        Some(Value::String(text)) => text.to_lowercase(),
        Some(Value::Object(obj)) => obj
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_lowercase(),
        _ => String::new(),
    };
    [
        "credit",
        "out of",
        "exhausted",
        "quota",
        "rate limit",
        "rate_limit",
        "unauthorized",
        "invalid api key",
        "invalid key",
        "blocked",
        "denied",
        "exceeded",
        "insufficient",
        "revoked",
    ]
    .iter()
    .any(|needle| err.contains(needle))
}

fn extract_chat_content(data: &Value) -> Option<String> {
    data.get("choices")?
        .as_array()?
        .first()?
        .get("message")?
        .get("content")
        .and_then(|content| match content {
            Value::String(text) => Some(text.clone()),
            Value::Array(parts) => Some(
                parts
                    .iter()
                    .filter_map(|part| part.get("text").and_then(|v| v.as_str()))
                    .collect::<Vec<_>>()
                    .join(""),
            ),
            other if !other.is_null() => Some(other.to_string()),
            _ => None,
        })
}

fn stream_faceb_sse_response(
    response: reqwest::Response,
) -> impl futures::Stream<Item = Result<String>> {
    stream::unfold(
        (response.bytes_stream(), String::new(), false),
        |(mut bytes, mut buffer, mut done)| async move {
            loop {
                if done {
                    return None;
                }
                if let Some((line, rest)) = take_line(&buffer) {
                    buffer = rest;
                    if let Some(delta) = parse_sse_line(&line) {
                        return Some((Ok(delta), (bytes, buffer, done)));
                    }
                    continue;
                }
                match bytes.next().await {
                    Some(Ok(chunk)) => buffer.push_str(&String::from_utf8_lossy(&chunk)),
                    Some(Err(err)) => {
                        done = true;
                        return Some((
                            Err(anyhow!("Faceb stream read failed: {}", err)),
                            (bytes, buffer, done),
                        ));
                    }
                    None => {
                        done = true;
                        if !buffer.trim().is_empty() {
                            if let Some(delta) = parse_sse_line(&buffer) {
                                return Some((Ok(delta), (bytes, String::new(), done)));
                            }
                        }
                        return None;
                    }
                }
            }
        },
    )
}

fn take_line(buffer: &str) -> Option<(String, String)> {
    let idx = buffer.find('\n')?;
    Some((
        buffer[..idx].trim_end_matches('\r').to_string(),
        buffer[idx + 1..].to_string(),
    ))
}

fn parse_sse_line(line: &str) -> Option<String> {
    let line = line.trim();
    if !line.starts_with("data:") {
        return None;
    }
    let payload = line.trim_start_matches("data:").trim();
    if payload == "[DONE]" || payload.is_empty() {
        return None;
    }
    let obj = serde_json::from_str::<Value>(payload).ok()?;
    obj.get("choices")?
        .as_array()?
        .first()?
        .get("delta")?
        .get("content")?
        .as_str()
        .filter(|delta| !delta.is_empty())
        .map(ToOwned::to_owned)
}
