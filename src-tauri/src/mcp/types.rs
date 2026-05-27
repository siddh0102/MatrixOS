use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum McpInboundMessage {
    Rpc { message: String },
    Stderr { line: String },
    #[serde(rename_all = "camelCase")]
    Closed { exit_code: Option<i32>, signal: Option<String> },
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum McpServerStatus {
    Stopped,
    Starting,
    #[serde(rename_all = "camelCase")]
    RunningStdio { pid: u32, started_at: String },
    #[serde(rename_all = "camelCase")]
    RunningHttp { started_at: String },
    #[serde(rename_all = "camelCase")]
    Crashed { exit_code: Option<i32>, at: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "transport", rename_all = "camelCase")]
pub enum McpServerConfig {
    #[serde(rename_all = "camelCase")]
    Stdio {
        id: String,
        name: String,
        command: String,
        args: Vec<String>,
        env: HashMap<String, String>,
        enabled: bool,
    },
    #[serde(rename_all = "camelCase")]
    Http {
        id: String,
        name: String,
        base_url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
        #[serde(default)]
        allow_private: bool,
        #[serde(default = "default_timeout_ms")]
        timeout_ms: u32,
        enabled: bool,
    },
}

fn default_timeout_ms() -> u32 { 30_000 }

impl McpServerConfig {
    pub fn id(&self) -> &str {
        match self { Self::Stdio { id, .. } | Self::Http { id, .. } => id }
    }
    pub fn name(&self) -> &str {
        match self { Self::Stdio { name, .. } | Self::Http { name, .. } => name }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inbound_message_uses_type_discriminator_camel_case() {
        let m = McpInboundMessage::Rpc { message: "{}".into() };
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["type"], "rpc");

        let m = McpInboundMessage::Closed { exit_code: Some(1), signal: None };
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["type"], "closed");
        assert_eq!(v["exitCode"], 1);
    }

    #[test]
    fn server_status_uses_kind_discriminator() {
        let s = McpServerStatus::RunningStdio { pid: 42, started_at: "2026-05-21T00:00:00Z".into() };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["kind"], "runningStdio");
        assert_eq!(v["pid"], 42);
        assert_eq!(v["startedAt"], "2026-05-21T00:00:00Z");
    }

    #[test]
    fn server_config_uses_transport_discriminator() {
        let cfg = McpServerConfig::Stdio {
            id: "s1".into(), name: "Test".into(),
            command: "node".into(), args: vec!["server.js".into()],
            env: HashMap::new(), enabled: true,
        };
        let v = serde_json::to_value(&cfg).unwrap();
        assert_eq!(v["transport"], "stdio");
        assert_eq!(v["command"], "node");
    }

    #[test]
    fn http_config_defaults() {
        let json = serde_json::json!({
            "transport": "http",
            "id": "h1", "name": "remote",
            "baseUrl": "https://example.com/mcp",
            "enabled": true
        });
        let cfg: McpServerConfig = serde_json::from_value(json).unwrap();
        match cfg {
            McpServerConfig::Http { allow_private, timeout_ms, .. } => {
                assert_eq!(allow_private, false);
                assert_eq!(timeout_ms, 30_000);
            }
            _ => panic!("expected http"),
        }
    }
}
