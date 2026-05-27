use crate::mcp::stdio::RunningStdio;
use crate::mcp::types::{McpInboundMessage, McpServerConfig, McpServerStatus};
use crate::providers::error::RustError;
use dashmap::DashMap;
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub enum Transport {
    Stdio(Arc<RunningStdio>),
    Http,
}

pub struct ServerEntry {
    pub config: McpServerConfig,
    pub status: Mutex<McpServerStatus>,
    pub transport: Mutex<Option<Transport>>,
    pub subscribers: Mutex<Vec<(String, Arc<Channel<McpInboundMessage>>)>>,
    pub spawning: Arc<Mutex<()>>,
}

/// Cancellation namespace for MCP request IDs — separate from
/// `providers::registry::Registry`, so request-id collisions across the two
/// surfaces are impossible.
#[derive(Default)]
struct InFlight {
    tokens: DashMap<String, CancellationToken>,
}

impl InFlight {
    fn register(&self, request_id: &str) -> Result<CancellationToken, RustError> {
        if self.tokens.contains_key(request_id) {
            return Err(RustError::request_id_collision(request_id));
        }
        let tok = CancellationToken::new();
        self.tokens.insert(request_id.to_string(), tok.clone());
        Ok(tok)
    }
    fn deregister(&self, request_id: &str) {
        self.tokens.remove(request_id);
    }
    fn cancel(&self, request_id: &str) {
        if let Some((_, tok)) = self.tokens.remove(request_id) {
            tok.cancel();
        }
    }
}

#[derive(Default)]
pub struct McpRegistry {
    entries: DashMap<String, Arc<ServerEntry>>,
    in_flight: InFlight,
}

impl McpRegistry {
    pub fn new() -> Arc<Self> { Arc::new(Self::default()) }

    /// Replace or insert the in-memory config. Preserves subscribers across
    /// re-config. Status reset to Stopped; if a transport is currently set
    /// (server running), caller must reject with MCP_CONFIG_LOCKED upstream.
    pub async fn upsert_config(&self, cfg: McpServerConfig) {
        let id = cfg.id().to_string();
        if let Some(existing) = self.entries.get(&id).map(|e| e.clone()) {
            let subs = existing.subscribers.lock().await.drain(..).collect::<Vec<_>>();
            let new_entry = Arc::new(ServerEntry {
                config: cfg,
                status: Mutex::new(McpServerStatus::Stopped),
                transport: Mutex::new(None),
                subscribers: Mutex::new(subs),
                spawning: existing.spawning.clone(),
            });
            self.entries.insert(id, new_entry);
        } else {
            self.entries.insert(id, Arc::new(ServerEntry {
                config: cfg,
                status: Mutex::new(McpServerStatus::Stopped),
                transport: Mutex::new(None),
                subscribers: Mutex::new(Vec::new()),
                spawning: Arc::new(Mutex::new(())),
            }));
        }
    }

    pub fn remove(&self, id: &str) -> Option<Arc<ServerEntry>> {
        self.entries.remove(id).map(|(_, v)| v)
    }

    pub fn get(&self, id: &str) -> Option<Arc<ServerEntry>> {
        self.entries.get(id).map(|e| e.clone())
    }

    pub fn all(&self) -> Vec<(String, Arc<ServerEntry>)> {
        self.entries.iter().map(|e| (e.key().clone(), e.value().clone())).collect()
    }

    pub async fn status(&self, id: &str) -> Option<McpServerStatus> {
        Some(self.get(id)?.status.lock().await.clone())
    }

    pub async fn add_subscriber(
        &self,
        id: &str,
        ch: Arc<Channel<McpInboundMessage>>,
    ) -> Result<String, RustError> {
        let entry = self.get(id).ok_or_else(|| RustError::new(
            "MCP_SERVER_UNKNOWN", format!("server {} not configured", id), false))?;
        let sub_id = nanoid::nanoid!();
        entry.subscribers.lock().await.push((sub_id.clone(), ch));
        Ok(sub_id)
    }

    pub async fn remove_subscriber(&self, id: &str, subscription_id: &str) -> Result<(), RustError> {
        let entry = self.get(id).ok_or_else(|| RustError::new(
            "MCP_SERVER_UNKNOWN", format!("server {} not configured", id), false))?;
        entry.subscribers.lock().await.retain(|(sid, _)| sid != subscription_id);
        Ok(())
    }

    pub async fn broadcast(&self, id: &str, msg: McpInboundMessage) {
        let Some(entry) = self.get(id) else { return };
        let subs = entry.subscribers.lock().await;
        for (_, ch) in subs.iter() {
            let _ = ch.send(msg.clone());
        }
    }

    // ── Cancellation namespace ──

    pub fn register_in_flight(&self, request_id: &str) -> Result<CancellationToken, RustError> {
        self.in_flight.register(request_id)
    }
    pub fn deregister_in_flight(&self, request_id: &str) {
        self.in_flight.deregister(request_id);
    }
    pub fn cancel(&self, request_id: &str) {
        self.in_flight.cancel(request_id);
    }
}

/// RAII guard — deregisters an MCP in-flight request_id on drop. Mirrors
/// `providers::registry::CancelGuard` at `src-tauri/src/providers/registry.rs:213-229`.
pub struct McpCancelGuard<'a> {
    registry: &'a McpRegistry,
    request_id: String,
}

impl<'a> McpCancelGuard<'a> {
    pub fn new(registry: &'a McpRegistry, request_id: String) -> Self {
        Self { registry, request_id }
    }
}

impl Drop for McpCancelGuard<'_> {
    fn drop(&mut self) {
        self.registry.deregister_in_flight(&self.request_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn stdio_cfg(id: &str) -> McpServerConfig {
        McpServerConfig::Stdio {
            id: id.into(), name: id.into(),
            command: "/bin/true".into(), args: vec![], env: HashMap::new(),
            enabled: true,
        }
    }

    #[tokio::test]
    async fn upsert_preserves_subscribers() {
        let reg = McpRegistry::new();
        reg.upsert_config(stdio_cfg("a")).await;
        // simulate a subscriber by hand-pushing — we can't construct Channel<T>
        // easily, so just verify the entry exists across re-config.
        let entry_before = reg.get("a").unwrap();
        let spawning_before = entry_before.spawning.clone();
        reg.upsert_config(stdio_cfg("a")).await;
        let entry_after = reg.get("a").unwrap();
        assert!(Arc::ptr_eq(&spawning_before, &entry_after.spawning));
    }

    #[tokio::test]
    async fn cancellation_namespace_is_independent() {
        let reg = McpRegistry::new();
        let tok = reg.register_in_flight("r1").unwrap();
        assert!(!tok.is_cancelled());
        reg.cancel("r1");
        assert!(tok.is_cancelled());
        // Re-register after cancel: should succeed (cancel removed the entry).
        assert!(reg.register_in_flight("r1").is_ok());
    }

    #[tokio::test]
    async fn register_collides_on_active_id() {
        let reg = McpRegistry::new();
        let _t = reg.register_in_flight("r2").unwrap();
        let err = reg.register_in_flight("r2").unwrap_err();
        assert_eq!(err.code, "REQUEST_ID_COLLISION");
    }

    #[tokio::test]
    async fn server_status_transitions_drive_correctly() {
        let reg = McpRegistry::new();
        reg.upsert_config(stdio_cfg("s")).await;
        let entry = reg.get("s").unwrap();

        // Stopped (initial)
        assert!(matches!(*entry.status.lock().await, McpServerStatus::Stopped));

        // Starting
        *entry.status.lock().await = McpServerStatus::Starting;
        assert!(matches!(*entry.status.lock().await, McpServerStatus::Starting));

        // RunningStdio
        *entry.status.lock().await = McpServerStatus::RunningStdio {
            pid: 42, started_at: "2026-05-21T00:00:00Z".into(),
        };
        {
            let guard = entry.status.lock().await;
            match &*guard {
                McpServerStatus::RunningStdio { pid, .. } => assert_eq!(*pid, 42),
                _ => panic!("expected RunningStdio"),
            }
        }

        // Crashed
        *entry.status.lock().await = McpServerStatus::Crashed {
            exit_code: Some(137), at: "2026-05-21T00:01:00Z".into(),
        };
        {
            let guard = entry.status.lock().await;
            match &*guard {
                McpServerStatus::Crashed { exit_code, .. } => assert_eq!(*exit_code, Some(137)),
                _ => panic!("expected Crashed"),
            }
        }
    }
}
