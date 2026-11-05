//! Oversized tool results: persist to disk instead of truncating.
//!
//! Claude Code keeps a 50k-character cap per result and a 200k budget per
//! message; anything larger is written to a file and replaced by a
//! `<persisted-output>` notice with a preview, so the model can read the rest
//! with `read_file` instead of losing it to a cut. bnote used to truncate in
//! place, which silently destroyed the tail of a large build log.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use super::types::Content;

/// Per-result cap (characters). Matches CC's DEFAULT_MAX_RESULT_SIZE_CHARS.
pub const MAX_RESULT_CHARS: usize = 50_000;
/// Aggregate cap for one tool-result message (one parallel batch).
pub const MAX_RESULTS_PER_MESSAGE_CHARS: usize = 200_000;
/// How much of a persisted result stays inline.
const PREVIEW_CHARS: usize = 2_000;

pub struct ResultStore {
    dir: PathBuf,
    seq: AtomicU64,
}

impl ResultStore {
    pub fn new(dir: PathBuf) -> Self {
        ResultStore {
            dir,
            seq: AtomicU64::new(0),
        }
    }

    /// Replaces an oversized text with a persisted-output notice. Text under the
    /// cap (or a failure with no text) passes through unchanged.
    pub fn cap(&self, session: &str, text: String) -> String {
        if text.chars().count() <= MAX_RESULT_CHARS {
            return text;
        }
        self.persist(session, text)
    }

    /// Keeps one tool-result message under the aggregate budget by persisting
    /// its largest texts. Only successful results are rewritten: an error text
    /// is what the model must read in full to recover.
    pub fn apply_budget(&self, session: &str, results: &mut [Content]) {
        let total: usize = results.iter().map(result_chars).sum();
        if total <= MAX_RESULTS_PER_MESSAGE_CHARS {
            return;
        }
        let mut order: Vec<(usize, usize)> = results
            .iter()
            .enumerate()
            .filter(|(_, c)| match c {
                Content::ToolResult {
                    is_error: false,
                    content,
                    ..
                } => content.chars().count() > PREVIEW_CHARS * 2,
                _ => false,
            })
            .map(|(i, c)| (i, result_chars(c)))
            .collect();
        order.sort_by(|a, b| b.1.cmp(&a.1));
        for (index, _) in order {
            // Recompute instead of subtracting the old size: the persisted notice
            // itself has weight, and the budget must account for it.
            let running: usize = results.iter().map(result_chars).sum();
            if running <= MAX_RESULTS_PER_MESSAGE_CHARS {
                break;
            }
            if let Some(Content::ToolResult { content, .. }) = results.get_mut(index) {
                let taken = std::mem::take(content);
                *content = self.persist(session, taken);
            }
        }
    }

    fn persist(&self, session: &str, text: String) -> String {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        let safe_session: String = session
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        let dir = self.dir.join(&safe_session);
        if let Err(e) = std::fs::create_dir_all(&dir) {
            return format!(
                "<persisted-output>\nOutput too large ({} chars) and could not be saved: {}\n\nPreview:\n{}\n</persisted-output>",
                text.chars().count(),
                e,
                preview(&text)
            );
        }
        let path = dir.join(format!("result-{}-{}.txt", std::process::id(), seq));
        if let Err(e) = std::fs::write(&path, &text) {
            return format!(
                "<persisted-output>\nOutput too large ({} chars) and could not be saved: {}\n\nPreview:\n{}\n</persisted-output>",
                text.chars().count(),
                e,
                preview(&text)
            );
        }
        format!(
            "<persisted-output>\nOutput too large ({} chars). Full output saved to: {}\n\nPreview (first {} chars):\n{}\n</persisted-output>",
            text.chars().count(),
            path.display(),
            PREVIEW_CHARS,
            preview(&text)
        )
    }
}

fn result_chars(content: &Content) -> usize {
    match content {
        Content::ToolResult { content, .. } => content.chars().count(),
        _ => 0,
    }
}

fn preview(text: &str) -> String {
    let mut out: String = text.chars().take(PREVIEW_CHARS).collect();
    if text.chars().count() > PREVIEW_CHARS {
        out.push_str("\n…[preview truncated]");
    }
    out
}

/// Reads a persisted result back (the `read_file` tool sees ordinary files, so
/// no special path is needed; this helper exists for tests).
pub fn is_persisted_notice(text: &str) -> bool {
    text.starts_with("<persisted-output>")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (ResultStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "bnote-results-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        (ResultStore::new(dir.clone()), dir)
    }

    #[test]
    fn a_small_result_passes_through() {
        let (store, dir) = store();
        let text = "ok".to_string();
        assert_eq!(store.cap("s", text.clone()), text);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_oversized_result_is_written_to_disk_with_a_preview() {
        let (store, dir) = store();
        let big = "x".repeat(MAX_RESULT_CHARS + 10);
        let capped = store.cap("sess", big);
        assert!(is_persisted_notice(&capped), "{}", &capped[..40]);
        assert!(capped.contains("Full output saved to"));
        assert!(capped.contains("Preview"));
        // The file exists and holds the whole text.
        let path = capped
            .lines()
            .find_map(|l| l.strip_prefix("Output too large ("))
            .map(|_| ())
            .map(|_| dir.join("sess"))
            .expect("dir");
        let entries: Vec<_> = std::fs::read_dir(&path)
            .expect("persisted dir")
            .flatten()
            .collect();
        assert_eq!(entries.len(), 1);
        let stored = std::fs::read_to_string(entries[0].path()).expect("persisted file");
        assert_eq!(stored.chars().count(), MAX_RESULT_CHARS + 10);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_message_budget_persists_the_largest_results_first() {
        let (store, dir) = store();
        let mut results = vec![
            Content::ToolResult {
                tool_use_id: "a".into(),
                content: "a".repeat(MAX_RESULT_CHARS),
                is_error: false,
                images: Vec::new(),
            },
            Content::ToolResult {
                tool_use_id: "b".into(),
                content: "b".repeat(MAX_RESULT_CHARS),
                is_error: false,
                images: Vec::new(),
            },
            Content::ToolResult {
                tool_use_id: "c".into(),
                content: "c".repeat(MAX_RESULT_CHARS),
                is_error: false,
                images: Vec::new(),
            },
            Content::ToolResult {
                tool_use_id: "d".into(),
                content: "d".repeat(MAX_RESULT_CHARS),
                is_error: false,
                images: Vec::new(),
            },
            Content::ToolResult {
                tool_use_id: "e".into(),
                content: "e".repeat(MAX_RESULT_CHARS),
                is_error: false,
                images: Vec::new(),
            },
        ];
        store.apply_budget("sess", &mut results);
        let total: usize = results.iter().map(result_chars).sum();
        assert!(
            total <= MAX_RESULTS_PER_MESSAGE_CHARS,
            "the message budget must hold, got {}",
            total
        );
        // Everything that was rewritten now points at a file.
        let persisted = results
            .iter()
            .filter(|c| match c {
                Content::ToolResult { content, .. } => is_persisted_notice(content),
                _ => false,
            })
            .count();
        assert!(persisted >= 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn error_texts_are_never_budgeted_away() {
        let (store, dir) = store();
        let mut results = vec![Content::ToolResult {
            tool_use_id: "e".into(),
            content: "e".repeat(MAX_RESULTS_PER_MESSAGE_CHARS + 100),
            is_error: true,
            images: Vec::new(),
        }];
        store.apply_budget("sess", &mut results);
        match &results[0] {
            Content::ToolResult { content, .. } => assert!(!is_persisted_notice(content)),
            _ => panic!("expected a tool result"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
