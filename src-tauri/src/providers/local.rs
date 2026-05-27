use crate::providers::error::RustError;
use crate::providers::http::http_llm;
use crate::providers::openai_compatible::OpenAiCompatibleProvider;
use crate::providers::provider::{LlmProvider, ProviderConfig, StreamCallback};
use crate::providers::types::{LlmRequest, LlmResponse, ModelConfig, UsageInfo};
use async_trait::async_trait;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

// Base URL must include the `/v1` segment — matches the convention in
// openai_compatible.rs (Groq default is `https://api.groq.com/openai/v1`).
// Both fetch_current_model here AND the inner OpenAiCompatibleProvider's
// send/stream append `/models`, `/chat/completions` etc. directly; if `/v1`
// isn't in the base URL, the latter would 404 against llama.cpp-server.
pub const DEFAULT_BASE_URL: &str = "http://127.0.0.1:8080/v1";

/// Provider for locally-served OpenAI-compatible LLM servers (llama.cpp-server,
/// vLLM, etc.). Unlike `OpenAiCompatibleProvider`, no API key is required, and
/// the active model is auto-discovered on every request by querying `/v1/models`
/// so the user can swap the loaded model without touching their agent config.
pub struct LocalProvider {
    config: ProviderConfig,
    inner: OpenAiCompatibleProvider,
}

impl LocalProvider {
    pub fn new(config: ProviderConfig) -> Self {
        let inner = OpenAiCompatibleProvider::new(config.clone());
        Self { config, inner }
    }

    fn base_url(&self) -> &str {
        self.config.base_url.as_deref().unwrap_or(DEFAULT_BASE_URL)
    }

    /// Query `GET {base_url}/models` and return `data[0].id`.
    /// Returns `NO_MODEL_LOADED` if the `data` array is empty.
    async fn fetch_current_model(&self) -> Result<String, RustError> {
        let (id, _) = self.fetch_current_model_with_ctx().await?;
        Ok(id)
    }

    /// Like `fetch_current_model` but also returns the model's context window
    /// (`meta.n_ctx` from llama.cpp-server's response). Returns None for the
    /// context if the field is missing — callers fall back to a default.
    async fn fetch_current_model_with_ctx(&self) -> Result<(String, Option<usize>), RustError> {
        let url = format!("{}/models", self.base_url());
        let res = http_llm()
            .get(&url)
            .timeout(Duration::from_secs(5))
            .send()
            .await?;
        if !res.status().is_success() {
            let status = res.status().as_u16();
            let body = res.text().await.unwrap_or_default();
            return Err(RustError::provider_http(status, body));
        }
        let json: serde_json::Value = res.json().await?;
        let first = json
            .get("data")
            .and_then(|d| d.as_array())
            .and_then(|arr| arr.first())
            .ok_or_else(|| {
                RustError::new(
                    "NO_MODEL_LOADED",
                    "Local server is running but no model is currently loaded",
                    false,
                )
            })?;
        let id = first
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| RustError::parse("model entry missing 'id'"))?
            .to_string();
        // llama.cpp-server exposes the loaded model's training context via
        // meta.n_ctx; some forks/versions surface it as context_length on the
        // top-level model object. Try both.
        let ctx = first
            .get("meta")
            .and_then(|m| m.get("n_ctx"))
            .and_then(|v| v.as_u64())
            .or_else(|| first.get("context_length").and_then(|v| v.as_u64()))
            .map(|n| n as usize);
        Ok((id, ctx))
    }
}

#[async_trait]
impl LlmProvider for LocalProvider {
    /// Local providers never require an API key.
    fn requires_key(&self) -> bool {
        false
    }

    /// Validate by hitting `{base_url}/models` — success means the server is up.
    async fn validate(&self, _key: Option<&str>) -> Result<bool, RustError> {
        let url = format!("{}/models", self.base_url());
        let res = http_llm()
            .get(&url)
            .timeout(Duration::from_secs(5))
            .send()
            .await?;
        Ok(res.status().is_success())
    }

    /// Returns the currently-loaded model as a single-element list so the UI
    /// can show what is live. Returns `NO_MODEL_LOADED` when `data` is empty.
    ///
    /// `context_window` is sourced from `meta.n_ctx` in the `/v1/models`
    /// response so the token budgeter sees the real ceiling of whatever model
    /// llama.cpp loaded (32k, 64k, 128k, …). Falls back to a conservative
    /// 8192 when the server doesn't report the field.
    async fn list_models(&self, _key: Option<&str>) -> Result<Vec<ModelConfig>, RustError> {
        let (model, ctx) = self.fetch_current_model_with_ctx().await?;
        Ok(vec![ModelConfig {
            id: model.clone(),
            name: model,
            context_window: ctx.unwrap_or(8192) as u32,
            max_output_tokens: 4_096,
            supports_tools: true,
            supports_streaming: true,
            supports_vision: false,
            cost_per_input_token: 0.0,
            cost_per_output_token: 0.0,
            supports_thinking: None,
            thinking_budget_default: None,
        }])
    }

    /// Auto-discovers the current model, overrides `req.model`, then delegates
    /// to the inner OpenAI-compatible provider with a dummy auth token.
    /// llama.cpp-server ignores Bearer headers when `--api-key` is not set.
    async fn send(
        &self,
        _key: Option<&str>,
        mut req: LlmRequest,
        cancel: CancellationToken,
    ) -> Result<LlmResponse, RustError> {
        req.model = self.fetch_current_model().await?;
        self.inner.send(Some("local-no-auth"), req, cancel).await
    }

    /// Auto-discovers the current model, overrides `req.model`, then delegates
    /// streaming to the inner OpenAI-compatible provider.
    async fn stream(
        &self,
        _key: Option<&str>,
        mut req: LlmRequest,
        on_chunk: StreamCallback,
        cancel: CancellationToken,
    ) -> Result<UsageInfo, RustError> {
        req.model = self.fetch_current_model().await?;
        self.inner
            .stream(Some("local-no-auth"), req, on_chunk, cancel)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::provider::ProviderType;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn config_with_base(base_url: String) -> ProviderConfig {
        ProviderConfig {
            id: "local-test".into(),
            r#type: ProviderType::Local,
            name: "Local Test".into(),
            base_url: Some(base_url),
            models: vec![],
            default_model_id: None,
        }
    }

    #[test]
    fn requires_key_is_false() {
        let provider = LocalProvider::new(config_with_base("http://unused".into()));
        assert!(!provider.requires_key());
    }

    #[test]
    fn default_base_url_is_localhost_8080_v1() {
        let mut cfg = config_with_base("http://unused".into());
        cfg.base_url = None;
        let provider = LocalProvider::new(cfg);
        assert_eq!(provider.base_url(), DEFAULT_BASE_URL);
    }

    #[tokio::test]
    async fn validate_returns_true_on_200() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "data": [{ "id": "llama-3.2-3b", "object": "model" }]
                })),
            )
            .mount(&server)
            .await;

        let provider = LocalProvider::new(config_with_base(server.uri()));
        assert!(provider.validate(None).await.unwrap());
    }

    #[tokio::test]
    async fn validate_returns_false_on_500() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        let provider = LocalProvider::new(config_with_base(server.uri()));
        assert!(!provider.validate(None).await.unwrap());
    }

    #[tokio::test]
    async fn list_models_returns_current_model() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "data": [{ "id": "mistral-7b-instruct", "object": "model" }]
                })),
            )
            .mount(&server)
            .await;

        let provider = LocalProvider::new(config_with_base(server.uri()));
        let models = provider.list_models(None).await.unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "mistral-7b-instruct");
        // No meta.n_ctx in this response → falls back to the safe 8192 default.
        assert_eq!(models[0].context_window, 8192);
    }

    #[tokio::test]
    async fn list_models_reads_context_window_from_meta_n_ctx() {
        // llama.cpp-server reports the loaded model's training context as
        // `meta.n_ctx` in the /v1/models response. We must honor it so the
        // token budgeter sees the real ceiling.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "data": [{
                        "id": "qwen3-35b-q8",
                        "object": "model",
                        "meta": { "n_ctx": 65536, "n_vocab": 248320 }
                    }]
                })),
            )
            .mount(&server)
            .await;

        let provider = LocalProvider::new(config_with_base(server.uri()));
        let models = provider.list_models(None).await.unwrap();
        assert_eq!(models[0].context_window, 65536);
    }

    #[tokio::test]
    async fn list_models_returns_no_model_loaded_on_empty_data() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "data": [] })),
            )
            .mount(&server)
            .await;

        let provider = LocalProvider::new(config_with_base(server.uri()));
        let err = provider.list_models(None).await.unwrap_err();
        assert_eq!(err.code, "NO_MODEL_LOADED");
        assert!(!err.retryable);
    }

    #[tokio::test]
    async fn fetch_current_model_returns_network_error_when_unreachable() {
        let provider = LocalProvider::new(config_with_base("http://127.0.0.1:1".into()));
        let err = provider.fetch_current_model().await.unwrap_err();
        assert_eq!(err.code, "NETWORK_ERROR");
    }
}
