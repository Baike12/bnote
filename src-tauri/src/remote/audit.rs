//! Local audit trail of remote activity.
//!
//! The relay never receives these lines. They stay under `<data_dir>/remote/`
//! on the Mac, rotate at 10 MB (three kept files) and never carry credentials:
//! callers pass a already-redacted summary.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::settings;

const MAX_BYTES: u64 = 10 * 1024 * 1024;
const KEEP: usize = 3;
const SUMMARY_CHARS: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub at: u64,
    pub device_id: String,
    pub kind: String,
    pub summary: String,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn clip(summary: &str) -> String {
    let one_line = summary.replace(['\r', '\n'], " ");
    if one_line.chars().count() <= SUMMARY_CHARS {
        return one_line;
    }
    let mut out: String = one_line.chars().take(SUMMARY_CHARS).collect();
    out.push('…');
    out
}

pub fn append(data_dir: &Path, device_id: &str, kind: &str, summary: &str) {
    if let Err(e) = append_inner(data_dir, device_id, kind, summary) {
        // The audit log must never break the action it records.
        eprintln!("[bnote] remote audit: {e}");
    }
}

fn append_inner(data_dir: &Path, device_id: &str, kind: &str, summary: &str) -> Result<(), String> {
    let path = settings::audit_file(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("WRITE_FAILED: {e}"))?;
    }
    rotate_if_needed(&path)?;
    let entry = AuditEntry {
        at: now_ms(),
        device_id: device_id.to_string(),
        kind: kind.to_string(),
        summary: clip(summary),
    };
    let line = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("WRITE_FAILED: {e}"))?;
    writeln!(file, "{line}").map_err(|e| format!("WRITE_FAILED: {e}"))
}

fn rotate_if_needed(path: &Path) -> Result<(), String> {
    let Ok(meta) = std::fs::metadata(path) else {
        return Ok(());
    };
    if meta.len() < MAX_BYTES {
        return Ok(());
    }
    let stem = path.with_extension("jsonl");
    let base = stem.to_string_lossy().to_string();
    let oldest = format!("{base}.{KEEP}");
    let _ = std::fs::remove_file(&oldest);
    for index in (1..KEEP).rev() {
        let from = format!("{base}.{index}");
        let to = format!("{base}.{}", index + 1);
        if Path::new(&from).exists() {
            let _ = std::fs::rename(&from, &to);
        }
    }
    std::fs::rename(path, format!("{base}.1")).map_err(|e| format!("WRITE_FAILED: {e}"))
}

/// The last `limit` entries, newest last. `cursor` is accepted for protocol
/// compatibility; v1 returns the newest page and no next cursor.
pub fn tail(data_dir: &Path, limit: usize) -> Vec<AuditEntry> {
    let path = settings::audit_file(data_dir);
    let Ok(file) = std::fs::File::open(&path) else {
        return Vec::new();
    };
    let limit = limit.clamp(1, 500);
    let mut ring: std::collections::VecDeque<AuditEntry> =
        std::collections::VecDeque::with_capacity(limit);
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if let Ok(entry) = serde_json::from_str::<AuditEntry>(&line) {
            if ring.len() == limit {
                ring.pop_front();
            }
            ring.push_back(entry);
        }
    }
    ring.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("bnote-remote-audit-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn tail_returns_the_newest_entries() {
        let dir = temp_dir("tail");
        for i in 0..5 {
            append(&dir, "dev", "send", &format!("line {i}"));
        }
        let entries = tail(&dir, 3);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[2].summary, "line 4");
        assert_eq!(entries[0].summary, "line 2");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn summaries_are_one_line_and_bounded() {
        let dir = temp_dir("clip");
        let long = format!("a\nb{}", "x".repeat(1000));
        append(&dir, "dev", "send", &long);
        let entry = tail(&dir, 1).remove(0);
        assert!(!entry.summary.contains('\n'));
        assert!(entry.summary.chars().count() <= SUMMARY_CHARS + 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
