use crate::providers::error::RustError;
use crate::providers::http::http_llm;
use crate::providers::provider::{LlmProvider, ProviderConfig, StreamCallback};
use crate::providers::types::{
    LlmRequest, LlmResponse, LlmResponseContent, LlmStreamChunk, ModelConfig, UsageInfo,
};
use async_trait::async_trait;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub const DEFAULT_BASE_URL: &str = "http://localhost:11434";

pub struct OllamaProvider {
    pub config: ProviderConfig,
}

impl OllamaProvider {
    pub fn new(config: ProviderConfig) -> Self {
        Self { config }
    }

    fn base_url(&self) -> &str {
        self.config.base_url.as_deref().unwrap_or(DEFAULT_BASE_URL)
    }
}

fn build_ollama_messages(req: &LlmRequest) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    if !req.system_prompt.is_empty() {
        out.push(serde_json::json!({ "role": "system", "content": req.system_prompt }));
    }
    for msg in &req.messages {
        let text = msg
            .content
            .iter()
            .filter_map(|c| match c {
                crate::providers::types::LlmContent::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        if !text.is_empty() {
            out.push(serde_json::json!({ "role": msg.role, "content": text }));
        }
    }
    out
}

#[async_trait]
impl LlmProvider for OllamaProvider {
    fn requires_key(&self) -> bool {
        false
    }

    async fn validate(&self, _key: Option<&str>) -> Result<bool, RustError> {
        let url = format!("{}/api/tags", self.base_url());
        let res = http_llm()
            .get(&url)
            .timeout(Duration::from_secs(15))
            .send()
            .await?;
        Ok(res.status().is_success())
    }

    async fn list_models(&self, _key: Option<&str>) -> Result<Vec<ModelConfig>, RustError> {
        let url = format!("{}/api/tags", self.base_url());
        let res = http_llm()
            .get(&url)
            .timeout(Duration::from_secs(15))
            .send()
            .await?;
        if !res.status().is_success() {
            return Ok(Vec::new());
        }
        let json: serde_json::Value = res.json().await?;
        let mut models = Vec::new();
        if let Some(arr) = json.get("models").and_then(|v| v.as_array()) {
            for m in arr {
                if let Some(name) = m.get("name").and_then(|v| v.as_str()) {
                    models.push(ModelConfig {
                        id: name.to_string(),
                        name: name.to_string(),
                        context_window: 8192,
                        max_output_tokens: 4096,
                        supports_tools: false,
                        supports_streaming: true,
                        supports_vision: false,
                        cost_per_input_token: 0.0,
                        cost_per_output_token: 0.0,
                        supports_thinking: None,
                        thinking_budget_default: None,
                    });
                }
            }
        }
        Ok(models)
    }

    async fn send(
        &self,
        _key: Option<&str>,
        req: LlmRequest,
        cancel: CancellationToken,
    ) -> Result<LlmResponse, RustError> {
        let url = format!("{}/api/chat", self.base_url());
        // max_tokens == 0 → "let the model decide": Ollama's num_predict
        // sentinel for "generate until EOS / context limit" is -1.
        let num_predict: i64 = if req.max_tokens == 0 { -1 } else { req.max_tokens as i64 };
        let body = serde_json::json!({
            "model": req.model,
            "messages": build_ollama_messages(&req),
            "stream": false,
            "options": {
                "temperature": req.temperature,
                "num_predict": num_predict,
            },
        });

        let fut = http_llm()
            .post(&url)
            .json(&body)
            .timeout(Duration::from_secs(300)) // 5 min per Appendix B
            .send();

        let res = tokio::select! {
            r = fut => r?,
            _ = cancel.cancelled() => return Err(RustError::cancelled()),
        };

        if !res.status().is_success() {
            let status = res.status().as_u16();
            let txt = res.text().await.unwrap_or_default();
            return Err(RustError::provider_http(status, txt));
        }

        let json: serde_json::Value = res.json().await?;
        let text = json
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let usage = UsageInfo {
            input_tokens: json
                .get("prompt_eval_count")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
            output_tokens: json
                .get("eval_count")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
        };

        Ok(LlmResponse {
            id: String::new(),
            model: json
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or(&req.model)
                .to_string(),
            content: vec![LlmResponseContent::Text { text }],
            stop_reason: "end_turn".into(),
            usage,
            timing: None,
        })
    }

    async fn stream(
        &self,
        _key: Option<&str>,
        req: LlmRequest,
        on_chunk: StreamCallback,
        cancel: CancellationToken,
    ) -> Result<UsageInfo, RustError> {
        use crate::providers::http::NdjsonReader;
        let url = format!("{}/api/chat", self.base_url());
        // max_tokens == 0 → "let the model decide": Ollama's num_predict
        // sentinel for "generate until EOS / context limit" is -1.
        let num_predict: i64 = if req.max_tokens == 0 { -1 } else { req.max_tokens as i64 };
        let body = serde_json::json!({
            "model": req.model,
            "messages": build_ollama_messages(&req),
            "stream": true,
            "options": {
                "temperature": req.temperature,
                "num_predict": num_predict,
            },
        });

        let send_fut = http_llm()
            .post(&url)
            .json(&body)
            .timeout(Duration::from_secs(30)) // 30s to first byte per Appendix B
            .send();

        let res = tokio::select! {
            r = send_fut => r?,
            _ = cancel.cancelled() => return Err(RustError::cancelled()),
        };

        if !res.status().is_success() {
            let status = res.status().as_u16();
            let txt = res.text().await.unwrap_or_default();
            return Err(RustError::provider_http(status, txt));
        }

        on_chunk(LlmStreamChunk::MessageStart { id: None });

        let mut reader = NdjsonReader::new(res.bytes_stream());
        let mut usage = UsageInfo::default();

        loop {
            let next = tokio::select! {
                r = reader.next_line() => r?,
                _ = cancel.cancelled() => return Err(RustError::cancelled()),
            };
            let Some(line) = next else { break };
            let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) else { continue };

            if let Some(text) = json
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|v| v.as_str())
            {
                if !text.is_empty() {
                    on_chunk(LlmStreamChunk::TextDelta { text: text.to_string() });
                }
            }

            if json.get("done").and_then(|v| v.as_bool()) == Some(true) {
                usage.input_tokens = json
                    .get("prompt_eval_count")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;
                usage.output_tokens = json
                    .get("eval_count")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;
                break;
            }
        }

        on_chunk(LlmStreamChunk::MessageEnd {
            usage,
            timing: None,
            finish_reason: None,
            ttft_ms: None,
        });
        Ok(usage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::provider::ProviderType;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn cfg(base: String) -> ProviderConfig {
        ProviderConfig {
            id: "ol".into(),
            r#type: ProviderType::Ollama,
            name: "Ollama".into(),
            base_url: Some(base),
            models: vec![],
            default_model_id: None,
        }
    }

    fn test_request(model: &str) -> LlmRequest {
        LlmRequest {
            model: model.into(),
            system_prompt: String::new(),
            messages: vec![crate::providers::types::LlmMessage {
                role: "user".into(),
                content: vec![crate::providers::types::LlmContent::Text { text: "hi".into() }],
            }],
            max_tokens: 100,
            temperature: 0.7,
            tools: None,
            thinking: None,
            call_context: None,
        }
    }

    #[test]
    fn requires_key_is_false() {
        let provider = OllamaProvider::new(cfg("http://unused".into()));
        assert!(!provider.requires_key());
    }

    #[tokio::test]
    async fn list_models_parses_tags_response() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/tags"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "models": [{"name": "llama3:8b"}, {"name": "mistral:7b"}]
            })))
            .mount(&server)
            .await;

        let p = OllamaProvider::new(cfg(server.uri()));
        let models = p.list_models(None).await.unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "llama3:8b");
        assert_eq!(models[1].id, "mistral:7b");
    }

    #[tokio::test]
    async fn send_returns_text() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "model": "llama3",
                "done": true,
                "message": {"role": "assistant", "content": "hi"},
                "prompt_eval_count": 1,
                "eval_count": 2
            })))
            .mount(&server)
            .await;

        let p = OllamaProvider::new(cfg(server.uri()));
        let resp = p
            .send(None, test_request("llama3"), CancellationToken::new())
            .await
            .unwrap();
        assert!(matches!(
            &resp.content[0],
            LlmResponseContent::Text { text } if text == "hi"
        ));
        assert_eq!(resp.usage.input_tokens, 1);
        assert_eq!(resp.usage.output_tokens, 2);
        assert_eq!(resp.stop_reason, "end_turn");
        assert!(resp.timing.is_none());
    }

    #[tokio::test]
    async fn stream_yields_deltas_and_done() {
        let body = concat!(
            "{\"message\":{\"content\":\"He\"},\"done\":false}\n",
            "{\"message\":{\"content\":\"llo\"},\"done\":false}\n",
            "{\"message\":{\"content\":\"\"},\"done\":true,\"prompt_eval_count\":2,\"eval_count\":3}\n",
        );
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .mount(&server)
            .await;

        let p = OllamaProvider::new(cfg(server.uri()));
        let chunks = std::sync::Arc::new(std::sync::Mutex::new(Vec::<LlmStreamChunk>::new()));
        let cc = chunks.clone();
        let cb: StreamCallback = Box::new(move |c| cc.lock().unwrap().push(c));

        let usage = p
            .stream(None, test_request("llama3"), cb, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(usage.input_tokens, 2);
        assert_eq!(usage.output_tokens, 3);

        let recv = chunks.lock().unwrap().clone();
        assert!(matches!(recv.first(), Some(LlmStreamChunk::MessageStart { .. })));
        assert!(recv
            .iter()
            .any(|c| matches!(c, LlmStreamChunk::TextDelta { text } if text == "He")));
        assert!(recv
            .iter()
            .any(|c| matches!(c, LlmStreamChunk::TextDelta { text } if text == "llo")));
        assert!(matches!(recv.last(), Some(LlmStreamChunk::MessageEnd { .. })));
    }
}
