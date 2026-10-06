//! Footprint (今日足迹) host: owns the `bnote_core::footprint` core, feeds it
//! vault scans and watcher events, and exposes today's entries for the UI.
//! The in-editor footprint rendering itself waits on the block-decoration
//! seam (next engine milestone); until then the status bar shows the count.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use bnote_core::footprint::model::FootprintEntry;
use bnote_core::footprint::store::FootprintCore;

pub struct FootprintHost {
    core: Arc<FootprintCore>,
    vault: PathBuf,
}

impl FootprintHost {
    pub fn new(vault: &Path) -> Self {
        Self { core: Arc::new(FootprintCore::new(vault)), vault: vault.to_path_buf() }
    }

    /// Full-vault scan + baseline setup. Blocking; call on a background
    /// executor when the vault opens.
    pub fn init(&self, today: &str) {
        self.core.init(today, &scan_closure(self.vault.clone()));
    }

    /// Watcher told us files changed (absolute or vault-relative paths —
    /// the core normalizes against its vault root).
    pub fn note_dirty(&self, paths: &[String]) {
        let refs: Vec<&str> = paths.iter().map(|p| p.as_str()).collect();
        self.core.note_dirty(&refs, Instant::now());
    }

    /// Periodic pump (rotation, throttled rebuilds). Cheap; safe to call
    /// every second.
    pub fn tick(&self, today: &str) {
        self.core.tick(today, Instant::now(), &scan_closure(self.vault.clone()));
    }

    pub fn entries_for(&self, day: &str) -> Vec<FootprintEntry> {
        self.core.entries_for(day)
    }

    pub fn today_entries(&self) -> Vec<FootprintEntry> {
        self.core.today_entries()
    }

    pub fn revision(&self) -> u64 {
        self.core.revision()
    }
}

/// Scan closure handed to the core: every markdown file under the vault as
/// (path, text). bnote vaults are plain folders (~hundreds of files, small);
/// the core throttles how often this actually runs.
fn scan_closure(vault: PathBuf) -> impl Fn() -> Vec<(String, String)> {
    move || {
        let mut out = Vec::new();
        walk_md(&vault, &mut out, 0);
        out
    }
}

const MAX_SCAN_DEPTH: usize = 12;

fn walk_md(dir: &Path, out: &mut Vec<(String, String)>, depth: usize) {
    if depth > MAX_SCAN_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_dir() {
            // Skip hidden dirs (.bnote, .obsidian, …).
            if entry
                .file_name()
                .to_str()
                .is_some_and(|n| n.starts_with('.'))
            {
                continue;
            }
            walk_md(&path, out, depth + 1);
        } else if path.extension().is_some_and(|e| e == "md") {
            if let Ok(text) = std::fs::read_to_string(&path) {
                out.push((path.to_string_lossy().to_string(), text));
            }
        }
    }
}
