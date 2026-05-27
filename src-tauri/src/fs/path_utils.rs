//! Path canonicalization helpers that tolerate not-yet-existing files
//! AND not-yet-existing intermediate directories.
//!
//! `std::fs::canonicalize` requires the entire path to exist. For
//! filesystem WRITE operations the leaf and zero-or-more leading
//! directory components may be missing — they're created by the write
//! itself. We need a canonical form anyway (for sandbox checks and
//! UserPaths containment), so this helper walks the path upward until
//! it finds an existing ancestor, canonicalizes that, then re-joins the
//! missing tail components onto it.
//!
//! Example: writing `…/Desktop/.claude/agents/foo.md` when `Desktop`
//! exists but `.claude/agents` does not. Single-level fallback would
//! fail at `…/.claude/agents` and return Err. This helper walks up to
//! `…/Desktop`, canonicalizes (producing the `\\?\` UNC form on Windows),
//! then joins `.claude/agents/foo.md` back on.

use std::path::{Path, PathBuf};

/// Canonicalize `p` if it exists; otherwise walk up the path until an
/// existing ancestor is found, canonicalize that ancestor, and re-join
/// the missing tail components.
///
/// Returns Err when no ancestor exists (rare — would imply a malformed
/// path with no real component, or a removed drive on Windows).
pub fn canonicalize_with_missing_tail(p: &Path) -> Result<PathBuf, String> {
    if let Ok(c) = std::fs::canonicalize(p) {
        return Ok(c);
    }
    // Collect missing tail components as we walk up. We keep them as
    // owned OsStrings so the loop can mutate `ancestor` freely.
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut ancestor = p.to_path_buf();
    loop {
        let file_name = ancestor
            .file_name()
            .ok_or_else(|| format!("no filename component in {}", ancestor.display()))?
            .to_os_string();
        let parent = ancestor
            .parent()
            .ok_or_else(|| format!("no parent component for {}", ancestor.display()))?
            .to_path_buf();
        tail.push(file_name);
        if let Ok(c) = std::fs::canonicalize(&parent) {
            // Re-join tail in reverse order (we collected it deepest-first).
            let mut result = c;
            for component in tail.iter().rev() {
                result = result.join(component);
            }
            return Ok(result);
        }
        // Otherwise climb another level.
        if parent.as_os_str().is_empty() {
            return Err(format!("no existing ancestor for {}", p.display()));
        }
        ancestor = parent;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "matrixos_pu_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn existing_file_canonicalizes() {
        let dir = temp_dir();
        let file = dir.join("a.txt");
        fs::write(&file, "x").unwrap();
        let c = canonicalize_with_missing_tail(&file).unwrap();
        // canonicalize returns the same target as the std lib version
        assert_eq!(c, std::fs::canonicalize(&file).unwrap());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_file_in_existing_dir_resolves() {
        let dir = temp_dir();
        let file = dir.join("not-yet.txt");
        let c = canonicalize_with_missing_tail(&file).unwrap();
        let expected_parent = std::fs::canonicalize(&dir).unwrap();
        assert_eq!(c, expected_parent.join("not-yet.txt"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_intermediate_directories_resolve() {
        // Regression for the agent-export bug: writing
        // …/Desktop/.claude/agents/foo.md when .claude/agents do not
        // yet exist. Single-level fallback failed here; multi-level
        // walks up to Desktop, canonicalizes, then rejoins the tail.
        let dir = temp_dir();
        let nested = dir.join("a").join("b").join("c").join("foo.md");
        let c = canonicalize_with_missing_tail(&nested).unwrap();
        let expected_root = std::fs::canonicalize(&dir).unwrap();
        assert_eq!(
            c,
            expected_root
                .join("a")
                .join("b")
                .join("c")
                .join("foo.md")
        );
        fs::remove_dir_all(&dir).ok();
    }
}
