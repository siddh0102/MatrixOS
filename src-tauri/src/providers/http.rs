//! Shared HTTP client and SSE / NDJSON line readers.
//!
//! `HTTP_LLM` is the singleton reqwest client used by every LLM provider
//! (and Phase D MCP HTTP). It uses rustls-tls-native-roots so OS-installed
//! root CAs are honored.
//!
//! A separate "HTTP_TOOLS" client used to live here for `web_fetch`, but
//! `web_fetch` must call `reqwest::Client::builder().resolve_to_addrs(...)`
//! per request to pin the specific IPs validated against SSRF — a shared
//! client can't do that, so each `web_fetch` builds its own client. The
//! old singleton was never used and has been removed.

use crate::providers::error::RustError;
use futures_util::{Stream, StreamExt};
use reqwest::Client;
use std::pin::Pin;
use std::sync::OnceLock;
use std::time::Duration;

static HTTP_LLM: OnceLock<Client> = OnceLock::new();

/// Shared client for LLM HTTP traffic. Default redirect policy.
/// Per-endpoint timeouts (5min for `llm_send`, 30s+streaming for `llm_stream`,
/// 15s for `llm_validate`/`llm_list_models`) are applied at request-build time
/// by individual provider impls and override this client's default.
pub fn http_llm() -> &'static Client {
    HTTP_LLM.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(60))
            .pool_idle_timeout(Duration::from_secs(90))
            .user_agent(concat!("MatrixOS/", env!("CARGO_PKG_VERSION")))
            // Force HTTP/1.1. SSE token streams behind CDNs (Cloudflare in
            // front of OpenRouter / OpenCode Zen) are prone to HTTP/2
            // RST_STREAM / incomplete-message errors that surface as the
            // cryptic "error decoding response body" mid-stream. SSE is an
            // HTTP/1.1-shaped protocol and streams far more reliably over h1;
            // we gain nothing from h2 multiplexing for one-shot LLM calls.
            .http1_only()
            .build()
            .expect("Failed to build HTTP_LLM client")
    })
}

/// Reads SSE event-stream chunks and returns the data payload of each `data:` line.
/// Returns `Ok(None)` when the stream ends or `data: [DONE]` is encountered.
pub struct SseReader<S> {
    stream: Pin<Box<S>>,
    buffer: Vec<u8>,
}

impl<S, E> SseReader<S>
where
    S: Stream<Item = Result<bytes::Bytes, E>> + Send + Unpin,
    E: std::error::Error + 'static,
{
    pub fn new(stream: S) -> Self {
        Self {
            stream: Box::pin(stream),
            buffer: Vec::new(),
        }
    }

    pub async fn next_data(&mut self) -> Result<Option<String>, RustError> {
        loop {
            if let Some(data) = self.try_extract_data()? {
                if data == "[DONE]" {
                    return Ok(None);
                }
                return Ok(Some(data));
            }
            match self.stream.next().await {
                Some(Ok(bytes)) => {
                    self.buffer.extend_from_slice(&bytes);
                }
                Some(Err(e)) => {
                    // Walk the full source chain — reqwest's top-level
                    // "error decoding response body" hides the real cause
                    // (connection reset, unexpected EOF, h2 GOAWAY, …).
                    let chain = crate::providers::debug_dump::error_chain(&e);
                    return Err(RustError::network(format!(
                        "Connection dropped while streaming the response. The provider closed \
                         or reset the connection before the response completed — common on \
                         overloaded free/shared tiers. Full error chain:\n{chain}"
                    )));
                }
                None => return Ok(None),
            }
        }
    }

    fn try_extract_data(&mut self) -> Result<Option<String>, RustError> {
        loop {
            let Some(newline) = self.buffer.iter().position(|&b| b == b'\n') else {
                return Ok(None);
            };
            // Validate the complete line as UTF-8. Since newlines are single-byte ASCII,
            // a complete line ending at `\n` cannot have a codepoint straddling a chunk
            // boundary — any UTF-8 error here is a genuine decode failure.
            let line_bytes = &self.buffer[..newline];
            let line = std::str::from_utf8(line_bytes)
                .map_err(|e| RustError::parse(format!("invalid UTF-8: {}", e)))?
                .trim_end_matches('\r')
                .to_string();
            self.buffer.drain(..=newline);

            if let Some(rest) = line.strip_prefix("data: ") {
                return Ok(Some(rest.to_string()));
            }
            if let Some(rest) = line.strip_prefix("data:") {
                return Ok(Some(rest.trim_start().to_string()));
            }
            // Skip blank lines, event:, id:, retry:, comments (lines starting with ':')
        }
    }
}

/// Reads newline-delimited JSON. Returns each non-empty line as a string.
pub struct NdjsonReader<S> {
    stream: Pin<Box<S>>,
    buffer: Vec<u8>,
}

impl<S, E> NdjsonReader<S>
where
    S: Stream<Item = Result<bytes::Bytes, E>> + Send + Unpin,
    E: std::error::Error + 'static,
{
    pub fn new(stream: S) -> Self {
        Self {
            stream: Box::pin(stream),
            buffer: Vec::new(),
        }
    }

    pub async fn next_line(&mut self) -> Result<Option<String>, RustError> {
        loop {
            if let Some(line) = self.try_extract_line()? {
                if !line.is_empty() {
                    return Ok(Some(line));
                }
                continue;
            }
            match self.stream.next().await {
                Some(Ok(bytes)) => {
                    self.buffer.extend_from_slice(&bytes);
                }
                Some(Err(e)) => {
                    let chain = crate::providers::debug_dump::error_chain(&e);
                    return Err(RustError::network(format!(
                        "Connection dropped while streaming the response. The provider closed \
                         or reset the connection before the response completed — common on \
                         overloaded free/shared tiers. Full error chain:\n{chain}"
                    )));
                }
                None => {
                    let last = std::mem::take(&mut self.buffer);
                    let last_str = std::str::from_utf8(&last)
                        .map_err(|e| RustError::parse(format!("invalid UTF-8: {}", e)))?;
                    let trimmed = last_str.trim().to_string();
                    return Ok(if trimmed.is_empty() { None } else { Some(trimmed) });
                }
            }
        }
    }

    fn try_extract_line(&mut self) -> Result<Option<String>, RustError> {
        let Some(newline) = self.buffer.iter().position(|&b| b == b'\n') else {
            return Ok(None);
        };
        // Validate the complete line as UTF-8. Newlines are single-byte ASCII, so
        // a complete line cannot have a codepoint straddling a chunk boundary —
        // any UTF-8 error here is a genuine decode failure.
        let line_bytes = &self.buffer[..newline];
        let line = std::str::from_utf8(line_bytes)
            .map_err(|e| RustError::parse(format!("invalid UTF-8: {}", e)))?
            .trim_end_matches('\r')
            .to_string();
        self.buffer.drain(..=newline);
        Ok(Some(line))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;
    use std::convert::Infallible;

    fn bytes_stream(chunks: Vec<&'static str>) -> impl futures_util::Stream<Item = Result<bytes::Bytes, Infallible>> {
        stream::iter(chunks.into_iter().map(|s| Ok(bytes::Bytes::from(s.as_bytes()))))
    }

    fn bytes_stream_raw(chunks: Vec<&'static [u8]>) -> impl futures_util::Stream<Item = Result<bytes::Bytes, Infallible>> {
        stream::iter(chunks.into_iter().map(|s| Ok(bytes::Bytes::from_static(s))))
    }

    #[tokio::test]
    async fn sse_reader_splits_data_lines() {
        let body = bytes_stream(vec![
            "data: hello\n\n",
            "data: world\n\n",
            "data: [DONE]\n\n",
        ]);
        let mut reader = SseReader::new(body);
        assert_eq!(reader.next_data().await.unwrap(), Some("hello".to_string()));
        assert_eq!(reader.next_data().await.unwrap(), Some("world".to_string()));
        assert_eq!(reader.next_data().await.unwrap(), None);
    }

    #[tokio::test]
    async fn sse_reader_handles_split_chunks() {
        let body = bytes_stream(vec!["data: hel", "lo\n\ndata: world\n\n", "data: [DONE]\n\n"]);
        let mut reader = SseReader::new(body);
        assert_eq!(reader.next_data().await.unwrap(), Some("hello".to_string()));
        assert_eq!(reader.next_data().await.unwrap(), Some("world".to_string()));
        assert_eq!(reader.next_data().await.unwrap(), None);
    }

    #[tokio::test]
    async fn sse_reader_skips_non_data_lines() {
        let body = bytes_stream(vec![
            "event: message\ndata: hi\n\n",
            ": this is a comment\ndata: bye\n\n",
            "data: [DONE]\n\n",
        ]);
        let mut reader = SseReader::new(body);
        assert_eq!(reader.next_data().await.unwrap(), Some("hi".to_string()));
        assert_eq!(reader.next_data().await.unwrap(), Some("bye".to_string()));
        assert_eq!(reader.next_data().await.unwrap(), None);
    }

    #[tokio::test]
    async fn ndjson_reader_yields_one_line_per_object() {
        let body = bytes_stream(vec![
            "{\"a\":1}\n",
            "{\"b\":2}\n{\"c\":3}\n",
        ]);
        let mut reader = NdjsonReader::new(body);
        assert_eq!(reader.next_line().await.unwrap(), Some("{\"a\":1}".to_string()));
        assert_eq!(reader.next_line().await.unwrap(), Some("{\"b\":2}".to_string()));
        assert_eq!(reader.next_line().await.unwrap(), Some("{\"c\":3}".to_string()));
        assert_eq!(reader.next_line().await.unwrap(), None);
    }

    #[tokio::test]
    async fn sse_reader_handles_utf8_split_across_chunks() {
        // "é" is 0xC3 0xA9. Split between chunks.
        let body = bytes_stream_raw(vec![
            b"data: caf\xc3" as &[u8],     // "caf" + first byte of é
            b"\xa9\n\n",                   // second byte of é, then newlines
            b"data: [DONE]\n\n",
        ]);
        let mut reader = SseReader::new(body);
        assert_eq!(reader.next_data().await.unwrap(), Some("café".to_string()));
        assert_eq!(reader.next_data().await.unwrap(), None);
    }

    #[tokio::test]
    async fn sse_reader_handles_4byte_codepoint_split_across_chunks() {
        // "🦀" (crab) is 0xF0 0x9F 0xA6 0x80 — 4 bytes. Split arbitrarily.
        let body = bytes_stream_raw(vec![
            b"data: love \xf0\x9f" as &[u8],
            b"\xa6\x80!\n\n",
            b"data: [DONE]\n\n",
        ]);
        let mut reader = SseReader::new(body);
        assert_eq!(reader.next_data().await.unwrap(), Some("love 🦀!".to_string()));
        assert_eq!(reader.next_data().await.unwrap(), None);
    }

    #[tokio::test]
    async fn ndjson_reader_handles_utf8_split_across_chunks() {
        let body = bytes_stream_raw(vec![
            b"{\"name\":\"caf\xc3" as &[u8],
            b"\xa9\"}\n",
            b"{\"emoji\":\"\xf0\x9f\xa6\x80\"}\n",
        ]);
        let mut reader = NdjsonReader::new(body);
        assert_eq!(reader.next_line().await.unwrap(), Some("{\"name\":\"café\"}".to_string()));
        assert_eq!(reader.next_line().await.unwrap(), Some("{\"emoji\":\"🦀\"}".to_string()));
        assert_eq!(reader.next_line().await.unwrap(), None);
    }

    #[tokio::test]
    async fn sse_reader_rejects_truly_malformed_utf8() {
        // 0xFF is never valid UTF-8 — this is a real decode failure, not a split.
        let body = bytes_stream_raw(vec![b"data: bad\xff\xfe\n\n" as &[u8]]);
        let mut reader = SseReader::new(body);
        let err = reader.next_data().await.unwrap_err();
        assert_eq!(err.code, "PARSE_ERROR");
    }

    #[tokio::test]
    async fn http_llm_singleton_returns_same_instance() {
        // Smoke: the OnceLock-based singleton returns the same client on
        // repeated calls. Cheap regression guard against an accidental
        // refactor that builds a new client per call.
        let a = http_llm();
        let b = http_llm();
        assert!(std::ptr::eq(a, b), "http_llm() must be a singleton");
    }
}
