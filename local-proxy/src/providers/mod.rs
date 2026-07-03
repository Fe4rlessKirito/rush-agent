//! Provider routing and shared completion interface.

pub mod faceb;
pub mod sakana;
pub mod use_ai;

use anyhow::Result;
use futures::stream::BoxStream;
use serde_json::Value;

use crate::account_pool::Account;

#[derive(Clone, Debug, serde::Serialize)]
pub struct ProviderPoolStats {
    pub provider: &'static str,
    pub ready: usize,
    pub target: Option<usize>,
    pub generated: Option<u64>,
    pub failed: Option<u64>,
    pub dead: Option<u64>,
    pub cooling: Option<usize>,
    pub degraded: bool,
    pub last_error: Option<String>,
}

#[derive(Clone)]
pub struct CompletionRequest {
    pub model: String,
    pub messages: Vec<Value>,
    pub proxy_url: Option<String>,
    pub account: Option<Account>,
}

pub fn requires_use_ai_account(model: &str) -> bool {
    !faceb::is_faceb_model(model) && !crate::sakana::is_sakana_model(model)
}

pub fn provider_for_model(model: &str) -> &'static str {
    if faceb::is_faceb_model(model) {
        "faceb"
    } else if crate::sakana::is_sakana_model(model) {
        "sakana"
    } else {
        "use_ai"
    }
}

pub trait CompletionProvider {
    fn stream_completion(
        &self,
        request: CompletionRequest,
    ) -> impl std::future::Future<Output = BoxStream<'static, Result<String>>> + Send;

    fn complete_completion(
        &self,
        request: CompletionRequest,
    ) -> impl std::future::Future<Output = Result<String>> + Send;
}

pub async fn stream_completion(request: CompletionRequest) -> BoxStream<'static, Result<String>> {
    if faceb::is_faceb_model(&request.model) {
        return faceb::FacebProvider.stream_completion(request).await;
    }

    if crate::sakana::is_sakana_model(&request.model) {
        return sakana::SakanaProvider.stream_completion(request).await;
    }

    use_ai::UseAiProvider.stream_completion(request).await
}

pub async fn complete_completion(request: CompletionRequest) -> Result<String> {
    if faceb::is_faceb_model(&request.model) {
        return faceb::FacebProvider.complete_completion(request).await;
    }

    if crate::sakana::is_sakana_model(&request.model) {
        return sakana::SakanaProvider.complete_completion(request).await;
    }

    use_ai::UseAiProvider.complete_completion(request).await
}

pub async fn pool_stats(use_ai_ready: usize, use_ai_target: usize) -> Vec<ProviderPoolStats> {
    let mut stats = vec![ProviderPoolStats {
        provider: "use_ai",
        ready: use_ai_ready,
        target: Some(use_ai_target),
        generated: None,
        failed: None,
        dead: None,
        cooling: None,
        degraded: use_ai_ready == 0,
        last_error: if use_ai_ready == 0 {
            Some("use.ai account pool is empty".to_string())
        } else {
            None
        },
    }];
    stats.push(sakana::pool_stats().await);
    stats.push(faceb::pool_stats().await);
    stats
}
