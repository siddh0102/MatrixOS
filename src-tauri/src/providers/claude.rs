use crate::providers::error::RustError;
use crate::providers::http::http_llm;
use crate::providers::provider::{LlmProvider, ProviderConfig, StreamCallback};
use crate::providers::types::{LlmRequest, LlmResponse, LlmStreamChunk, ModelConfig, UsageInfo};
use async_trait::async_trait;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com/v1";
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Claude's Messages API requires `max_tokens` — there is no "unlimited"
/// option. When an agent uses the 0 = "let the model decide" sentinel we
/// substitute this generous default. The context budgeter has already
/// compacted the prompt to leave headroom, so this is safe against
/// Claude's large context windows.
const CLAUDE_FALLBACK_MAX_TOKENS: u32 = 8_192;

/// Resolves the request's max_tokens for Claude, applying the fallback for
/// the 0 sentinel.
fn claude_max_tokens(requested: u32) -> u32 {
    if requested == 0 { CLAUDE_FALLBACK_MAX_TOKENS } else { requested }
}

pub fn default_models() -> Vec<ModelConfig> {
    vec![
        ModelConfig {
            id: "claude-sonnet-4-5".into(),
            name: "Claude Sonnet 4.5".into(),
            context_window: 200_000,
            max_output_tokens: 8_192,
            supports_tools: true,
            supports_streaming: true,
            supports_vision: true,
            cost_per_input_token: 3.0 / 1_000_000.0,
            cost_per_output_token: 15.0 / 1_000_000.0,
            supports_thinking: Some(true),
            thinking_budget_default: Some(10_000),
        },
        ModelConfig {
            id: "claude-opus-4-7".into(),
            name: "Claude Opus 4.7".into(),
            context_window: 200_000,
            max_output_tokens: 8_192,
            supports_tools: true,
            supports_streaming: true,
            supports_vision: true,
            cost_per_input_token: 15.0 / 1_000_000.0,
            cost_per_output_token: 75.0 / 1_000_000.0,
            supports_thinking: Some(true),
            thinking_budget_default: Some(10_000),
        },
        ModelConfig {
            id: "claude-haiku-4-5-20251001".into(),
            name: "Claude Haiku 4.5".into(),
            context_window: 200_000,
            max_output_tokens: 8_192,
            supports_tools: true,
            supports_streaming: true,
            supports_vision: true,
            cost_per_input_token: 0.8 / 1_000_000.0,
            cost_per_output_token: 4.0 / 1_000_000.0,
            supports_thinking: None,
            thinking_budget_default: None,
        },
    ]
}

pub struct ClaudeProvider {
    pub config: ProviderConfig,
}

impl ClaudeProvider {
    pub fn new(config: ProviderConfig) -> Self {
        Self { config }
    }
    fn base_url(&self) -> &str {
        self.config.base_url.as_deref().unwrap_or(DEFAULT_BASE_URL)
    }
}

fn build_claude_messages(req: &LlmRequest) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for msg in &req.messages {
        let mut blocks = Vec::new();
        for c in &msg.content {
            use crate::providers::types::LlmContent::*;
            match c {
                Text { text } => blocks.push(serde_json::json!({ "type": "text", "text": text })),
                Image { mime_type, base64 } => blocks.push(serde_json::json!({
                    "type": "image",
                    "source": { "type": "base64", "media_type": mime_type, "data": base64 }
                })),
                // Claude requires a valid `signature` on thinking blocks
                // echoed back when extended thinking is enabled, and rejects
                // them outright otherwise. We don't capture thinking
                // signatures from the stream, so drop thinking blocks rather
                // than send invalid ones. (Reasoning echo-back is an
                // openai-compatible/DeepSeek concern, handled there.)
                Thinking { .. } => {}
                ToolUse { id, name, input } => blocks.push(serde_json::json!({
                    "type": "tool_use", "id": id, "name": name, "input": input
                })),
                ToolResult { tool_call_id, content, is_error } => blocks.push(serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": tool_call_id,
                    "content": content,
                    "is_error": is_error
                })),
            }
        }
        out.push(serde_json::json!({ "role": msg.role, "content": blocks }));
    }
    out
}

fn build_claude_tools(tools: &[crate::providers::types::LlmToolDefinition]) -> Vec<serde_json::Value> {
    tools.iter().map(|t| serde_json::json!({
        "name": t.name, "description": t.description, "input_schema": t.input_schema
    })).collect()
}

#[async_trait]
impl LlmProvider for ClaudeProvider {
    fn requires_key(&self) -> bool { true }

    async fn validate(&self, key: Option<&str>) -> Result<bool, RustError> {
        let key = key.ok_or_else(|| RustError::auth_missing("Claude"))?;
        let url = format!("{}/messages", self.base_url());
        let body = serde_json::json!({
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 1,
            "messages": [{ "role": "user", "content": "hi" }],
        });
        let res = http_llm()
            .post(&url)
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&body)
            .timeout(Duration::from_secs(15))
            .send()
            .await?;
        Ok(res.status() != reqwest::StatusCode::UNAUTHORIZED
            && res.status() != reqwest::StatusCode::FORBIDDEN)
    }

    async fn list_models(&self, _key: Option<&str>) -> Result<Vec<ModelConfig>, RustError> {
        Ok(default_models())
    }

    async fn send(
        &self,
        key: Option<&str>,
        req: LlmRequest,
        cancel: CancellationToken,
    ) -> Result<LlmResponse, RustError> {
        let key = key.ok_or_else(|| RustError::auth_missing("Claude"))?;
        let url = format!("{}/messages", self.base_url());
        let mut body = serde_json::json!({
            "model": req.model,
            "messages": build_claude_messages(&req),
            "max_tokens": claude_max_tokens(req.max_tokens),
            "temperature": req.temperature,
        });
        if !req.system_prompt.is_empty() { body["system"] = serde_json::json!(req.system_prompt); }
        if let Some(tools) = &req.tools {
            if !tools.is_empty() {
                body["tools"] = serde_json::Value::Array(build_claude_tools(tools));
            }
        }
        if let Some(thinking) = &req.thinking {
            if thinking.enabled {
                let mut th = serde_json::json!({ "type": "enabled" });
                if let Some(b) = thinking.budget_tokens {
                    th["budget_tokens"] = serde_json::json!(b);
                }
                body["thinking"] = th;
            }
        }

        let fut = http_llm()
            .post(&url)
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&body)
            .timeout(Duration::from_secs(300))
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
        parse_claude_response(json, &req.model)
    }

    async fn stream(
        &self,
        key: Option<&str>,
        req: LlmRequest,
        on_chunk: StreamCallback,
        cancel: CancellationToken,
    ) -> Result<UsageInfo, RustError> {
        use crate::providers::http::SseReader;
        let key = key.ok_or_else(|| RustError::auth_missing("Claude"))?;
        let url = format!("{}/messages", self.base_url());
        let mut body = serde_json::json!({
            "model": req.model,
            "messages": build_claude_messages(&req),
            "max_tokens": claude_max_tokens(req.max_tokens),
            "temperature": req.temperature,
            "stream": true,
        });
        if !req.system_prompt.is_empty() { body["system"] = serde_json::json!(req.system_prompt); }
        if let Some(tools) = &req.tools {
            if !tools.is_empty() {
                body["tools"] = serde_json::Value::Array(build_claude_tools(tools));
            }
        }
        if let Some(thinking) = &req.thinking {
            if thinking.enabled {
                let mut th = serde_json::json!({ "type": "enabled" });
                if let Some(b) = thinking.budget_tokens {
                    th["budget_tokens"] = serde_json::json!(b);
                }
                body["thinking"] = th;
            }
        }

        let send_fut = http_llm()
            .post(&url)
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&body)
            .timeout(Duration::from_secs(30))
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
        let stream = res.bytes_stream();
        let mut sse = SseReader::new(stream);
        let mut usage = UsageInfo::default();
        let mut tool_blocks: std::collections::HashMap<u64, String> = std::collections::HashMap::new();
        let mut thinking_open = false;

        loop {
            let next = tokio::select! {
                r = sse.next_data() => r?,
                _ = cancel.cancelled() => return Err(RustError::cancelled()),
            };
            let Some(data) = next else { break };
            let Ok(evt) = serde_json::from_str::<serde_json::Value>(&data) else { continue };
            let evt_type = evt.get("type").and_then(|v| v.as_str()).unwrap_or("");

            match evt_type {
                "message_start" => {
                    if let Some(u) = evt.get("message").and_then(|m| m.get("usage")) {
                        if let Some(it) = u.get("input_tokens").and_then(|v| v.as_u64()) {
                            usage.input_tokens = it as u32;
                        }
                    }
                }
                "content_block_start" => {
                    let idx = evt.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                    if let Some(block) = evt.get("content_block") {
                        match block.get("type").and_then(|v| v.as_str()) {
                            Some("tool_use") => {
                                let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                tool_blocks.insert(idx, id.clone());
                                on_chunk(LlmStreamChunk::ToolUseStart { id, name });
                            }
                            Some("thinking") => {
                                thinking_open = true;
                            }
                            _ => {}
                        }
                    }
                }
                "content_block_delta" => {
                    let idx = evt.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                    let delta = evt.get("delta");
                    let delta_type = delta.and_then(|d| d.get("type")).and_then(|v| v.as_str()).unwrap_or("");
                    match delta_type {
                        "text_delta" => {
                            if let Some(text) = delta.and_then(|d| d.get("text")).and_then(|v| v.as_str()) {
                                on_chunk(LlmStreamChunk::TextDelta { text: text.to_string() });
                            }
                        }
                        "thinking_delta" => {
                            if let Some(text) = delta.and_then(|d| d.get("thinking")).and_then(|v| v.as_str()) {
                                on_chunk(LlmStreamChunk::ThinkingDelta { text: text.to_string() });
                            }
                        }
                        "input_json_delta" => {
                            if let Some(partial) = delta.and_then(|d| d.get("partial_json")).and_then(|v| v.as_str()) {
                                if let Some(id) = tool_blocks.get(&idx) {
                                    on_chunk(LlmStreamChunk::ToolUseDelta {
                                        tool_call_id: id.clone(),
                                        partial_json: partial.to_string(),
                                    });
                                }
                            }
                        }
                        _ => {}
                    }
                }
                "content_block_stop" => {
                    let idx = evt.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                    if let Some(id) = tool_blocks.remove(&idx) {
                        on_chunk(LlmStreamChunk::ToolUseEnd { tool_call_id: id });
                    } else if thinking_open {
                        on_chunk(LlmStreamChunk::ThinkingEnd);
                        thinking_open = false;
                    }
                }
                "message_delta" => {
                    if let Some(u) = evt.get("usage") {
                        if let Some(ot) = u.get("output_tokens").and_then(|v| v.as_u64()) {
                            usage.output_tokens = ot as u32;
                        }
                    }
                }
                "message_stop" => break,
                _ => {}
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

fn parse_claude_response(json: serde_json::Value, request_model: &str) -> Result<LlmResponse, RustError> {
    use crate::providers::types::LlmResponseContent;
    let id = json.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let model = json.get("model").and_then(|v| v.as_str()).unwrap_or(request_model).to_string();
    let stop_reason = json.get("stop_reason").and_then(|v| v.as_str()).unwrap_or("end_turn").to_string();
    let usage = json.get("usage").map(|u| UsageInfo {
        input_tokens: u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        output_tokens: u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
    }).unwrap_or_default();

    let mut content = Vec::new();
    if let Some(arr) = json.get("content").and_then(|v| v.as_array()) {
        for block in arr {
            match block.get("type").and_then(|v| v.as_str()) {
                Some("text") => {
                    if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                        content.push(LlmResponseContent::Text { text: t.to_string() });
                    }
                }
                Some("tool_use") => {
                    let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let input = block.get("input").cloned().unwrap_or(serde_json::json!({}));
                    content.push(LlmResponseContent::ToolUse { id, name, input });
                }
                _ => {} // skip thinking blocks etc.
            }
        }
    }
    if content.is_empty() {
        content.push(LlmResponseContent::Text { text: String::new() });
    }

    Ok(LlmResponse { id, model, content, stop_reason, usage, timing: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::provider::ProviderType;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn config_with_base(base_url: String) -> ProviderConfig {
        ProviderConfig {
            id: "test".into(),
            r#type: ProviderType::Claude,
            name: "Claude".into(),
            base_url: Some(base_url),
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

    #[tokio::test]
    async fn validate_returns_true_when_key_accepted() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/messages"))
            .and(header("x-api-key", "k"))
            .and(header("anthropic-version", ANTHROPIC_VERSION))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server).await;
        let p = ClaudeProvider::new(config_with_base(server.uri()));
        assert_eq!(p.validate(Some("k")).await.unwrap(), true);
    }

    #[tokio::test]
    async fn validate_returns_false_on_401() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/messages"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server).await;
        let p = ClaudeProvider::new(config_with_base(server.uri()));
        assert_eq!(p.validate(Some("k")).await.unwrap(), false);
    }

    #[tokio::test]
    async fn list_models_includes_haiku() {
        let p = ClaudeProvider::new(config_with_base("http://unused".into()));
        let models = p.list_models(None).await.unwrap();
        assert!(models.iter().any(|m| m.id.starts_with("claude-haiku")));
    }

    #[test]
    fn requires_key_is_true() {
        let p = ClaudeProvider::new(config_with_base("http://unused".into()));
        assert!(p.requires_key());
    }

    #[tokio::test]
    async fn send_returns_text_block() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "msg_123",
                "model": "claude-sonnet-4-5",
                "content": [{ "type": "text", "text": "Hi!" }],
                "stop_reason": "end_turn",
                "usage": { "input_tokens": 5, "output_tokens": 3 }
            })))
            .mount(&server).await;

        let p = ClaudeProvider::new(config_with_base(server.uri()));
        let resp = p.send(Some("k"), test_request("claude-sonnet-4-5"), CancellationToken::new()).await.unwrap();
        assert_eq!(resp.id, "msg_123");
        assert_eq!(resp.stop_reason, "end_turn");
        assert!(matches!(&resp.content[0], crate::providers::types::LlmResponseContent::Text { text } if text == "Hi!"));
        assert!(resp.timing.is_none());
    }

    #[tokio::test]
    async fn send_extracts_tool_use_blocks() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "msg_456",
                "model": "claude-sonnet-4-5",
                "content": [
                    { "type": "text", "text": "Let me check." },
                    { "type": "tool_use", "id": "toolu_1", "name": "get_weather", "input": {"city": "NYC"} }
                ],
                "stop_reason": "tool_use",
                "usage": { "input_tokens": 10, "output_tokens": 20 }
            })))
            .mount(&server).await;

        let p = ClaudeProvider::new(config_with_base(server.uri()));
        let mut req = test_request("claude-sonnet-4-5");
        req.system_prompt = "Be brief.".into();
        req.tools = Some(vec![crate::providers::types::LlmToolDefinition {
            name: "get_weather".into(),
            description: "get the weather".into(),
            input_schema: serde_json::json!({"type": "object", "properties": {"city": {"type": "string"}}}),
        }]);
        let resp = p.send(Some("k"), req, CancellationToken::new()).await.unwrap();
        assert_eq!(resp.stop_reason, "tool_use");
        assert_eq!(resp.content.len(), 2);
        assert!(matches!(&resp.content[1], crate::providers::types::LlmResponseContent::ToolUse { name, .. } if name == "get_weather"));
    }

    #[tokio::test]
    async fn stream_yields_text_deltas() {
        let sse_body = concat!(
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":5,\"output_tokens\":0}}}\n\n",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}\n\n",
            "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":2}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        );
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/messages"))
            .respond_with(ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(sse_body))
            .mount(&server).await;

        let p = ClaudeProvider::new(config_with_base(server.uri()));
        let chunks = std::sync::Arc::new(std::sync::Mutex::new(Vec::<LlmStreamChunk>::new()));
        let cc = chunks.clone();
        let cb: StreamCallback = Box::new(move |c| cc.lock().unwrap().push(c));

        let usage = p.stream(Some("k"), test_request("claude-sonnet-4-5"), cb, CancellationToken::new()).await.unwrap();
        assert_eq!(usage.input_tokens, 5);
        assert_eq!(usage.output_tokens, 2);
        let recv = chunks.lock().unwrap().clone();
        assert!(matches!(recv.first(), Some(LlmStreamChunk::MessageStart { .. })));
        assert!(recv.iter().any(|c| matches!(c, LlmStreamChunk::TextDelta { text } if text == "Hel")));
        assert!(recv.iter().any(|c| matches!(c, LlmStreamChunk::TextDelta { text } if text == "lo")));
        assert!(matches!(recv.last(), Some(LlmStreamChunk::MessageEnd { .. })));
    }

    #[tokio::test]
    async fn stream_emits_thinking_deltas_when_enabled() {
        let sse_body = concat!(
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":0}}}\n\n",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"reasoning...\"}}\n\n",
            "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"answer\"}}\n\n",
            "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
            "event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":5}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        );
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/messages"))
            .respond_with(ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(sse_body))
            .mount(&server).await;

        let p = ClaudeProvider::new(config_with_base(server.uri()));
        let chunks = std::sync::Arc::new(std::sync::Mutex::new(Vec::<LlmStreamChunk>::new()));
        let cc = chunks.clone();
        let cb: StreamCallback = Box::new(move |c| cc.lock().unwrap().push(c));

        let mut req = test_request("claude-opus-4-7");
        req.thinking = Some(crate::providers::types::ThinkingConfig { enabled: true, budget_tokens: Some(5000) });
        p.stream(Some("k"), req, cb, CancellationToken::new()).await.unwrap();
        let recv = chunks.lock().unwrap().clone();
        assert!(recv.iter().any(|c| matches!(c, LlmStreamChunk::ThinkingDelta { text } if text == "reasoning...")));
        assert!(recv.iter().any(|c| matches!(c, LlmStreamChunk::ThinkingEnd)));
        assert!(recv.iter().any(|c| matches!(c, LlmStreamChunk::TextDelta { text } if text == "answer")));
    }
}
