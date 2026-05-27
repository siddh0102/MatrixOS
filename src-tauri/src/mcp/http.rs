use crate::fs::ssrf::is_private_addr;
use crate::providers::error::RustError;
use futures_util::StreamExt;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use url::Url;

const MAX_BODY_BYTES: usize = 1024 * 1024; // 1 MiB — bigger than fs::web's 256 KiB cap

/// Per-request HTTP send for MCP. SSRF-guarded (loopback/private blocked unless
/// the per-server config opts in), Policy::none() (no redirect-based bypass),
/// caller-controlled timeout, 1 MiB body cap.
pub async fn send(
    base_url: &str,
    headers: &HashMap<String, String>,
    body: &str,
    allow_private: bool,
    timeout_ms: u32,
    cancel: CancellationToken,
) -> Result<String, RustError> {
    let url = Url::parse(base_url)
        .map_err(|e| RustError::new("MCP_CONFIG_INVALID", e.to_string(), false))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(RustError::new("MCP_CONFIG_INVALID", "URL must be http or https", false));
    }
    let host = url.host_str()
        .ok_or_else(|| RustError::new("MCP_CONFIG_INVALID", "missing host", false))?
        .trim_end_matches('.')
        .to_string();
    let port = url.port_or_known_default().unwrap_or(443);

    let lookup = tokio::net::lookup_host((host.clone(), port));
    let addrs = tokio::time::timeout(Duration::from_secs(5), lookup).await
        .map_err(|_| RustError::new("MCP_TIMEOUT", "DNS lookup timed out", true))?
        .map_err(|e| RustError::new("MCP_HTTP_DNS", e.to_string(), true))?;
    let resolved: Vec<SocketAddr> = addrs.collect();
    let validated: Vec<SocketAddr> = resolved.iter()
        .filter(|sa| allow_private || !is_private_addr(sa.ip()))
        .cloned()
        .collect();
    if validated.is_empty() {
        return Err(RustError::new(
            "SSRF_BLOCKED",
            format!("Host \"{}\" resolves only to private/loopback addresses", host),
            false,
        ));
    }

    let client = reqwest::Client::builder()
        .resolve_to_addrs(&host, &validated)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(timeout_ms as u64))
        .build()
        .map_err(|e| RustError::new("MCP_HTTP_ERROR", e.to_string(), false))?;

    let mut req = client.post(url.clone())
        .header("content-type", "application/json")
        .body(body.to_string());
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }

    let res = tokio::select! {
        r = req.send() => r,
        _ = cancel.cancelled() => return Err(RustError::cancelled()),
    };
    let res = match res {
        Ok(r) => r,
        Err(e) if e.is_timeout() => return Err(RustError::new("MCP_TIMEOUT", e.to_string(), true)),
        Err(e) => return Err(RustError::new("MCP_HTTP_ERROR", e.to_string(), true)),
    };

    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        let txt = res.text().await.unwrap_or_default();
        return Err(RustError::new(
            &format!("MCP_HTTP_{}", status),
            txt,
            status == 429 || status >= 500,
        ));
    }

    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| RustError::new("MCP_HTTP_ERROR", e.to_string(), true))?;
        if buf.len() + chunk.len() > MAX_BODY_BYTES {
            return Err(RustError::new("MCP_BODY_TOO_LARGE",
                format!("response exceeded {} bytes", MAX_BODY_BYTES), false));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&buf).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn send_posts_body_and_returns_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST")).and(path("/"))
            .and(header("authorization", "Bearer xyz"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{\"result\":42}"))
            .mount(&server).await;

        let mut hdrs = HashMap::new();
        hdrs.insert("authorization".into(), "Bearer xyz".into());
        let resp = send(&server.uri(), &hdrs, "{\"method\":\"x\"}", true, 30_000, CancellationToken::new())
            .await.unwrap();
        assert_eq!(resp, "{\"result\":42}");
    }

    #[tokio::test]
    async fn http_error_carries_status_code() {
        let server = MockServer::start().await;
        Mock::given(method("POST")).and(path("/"))
            .respond_with(ResponseTemplate::new(500).set_body_string("oops"))
            .mount(&server).await;
        let err = send(&server.uri(), &HashMap::new(), "{}", true, 30_000, CancellationToken::new())
            .await.unwrap_err();
        assert_eq!(err.code, "MCP_HTTP_500");
        assert!(err.retryable);
    }

    #[tokio::test]
    async fn ssrf_blocks_loopback_by_default() {
        let server = MockServer::start().await; // listens on 127.0.0.1
        let err = send(&server.uri(), &HashMap::new(), "{}", false, 30_000, CancellationToken::new())
            .await.unwrap_err();
        assert_eq!(err.code, "SSRF_BLOCKED");
    }

    #[tokio::test]
    async fn body_cap_rejects_oversize_response() {
        let server = MockServer::start().await;
        let big = "x".repeat(2 * 1024 * 1024);
        Mock::given(method("POST")).and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_string(big))
            .mount(&server).await;
        let err = send(&server.uri(), &HashMap::new(), "{}", true, 30_000, CancellationToken::new())
            .await.unwrap_err();
        assert_eq!(err.code, "MCP_BODY_TOO_LARGE");
    }
}
