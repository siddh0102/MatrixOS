use crate::db::Db;
use crate::fs::ssrf::is_private_addr;
use crate::fs::types::WebFetchResponse;
use crate::providers::error::RustError;
use crate::providers::types::CallContext;
use futures_util::StreamExt;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use url::Url;

const MAX_BODY_BYTES: usize = 256 * 1024;
const ALLOWED_PREFIXES: &[&str] = &[
    "text/", "application/json", "application/xml", "application/xhtml",
    "application/javascript", "application/yaml", "application/x-yaml",
];

pub async fn web_fetch(
    db: &Arc<Db>,
    ctx: &CallContext,
    url_str: &str,
    allow_private: bool,
    cancel: CancellationToken,
) -> Result<WebFetchResponse, RustError> {
    let url = Url::parse(url_str)
        .map_err(|e| RustError::new("WEB_INVALID_URL", e.to_string(), false))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(RustError::new("WEB_INVALID_URL", "URL must be http or https", false));
    }
    let host = url.host_str()
        .ok_or_else(|| RustError::new("WEB_INVALID_URL", "missing host", false))?
        .trim_end_matches('.')
        .to_string();
    let port = url.port_or_known_default().unwrap_or(443);

    let lookup_fut = tokio::net::lookup_host((host.clone(), port));
    let addrs_iter = tokio::time::timeout(Duration::from_secs(5), lookup_fut).await
        .map_err(|_| RustError::new("WEB_DNS_ERROR", "DNS lookup timed out", true))?
        .map_err(|e| RustError::new("WEB_DNS_ERROR", e.to_string(), true))?;
    let resolved: Vec<SocketAddr> = addrs_iter.collect();

    let validated: Vec<SocketAddr> = resolved.iter()
        .filter(|sa| allow_private || !is_private_addr(sa.ip()))
        .cloned()
        .collect();
    if validated.is_empty() {
        crate::fs::audit::audit_hook(db, &crate::fs::audit::AuditEvent {
            kind: crate::fs::audit::AuditKind::SsrfBlocked,
            ctx: ctx.clone(),
            path_or_url: url.to_string(),
            extra: serde_json::json!({ "resolved_count": resolved.len() }),
        }).await;
        return Err(RustError::new(
            "SSRF_BLOCKED",
            format!("Host \"{}\" resolves only to private/loopback addresses", host),
            false,
        ));
    }

    let client = reqwest::Client::builder()
        .resolve_to_addrs(&host, &validated)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("MatrixOS/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| RustError::new("WEB_FETCH_ERROR", e.to_string(), false))?;

    let send_fut = client.get(url.clone()).send();
    let res = tokio::select! {
        r = send_fut => r.map_err(|e| RustError::new("WEB_FETCH_ERROR", e.to_string(), true))?,
        _ = cancel.cancelled() => return Err(RustError::cancelled()),
    };

    let status = res.status().as_u16();
    let content_type = res.headers().get("content-type")
        .and_then(|v| v.to_str().ok()).unwrap_or("").to_string();

    let allowed = ALLOWED_PREFIXES.iter().any(|p| content_type.to_lowercase().starts_with(p));
    if !allowed && (200..300).contains(&status) {
        crate::fs::audit::audit_hook(db, &crate::fs::audit::AuditEvent {
            kind: crate::fs::audit::AuditKind::WebDenied,
            ctx: ctx.clone(),
            path_or_url: url.to_string(),
            extra: serde_json::json!({
                "reason": "content_type_rejected",
                "content_type": content_type,
                "status": status,
            }),
        }).await;
        return Err(RustError::new("WEB_CONTENT_TYPE_REJECTED",
            format!("unsupported content type \"{}\"", content_type), false));
    }

    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
    let mut truncated = false;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| RustError::new("WEB_FETCH_ERROR", e.to_string(), true))?;
        let remaining = MAX_BODY_BYTES.saturating_sub(buf.len());
        if chunk.len() > remaining {
            buf.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }
        buf.extend_from_slice(&chunk);
    }
    let body = String::from_utf8_lossy(&buf).to_string();

    Ok(WebFetchResponse { status, content_type, truncated, body })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_db() -> Arc<Db> {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../migrations/005_audit_log.sql")).unwrap();
        Arc::new(Db::from_connection(conn))
    }

    fn test_ctx() -> CallContext {
        CallContext::User
    }

    #[tokio::test]
    async fn returns_body_when_content_type_allowed() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/x"))
            .respond_with(ResponseTemplate::new(200)
                .insert_header("content-type", "text/plain")
                .set_body_string("hello"))
            .mount(&server).await;
        let resp = web_fetch(&test_db(), &test_ctx(), &format!("{}/x", server.uri()), true, CancellationToken::new())
            .await.unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.body, "hello");
        assert!(!resp.truncated);
    }

    #[tokio::test]
    async fn rejects_binary_content_type_on_2xx() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/x"))
            .respond_with(ResponseTemplate::new(200)
                .insert_header("content-type", "application/octet-stream")
                .set_body_bytes(vec![0u8, 1, 2, 3]))
            .mount(&server).await;
        let err = web_fetch(&test_db(), &test_ctx(), &format!("{}/x", server.uri()), true, CancellationToken::new())
            .await.unwrap_err();
        assert_eq!(err.code, "WEB_CONTENT_TYPE_REJECTED");
    }

    #[tokio::test]
    async fn returns_3xx_without_following() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/redir"))
            .respond_with(ResponseTemplate::new(302)
                .insert_header("location", "http://example.com/elsewhere"))
            .mount(&server).await;
        let resp = web_fetch(&test_db(), &test_ctx(), &format!("{}/redir", server.uri()), true, CancellationToken::new())
            .await.unwrap();
        assert_eq!(resp.status, 302);
    }

    #[tokio::test]
    async fn ssrf_blocks_localhost_when_private_not_allowed() {
        let err = web_fetch(&test_db(), &test_ctx(), "http://127.0.0.1:9999/x", false, CancellationToken::new())
            .await.unwrap_err();
        assert_eq!(err.code, "SSRF_BLOCKED");
    }

    #[tokio::test]
    async fn ssrf_blocks_aws_metadata() {
        let err = web_fetch(&test_db(), &test_ctx(), "http://169.254.169.254/latest/meta-data", false, CancellationToken::new())
            .await.unwrap_err();
        assert_eq!(err.code, "SSRF_BLOCKED");
    }

    #[tokio::test]
    async fn rejects_file_scheme() {
        let err = web_fetch(&test_db(), &test_ctx(), "file:///etc/passwd", true, CancellationToken::new())
            .await.unwrap_err();
        assert_eq!(err.code, "WEB_INVALID_URL");
    }

    #[tokio::test]
    async fn ssrf_blocks_decimal_ip_form() {
        let err = web_fetch(&test_db(), &test_ctx(), "http://2130706433/", false, CancellationToken::new())
            .await.unwrap_err();
        assert_eq!(err.code, "SSRF_BLOCKED");
    }

    #[tokio::test]
    async fn body_cap_truncates_oversized() {
        let big = "X".repeat(300 * 1024);
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/big"))
            .respond_with(ResponseTemplate::new(200)
                .insert_header("content-type", "text/plain")
                .set_body_string(big))
            .mount(&server).await;
        let resp = web_fetch(&test_db(), &test_ctx(), &format!("{}/big", server.uri()), true, CancellationToken::new())
            .await.unwrap();
        assert!(resp.truncated);
        assert_eq!(resp.body.len(), MAX_BODY_BYTES);
    }
}
