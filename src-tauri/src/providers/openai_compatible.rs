use crate::providers::error::RustError;
use crate::providers::http::http_llm;
use crate::providers::provider::{LlmProvider, ProviderConfig, StreamCallback};
use crate::providers::types::{LlmRequest, LlmResponse, LlmStreamChunk, ModelConfig, UsageInfo};
use async_trait::async_trait;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub const DEFAULT_BASE_URL: &str = "https://api.groq.com/openai/v1";

/// Some chat templates (qwen, llama 3 instruct, deepseek) enforce strict
/// role alternation after an optional system message and raise a Jinja
/// exception on consecutive user-or-assistant messages. Real conversations
/// hit this whenever a prior assistant turn errored without saving a
/// reply (rate limit, network blip), leaving consecutive user rows in
/// `messages`. This helper collapses adjacent same-role text-only rows
/// into one before the request reaches the server, preserving every word
/// the user typed while keeping the template happy.
///
/// Tool-use and tool-result messages are NOT merged — the same Jinja rule
/// explicitly exempts "tool calls and results", and merging them would
/// destroy the call_id ↔ result_id pairing the model needs.
fn merge_consecutive_same_role_text(
    messages: &[crate::providers::types::LlmMessage],
) -> Vec<crate::providers::types::LlmMessage> {
    use crate::providers::types::{LlmContent, LlmMessage};
    let mut out: Vec<LlmMessage> = Vec::with_capacity(messages.len());
    for msg in messages {
        // Only text-only messages are eligible to merge with their
        // predecessor. Anything with images, tool_use, or tool_result
        // stays as its own row.
        let text_only = !msg.content.is_empty() && msg.content.iter().all(|c| matches!(c, LlmContent::Text { .. } | LlmContent::Thinking { .. }));
        if let Some(prev) = out.last_mut() {
            let prev_text_only = !prev.content.is_empty() && prev.content.iter().all(|c| matches!(c, LlmContent::Text { .. } | LlmContent::Thinking { .. }));
            if text_only && prev_text_only && prev.role == msg.role {
                // Merge: append this msg's content blocks to the prior
                // message with a "\n\n---\n\n" visual separator so the
                // model can still tell the turns apart.
                prev.content.push(LlmContent::Text { text: "\n\n---\n\n".to_string() });
                for c in &msg.content {
                    prev.content.push(c.clone());
                }
                continue;
            }
        }
        out.push(msg.clone());
    }
    out
}

fn build_openai_messages(req: &LlmRequest) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    if !req.system_prompt.is_empty() {
        out.push(serde_json::json!({ "role": "system", "content": req.system_prompt }));
    }
    let sanitized = merge_consecutive_same_role_text(&req.messages);
    for msg in &sanitized {
        let mut text_parts = Vec::new();
        let mut image_parts = Vec::new();
        let mut tool_uses = Vec::new();
        let mut tool_results = Vec::new();
        let mut thinking_parts = Vec::new();
        for c in &msg.content {
            use crate::providers::types::LlmContent::*;
            match c {
                Text { text } => text_parts.push(text.clone()),
                Image { mime_type, base64 } => image_parts.push((mime_type.clone(), base64.clone())),
                // Reasoning models (DeepSeek-R1 and routers like Opencode Zen)
                // REQUIRE the prior turn's reasoning_content to be echoed back
                // when continuing — otherwise: "The reasoning_content in the
                // thinking mode must be passed back to the API." So we collect
                // it and attach it to assistant messages below. Providers that
                // don't use reasoning ignore the extra field.
                Thinking { thinking } => thinking_parts.push(thinking.clone()),
                ToolUse { id, name, input } => tool_uses.push((id.clone(), name.clone(), input.clone())),
                ToolResult { tool_call_id, content, .. } => {
                    tool_results.push((tool_call_id.clone(), content.clone()))
                }
            }
        }

        if !tool_uses.is_empty() {
            let tc: Vec<_> = tool_uses
                .into_iter()
                .map(|(id, name, input)| {
                    serde_json::json!({
                        "id": id,
                        "type": "function",
                        "function": { "name": name, "arguments": input.to_string() }
                    })
                })
                .collect();
            let mut assistant_msg = serde_json::json!({
                "role": "assistant",
                "content": if text_parts.is_empty() {
                    serde_json::Value::Null
                } else {
                    serde_json::Value::String(text_parts.join("\n"))
                },
                "tool_calls": tc,
            });
            if !thinking_parts.is_empty() {
                assistant_msg["reasoning_content"] =
                    serde_json::json!(thinking_parts.join("\n"));
            }
            out.push(assistant_msg);
        } else if !tool_results.is_empty() {
            for (id, content) in tool_results {
                out.push(serde_json::json!({
                    "role": "tool",
                    "content": content,
                    "tool_call_id": id,
                }));
            }
        } else if !image_parts.is_empty() {
            let mut content_arr = Vec::new();
            for t in text_parts {
                content_arr.push(serde_json::json!({ "type": "text", "text": t }));
            }
            for (mime, b64) in image_parts {
                content_arr.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": { "url": format!("data:{};base64,{}", mime, b64), "detail": "auto" }
                }));
            }
            out.push(serde_json::json!({ "role": msg.role, "content": content_arr }));
        } else if !text_parts.is_empty() {
            let mut m = serde_json::json!({ "role": msg.role, "content": text_parts.join("\n") });
            if msg.role == "assistant" && !thinking_parts.is_empty() {
                m["reasoning_content"] = serde_json::json!(thinking_parts.join("\n"));
            }
            out.push(m);
        }
    }
    out
}

/// Thin wrapper that assembles an `LlmDump` and writes it. Keeps the two
/// failure sites in `stream()` terse.
#[allow(clippy::too_many_arguments)]
fn write_stream_dump(
    url: &str,
    model: &str,
    request_body: &serde_json::Value,
    status: u16,
    headers: &[String],
    events_received: usize,
    received_tail: &[String],
    error_chain: Option<&str>,
) {
    use crate::providers::debug_dump::{write_dump, LlmDump};
    write_dump(&LlmDump {
        provider: "openai-compatible",
        url,
        model,
        request_body,
        response_status: Some(status),
        response_headers: headers,
        events_received,
        received_tail,
        error_chain,
    });
}

fn build_openai_tools(tools: &[crate::providers::types::LlmToolDefinition]) -> Vec<serde_json::Value> {
    tools.iter().map(|t| serde_json::json!({
        "type": "function",
        "function": { "name": t.name, "description": t.description, "parameters": t.input_schema }
    })).collect()
}

pub struct OpenAiCompatibleProvider {
    pub config: ProviderConfig,
}

impl OpenAiCompatibleProvider {
    pub fn new(config: ProviderConfig) -> Self {
        Self { config }
    }

    fn base_url(&self) -> &str {
        self.config.base_url.as_deref().unwrap_or(DEFAULT_BASE_URL)
    }
}

#[async_trait]
impl LlmProvider for OpenAiCompatibleProvider {
    fn requires_key(&self) -> bool {
        true
    }

    async fn validate(&self, key: Option<&str>) -> Result<bool, RustError> {
        let key = key.ok_or_else(|| RustError::auth_missing("OpenAI-Compatible"))?;
        let url = format!("{}/models", self.base_url());
        let res = http_llm()
            .get(&url)
            .bearer_auth(key)
            .timeout(Duration::from_secs(15))
            .send()
            .await?;
        Ok(res.status().is_success())
    }

    async fn list_models(&self, key: Option<&str>) -> Result<Vec<ModelConfig>, RustError> {
        // Query the server's /models endpoint. OpenAI / Groq / generic
        // OpenAI-compatible servers implement it; response shape is
        // `{ data: [{ id, ... }, ...] }`. No hardcoded fallback — if the
        // endpoint isn't reachable or returns an error, surface it so the
        // UI can show what went wrong instead of fake model names.
        let url = format!("{}/models", self.base_url());
        let mut builder = http_llm().get(&url).timeout(Duration::from_secs(15));
        if let Some(k) = key {
            builder = builder.bearer_auth(k);
        }
        let res = builder.send().await?;
        if !res.status().is_success() {
            let status = res.status().as_u16();
            let body = res.text().await.unwrap_or_default();
            return Err(RustError::provider_http(status, body));
        }
        let json: serde_json::Value = res.json().await?;
        let mut models = Vec::new();
        if let Some(arr) = json.get("data").and_then(|d| d.as_array()) {
            for entry in arr {
                if let Some(id) = entry.get("id").and_then(|v| v.as_str()) {
                    models.push(ModelConfig {
                        id: id.to_string(),
                        name: id.to_string(),
                        context_window: 128_000,
                        max_output_tokens: 8_192,
                        supports_tools: true,
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
        key: Option<&str>,
        req: LlmRequest,
        cancel: CancellationToken,
    ) -> Result<LlmResponse, RustError> {
        let key = key.ok_or_else(|| RustError::auth_missing("OpenAI-Compatible"))?;
        let url = format!("{}/chat/completions", self.base_url());
        let mut body = serde_json::json!({
            "model": req.model,
            "messages": build_openai_messages(&req),
            "stream": false,
            "temperature": req.temperature,
        });
        // max_tokens == 0 is the "let the model decide" sentinel: omit the
        // field so the server generates until EOS or the context ceiling.
        if req.max_tokens > 0 {
            body["max_tokens"] = serde_json::json!(req.max_tokens);
        }
        if let Some(tools) = &req.tools {
            if !tools.is_empty() {
                body["tools"] = serde_json::Value::Array(build_openai_tools(tools));
            }
        }

        let fut = http_llm()
            .post(&url)
            .bearer_auth(key)
            .json(&body)
            .timeout(Duration::from_secs(300))   // 5 min per Appendix B
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
        parse_openai_response(json, &req.model)
    }

    async fn stream(
        &self,
        key: Option<&str>,
        req: LlmRequest,
        on_chunk: StreamCallback,
        cancel: CancellationToken,
    ) -> Result<UsageInfo, RustError> {
        use crate::providers::http::SseReader;
        let key = key.ok_or_else(|| RustError::auth_missing("OpenAI-Compatible"))?;
        let url = format!("{}/chat/completions", self.base_url());
        let mut body = serde_json::json!({
            "model": req.model,
            "messages": build_openai_messages(&req),
            "stream": true,
            "stream_options": { "include_usage": true },
            "temperature": req.temperature,
        });
        // max_tokens == 0 is the "let the model decide" sentinel: omit the
        // field so the server generates until EOS or the context ceiling.
        if req.max_tokens > 0 {
            body["max_tokens"] = serde_json::json!(req.max_tokens);
        }
        if let Some(tools) = &req.tools {
            if !tools.is_empty() {
                body["tools"] = serde_json::Value::Array(build_openai_tools(tools));
            }
        }

        let send_fut = http_llm()
            .post(&url)
            .bearer_auth(key)
            // NOTE: reqwest's `.timeout()` bounds the ENTIRE request,
            // including the incrementally-read SSE body — not just
            // time-to-headers. If we set it to our first-chunk budget it
            // races (and usually beats) the FIRST_CHUNK_TIMEOUT watchdog
            // below, surfacing a cryptic "operation timed out / error
            // decoding response body" instead of the watchdog's actionable
            // message. So here it is only a coarse final backstop (1h); the
            // FIRST_CHUNK_TIMEOUT and IDLE_TIMEOUT watchdogs are the real
            // stall controls and produce the user-facing diagnostics.
            .timeout(Duration::from_secs(3600))
            .json(&body)
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

        // Capture response metadata for the on-error debug dump BEFORE
        // bytes_stream() consumes `res`. The headers (Content-Type,
        // Content-Encoding, server/cf-ray) plus the received-data tail are
        // what let us tell a genuine connection drop apart from e.g. the
        // provider streaming back an error page or a non-SSE body.
        let dump_status = res.status().as_u16();
        let dump_headers: Vec<String> = res
            .headers()
            .iter()
            .map(|(k, v)| format!("{}: {}", k, v.to_str().unwrap_or("<non-utf8>")))
            .collect();

        let stream = res.bytes_stream();
        let mut sse = SseReader::new(stream);
        let mut active_tool_id: Option<String> = None;
        let mut usage = UsageInfo::default();
        // Rolling capture for the debug dump: count of events and a tail of
        // the most recent raw SSE payloads (each capped) so a dump stays
        // small even on a long stream.
        let mut events_received: usize = 0;
        let mut received_tail: Vec<String> = Vec::new();
        // Reasoning-model support: servers like llama.cpp + qwen/deepseek-r1
        // emit `delta.reasoning_content` for chain-of-thought before any
        // `delta.content`. Surface those as ThinkingDelta so the UI shows
        // progress instead of a frozen typing bubble. ThinkingEnd is fired on
        // the first non-empty content delta or on finish_reason.
        let mut in_reasoning = false;
        // Degenerate-response detection. A stream can complete "successfully"
        // (no HTTP error, no stall) yet emit neither text nor a tool call —
        // an empty completion (the model stalled / returned nothing after a
        // tool result, common on overloaded/free/stealth models). None of the
        // error dumps above fire for it, so we track content here and write a
        // dump at end-of-stream when nothing meaningful came back.
        let mut emitted_text = false;
        let mut emitted_tool = false;
        let mut saw_reasoning = false;
        let mut last_finish_reason: Option<String> = None;
        // Time-to-first-token: stream start → first emitted text/tool delta.
        // Measured here because only the provider's SSE loop sees the bytes.
        let stream_start = std::time::Instant::now();
        let mut ttft_ms: Option<u64> = None;

        // Stream watchdog with two distinct budgets:
        //   • FIRST_CHUNK_TIMEOUT — time until the *first* SSE chunk arrives.
        //     This covers server-side prompt processing AND queueing on
        //     free/shared endpoints, which for a large model on a big prompt
        //     can legitimately take minutes. The connection is open (headers
        //     returned) but no `data:` line flows yet.
        //   • IDLE_TIMEOUT — gap between chunks once streaming has started.
        //     Once tokens flow, a 60s gap means a genuine mid-stream stall.
        // Using one short timeout for both (the old behaviour) caused false
        // "stalled" errors on slow/queued providers like Nemotron on free
        // tiers, even though the request was perfectly valid.
        const FIRST_CHUNK_TIMEOUT: Duration = Duration::from_secs(300);
        const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
        let mut first_chunk_seen = false;
        loop {
            let watchdog = if first_chunk_seen { IDLE_TIMEOUT } else { FIRST_CHUNK_TIMEOUT };
            let next = tokio::select! {
                r = sse.next_data() => match r {
                    Ok(v) => v,
                    Err(e) => {
                        // Stream byte-read failed (the cryptic "error decoding
                        // response body" lives here). Dump everything we have
                        // so the failure can be classified. e.message already
                        // carries the full source chain (see SseReader).
                        write_stream_dump(
                            &url, &req.model, &body, dump_status, &dump_headers,
                            events_received, &received_tail, Some(&e.message),
                        );
                        return Err(e);
                    }
                },
                _ = cancel.cancelled() => {
                    if let Some(id) = active_tool_id.take() {
                        on_chunk(LlmStreamChunk::ToolUseEnd { tool_call_id: id });
                    }
                    return Err(RustError::cancelled());
                }
                _ = tokio::time::sleep(watchdog) => {
                    if let Some(id) = active_tool_id.take() {
                        on_chunk(LlmStreamChunk::ToolUseEnd { tool_call_id: id });
                    }
                    let msg = if first_chunk_seen {
                        format!(
                            "Stream stalled mid-response — no data for {}s after streaming had \
                             started. The provider likely dropped the connection.",
                            IDLE_TIMEOUT.as_secs()
                        )
                    } else {
                        format!(
                            "Provider sent no tokens within {}s of accepting the request. This \
                             usually means a slow or queued model (common on free/shared tiers) \
                             or an oversized prompt being processed. Try a faster/smaller model, \
                             a paid tier, or a shorter prompt.",
                            FIRST_CHUNK_TIMEOUT.as_secs()
                        )
                    };
                    write_stream_dump(
                        &url, &req.model, &body, dump_status, &dump_headers,
                        events_received, &received_tail, Some(&msg),
                    );
                    return Err(RustError::network(msg));
                }
            };
            let Some(data) = next else { break };
            first_chunk_seen = true;
            events_received += 1;
            // Keep a bounded tail: last 40 events, each capped at 600 chars.
            received_tail.push(data.chars().take(600).collect());
            if received_tail.len() > 40 {
                received_tail.remove(0);
            }
            let Ok(json) = serde_json::from_str::<serde_json::Value>(&data) else { continue };

            // In-band SSE error chunk. OpenRouter (and some OpenAI-compatible
            // gateways) return HTTP 200 and then stream an error object when an
            // upstream provider is unavailable, e.g.
            //   {"choices":[],"error":{"code":502,"message":"Provider returned
            //    error","metadata":{"error_type":"provider_unavailable"}}}
            // Without this the chunk is skipped (no choices[0]), the stream
            // ends empty, and the turn looks like an "empty completion" — which
            // hides a transient, retryable provider error and wrongly implicates
            // the model. Surface it as a typed error so it's reported accurately
            // and (for 5xx/429) becomes retryable + fallback-eligible.
            if let Some(err_obj) = json.get("error").filter(|e| !e.is_null()) {
                if let Some(id) = active_tool_id.take() {
                    on_chunk(LlmStreamChunk::ToolUseEnd { tool_call_id: id });
                }
                let emsg = err_obj.get("message").and_then(|v| v.as_str()).unwrap_or("provider error");
                let etype = err_obj
                    .get("metadata")
                    .and_then(|m| m.get("error_type"))
                    .and_then(|v| v.as_str());
                let ecode = err_obj.get("code").and_then(|v| v.as_u64());
                let full = format!(
                    "Provider streamed an error: {emsg}{}{}",
                    etype.map(|t| format!(" ({t})")).unwrap_or_default(),
                    ecode.map(|c| format!(" [code {c}]")).unwrap_or_default(),
                );
                write_stream_dump(
                    &url, &req.model, &body, dump_status, &dump_headers,
                    events_received, &received_tail, Some(&full),
                );
                // HTTP-style status codes map to a typed provider_http error
                // (5xx/429 are retryable + fallback-eligible on the TS side).
                // A non-numeric/absent code is still treated as a transient
                // network error rather than a hard failure.
                return Err(match ecode {
                    Some(c) if (100..=599).contains(&c) => RustError::provider_http(c as u16, full),
                    _ => RustError::network(full),
                });
            }

            if let Some(u) = json.get("usage") {
                if let Some(pt) = u.get("prompt_tokens").and_then(|v| v.as_u64()) { usage.input_tokens = pt as u32; }
                if let Some(ct) = u.get("completion_tokens").and_then(|v| v.as_u64()) { usage.output_tokens = ct as u32; }
            }
            let Some(choice) = json.get("choices").and_then(|c| c.get(0)) else { continue };
            let delta = choice.get("delta");
            let finish_reason = choice.get("finish_reason").and_then(|v| v.as_str());
            if let Some(fr) = finish_reason {
                last_finish_reason = Some(fr.to_string());
            }

            if let Some(delta) = delta {
                // Reasoning/chain-of-thought field name varies by provider:
                //   • llama.cpp / deepseek-r1 / opencode-zen → `reasoning_content`
                //   • OpenRouter (e.g. moonshotai/kimi-k2.6) → `reasoning`
                //     (with a parallel structured `reasoning_details` array).
                // Read whichever is present. Without this, kimi-style reasoning
                // is invisible (no ThinkingDelta) and the turn can look empty.
                let reasoning = delta
                    .get("reasoning_content")
                    .and_then(|v| v.as_str())
                    .or_else(|| delta.get("reasoning").and_then(|v| v.as_str()));
                if let Some(rc) = reasoning {
                    if !rc.is_empty() {
                        in_reasoning = true;
                        saw_reasoning = true;
                        on_chunk(LlmStreamChunk::ThinkingDelta { text: rc.to_string() });
                    }
                }
                if let Some(text) = delta.get("content").and_then(|v| v.as_str()) {
                    if !text.is_empty() {
                        if in_reasoning {
                            on_chunk(LlmStreamChunk::ThinkingEnd);
                            in_reasoning = false;
                        }
                        emitted_text = true;
                        if ttft_ms.is_none() {
                            ttft_ms = Some(stream_start.elapsed().as_millis() as u64);
                        }
                        on_chunk(LlmStreamChunk::TextDelta { text: text.to_string() });
                    }
                }
                if let Some(tcs) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                    for tc in tcs {
                        let func = tc.get("function");
                        if let Some(name) = func.and_then(|f| f.get("name")).and_then(|v| v.as_str()) {
                            if let Some(prev) = active_tool_id.take() {
                                on_chunk(LlmStreamChunk::ToolUseEnd { tool_call_id: prev });
                            }
                            let id = tc.get("id").and_then(|v| v.as_str()).map(String::from)
                                .or_else(|| tc.get("index").and_then(|v| v.as_u64()).map(|i| format!("tool_{}", i)))
                                .unwrap_or_default();
                            emitted_tool = true;
                            if ttft_ms.is_none() {
                                ttft_ms = Some(stream_start.elapsed().as_millis() as u64);
                            }
                            on_chunk(LlmStreamChunk::ToolUseStart {
                                id: id.clone(), name: name.to_string()
                            });
                            active_tool_id = Some(id);
                        }
                        if let Some(args) = func.and_then(|f| f.get("arguments")).and_then(|v| v.as_str()) {
                            if let Some(id) = &active_tool_id {
                                on_chunk(LlmStreamChunk::ToolUseDelta {
                                    tool_call_id: id.clone(),
                                    partial_json: args.to_string(),
                                });
                            }
                        }
                    }
                }
            }

            if finish_reason.is_some() && active_tool_id.is_some() {
                let id = active_tool_id.take().unwrap();
                on_chunk(LlmStreamChunk::ToolUseEnd { tool_call_id: id });
            }
        }

        if let Some(id) = active_tool_id.take() {
            on_chunk(LlmStreamChunk::ToolUseEnd { tool_call_id: id });
        }
        if in_reasoning {
            // Reasoning model finished without ever emitting content (e.g.
            // max_tokens consumed entirely during chain-of-thought). Close
            // the thinking block so the UI doesn't show "still thinking".
            on_chunk(LlmStreamChunk::ThinkingEnd);
        }
        // Empty completion: the stream ended cleanly but produced no text and
        // no tool call. The error dumps above never fire for this, yet it's a
        // real failure (the step gets empty output). Write a dump with the raw
        // SSE so it can be told apart from a genuine answer — e.g. the model
        // emitted only reasoning_content, or ended with finish_reason="stop"
        // and an empty content delta after queueing server-side.
        if !emitted_text && !emitted_tool {
            let summary = format!(
                "EMPTY COMPLETION — stream finished with no assistant text and no tool call.\n\
                 emitted_text=false, emitted_tool_call=false, reasoning_content_seen={}, \
                 finish_reason={:?}, events_received={}, prompt_tokens={}, completion_tokens={}.\n\
                 The provider accepted the request and ended the turn without producing usable \
                 content (common on overloaded/free or stealth/rotating models, or a model that \
                 spent its output budget on hidden reasoning). The received SSE tail below shows \
                 exactly what the provider sent.",
                saw_reasoning, last_finish_reason, events_received,
                usage.input_tokens, usage.output_tokens,
            );
            write_stream_dump(
                &url, &req.model, &body, dump_status, &dump_headers,
                events_received, &received_tail, Some(&summary),
            );
        }
        on_chunk(LlmStreamChunk::MessageEnd {
            usage,
            timing: None,
            finish_reason: last_finish_reason,
            ttft_ms,
        });
        Ok(usage)
    }
}

fn parse_openai_response(json: serde_json::Value, request_model: &str) -> Result<LlmResponse, RustError> {
    use crate::providers::types::LlmResponseContent;
    let id = json.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let model = json.get("model").and_then(|v| v.as_str()).unwrap_or(request_model).to_string();
    let usage = json.get("usage").map(|u| UsageInfo {
        input_tokens: u.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        output_tokens: u.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
    }).unwrap_or_default();

    let choice = json.get("choices").and_then(|c| c.get(0))
        .ok_or_else(|| RustError::parse("missing choices[0]"))?;
    let message = choice.get("message")
        .ok_or_else(|| RustError::parse("missing choices[0].message"))?;
    let finish_reason = choice.get("finish_reason").and_then(|v| v.as_str()).unwrap_or("stop");

    let mut content = Vec::new();
    if let Some(text) = message.get("content").and_then(|v| v.as_str()) {
        if !text.is_empty() {
            content.push(LlmResponseContent::Text { text: text.to_string() });
        }
    }
    let mut has_tool_calls = false;
    if let Some(tc_arr) = message.get("tool_calls").and_then(|v| v.as_array()) {
        for tc in tc_arr {
            has_tool_calls = true;
            let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let func = tc.get("function").ok_or_else(|| RustError::parse("tool_call missing function"))?;
            let name = func.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let args_str = func.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}");
            let input: serde_json::Value = serde_json::from_str(args_str)
                .unwrap_or_else(|_| serde_json::json!({}));
            content.push(LlmResponseContent::ToolUse { id, name, input });
        }
    }

    let stop_reason = if has_tool_calls {
        "tool_use".to_string()
    } else if finish_reason == "length" {
        "max_tokens".to_string()
    } else {
        "end_turn".to_string()
    };

    if content.is_empty() {
        content.push(LlmResponseContent::Text { text: String::new() });
    }

    Ok(LlmResponse { id, model, content, stop_reason, usage, timing: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::provider::ProviderType;
    use crate::providers::types::{LlmContent, LlmMessage};
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn umsg(text: &str) -> LlmMessage {
        LlmMessage {
            role: "user".into(),
            content: vec![LlmContent::Text { text: text.into() }],
        }
    }
    fn amsg(text: &str) -> LlmMessage {
        LlmMessage {
            role: "assistant".into(),
            content: vec![LlmContent::Text { text: text.into() }],
        }
    }

    #[test]
    fn merge_collapses_consecutive_user_messages() {
        // Real-world repro: prior assistant turn errored and saved no
        // reply, so the user retried, leaving [user, user, user] in
        // history. Strict templates (qwen, llama-instruct) reject this.
        let merged = merge_consecutive_same_role_text(&[
            umsg("first"),
            umsg("second"),
            umsg("third"),
        ]);
        assert_eq!(merged.len(), 1);
        let text = merged[0].content.iter().filter_map(|c| {
            if let LlmContent::Text { text } = c { Some(text.as_str()) } else { None }
        }).collect::<Vec<_>>().join("");
        assert!(text.contains("first"));
        assert!(text.contains("second"));
        assert!(text.contains("third"));
        assert!(text.contains("---"), "separator should appear between merged turns");
    }

    #[test]
    fn merge_preserves_normal_alternation() {
        let merged = merge_consecutive_same_role_text(&[
            umsg("u1"), amsg("a1"), umsg("u2"), amsg("a2"),
        ]);
        assert_eq!(merged.len(), 4, "no merge should happen when roles alternate");
    }

    #[test]
    fn merge_does_not_touch_tool_use_or_tool_result() {
        let tool_msg = LlmMessage {
            role: "assistant".into(),
            content: vec![LlmContent::ToolUse {
                id: "x".into(),
                name: "n".into(),
                input: serde_json::json!({}),
            }],
        };
        let merged = merge_consecutive_same_role_text(&[
            amsg("text-only assistant"),
            tool_msg,
        ]);
        // Same role (both assistant), but second is tool_use → must NOT merge.
        assert_eq!(merged.len(), 2);
    }

    fn config_with_base(base_url: String) -> ProviderConfig {
        ProviderConfig {
            id: "test".into(),
            r#type: ProviderType::OpenAiCompatible,
            name: "Test".into(),
            base_url: Some(base_url),
            models: vec![],
            default_model_id: None,
        }
    }

    #[tokio::test]
    async fn validate_returns_true_on_200() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .and(header("authorization", "Bearer test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": []})))
            .mount(&server)
            .await;

        let provider = OpenAiCompatibleProvider::new(config_with_base(server.uri()));
        assert_eq!(provider.validate(Some("test-key")).await.unwrap(), true);
    }

    #[tokio::test]
    async fn validate_returns_false_on_401() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;

        let provider = OpenAiCompatibleProvider::new(config_with_base(server.uri()));
        assert_eq!(provider.validate(Some("test-key")).await.unwrap(), false);
    }

    #[tokio::test]
    async fn validate_returns_auth_missing_with_no_key() {
        let provider = OpenAiCompatibleProvider::new(config_with_base("http://unused".into()));
        let err = provider.validate(None).await.unwrap_err();
        assert_eq!(err.code, "AUTH_MISSING");
    }

    #[tokio::test]
    async fn list_models_returns_error_when_endpoint_unreachable() {
        // Base URL points to a port nothing listens on — call fails → NETWORK_ERROR.
        let provider = OpenAiCompatibleProvider::new(config_with_base("http://127.0.0.1:1".into()));
        let err = provider.list_models(None).await.unwrap_err();
        assert_eq!(err.code, "NETWORK_ERROR");
    }

    #[tokio::test]
    async fn list_models_parses_server_response() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "object": "list",
                "data": [
                    { "id": "llama-3.2-3b-instruct-q4_k_m", "object": "model" },
                    { "id": "qwen2.5-7b-instruct", "object": "model" }
                ]
            })))
            .mount(&server)
            .await;

        let provider = OpenAiCompatibleProvider::new(config_with_base(server.uri()));
        let models = provider.list_models(Some("k")).await.unwrap();
        assert_eq!(models.len(), 2);
        assert!(models.iter().any(|m| m.id == "llama-3.2-3b-instruct-q4_k_m"));
        assert!(models.iter().any(|m| m.id == "qwen2.5-7b-instruct"));
    }

    #[tokio::test]
    async fn list_models_returns_empty_when_server_returns_empty_data() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "object": "list", "data": []
            })))
            .mount(&server)
            .await;
        let provider = OpenAiCompatibleProvider::new(config_with_base(server.uri()));
        let models = provider.list_models(Some("k")).await.unwrap();
        // Empty data → empty list. Caller decides UX (e.g., "no models found").
        assert!(models.is_empty());
    }

    #[tokio::test]
    async fn list_models_surfaces_http_error_on_404() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(ResponseTemplate::new(404).set_body_string("not found"))
            .mount(&server)
            .await;
        let provider = OpenAiCompatibleProvider::new(config_with_base(server.uri()));
        let err = provider.list_models(Some("k")).await.unwrap_err();
        assert_eq!(err.code, "PROVIDER_HTTP_404");
    }

    #[test]
    fn requires_key_is_true() {
        let provider = OpenAiCompatibleProvider::new(config_with_base("http://unused".into()));
        assert!(provider.requires_key());
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
    async fn send_returns_text_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "resp-123",
                "model": "test-model",
                "choices": [{
                    "message": { "content": "Hello world", "tool_calls": null },
                    "finish_reason": "stop"
                }],
                "usage": { "prompt_tokens": 10, "completion_tokens": 20 }
            })))
            .mount(&server)
            .await;

        let provider = OpenAiCompatibleProvider::new(config_with_base(server.uri()));
        let resp = provider
            .send(Some("test-key"), test_request("test-model"), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(resp.id, "resp-123");
        assert_eq!(resp.stop_reason, "end_turn");
        assert_eq!(resp.usage.input_tokens, 10);
        assert_eq!(resp.usage.output_tokens, 20);
        assert!(matches!(
            &resp.content[0],
            crate::providers::types::LlmResponseContent::Text { text } if text == "Hello world"
        ));
        assert!(resp.timing.is_none());
    }

    #[tokio::test]
    async fn send_extracts_tool_calls() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "resp-456",
                "model": "test-model",
                "choices": [{
                    "message": {
                        "content": null,
                        "tool_calls": [{
                            "id": "call_1",
                            "type": "function",
                            "function": { "name": "get_weather", "arguments": "{\"city\":\"NYC\"}" }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }],
                "usage": { "prompt_tokens": 5, "completion_tokens": 15 }
            })))
            .mount(&server)
            .await;

        let provider = OpenAiCompatibleProvider::new(config_with_base(server.uri()));
        let resp = provider
            .send(Some("test-key"), test_request("test-model"), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(resp.stop_reason, "tool_use");
        assert!(matches!(
            &resp.content[0],
            crate::providers::types::LlmResponseContent::ToolUse { name, .. } if name == "get_weather"
        ));
    }

    #[tokio::test]
    async fn send_returns_http_error_with_status_code() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(429).set_body_string("rate limited"))
            .mount(&server)
            .await;

        let provider = OpenAiCompatibleProvider::new(config_with_base(server.uri()));
        let err = provider
            .send(Some("test-key"), test_request("test-model"), CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(err.code, "PROVIDER_HTTP_429");
        assert!(err.retryable);
    }

    #[tokio::test]
    async fn send_respects_cancellation_token() {
        // Server that delays 10s — token cancellation should beat the response.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"id":"x","model":"x","choices":[{"message":{"content":"x"},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0}}))
                .set_delay(std::time::Duration::from_secs(10)))
            .mount(&server)
            .await;

        let provider = OpenAiCompatibleProvider::new(config_with_base(server.uri()));
        let token = CancellationToken::new();
        let token_for_cancel = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            token_for_cancel.cancel();
        });
        let err = provider
            .send(Some("test-key"), test_request("test-model"), token)
            .await
            .unwrap_err();
        assert_eq!(err.code, "CANCELLED");
    }

    #[tokio::test]
    async fn stream_yields_text_deltas_and_end() {
        let sse_body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4}}\n\n",
            "data: [DONE]\n\n",
        );
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(sse_body),
            )
            .mount(&server)
            .await;

        let provider = OpenAiCompatibleProvider::new(config_with_base(server.uri()));
        let chunks = std::sync::Arc::new(std::sync::Mutex::new(Vec::<LlmStreamChunk>::new()));
        let chunks_clone = chunks.clone();
        let cb: StreamCallback = Box::new(move |c| chunks_clone.lock().unwrap().push(c));

        let usage = provider.stream(Some("k"), test_request("m"), cb, CancellationToken::new()).await.unwrap();
        assert_eq!(usage.input_tokens, 3);
        assert_eq!(usage.output_tokens, 4);

        let received = chunks.lock().unwrap().clone();
        // Expect: MessageStart, text_delta("Hel"), text_delta("lo"), MessageEnd
        assert!(matches!(received.first(), Some(LlmStreamChunk::MessageStart { .. })));
        assert!(received.iter().any(|c| matches!(c, LlmStreamChunk::TextDelta { text } if text == "Hel")));
        assert!(received.iter().any(|c| matches!(c, LlmStreamChunk::TextDelta { text } if text == "lo")));
        assert!(matches!(received.last(), Some(LlmStreamChunk::MessageEnd { .. })));
    }

    #[tokio::test]
    async fn stream_emits_reasoning_content_as_thinking_delta() {
        let sse_body = concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"Let\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\" me think\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"!\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":4}}\n\n",
            "data: [DONE]\n\n",
        );
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(sse_body),
            )
            .mount(&server)
            .await;

        let provider = OpenAiCompatibleProvider::new(config_with_base(server.uri()));
        let chunks = std::sync::Arc::new(std::sync::Mutex::new(Vec::<LlmStreamChunk>::new()));
        let chunks_clone = chunks.clone();
        let cb: StreamCallback = Box::new(move |c| chunks_clone.lock().unwrap().push(c));
        provider.stream(Some("k"), test_request("m"), cb, CancellationToken::new()).await.unwrap();

        let received = chunks.lock().unwrap().clone();
        // Expect ordering: MessageStart, ThinkingDelta("Let"), ThinkingDelta(" me think"),
        // ThinkingEnd, TextDelta("Hi"), TextDelta("!"), MessageEnd.
        let kinds: Vec<&str> = received.iter().map(|c| match c {
            LlmStreamChunk::MessageStart { .. } => "start",
            LlmStreamChunk::ThinkingDelta { .. } => "think",
            LlmStreamChunk::ThinkingEnd => "think_end",
            LlmStreamChunk::TextDelta { .. } => "text",
            LlmStreamChunk::MessageEnd { .. } => "end",
            _ => "other",
        }).collect();
        assert_eq!(kinds, vec!["start", "think", "think", "think_end", "text", "text", "end"]);
        let think_text: String = received.iter().filter_map(|c| {
            if let LlmStreamChunk::ThinkingDelta { text } = c { Some(text.clone()) } else { None }
        }).collect();
        assert_eq!(think_text, "Let me think");
    }

    #[tokio::test]
    async fn stream_reasoning_only_emits_thinking_end_at_close() {
        // Reasoning model burns whole budget on chain-of-thought; no content
        // delta ever arrives. ThinkingEnd must still fire so the UI closes
        // the thinking block.
        let sse_body = concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking...\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}\n\n",
            "data: [DONE]\n\n",
        );
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(sse_body),
            )
            .mount(&server)
            .await;

        let provider = OpenAiCompatibleProvider::new(config_with_base(server.uri()));
        let chunks = std::sync::Arc::new(std::sync::Mutex::new(Vec::<LlmStreamChunk>::new()));
        let chunks_clone = chunks.clone();
        let cb: StreamCallback = Box::new(move |c| chunks_clone.lock().unwrap().push(c));
        provider.stream(Some("k"), test_request("m"), cb, CancellationToken::new()).await.unwrap();

        let received = chunks.lock().unwrap().clone();
        assert!(received.iter().any(|c| matches!(c, LlmStreamChunk::ThinkingDelta { text } if text == "thinking...")));
        // ThinkingEnd must appear before MessageEnd.
        let think_end_idx = received.iter().position(|c| matches!(c, LlmStreamChunk::ThinkingEnd));
        let msg_end_idx = received.iter().position(|c| matches!(c, LlmStreamChunk::MessageEnd { .. }));
        assert!(think_end_idx.is_some());
        assert!(msg_end_idx.is_some());
        assert!(think_end_idx.unwrap() < msg_end_idx.unwrap());
    }

    #[tokio::test]
    async fn stream_emits_tool_use_chunks() {
        let sse_body = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_x\",\"function\":{\"name\":\"foo\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"a\\\":1}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":2}}\n\n",
            "data: [DONE]\n\n",
        );
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(sse_body))
            .mount(&server).await;

        let provider = OpenAiCompatibleProvider::new(config_with_base(server.uri()));
        let chunks = std::sync::Arc::new(std::sync::Mutex::new(Vec::<LlmStreamChunk>::new()));
        let chunks_clone = chunks.clone();
        let cb: StreamCallback = Box::new(move |c| chunks_clone.lock().unwrap().push(c));

        provider.stream(Some("k"), test_request("m"), cb, CancellationToken::new()).await.unwrap();
        let received = chunks.lock().unwrap().clone();
        assert!(received.iter().any(|c| matches!(c, LlmStreamChunk::ToolUseStart { name, .. } if name == "foo")));
        assert!(received.iter().any(|c| matches!(c, LlmStreamChunk::ToolUseDelta { partial_json, .. } if partial_json == "{\"a\":1}")));
        assert!(received.iter().any(|c| matches!(c, LlmStreamChunk::ToolUseEnd { .. })));
    }
}
