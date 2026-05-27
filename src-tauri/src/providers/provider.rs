use crate::providers::error::RustError;
use crate::providers::types::{LlmRequest, LlmResponse, LlmStreamChunk, ModelConfig, UsageInfo};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

/// Provider type discriminator. JSON encoding matches the existing TS
/// `ProviderType` in `src/types/provider.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderType {
    Claude,
    #[serde(rename = "openai-compatible")]
    OpenAiCompatible,
    Ollama,
    Local,
}

/// Slice of `provider_configs` row that the Rust side cares about.
/// The TS side owns the full `ProviderConfig` including `enabled`,
/// `rateLimit`, `createdAt`, `updatedAt`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub r#type: ProviderType,
    pub name: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub models: Vec<ModelConfig>,
    #[serde(default)]
    pub default_model_id: Option<String>,
}

/// Callback type for streaming. The IPC handler wraps the `Channel<T>`
/// into one of these so the provider impls stay decoupled from Tauri.
pub type StreamCallback = Box<dyn Fn(LlmStreamChunk) + Send + Sync>;

#[async_trait]
pub trait LlmProvider: Send + Sync {
    /// Whether this provider requires an API key from the keychain.
    /// When `true` and no key is present, the IPC layer short-circuits with
    /// `AUTH_MISSING` before issuing any HTTP request.
    fn requires_key(&self) -> bool;

    async fn validate(&self, key: Option<&str>) -> Result<bool, RustError>;

    async fn list_models(&self, key: Option<&str>) -> Result<Vec<ModelConfig>, RustError>;

    async fn send(
        &self,
        key: Option<&str>,
        req: LlmRequest,
        cancel: CancellationToken,
    ) -> Result<LlmResponse, RustError>;

    async fn stream(
        &self,
        key: Option<&str>,
        req: LlmRequest,
        on_chunk: StreamCallback,
        cancel: CancellationToken,
    ) -> Result<UsageInfo, RustError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_type_serializes_as_kebab() {
        assert_eq!(
            serde_json::to_value(ProviderType::OpenAiCompatible).unwrap(),
            serde_json::Value::String("openai-compatible".into())
        );
        assert_eq!(
            serde_json::to_value(ProviderType::Claude).unwrap(),
            serde_json::Value::String("claude".into())
        );
        assert_eq!(
            serde_json::to_value(ProviderType::Ollama).unwrap(),
            serde_json::Value::String("ollama".into())
        );
        assert_eq!(
            serde_json::to_value(ProviderType::Local).unwrap(),
            serde_json::Value::String("local".into())
        );
    }

    #[test]
    fn provider_type_deserializes_from_typescript_shape() {
        // The TS side stores type names like "openai-compatible".
        let t: ProviderType = serde_json::from_str(r#""openai-compatible""#).unwrap();
        assert_eq!(t, ProviderType::OpenAiCompatible);
        let t: ProviderType = serde_json::from_str(r#""claude""#).unwrap();
        assert_eq!(t, ProviderType::Claude);
        let t: ProviderType = serde_json::from_str(r#""ollama""#).unwrap();
        assert_eq!(t, ProviderType::Ollama);
        let t: ProviderType = serde_json::from_str(r#""local""#).unwrap();
        assert_eq!(t, ProviderType::Local);
    }

    #[test]
    fn provider_config_deserializes_minimal() {
        let json = serde_json::json!({
            "id": "anthropic",
            "type": "claude",
            "name": "Anthropic"
        });
        let cfg: ProviderConfig = serde_json::from_value(json).unwrap();
        assert_eq!(cfg.id, "anthropic");
        assert_eq!(cfg.r#type, ProviderType::Claude);
        assert_eq!(cfg.name, "Anthropic");
        assert!(cfg.base_url.is_none());
        assert!(cfg.models.is_empty());
        assert!(cfg.default_model_id.is_none());
    }
}
