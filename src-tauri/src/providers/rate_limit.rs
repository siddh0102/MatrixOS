//! Token-bucket rate limiter keyed by (provider_id, RateKind).
//!
//! Per spec §4.4 and Appendix H2, limits are read from
//! `provider_configs.config_json.rateLimit.requestsPerMinute` via a 5s TTL
//! cache. Phase A keys by provider_id (matching today's TS behavior);
//! Phase C will switch to per-agent keying.

use crate::providers::error::RustError;
use dashmap::DashMap;
use rusqlite::Connection;
use std::time::{Duration, Instant};

const LIMIT_CACHE_TTL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RateKind {
    RequestsPerMinute,
    // Future variants are additive — see spec §3.2 stability rule.
}

#[derive(Debug)]
pub struct TokenBucket {
    capacity: f64,
    tokens: f64,
    refill_per_sec: f64,
    last_refill: Instant,
}

impl TokenBucket {
    pub fn new(capacity_per_minute: u32) -> Self {
        Self {
            capacity: capacity_per_minute as f64,
            tokens: capacity_per_minute as f64,
            refill_per_sec: capacity_per_minute as f64 / 60.0,
            last_refill: Instant::now(),
        }
    }

    pub fn try_consume(&mut self, n: f64) -> bool {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        self.last_refill = now;
        if self.tokens >= n {
            self.tokens -= n;
            true
        } else {
            false
        }
    }
}

#[derive(Default)]
pub struct RateLimiter {
    buckets: DashMap<(String, RateKind), TokenBucket>,
    /// Cached `(rpm, cached_at)` per provider_id. `rpm == 0` means "no limit".
    cache: DashMap<String, (u32, Instant)>,
}

impl RateLimiter {
    pub fn new() -> Self { Self::default() }

    /// Test/internal helper: consume 1 token against an explicitly-supplied
    /// limit. Seeds the bucket on first call.
    pub fn try_acquire_with_limit(&self, provider_id: &str, rpm: u32) -> bool {
        if rpm == 0 { return true; }
        let mut entry = self.buckets
            .entry((provider_id.to_string(), RateKind::RequestsPerMinute))
            .or_insert_with(|| TokenBucket::new(rpm));
        entry.try_consume(1.0)
    }

    /// Production path: reads the per-provider limit from SQL via 5s TTL
    /// cache, then consumes 1 token. Returns `Ok(false)` if the bucket is
    /// empty; `Ok(true)` if the call may proceed.
    pub fn try_acquire_for_provider(
        &self,
        provider_id: &str,
        conn: &Connection,
    ) -> Result<bool, RustError> {
        let now = Instant::now();
        // Critical: the Ref returned by `cache.get()` holds a READ lock on the
        // DashMap shard. We must drop that Ref BEFORE calling `cache.insert()`
        // (which needs a WRITE lock on the same shard) or we deadlock. The
        // previous `match cache.get() { Some(e) if … => e.0, _ => { insert } }`
        // form kept the Ref alive across the whole match expression — when the
        // guard failed (entry expired after 5s TTL), the `_` arm's insert hung
        // forever. Because this method runs inside `db.with(|conn| …)`, the
        // deadlock also pinned the Db mutex, freezing every subsequent Rust DB
        // operation (proc_start, audit, other rate-limit checks). Extracting
        // the cached value into an owned Option<u32> drops the Ref at the end
        // of the block.
        let cached_rpm: Option<u32> = self
            .cache
            .get(provider_id)
            .filter(|entry| now.duration_since(entry.1) < LIMIT_CACHE_TTL)
            .map(|entry| entry.0);

        let rpm = match cached_rpm {
            Some(v) => v,
            None => {
                let fresh = load_rate_limit_for_provider(conn, provider_id)?;
                self.cache.insert(provider_id.to_string(), (fresh, now));
                fresh
            }
        };
        Ok(self.try_acquire_with_limit(provider_id, rpm))
    }

    /// Drop cached limit for a provider — called by Phase C when
    /// `provider_set_config` writes change the rate-limit setting.
    pub fn invalidate_provider(&self, provider_id: &str) {
        self.cache.remove(provider_id);
        // Buckets are not removed — they refill naturally; if the limit was
        // raised, headroom catches up within (60s / new_rpm) seconds.
    }
}

/// Reads `provider_configs.config_json.rateLimit.requestsPerMinute` from SQL.
/// Returns 0 if the column / key / value is missing — "no limit" semantics.
fn load_rate_limit_for_provider(
    conn: &Connection,
    provider_id: &str,
) -> Result<u32, RustError> {
    let cj: Option<String> = conn
        .query_row(
            "SELECT config_json FROM provider_configs WHERE id = ?",
            [provider_id],
            |r| r.get(0),
        )
        .ok();
    let rpm = cj
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("rateLimit")
                .and_then(|r| r.get("requestsPerMinute"))
                .and_then(|n| n.as_u64())
        })
        .map(|n| n as u32)
        .unwrap_or(0);
    Ok(rpm)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE provider_configs (id TEXT PRIMARY KEY, config_json TEXT)",
            [],
        ).unwrap();
        conn
    }

    fn insert_provider(conn: &Connection, id: &str, rpm: Option<u32>) {
        let cj = match rpm {
            Some(n) => format!(r#"{{"rateLimit":{{"requestsPerMinute":{}}}}}"#, n),
            None => "{}".to_string(),
        };
        conn.execute(
            "INSERT INTO provider_configs (id, config_json) VALUES (?, ?)",
            params![id, cj],
        ).unwrap();
    }

    #[test]
    fn no_limit_set_allows_all() {
        let rl = RateLimiter::new();
        for _ in 0..1000 {
            assert!(rl.try_acquire_with_limit("p", 0));
        }
    }

    #[test]
    fn limit_caps_requests() {
        let rl = RateLimiter::new();
        assert!(rl.try_acquire_with_limit("p", 3));
        assert!(rl.try_acquire_with_limit("p", 3));
        assert!(rl.try_acquire_with_limit("p", 3));
        assert!(!rl.try_acquire_with_limit("p", 3));
    }

    #[test]
    fn try_acquire_for_provider_reads_rpm_from_sql() {
        let conn = setup_db();
        insert_provider(&conn, "claude", Some(2));
        let rl = RateLimiter::new();
        assert!(rl.try_acquire_for_provider("claude", &conn).unwrap());
        assert!(rl.try_acquire_for_provider("claude", &conn).unwrap());
        assert!(!rl.try_acquire_for_provider("claude", &conn).unwrap());
    }

    #[test]
    fn try_acquire_for_provider_no_limit_when_absent() {
        let conn = setup_db();
        insert_provider(&conn, "ollama", None);
        let rl = RateLimiter::new();
        for _ in 0..100 {
            assert!(rl.try_acquire_for_provider("ollama", &conn).unwrap());
        }
    }

    #[test]
    fn try_acquire_does_not_deadlock_when_cache_entry_expires() {
        // Regression for the DashMap Ref-held-across-insert deadlock.
        // Repro: prime the cache, manually expire it (write a stale Instant),
        // then call again. The expired path used to hold a Ref from .get()
        // alive across the match expression while calling .insert() on the
        // same shard — that deadlocked forever AND held the Db mutex.
        let conn = setup_db();
        insert_provider(&conn, "g", Some(60));
        let rl = RateLimiter::new();

        // Prime: populates cache.
        assert!(rl.try_acquire_for_provider("g", &conn).unwrap());

        // Manually expire the cache entry by rewriting its timestamp far
        // in the past. This forces the "cache miss after hit" branch on
        // the next call — exactly the path that deadlocked.
        let past = Instant::now() - LIMIT_CACHE_TTL - Duration::from_secs(1);
        rl.cache.insert("g".to_string(), (60, past));

        // Without the fix, this call hangs forever. With the fix, it
        // completes in microseconds.
        let result = std::thread::spawn(move || {
            // Build a fresh conn since we moved out of scope.
            let conn = setup_db();
            insert_provider(&conn, "g", Some(60));
            rl.try_acquire_for_provider("g", &conn).unwrap()
        });

        // Join with a generous timeout. If this returns Err(_), the thread
        // is still stuck → the deadlock has regressed.
        let start = Instant::now();
        loop {
            if result.is_finished() {
                let v = result.join().unwrap();
                assert!(v, "should still allow within rpm");
                return;
            }
            if start.elapsed() > Duration::from_secs(3) {
                panic!("try_acquire_for_provider deadlocked on cache-expiry path");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn missing_provider_row_returns_no_limit() {
        let conn = setup_db();
        // Note: no insert for "missing-id"
        let rl = RateLimiter::new();
        for _ in 0..100 {
            assert!(rl.try_acquire_for_provider("missing-id", &conn).unwrap());
        }
    }

    #[test]
    fn invalidate_provider_clears_cache() {
        let conn = setup_db();
        insert_provider(&conn, "p", Some(5));
        let rl = RateLimiter::new();
        rl.try_acquire_for_provider("p", &conn).unwrap();
        // Confirm the limit is cached
        assert!(rl.cache.contains_key("p"));
        rl.invalidate_provider("p");
        assert!(!rl.cache.contains_key("p"));
    }
}
