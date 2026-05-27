use serde::{Deserialize, Serialize};

/// LLM request envelope sent from JS to Rust. Mirrors `LLMRequest` in
/// `src/types/provider.ts` after the Phase A `callContext` addition.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmRequest {
    pub model: String,
    pub system_prompt: String,
    pub messages: Vec<LlmMessage>,
    pub max_tokens: u32,
    pub temperature: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<LlmToolDefinition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<ThinkingConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_context: Option<CallContext>,
}

/// Thinking-budget config (Claude). `signal` from TS is JS-side only and not
/// represented here — cancellation goes via `request_id` + `llm_cancel`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingConfig {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmMessage {
    /// "user" | "assistant" | "system"
    pub role: String,
    pub content: Vec<LlmContent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LlmContent {
    Text {
        text: String,
    },
    Image {
        #[serde(rename = "mimeType")]
        mime_type: String,
        base64: String,
    },
    Thinking {
        thinking: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolResult {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        content: String,
        #[serde(rename = "isError")]
        is_error: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmToolDefinition {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmResponse {
    pub id: String,
    pub model: String,
    pub content: Vec<LlmResponseContent>,
    /// "end_turn" | "tool_use" | "max_tokens" | "stop_sequence"
    pub stop_reason: String,
    pub usage: UsageInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timing: Option<TimingInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LlmResponseContent {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageInfo {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

/// Streaming chunk. Mirrors TS `LLMStreamChunk` discriminated union.
/// `MessageEnd` carries optional `timing` (added per spec §3.8 to avoid relying
/// on Channel-vs-app.emit ordering).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LlmStreamChunk {
    MessageStart {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    TextDelta {
        text: String,
    },
    ThinkingDelta {
        text: String,
    },
    ThinkingEnd,
    ToolUseStart {
        id: String,
        name: String,
    },
    #[serde(rename_all = "camelCase")]
    ToolUseDelta {
        tool_call_id: String,
        partial_json: String,
    },
    #[serde(rename_all = "camelCase")]
    ToolUseEnd {
        tool_call_id: String,
    },
    #[serde(rename_all = "camelCase")]
    MessageEnd {
        usage: UsageInfo,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timing: Option<TimingInfo>,
        /// Provider-reported finish/stop reason for this round (e.g. "stop",
        /// "length", "tool_calls"). Only Rust sees it in the SSE stream, so it
        /// is surfaced here for per-call telemetry. None when the provider does
        /// not report one in-stream (e.g. Claude uses message_stop events).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        finish_reason: Option<String>,
        /// Time-to-first-token (ms): stream start → first text/tool delta.
        /// Measured in the provider's SSE loop. None if no content was emitted.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ttft_ms: Option<u64>,
    },
}

/// Per-request timing metadata. Surfaced on the final chunk for streams and on
/// `LlmResponse` for non-streaming. ISO-8601 timestamps; latency in ms.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingInfo {
    pub request_started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_token_at: Option<String>,
    pub request_completed_at: String,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub id: String,
    pub name: String,
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub supports_tools: bool,
    pub supports_streaming: bool,
    pub supports_vision: bool,
    pub cost_per_input_token: f64,
    pub cost_per_output_token: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_thinking: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_budget_default: Option<u32>,
}

/// IPC call provenance — populated by JS on every privileged command per spec §3.2.
/// Variants must remain additive (existing variants and fields cannot change shape).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CallContext {
    #[serde(rename_all = "camelCase")]
    Agent {
        agent_id: String,
        process_id: Option<String>,
    },
    User,
    #[serde(rename_all = "camelCase")]
    Scheduler {
        job_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Workflow {
        workflow_run_id: String,
        /// Sandbox policy for the current workflow step's filesystem tool
        /// calls. Workflows have no agent_id to resolve a policy from, so the
        /// step supplies its own (defaults to disabled in step-runners, like
        /// an agent with sandboxConfig.enabled=false). Absent → most
        /// restrictive (user_default) in resolve_policy.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sandbox: Option<WorkflowSandbox>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSandbox {
    pub enabled: bool,
    pub allowed_paths: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn llm_request_serializes_with_camelcase_and_required_fields() {
        let req = LlmRequest {
            model: "claude-opus-4-7".to_string(),
            system_prompt: "You are helpful".to_string(),
            messages: vec![LlmMessage {
                role: "user".to_string(),
                content: vec![LlmContent::Text { text: "hi".into() }],
            }],
            max_tokens: 1024,
            temperature: 0.5,
            tools: None,
            thinking: None,
            call_context: None,
        };
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v["model"], "claude-opus-4-7");
        assert_eq!(v["systemPrompt"], "You are helpful");
        assert_eq!(v["maxTokens"], 1024);
        assert_eq!(v["temperature"], 0.5);
        assert_eq!(v["messages"][0]["role"], "user");
        assert_eq!(v["messages"][0]["content"][0]["type"], "text");
        assert_eq!(v["messages"][0]["content"][0]["text"], "hi");
        // Optional fields absent → null or omitted
        assert!(v.get("tools").map_or(true, |t| t.is_null()));
        assert!(v.get("thinking").map_or(true, |t| t.is_null()));
        assert!(v.get("callContext").map_or(true, |t| t.is_null()));
    }

    #[test]
    fn llm_request_deserializes_typescript_shape() {
        // Simulate what the TS proxy will send.
        let json = serde_json::json!({
            "model": "claude-opus-4-7",
            "systemPrompt": "sys",
            "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
            "maxTokens": 1024,
            "temperature": 0.7,
            "thinking": { "enabled": true, "budgetTokens": 10000 },
            "callContext": { "type": "Agent", "agentId": "a1", "processId": null }
        });
        let req: LlmRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.model, "claude-opus-4-7");
        assert_eq!(req.system_prompt, "sys");
        assert_eq!(req.max_tokens, 1024);
        assert_eq!(req.temperature, 0.7);
        let thinking = req.thinking.unwrap();
        assert!(thinking.enabled);
        assert_eq!(thinking.budget_tokens, Some(10000));
        match req.call_context.unwrap() {
            CallContext::Agent { agent_id, process_id } => {
                assert_eq!(agent_id, "a1");
                assert_eq!(process_id, None);
            }
            _ => panic!("expected Agent variant"),
        }
    }

    #[test]
    fn llm_stream_chunk_message_end_carries_optional_timing() {
        let chunk = LlmStreamChunk::TextDelta { text: "hello".into() };
        let v = serde_json::to_value(&chunk).unwrap();
        assert_eq!(v["type"], "text_delta");
        assert_eq!(v["text"], "hello");

        // MessageEnd without timing.
        let chunk = LlmStreamChunk::MessageEnd {
            usage: UsageInfo { input_tokens: 10, output_tokens: 20 },
            timing: None,
            finish_reason: None,
            ttft_ms: None,
        };
        let v = serde_json::to_value(&chunk).unwrap();
        assert_eq!(v["type"], "message_end");
        assert_eq!(v["usage"]["inputTokens"], 10);
        assert_eq!(v["usage"]["outputTokens"], 20);
        assert!(v.get("timing").map_or(true, |t| t.is_null()));

        // MessageEnd with timing.
        let chunk = LlmStreamChunk::MessageEnd {
            usage: UsageInfo { input_tokens: 5, output_tokens: 7 },
            timing: Some(TimingInfo {
                request_started_at: "2026-05-19T10:00:00Z".into(),
                first_token_at: Some("2026-05-19T10:00:01Z".into()),
                request_completed_at: "2026-05-19T10:00:05Z".into(),
                latency_ms: 5000,
            }),
            finish_reason: Some("stop".into()),
            ttft_ms: Some(1000),
        };
        let v = serde_json::to_value(&chunk).unwrap();
        assert_eq!(v["timing"]["latencyMs"], 5000);
        assert_eq!(v["timing"]["firstTokenAt"], "2026-05-19T10:00:01Z");
    }

    #[test]
    fn llm_response_carries_optional_timing() {
        let res = LlmResponse {
            id: "msg_1".into(),
            model: "claude-opus-4-7".into(),
            content: vec![LlmResponseContent::Text { text: "hello".into() }],
            stop_reason: "end_turn".into(),
            usage: UsageInfo { input_tokens: 10, output_tokens: 20 },
            timing: None,
        };
        let v = serde_json::to_value(&res).unwrap();
        assert_eq!(v["stopReason"], "end_turn");
        assert!(v.get("timing").map_or(true, |t| t.is_null()));
    }

    #[test]
    fn call_context_uses_type_discriminator_with_pascalcase_tags() {
        let ctx = CallContext::User;
        let v = serde_json::to_value(&ctx).unwrap();
        assert_eq!(v["type"], "User");

        let ctx = CallContext::Agent { agent_id: "a1".into(), process_id: None };
        let v = serde_json::to_value(&ctx).unwrap();
        assert_eq!(v["type"], "Agent");
        assert_eq!(v["agentId"], "a1");
        assert!(v["processId"].is_null());

        let ctx = CallContext::Scheduler { job_id: "j1".into() };
        let v = serde_json::to_value(&ctx).unwrap();
        assert_eq!(v["type"], "Scheduler");
        assert_eq!(v["jobId"], "j1");

        let ctx = CallContext::Workflow { workflow_run_id: "w1".into(), sandbox: None };
        let v = serde_json::to_value(&ctx).unwrap();
        assert_eq!(v["type"], "Workflow");
        assert_eq!(v["workflowRunId"], "w1");
    }
}
