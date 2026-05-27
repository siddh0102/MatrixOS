//! Provider registry: key cache, cancellation, and factory.
//!
//! Per spec §3.5 (cancellation), §3.6 (key handling), and Appendix H3/H4:
//! - Pre-registration tombstone defeats abort-vs-invoke race
//! - Required-key check short-circuits with AUTH_MISSING
//! - Bounded auth-failure re-read with 60s negative cache

use crate::providers::claude::ClaudeProvider;
use crate::providers::error::RustError;
use crate::providers::local::LocalProvider;
use crate::providers::ollama::OllamaProvider;
use crate::providers::openai_compatible::OpenAiCompatibleProvider;
use crate::providers::provider::{LlmProvider, ProviderConfig, ProviderType};
use dashmap::DashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

const KEYRING_SERVICE: &str = "com.matrixos.app";
const TOMBSTONE_TTL: Duration = Duration::from_secs(30);
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(60);

fn keychain_account(provider_id: &str) -> String {
    format!("matrixos.{}.apiKey", provider_id)
}

pub struct Registry {
    keys: DashMap<String, String>,
    in_flight: DashMap<String, CancellationToken>,
    tombstones: DashMap<String, Instant>,
    negative_cache: DashMap<String, Instant>,   // provider_id -> expires_at
    configs: DashMap<String, ProviderConfig>,
}

impl Registry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            keys: DashMap::new(),
            in_flight: DashMap::new(),
            tombstones: DashMap::new(),
            negative_cache: DashMap::new(),
            configs: DashMap::new(),
        })
    }

    // ── Config management ──

    pub fn upsert_config(&self, cfg: ProviderConfig) {
        self.configs.insert(cfg.id.clone(), cfg);
    }

    pub fn get_config(&self, provider_id: &str) -> Option<ProviderConfig> {
        self.configs.get(provider_id).map(|c| c.clone())
    }

    pub fn build_provider(&self, cfg: &ProviderConfig) -> Box<dyn LlmProvider> {
        match cfg.r#type {
            ProviderType::Claude => Box::new(ClaudeProvider::new(cfg.clone())),
            ProviderType::OpenAiCompatible => Box::new(OpenAiCompatibleProvider::new(cfg.clone())),
            ProviderType::Ollama => Box::new(OllamaProvider::new(cfg.clone())),
            ProviderType::Local => Box::new(LocalProvider::new(cfg.clone())),
        }
    }

    // ── Key handling (H4) ──

    fn read_keychain(&self, provider_id: &str) -> Result<Option<String>, RustError> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, &keychain_account(provider_id))
            .map_err(|e| RustError::internal_error("keychain entry create failed", Some(e.to_string())))?;
        match entry.get_password() {
            Ok(val) => Ok(Some(val)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(RustError::internal_error("keychain read failed", Some(e.to_string()))),
        }
    }

    fn is_negative_cached(&self, provider_id: &str) -> bool {
        match self.negative_cache.get(provider_id) {
            Some(entry) => Instant::now() < *entry,
            None => false,
        }
    }

    /// Get a key from the cache, falling back to the keychain.
    /// If `requires=true` and no key is found (or we're in negative cache),
    /// returns `Err(AUTH_MISSING)`.
    pub fn get_key(&self, provider_id: &str, requires: bool) -> Result<Option<String>, RustError> {
        if let Some(k) = self.keys.get(provider_id) {
            return Ok(Some(k.clone()));
        }
        if self.is_negative_cached(provider_id) {
            if requires {
                return Err(RustError::auth_missing(provider_id));
            }
            return Ok(None);
        }
        let key = self.read_keychain(provider_id)?;
        if requires && key.is_none() {
            return Err(RustError::auth_missing(provider_id));
        }
        if let Some(ref k) = key {
            self.keys.insert(provider_id.to_string(), k.clone());
        }
        Ok(key)
    }

    pub fn set_key(&self, provider_id: &str, key: &str) -> Result<(), RustError> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, &keychain_account(provider_id))
            .map_err(|e| RustError::internal_error("keychain entry create failed", Some(e.to_string())))?;
        entry.set_password(key)
            .map_err(|e| RustError::internal_error("keychain write failed", Some(e.to_string())))?;
        self.keys.insert(provider_id.to_string(), key.to_string());
        // Fresh key — clear any negative cache or tombstones for this provider.
        self.negative_cache.remove(provider_id);
        Ok(())
    }

    pub fn delete_key(&self, provider_id: &str) -> Result<(), RustError> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, &keychain_account(provider_id))
            .map_err(|e| RustError::internal_error("keychain entry create failed", Some(e.to_string())))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(RustError::internal_error("keychain delete failed", Some(e.to_string()))),
        }
        self.keys.remove(provider_id);
        self.negative_cache.remove(provider_id);
        Ok(())
    }

    /// Used by the settings UI to render "key configured" without exposing the key.
    pub fn has_key(&self, provider_id: &str) -> Result<bool, RustError> {
        if self.keys.contains_key(provider_id) { return Ok(true); }
        Ok(self.read_keychain(provider_id)?.is_some())
    }

    // Note: a previous `evict_key(provider_id)` helper was removed. Every
    // path that wanted single-key eviction (delete_key, reread_on_auth_failure)
    // already inlines `self.keys.remove(provider_id)` plus its own
    // negative-cache or fresh-read step, so the helper was unreachable.

    /// Drop ALL cached keys (provider_reload_keys command).
    pub fn clear_keys(&self) {
        self.keys.clear();
        self.negative_cache.clear();
    }

    /// On 401/403 from a provider, re-read the keychain once. Returns:
    /// - Ok(true)  → re-read produced a different value, caller may retry
    /// - Ok(false) → re-read returned same/None, do not retry; provider is
    ///               in 60s negative cache; further get_key calls (requires=true)
    ///               will short-circuit with AUTH_MISSING.
    pub fn reread_on_auth_failure(
        &self,
        provider_id: &str,
        old_value: &str,
    ) -> Result<bool, RustError> {
        if self.is_negative_cached(provider_id) {
            return Ok(false);
        }
        self.keys.remove(provider_id);
        let fresh = self.read_keychain(provider_id)?;
        match fresh {
            Some(v) if v != old_value => {
                self.keys.insert(provider_id.to_string(), v);
                Ok(true)
            }
            _ => {
                self.negative_cache
                    .insert(provider_id.to_string(), Instant::now() + NEGATIVE_CACHE_TTL);
                Ok(false)
            }
        }
    }

    // ── Cancellation (H3) ──

    /// Register a fresh CancellationToken for `request_id`.
    /// - If a tombstone exists (pre-cancelled), consume it and return CANCELLED.
    /// - If a token already exists for this id, return REQUEST_ID_COLLISION.
    pub fn register_in_flight(&self, request_id: &str) -> Result<CancellationToken, RustError> {
        if self.tombstones.remove(request_id).is_some() {
            return Err(RustError::cancelled());
        }
        if self.in_flight.contains_key(request_id) {
            return Err(RustError::request_id_collision(request_id));
        }
        let token = CancellationToken::new();
        self.in_flight.insert(request_id.to_string(), token.clone());
        Ok(token)
    }

    /// Remove an in-flight entry. Called by `CancelGuard::drop`; idempotent.
    pub fn deregister_in_flight(&self, request_id: &str) {
        self.in_flight.remove(request_id);
    }

    /// Cancel an in-flight request. If no in-flight token exists, install a
    /// tombstone with a 30s TTL so any subsequent register short-circuits.
    pub fn cancel(&self, request_id: &str) {
        if let Some((_, tok)) = self.in_flight.remove(request_id) {
            tok.cancel();
        } else {
            self.tombstones.insert(request_id.to_string(), Instant::now());
            self.gc_tombstones();
        }
    }

    fn gc_tombstones(&self) {
        let cutoff = Instant::now() - TOMBSTONE_TTL;
        self.tombstones.retain(|_, t| *t > cutoff);
    }
}

/// RAII guard that deregisters an in-flight request_id on drop.
/// IPC handlers hold this so leaks are impossible — even on panic.
pub struct CancelGuard<'a> {
    registry: &'a Registry,
    request_id: String,
}

impl<'a> CancelGuard<'a> {
    pub fn new(registry: &'a Registry, request_id: String) -> Self {
        Self { registry, request_id }
    }
}

impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        self.registry.deregister_in_flight(&self.request_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::provider::ProviderType;

    fn make_cfg(id: &str, t: ProviderType) -> ProviderConfig {
        ProviderConfig {
            id: id.into(), r#type: t, name: id.into(),
            base_url: None, models: vec![], default_model_id: None,
        }
    }

    #[test]
    fn cancellation_token_fires_via_cancel() {
        let reg = Registry::new();
        let tok = reg.register_in_flight("req-1").unwrap();
        assert!(!tok.is_cancelled());
        reg.cancel("req-1");
        assert!(tok.is_cancelled());
    }

    #[test]
    fn pre_cancel_creates_tombstone_then_register_returns_cancelled() {
        let reg = Registry::new();
        reg.cancel("req-2");  // no token registered yet — installs tombstone
        let err = reg.register_in_flight("req-2").unwrap_err();
        assert_eq!(err.code, "CANCELLED");
    }

    #[test]
    fn tombstone_consumed_by_register_and_doesnt_apply_to_later_requests() {
        let reg = Registry::new();
        reg.cancel("req-3");
        let _ = reg.register_in_flight("req-3").unwrap_err(); // consumes tombstone
        let tok = reg.register_in_flight("req-3").unwrap();   // fresh registration succeeds
        assert!(!tok.is_cancelled());
    }

    #[test]
    fn collision_returns_request_id_collision() {
        let reg = Registry::new();
        let _tok1 = reg.register_in_flight("req-4").unwrap();
        let err = reg.register_in_flight("req-4").unwrap_err();
        assert_eq!(err.code, "REQUEST_ID_COLLISION");
    }

    #[test]
    fn cancel_guard_deregisters_on_drop() {
        let reg = Registry::new();
        let _tok = reg.register_in_flight("req-5").unwrap();
        {
            let _guard = CancelGuard::new(&reg, "req-5".to_string());
            // tok still in flight here
            assert!(reg.in_flight.contains_key("req-5"));
        }
        // guard dropped — entry removed
        assert!(!reg.in_flight.contains_key("req-5"));
    }

    #[test]
    fn cancel_guard_lets_subsequent_register_succeed() {
        let reg = Registry::new();
        {
            let _tok = reg.register_in_flight("req-6").unwrap();
            let _guard = CancelGuard::new(&reg, "req-6".to_string());
        }
        // Both dropped. The same id can now be re-registered.
        let _tok2 = reg.register_in_flight("req-6").unwrap();
    }

    #[test]
    fn upsert_and_get_config_roundtrip() {
        let reg = Registry::new();
        let cfg = make_cfg("x", ProviderType::Ollama);
        reg.upsert_config(cfg.clone());
        assert_eq!(reg.get_config("x").unwrap().id, "x");
    }

    #[test]
    fn build_provider_returns_correct_impl() {
        let reg = Registry::new();
        // Just verify it compiles + doesn't panic — type erasure makes
        // matching nontrivial, but the build is the contract.
        let _ = reg.build_provider(&make_cfg("a", ProviderType::Claude));
        let _ = reg.build_provider(&make_cfg("b", ProviderType::OpenAiCompatible));
        let _ = reg.build_provider(&make_cfg("c", ProviderType::Ollama));
        let _ = reg.build_provider(&make_cfg("d", ProviderType::Local));
    }

    #[test]
    fn negative_cache_blocks_required_get_key() {
        let reg = Registry::new();
        // Manually install a negative cache entry (no keychain interaction).
        reg.negative_cache.insert(
            "p".to_string(),
            Instant::now() + Duration::from_secs(60),
        );
        let err = reg.get_key("p", true).unwrap_err();
        assert_eq!(err.code, "AUTH_MISSING");

        // requires=false: returns None without erroring
        assert!(reg.get_key("p", false).unwrap().is_none());
    }

    #[test]
    fn clear_keys_drops_cache_and_negative_cache() {
        let reg = Registry::new();
        reg.keys.insert("p".into(), "secret".into());
        reg.negative_cache.insert("q".into(), Instant::now() + Duration::from_secs(60));
        reg.clear_keys();
        assert!(reg.keys.is_empty());
        assert!(reg.negative_cache.is_empty());
    }

    #[test]
    fn reread_returns_false_when_negative_cached() {
        let reg = Registry::new();
        reg.negative_cache.insert(
            "p".to_string(),
            Instant::now() + Duration::from_secs(60),
        );
        assert!(!reg.reread_on_auth_failure("p", "old").unwrap());
    }

    // Keychain-touching tests deliberately omitted — they cannot run in headless CI
    // on all platforms. Integration coverage lives in Task 21 smoke tests.
}
