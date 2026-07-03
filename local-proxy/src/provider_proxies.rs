//! Provider-specific proxy rotation.

use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Mutex;

struct ProviderProxyState {
    proxies: HashMap<&'static str, Vec<String>>,
    indexes: HashMap<&'static str, AtomicUsize>,
}

static PROVIDER_PROXIES: Lazy<Mutex<ProviderProxyState>> = Lazy::new(|| {
    Mutex::new(ProviderProxyState {
        proxies: HashMap::new(),
        indexes: HashMap::new(),
    })
});

pub async fn init_active(use_ai: &[String], sakana: &[String], faceb: &[String]) {
    let mut state = PROVIDER_PROXIES.lock().await;
    state.proxies = HashMap::from([
        ("use_ai", use_ai.to_vec()),
        ("sakana", sakana.to_vec()),
        ("faceb", faceb.to_vec()),
    ]);
    state.indexes = HashMap::from([
        ("use_ai", AtomicUsize::new(0)),
        ("sakana", AtomicUsize::new(0)),
        ("faceb", AtomicUsize::new(0)),
    ]);
}

pub async fn next_proxy(provider: &str) -> Option<String> {
    let state = PROVIDER_PROXIES.lock().await;
    let proxies = state.proxies.get(provider)?;
    if proxies.is_empty() {
        return None;
    }
    let index = state
        .indexes
        .get(provider)
        .map(|idx| idx.fetch_add(1, Ordering::Relaxed))
        .unwrap_or(0);
    Some(proxies[index % proxies.len()].clone())
}

pub async fn assignments() -> HashMap<&'static str, Vec<String>> {
    PROVIDER_PROXIES.lock().await.proxies.clone()
}

pub async fn set_provider_proxies(provider: &'static str, proxies: Vec<String>) {
    let mut state = PROVIDER_PROXIES.lock().await;
    state.proxies.insert(provider, proxies);
    state.indexes.insert(provider, AtomicUsize::new(0));
}
