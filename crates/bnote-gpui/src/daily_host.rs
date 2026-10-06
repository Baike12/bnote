//! Daily-sync host: bridges the pure `bnote_core::daily` engine to file IO.
//!
//! The shell calls [`DailyHost::on_saved`] after every autosave (on the
//! background executor) with the path and its new text; the host diffs against
//! the last synced snapshot, derives sync intents and applies them as further
//! file writes. Link state persists to `<vault>/.bnote/daily-links.json` in
//! the exact v1 shape the Tauri shell reads.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;

use bnote_core::daily::engine::{
    self, Intent, MirrorSide,
};
use bnote_core::daily::links::{self, LinkStore};
use bnote_core::daily::model;
use bnote_core::state::AppState;

/// One file write the sync decided on; the caller executes it (still on the
/// background thread) and then refreshes whatever is open in the editor.
#[derive(Debug, Clone, PartialEq)]
pub struct SyncWrite {
    pub path: String,
    pub text: String,
}

pub struct DailyHost {
    vault: PathBuf,
    state: Arc<AppState>,
    links: Mutex<LinkStore>,
    /// path → text at the last sync decision point (baselines for the diff).
    last_synced: Mutex<HashMap<String, String>>,
    send_counter: Mutex<u64>,
}

/// First/last changed line between two snapshots, 1-based inclusive on both
/// sides: (from_a, to_a, from_b, to_b). None when identical.
fn changed_range(old: &str, new: &str) -> Option<(usize, usize, usize, usize)> {
    let a: Vec<&str> = old.split('\n').collect();
    let b: Vec<&str> = new.split('\n').collect();
    let mut prefix = 0usize;
    while prefix < a.len() && prefix < b.len() && a[prefix] == b[prefix] {
        prefix += 1;
    }
    let mut suffix = 0usize;
    while suffix < a.len() - prefix && suffix < b.len() - prefix
        && a[a.len() - 1 - suffix] == b[b.len() - 1 - suffix]
    {
        suffix += 1;
    }
    if prefix == a.len() && prefix == b.len() {
        return None;
    }
    Some((prefix + 1, a.len() - suffix, prefix + 1, b.len() - suffix))
}

impl DailyHost {
    pub fn new(state: Arc<AppState>, vault: &Path) -> Self {
        let links = links::load_links(vault);
        Self {
            vault: vault.to_path_buf(),
            state,
            links: Mutex::new(links),
            last_synced: Mutex::new(HashMap::new()),
            send_counter: Mutex::new(0),
        }
    }

    /// Seed the baseline so the first save after opening does not sync
    /// pre-existing differences.
    pub fn record_synced(&self, path: &str, text: &str) {
        self.last_synced
            .lock()
            .unwrap()
            .insert(path.to_string(), text.to_string());
    }

    fn read_file(&self, path: &str) -> Option<String> {
        bnote_core::commands::files::read_file(&self.state, path.to_string()).ok()
    }

    fn write_file(&self, path: &str, text: &str) -> Result<(), String> {
        bnote_core::commands::files::write_file(&self.state, path.to_string(), text.to_string())
            .map(|_| ())
    }

    /// Today's daily text: the file when it exists, else the rollover
    /// scaffold (not written here — the first actual sync writes it).
    pub fn daily_text_for(&self, today: &str) -> String {
        let daily_path = model::daily_path_for(
            &self.vault.to_string_lossy(),
            today,
        );
        if let Some(text) = self.read_file(&daily_path) {
            return text;
        }
        self.scaffold_for(today)
    }

    /// ⌘⇧O: read today's daily, creating it from the rollover scaffold when
    /// missing. Returns (absolute path, text). Blocking; background thread.
    pub fn open_daily_text(&self, today: &str) -> Result<(String, String), String> {
        let abs = model::daily_path_for(&self.vault.to_string_lossy(), today);
        if let Some(text) = self.read_file(&abs) {
            return Ok((abs, text));
        }
        let scaffold = self.scaffold_for(today);
        self.write_file(&abs, &scaffold)?;
        Ok((abs, scaffold))
    }

    /// Vault root as a string (model path helpers want &str).
    pub fn vault_str(&self) -> String {
        self.vault.to_string_lossy().to_string()
    }

    pub fn scaffold_for(&self, today: &str) -> String {
        let vault = self.vault.to_string_lossy().to_string();
        engine::daily_scaffold_with_rollover(
            &|dir: &str| {
                let full = self.vault.join(dir);
                let mut names: Vec<String> = std::fs::read_dir(full)
                    .ok()?
                    .filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .collect();
                names.sort();
                Some(names)
            },
            &|path: &str| std::fs::read_to_string(path).ok(),
            &vault,
            today,
        )
    }

    /// Run after a save of `path` with its new text. Returns the follow-up
    /// writes (mirror target / daily file) — the caller applies them.
    pub fn on_saved(&self, path: &str, text: &str, today: &str) -> Vec<SyncWrite> {
        let old = {
            let mut baselines = self.last_synced.lock().unwrap();
            baselines
                .insert(path.to_string(), text.to_string())
                .filter(|prev| prev != text)
        };
        let Some(old) = old else { return Vec::new() };
        let Some((from_a, to_a, from_b, to_b)) = changed_range(&old, text) else {
            return Vec::new();
        };

        let is_daily = model::is_daily_path(path);
        let file_links: Vec<_> = {
            let store = self.links.lock().unwrap();
            store.for_file(path).into_iter().cloned().collect()
        };
        let allow_send = !is_daily;
        let intents = engine::intents_for_range(
            &old,
            text,
            from_a,
            to_a,
            from_b,
            to_b,
            &file_links,
            allow_send,
        );
        if intents.is_empty() {
            return Vec::new();
        }

        let mut writes = Vec::new();
        let mut store_changed = false;
        {
            let mut store = self.links.lock().unwrap();
            for intent in intents {
                match intent {
                    Intent::Mirror { link_id, root_hint, renamed_to } => {
                        let Some(link) = store.get_by_id(&link_id).cloned() else { continue };
                        let side = if is_daily { MirrorSide::Daily } else { MirrorSide::Src };
                        let other_path = match side {
                            MirrorSide::Src => link.daily_path.clone(),
                            MirrorSide::Daily => link.src_path.clone(),
                        };
                        let other_text = self.read_file(&other_path);
                        let outcome = engine::apply_mirror(
                            side,
                            text,
                            other_text.as_deref(),
                            &link,
                            root_hint,
                            renamed_to.as_deref(),
                        );
                        if let Some(other_new) = outcome.other_new {
                            if self.write_file(&other_path, &other_new).is_ok() {
                                writes.push(SyncWrite { path: other_path.clone(), text: other_new });
                            }
                        }
                        match outcome.link {
                            engine::LinkChange::Keep => {}
                            engine::LinkChange::Remove => {
                                store.remove(&link_id);
                                store_changed = true;
                            }
                            engine::LinkChange::Update(new_link) => {
                                store.update(&link_id, |l| *l = new_link);
                                store_changed = true;
                            }
                        }
                    }
                    Intent::Send { root_hint, text: entry_text } => {
                        let daily_path = model::daily_path_for(
                            &self.vault.to_string_lossy(),
                            today,
                        );
                        let daily_text = self.read_file(&daily_path)
                            .unwrap_or_else(|| self.scaffold_for(today));
                        let link_id = self.next_link_id();
                        let outcome = engine::apply_send(
                            path,
                            text,
                            &daily_path,
                            &daily_text,
                            root_hint,
                            &entry_text,
                            today,
                            &link_id,
                            &mut store,
                        );
                        if let Some(daily_new) = outcome.daily_new {
                            if self.write_file(&daily_path, &daily_new).is_ok() {
                                writes.push(SyncWrite {
                                    path: daily_path.clone(),
                                    text: daily_new,
                                });
                            }
                        }
                        if let Some(link) = outcome.link {
                            store.upsert(link);
                            store_changed = true;
                        }
                    }
                }
            }
            if store_changed {
                let _ = links::save_links(&self.vault, &store);
            }
        }
        writes
    }

    /// ⌘⇧J: send the todo blocks at `cursor_lines` (1-based) of `path` to
    /// today's daily. Returns the daily write (if any) and per-line counters.
    pub fn send_todo(
        &self,
        path: &str,
        text: &str,
        cursor_lines: &[usize],
        today: &str,
    ) -> (Option<SyncWrite>, engine::SendReport) {
        if model::is_daily_path(path) {
            return (None, engine::SendReport::default());
        }
        let daily_path =
            model::daily_path_for(&self.vault.to_string_lossy(), today);
        let daily_text = self.read_file(&daily_path);
        let mut store = self.links.lock().unwrap();
        let vault = self.vault.to_string_lossy().to_string();
        // send_todo_lines wants an id *generator* (one fresh id per created
        // link), not a single value.
        let mut new_id = || self.next_link_id();
        let (daily_new, report) = engine::send_todo_lines(
            path,
            text,
            &daily_path,
            daily_text,
            cursor_lines,
            today,
            &mut store,
            // Fresh scaffold (rollover) only when a send actually happens.
            &|| {
                engine::daily_scaffold_with_rollover(
                    &|dir: &str| {
                        let full = Path::new(&vault).join(dir);
                        let mut names: Vec<String> = std::fs::read_dir(full)
                            .ok()?
                            .filter_map(|e| e.ok())
                            .map(|e| e.file_name().to_string_lossy().to_string())
                            .collect();
                        names.sort();
                        Some(names)
                    },
                    &|p: &str| std::fs::read_to_string(p).ok(),
                    &vault,
                    today,
                )
            },
            &mut new_id,
        );
        let mut write = None;
        if let Some(new_text) = daily_new {
            if self.write_file(&daily_path, &new_text).is_ok() {
                write = Some(SyncWrite { path: daily_path, text: new_text });
            }
        }
        let _ = links::save_links(&self.vault, &store);
        (write, report)
    }

    fn next_link_id(&self) -> String {
        let mut guard = self.send_counter.lock().unwrap();
        *guard += 1;
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("l{}-{}", millis, guard)
    }

    /// Reload from disk after another shell (or the sync itself) touched the
    /// link store.
    pub fn reload_links(&self) {
        *self.links.lock().unwrap() = links::load_links(&self.vault);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_locates_changed_lines() {
        let old = "a\nb\nc\nd\n";
        let new = "a\nB1\nB2\nc\nd\n";
        assert_eq!(changed_range(old, new), Some((2, 2, 2, 3)));
        assert_eq!(changed_range("same\n", "same\n"), None);
    }
}
