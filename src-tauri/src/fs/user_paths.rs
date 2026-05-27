use crate::providers::error::RustError;
use dashmap::DashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(300);   // 5 min
const MAX_ENTRIES: usize = 128;

#[derive(Default)]
pub struct UserPaths {
    /// Key: canonical path (file OR directory).
    /// Value: last-used timestamp (rolling TTL).
    entries: DashMap<PathBuf, Instant>,
}

impl UserPaths {
    pub fn new() -> Arc<Self> { Arc::new(Self::default()) }

    /// Canonicalize at register time. If the path does not exist yet (rare —
    /// from a `save` dialog), canonicalize the parent and re-join.
    pub fn register(&self, path: PathBuf) -> Result<(), RustError> {
        let canonical = canonicalize_or_parent(&path)?;
        // LRU evict if at cap (skip if re-registering an existing key).
        if self.entries.len() >= MAX_ENTRIES && !self.entries.contains_key(&canonical) {
            let oldest = self.entries.iter()
                .min_by_key(|e| *e.value())
                .map(|e| e.key().clone());
            if let Some(k) = oldest { self.entries.remove(&k); }
        }
        self.entries.insert(canonical, Instant::now());
        self.entries.retain(|_k, ts| ts.elapsed() < TTL);
        Ok(())
    }

    /// Returns true if `path` is contained in any registered file or directory.
    /// For directory entries, prefix-match. For file entries, exact-match.
    /// Rolling-TTL: refreshes the matched entry's timestamp on success.
    pub fn contains(&self, path: &Path) -> bool {
        self.entries.retain(|_k, ts| ts.elapsed() < TTL);
        let Ok(canonical) = canonicalize_or_parent(path) else { return false; };

        // Exact-match for file registrations.
        if let Some(mut entry) = self.entries.get_mut(&canonical) {
            *entry = Instant::now();
            return true;
        }

        // Prefix-match for directory registrations.
        let dir_match: Option<PathBuf> = self.entries.iter()
            .find(|e| {
                std::fs::metadata(e.key()).map(|m| m.is_dir()).unwrap_or(false)
                    && canonical.starts_with(e.key())
            })
            .map(|e| e.key().clone());
        if let Some(k) = dir_match {
            if let Some(mut entry) = self.entries.get_mut(&k) {
                *entry = Instant::now();
            }
            return true;
        }
        false
    }
}

fn canonicalize_or_parent(p: &Path) -> Result<PathBuf, RustError> {
    crate::fs::path_utils::canonicalize_with_missing_tail(p)
        .map_err(|e| RustError::new("FS_INVALID_PATH", e, false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir() -> PathBuf {
        let p = std::env::temp_dir().join(format!("matrixos_up_{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn registered_directory_accepts_children() {
        let up = UserPaths::new();
        let dir = temp_dir();
        let child = dir.join("sub").join("a.txt");
        fs::create_dir_all(child.parent().unwrap()).unwrap();
        fs::write(&child, "x").unwrap();
        up.register(dir.clone()).unwrap();
        assert!(up.contains(&child));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn registered_file_rejects_siblings() {
        let up = UserPaths::new();
        let dir = temp_dir();
        let f1 = dir.join("a.txt");
        let f2 = dir.join("b.txt");
        fs::write(&f1, "x").unwrap();
        fs::write(&f2, "y").unwrap();
        up.register(f1.clone()).unwrap();
        assert!(up.contains(&f1));
        assert!(!up.contains(&f2));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unregistered_path_not_contained() {
        let up = UserPaths::new();
        assert!(!up.contains(Path::new("/definitely/not/registered")));
    }

    #[test]
    fn lru_cap_evicts_oldest() {
        let up = UserPaths::new();
        let mut dirs = Vec::new();
        for _ in 0..(MAX_ENTRIES + 5) {
            let d = temp_dir();
            up.register(d.clone()).unwrap();
            dirs.push(d);
        }
        for d in &dirs[..5] {
            assert!(!up.contains(d), "expected evicted: {:?}", d);
        }
        for d in &dirs[5..] {
            assert!(up.contains(d), "expected retained: {:?}", d);
        }
        for d in dirs { fs::remove_dir_all(&d).ok(); }
    }
}
