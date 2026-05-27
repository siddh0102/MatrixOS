use serde::Serialize;
use std::collections::HashMap;

/// Phase A error envelope returned by every Tauri command. Mirrors
/// `RustError` in the TS-side `src/lib/errors.ts` (added in Task 16).
/// Concrete codes are enumerated in spec §3.3.
#[derive(Debug, Clone, Serialize)]
pub struct RustError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<HashMap<String, serde_json::Value>>,
}

impl RustError {
    pub fn new(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
            details: None,
        }
    }

    pub fn auth_missing(provider_name: impl AsRef<str>) -> Self {
        Self::new(
            "AUTH_MISSING",
            format!("{} API key not configured", provider_name.as_ref()),
            false,
        )
    }

    /// Map a provider HTTP status to a typed error.
    /// 429 and 5xx are retryable; other 4xx are not.
    pub fn provider_http(status: u16, message: impl Into<String>) -> Self {
        let retryable = status == 429 || status >= 500;
        Self::new(format!("PROVIDER_HTTP_{}", status), message, retryable)
    }

    pub fn cancelled() -> Self {
        Self::new("CANCELLED", "Request was cancelled", false)
    }

    pub fn rate_limited(message: impl Into<String>) -> Self {
        Self::new("RATE_LIMITED", message, true)
    }

    pub fn request_id_collision(request_id: impl AsRef<str>) -> Self {
        Self::new(
            "REQUEST_ID_COLLISION",
            format!("request_id {} is already in flight", request_id.as_ref()),
            false,
        )
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new("NETWORK_ERROR", message, true)
    }

    pub fn parse(message: impl Into<String>) -> Self {
        Self::new("PARSE_ERROR", message, false)
    }

    pub fn provider_not_found(provider_id: impl AsRef<str>) -> Self {
        Self::new(
            "PROVIDER_NOT_FOUND",
            format!("No provider configured for id: {}", provider_id.as_ref()),
            false,
        )
    }

    /// Internal Rust-side error. The optional `cause` is stored in
    /// `details.cause` so JS-side telemetry can capture it without exposing
    /// it in the user-facing message.
    pub fn internal_error(
        message: impl Into<String>,
        cause: Option<impl Into<String>>,
    ) -> Self {
        let mut err = Self::new("INTERNAL_ERROR", message, false);
        if let Some(c) = cause {
            let mut details = HashMap::new();
            details.insert("cause".to_string(), serde_json::Value::String(c.into()));
            err.details = Some(details);
        }
        err
    }

    pub fn with_details(mut self, details: HashMap<String, serde_json::Value>) -> Self {
        self.details = Some(details);
        self
    }
}

impl std::fmt::Display for RustError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for RustError {}

impl From<reqwest::Error> for RustError {
    fn from(e: reqwest::Error) -> Self {
        if let Some(status) = e.status() {
            Self::provider_http(status.as_u16(), e.to_string())
        } else {
            Self::network(e.to_string())
        }
    }
}

impl From<serde_json::Error> for RustError {
    fn from(e: serde_json::Error) -> Self {
        Self::parse(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn auth_missing_serializes_correctly() {
        let err = RustError::auth_missing("Claude");
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["code"], "AUTH_MISSING");
        assert_eq!(v["retryable"], false);
        assert!(v["message"].as_str().unwrap().contains("Claude"));
    }

    #[test]
    fn provider_http_includes_status_in_code() {
        let err = RustError::provider_http(429, "rate limited");
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["code"], "PROVIDER_HTTP_429");
        assert_eq!(v["retryable"], true);
    }

    #[test]
    fn provider_http_retryability() {
        // 429 and 5xx: retryable. 4xx (except 429): not retryable.
        assert!(RustError::provider_http(429, "x").retryable);
        assert!(RustError::provider_http(500, "x").retryable);
        assert!(RustError::provider_http(503, "x").retryable);
        assert!(!RustError::provider_http(400, "x").retryable);
        assert!(!RustError::provider_http(401, "x").retryable);
        assert!(!RustError::provider_http(403, "x").retryable);
        assert!(!RustError::provider_http(404, "x").retryable);
    }

    #[test]
    fn cancelled_constructor() {
        let err = RustError::cancelled();
        assert_eq!(err.code, "CANCELLED");
        assert!(!err.retryable);
    }

    #[test]
    fn rate_limited_is_retryable() {
        let err = RustError::rate_limited("provider rate limit exceeded");
        assert_eq!(err.code, "RATE_LIMITED");
        assert!(err.retryable);
    }

    #[test]
    fn request_id_collision_not_retryable() {
        let err = RustError::request_id_collision("abc123");
        assert_eq!(err.code, "REQUEST_ID_COLLISION");
        assert!(!err.retryable);
        assert!(err.message.contains("abc123"));
    }

    #[test]
    fn network_error_is_retryable() {
        let err = RustError::network("connection reset");
        assert_eq!(err.code, "NETWORK_ERROR");
        assert!(err.retryable);
    }

    #[test]
    fn parse_error_not_retryable() {
        let err = RustError::parse("malformed SSE");
        assert_eq!(err.code, "PARSE_ERROR");
        assert!(!err.retryable);
    }

    #[test]
    fn provider_not_found_constructor() {
        let err = RustError::provider_not_found("missing-id");
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["code"], "PROVIDER_NOT_FOUND");
        assert!(v["message"].as_str().unwrap().contains("missing-id"));
        assert_eq!(v["retryable"], false);
    }

    #[test]
    fn internal_error_carries_cause_in_details() {
        let err = RustError::internal_error("filesystem failure", Some("EACCES on /tmp/foo"));
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["code"], "INTERNAL_ERROR");
        assert_eq!(v["details"]["cause"], "EACCES on /tmp/foo");
    }

    #[test]
    fn internal_error_without_cause_omits_details() {
        let err = RustError::internal_error("something failed", None::<&str>);
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["code"], "INTERNAL_ERROR");
        assert!(v.get("details").map_or(true, |d| d.is_null()));
    }

    #[test]
    fn with_details_attaches_arbitrary_keys() {
        let err = RustError::network("timeout").with_details({
            let mut m = std::collections::HashMap::new();
            m.insert("host".to_string(), json!("api.anthropic.com"));
            m.insert("attempt".to_string(), json!(3));
            m
        });
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["details"]["host"], "api.anthropic.com");
        assert_eq!(v["details"]["attempt"], 3);
    }

    #[test]
    fn details_omitted_when_none() {
        let err = RustError::cancelled();
        let v = serde_json::to_value(&err).unwrap();
        assert!(v.get("details").map_or(true, |d| d.is_null()));
    }

    #[test]
    fn from_serde_json_error_maps_to_parse_error() {
        let bad: Result<serde_json::Value, _> = serde_json::from_str("not json");
        let rust_err: RustError = bad.unwrap_err().into();
        assert_eq!(rust_err.code, "PARSE_ERROR");
    }
}
