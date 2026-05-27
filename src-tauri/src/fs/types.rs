use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SandboxPolicy {
    pub enabled: bool,
    pub allowed_paths: Vec<PathBuf>,
}

impl SandboxPolicy {
    pub fn user_default() -> Self {
        // User-context calls don't have a per-agent sandbox; enforcement happens via the
        // user-confirmed paths map (Task 5).
        Self { enabled: true, allowed_paths: vec![] }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchResponse {
    pub status: u16,
    pub content_type: String,
    pub truncated: bool,
    pub body: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_policy_serializes_camel_case() {
        let p = SandboxPolicy { enabled: true, allowed_paths: vec!["/tmp/x".into()] };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["enabled"], true);
        assert!(v["allowedPaths"].is_array());
    }
}
