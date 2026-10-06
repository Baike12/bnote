//! Runtime storage for today's footprints: baseline on disk
//! (`<vault>/.bnote/daily-footprints.json`), day rotation, in-memory
//! increment index. Port of `bnote/src/footprint/store.ts::FootprintCore`.
//!
//! Facts kept here, per the TS contract:
//! - baseline = whole-vault snapshot taken at day-switch time (one rotation
//!   per day, at most one full read per day);
//! - today's footprints = current on-disk content diffed against the
//!   baseline (only for watcher-reported dirty paths, 1s debounce);
//! - history = at rotation time the old baseline day's diff is frozen into
//!   `history[day][path]`, read-only afterwards — historical dailies
//!   aggregate from it;
//! - `refresh_all` is the full-rebuild fallback for files changed while the
//!   app was not running (throttled to 5s).
//!
//! Adaptations from the TS version (shell concerns live in the GPUI shell):
//! - no `setTimeout`: the host pumps [`FootprintCore::tick`] with an explicit
//!   `Instant`, so the dirty debounce and the full-refresh throttle stay
//!   deterministic and testable;
//! - the vault-wide scan is injected as a closure returning
//!   `(absolute path, current text)` pairs — this module never walks the
//!   filesystem tree itself; dirty-path refresh reads the real files with
//!   `std::fs`;
//! - persistence writes synchronously at rotation time (rotation happens at
//!   most once per day, so the TS 300ms debounce has nothing to coalesce);
//!   [`FootprintCore::flush_persist`] covers exit-time flushes;
//! - path ordering is byte order (`BTreeMap`) where the TS sorts with
//!   `localeCompare`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::model::{
    diff_blocks, footprints_file_path, is_aggregate_path, FootprintBlock, FootprintEntry,
    StoredFootprints,
};

/// Dirty paths are diffed after this much quiet time
/// (`store.ts::DIRTY_DELAY`).
pub const DIRTY_DELAY: Duration = Duration::from_secs(1);
/// Full-rebuild throttle (`store.ts::FULL_REFRESH_THROTTLE`).
pub const FULL_REFRESH_THROTTLE: Duration = Duration::from_secs(5);

/// Historical archive: day → path → that day's frozen footprint blocks.
type History = BTreeMap<String, BTreeMap<String, Vec<FootprintBlock>>>;

/// Host-supplied vault scan: returns `(absolute path, current text)` for
/// every candidate file of the vault; the core filters with
/// [`is_aggregate_path`] again. Port of the `listFiles` + `readFile` pair of
/// `store.ts::FootprintIO`.
pub type Scan<'a> = &'a dyn Fn() -> Vec<(String, String)>;

struct Inner {
    vault: PathBuf,
    /// Baseline's owning day (YYYY-MM-DD); empty = never rotated (first
    /// use / broken metadata).
    day: String,
    baselines: BTreeMap<String, String>,
    /// Frozen archive: day → path → blocks. Read-only after rotation.
    history: History,
    /// Today's increment index: path → blocks.
    index: BTreeMap<String, Vec<FootprintBlock>>,
    /// Watcher-fed aggregate paths waiting for their debounce.
    dirty: BTreeSet<String>,
    dirty_since: Option<Instant>,
    last_full_refresh: Option<Instant>,
    revision: u64,
}

/// Thread-safe footprint core. The host thread feeds watcher events via
/// [`Self::note_dirty`] and pumps [`Self::tick`]; readers call
/// [`Self::footprints_for`] / [`Self::entries_for`] from any thread.
pub struct FootprintCore {
    inner: Mutex<Inner>,
}

impl FootprintCore {
    pub fn new(vault: impl Into<PathBuf>) -> FootprintCore {
        FootprintCore {
            inner: Mutex::new(Inner {
                vault: vault.into(),
                day: String::new(),
                baselines: BTreeMap::new(),
                history: BTreeMap::new(),
                index: BTreeMap::new(),
                dirty: BTreeSet::new(),
                dirty_since: None,
                last_full_refresh: None,
                revision: 0,
            }),
        }
    }

    /// Load the baseline metadata and rotate if needed. Missing or broken
    /// metadata counts as "never rotated" (the day's first start snapshots
    /// the whole vault — an empty baseline would bill the entire old vault
    /// as today's record). v1 payloads (no history) load their baselines
    /// with an empty archive — days before the upgrade have no archive and
    /// none is fabricated. Port of `store.ts::init`.
    pub fn init(&self, today: &str, scan: Scan<'_>) {
        let mut inner = self.lock();
        if let Ok(raw) = std::fs::read_to_string(footprints_path(&inner.vault)) {
            if let Some(parsed) = parse_stored(&raw) {
                inner.day = parsed.0;
                inner.baselines = parsed.1;
                inner.history = parsed.2;
            }
        }
        rotate_if_needed(&mut inner, today, scan);
    }

    /// Watcher feed entry: filter to aggregate paths, debounce then diff.
    /// Non-aggregate paths cost nothing. Port of `store.ts::noteDirty`
    /// (the 1s debounce elapses when the host next calls [`Self::tick`]
    /// with a later `Instant`).
    pub fn note_dirty(&self, paths: &[&str], now: Instant) {
        let mut inner = self.lock();
        for p in paths {
            if is_aggregate_path(p, &inner.vault.to_string_lossy()) {
                inner.dirty.insert(p.to_string());
            }
        }
        if inner.dirty.is_empty() {
            return;
        }
        if inner.dirty_since.is_none() {
            inner.dirty_since = Some(now);
        }
    }

    /// Combined pump: rotate on day change, then flush dirty paths whose 1s
    /// debounce elapsed. Idempotent — safe to call from a host timer loop.
    /// Covers `store.ts::flushDirty` (rotateIfNeeded then refreshPaths).
    pub fn tick(&self, today: &str, now: Instant, scan: Scan<'_>) {
        let mut inner = self.lock();
        rotate_if_needed(&mut inner, today, scan);
        let due = inner.dirty_since.is_some_and(|t| now.duration_since(t) >= DIRTY_DELAY);
        if inner.dirty.is_empty() || !due {
            return;
        }
        inner.dirty_since = None;
        let targets: Vec<String> = inner.dirty.iter().cloned().collect();
        inner.dirty.clear();
        refresh_paths(&mut inner, &targets);
    }

    /// Full-rebuild fallback (call when opening today's daily): re-diff the
    /// whole vault, covering changes made while the app was not running
    /// (watcher never reported them). Throttled unless `force`.
    /// Port of `store.ts::refreshAll`.
    pub fn refresh_all(&self, today: &str, force: bool, now: Instant, scan: Scan<'_>) {
        let mut inner = self.lock();
        if !force
            && inner.last_full_refresh.is_some_and(|t| now.duration_since(t) < FULL_REFRESH_THROTTLE)
        {
            return;
        }
        inner.last_full_refresh = Some(now);
        rotate_if_needed(&mut inner, today, scan);
        let vault = inner.vault.to_string_lossy().to_string();
        let mut next: BTreeMap<String, Vec<FootprintBlock>> = BTreeMap::new();
        for (p, text) in scan() {
            if !is_aggregate_path(&p, &vault) {
                continue;
            }
            let blocks = diff_blocks(inner.baselines.get(&p).map(String::as_str), &text);
            next.insert(p, blocks);
        }
        if next != inner.index {
            inner.index = next;
            inner.revision += 1;
        }
    }

    /// A file's footprint blocks for today; empty when unrecorded. Port of
    /// `store.ts::footprintsFor`.
    pub fn footprints_for(&self, path: &str) -> Vec<FootprintBlock> {
        self.lock().index.get(path).cloned().unwrap_or_default()
    }

    /// Every file with footprints today (sorted by path, so widget order is
    /// stable). Port of `store.ts::todayEntries`.
    pub fn today_entries(&self) -> Vec<FootprintEntry> {
        let inner = self.lock();
        entries_of(&inner.index)
    }

    /// Entries of a day: today → the live index; historical day → the frozen
    /// archive (read-only). Unknown days yield an empty vec. While the core
    /// has not rotated yet (`day` empty: injection/init window) the live
    /// index is the only data face, so any day reads it. Port of
    /// `store.ts::entriesFor`.
    pub fn entries_for(&self, day: &str) -> Vec<FootprintEntry> {
        let inner = self.lock();
        if day == inner.day || inner.day.is_empty() {
            return entries_of(&inner.index);
        }
        match inner.history.get(day) {
            Some(files) => entries_of(files),
            None => Vec::new(),
        }
    }

    /// First access after a day switch: finish the rotation (freeze the old
    /// day's archive + switch the baseline). Idempotent; called when opening
    /// any daily — historical ones see the fresh archive immediately. Port
    /// of `store.ts::ensureDay`.
    pub fn ensure_day(&self, today: &str, scan: Scan<'_>) {
        let mut inner = self.lock();
        rotate_if_needed(&mut inner, today, scan);
    }

    /// Baseline's owning day; `None` before the first rotation.
    /// Port of `store.ts::baselineDay`.
    pub fn baseline_day(&self) -> Option<String> {
        let inner = self.lock();
        (!inner.day.is_empty()).then(|| inner.day.clone())
    }

    /// Bumped on every content change (rotation / dirty flush / full
    /// rebuild). Port of `footprintRevision` + `markFootprintsChanged`.
    pub fn revision(&self) -> u64 {
        self.lock().revision
    }

    /// Write the baseline metadata now (exit/hide flush). Port of
    /// `store.ts::flushPersist` (rotation already persists eagerly — see
    /// the module comment).
    pub fn flush_persist(&self) {
        let inner = self.lock();
        persist(&inner);
    }

    /// Debug/test hook: replace the live index wholesale and broadcast
    /// (harness `__setFootprints`). Port of `store.ts::installIndexForTest`.
    pub fn install_index_for_test(&self, index: BTreeMap<String, Vec<FootprintBlock>>) {
        let mut inner = self.lock();
        inner.index = index;
        inner.revision += 1;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Absolute path of the metadata file inside the vault.
fn footprints_path(vault: &Path) -> PathBuf {
    PathBuf::from(footprints_file_path(&vault.to_string_lossy()))
}

/// Parse a stored dump with the TS shape guards: version 1 or 2, string
/// `day`, object `baselines`; `history` optional (v1). Anything else (or
/// broken JSON) → `None` = "never rotated". Port of the `JSON.parse` guard
/// in `store.ts::init`.
fn parse_stored(raw: &str) -> Option<(String, BTreeMap<String, String>, History)> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let version = value.get("version")?.as_u64()?;
    if version != 1 && version != 2 {
        return None;
    }
    let day = value.get("day")?.as_str()?.to_string();
    let baselines_json = value.get("baselines")?.as_object()?;
    let mut baselines = BTreeMap::new();
    for (k, v) in baselines_json {
        baselines.insert(k.clone(), v.as_str()?.to_string());
    }
    let mut history: History = BTreeMap::new();
    if let Some(history_json) = value.get("history").and_then(|h| h.as_object()) {
        for (day, files) in history_json {
            let files = files.as_object()?;
            let mut per_file: BTreeMap<String, Vec<FootprintBlock>> = BTreeMap::new();
            for (path, blocks) in files {
                per_file.insert(path.clone(), serde_json::from_value(blocks.clone()).ok()?);
            }
            history.insert(day.clone(), per_file);
        }
    }
    Some((day, baselines, history))
}

/// Rotation guard. Port of `store.ts::rotateIfNeeded` (the in-flight dedup
/// of the TS version is unnecessary here: the mutex serializes).
fn rotate_if_needed(inner: &mut Inner, today: &str, scan: Scan<'_>) {
    if inner.day == today {
        return;
    }
    do_rotate(inner, today, scan);
}

/// Day switch: the whole-vault snapshot becomes the new baseline; the old
/// baseline day's footprint diff freezes into the archive for historical
/// dailies. Content written in the last minutes before midnight is billed to
/// the old day's archive (one-time miss, minutes-scale, accepted by the TS
/// too). Days the app never ran through get no archive — opening one shows
/// no footprint zone (nothing fabricated). Port of `store.ts::doRotate`.
fn do_rotate(inner: &mut Inner, today: &str, scan: Scan<'_>) {
    let vault = inner.vault.to_string_lossy().to_string();
    let snapshot: BTreeMap<String, String> =
        scan().into_iter().filter(|(p, _)| is_aggregate_path(p, &vault)).collect();
    // The old day's footprints = old baseline diffed against the current
    // disk state — same read batch as the new baseline, zero extra IO.
    // First use (no old baseline) has no "that day": no archive.
    let previous_day = inner.day.clone();
    if !previous_day.is_empty() {
        let mut archived: BTreeMap<String, Vec<FootprintBlock>> = BTreeMap::new();
        for (abs, text) in &snapshot {
            let blocks = diff_blocks(inner.baselines.get(abs).map(String::as_str), text);
            if !blocks.is_empty() {
                archived.insert(abs.clone(), blocks);
            }
        }
        inner.history.insert(previous_day, archived);
    }
    inner.day = today.to_string();
    inner.baselines = snapshot;
    inner.index.clear();
    inner.revision += 1;
    persist(inner);
}

/// Diff only the dirty paths against the baseline; a deleted file
/// (unreadable) leaves the index. Port of `store.ts::refreshPaths`.
fn refresh_paths(inner: &mut Inner, paths: &[String]) {
    if paths.is_empty() {
        return;
    }
    let mut changed = false;
    for p in paths {
        match std::fs::read_to_string(p) {
            Err(_) => {
                changed |= inner.index.remove(p).is_some();
            }
            Ok(text) => {
                let blocks = diff_blocks(inner.baselines.get(p).map(String::as_str), &text);
                if inner.index.get(p) != Some(&blocks) {
                    inner.index.insert(p.clone(), blocks);
                    changed = true;
                }
            }
        }
    }
    if changed {
        inner.revision += 1;
    }
}

/// Entries with at least one block, sorted by path. Port of
/// `store.ts::entriesOf` (byte-order sort instead of `localeCompare`).
fn entries_of(map: &BTreeMap<String, Vec<FootprintBlock>>) -> Vec<FootprintEntry> {
    map.iter()
        .filter(|(_, blocks)| !blocks.is_empty())
        .map(|(path, blocks)| FootprintEntry { path: path.clone(), blocks: blocks.clone() })
        .collect()
}

/// Serialize and write the metadata (compact JSON, exactly
/// `JSON.stringify(stored)` like the TS shell). Best-effort: failures are
/// reported on stderr and otherwise swallowed. Port of `store.ts::writeNow`
/// (synchronous — see the module comment).
fn persist(inner: &Inner) {
    let stored = StoredFootprints {
        version: 2,
        day: inner.day.clone(),
        baselines: inner.baselines.clone(),
        history: inner.history.clone(),
    };
    let result = serde_json::to_string(&stored)
        .map_err(|e| e.to_string())
        .and_then(|json| {
            let path = footprints_path(&inner.vault);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(path, json).map_err(|e| e.to_string())
        });
    if let Err(e) = result {
        eprintln!("[bnote] footprint persist failed: {}", e);
    }
}

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;

    const NOTE_REL: &str = "Job/job todo.md";
    const OTHER_REL: &str = "研究/文献笔记.md";

    /// Test harness: a real tempdir vault. Note files live on disk under the
    /// tempdir (the core reads them with std::fs, exactly like production);
    /// the metadata file goes to `<tmp>/.bnote/daily-footprints.json`.
    struct Env {
        dir: tempfile::TempDir,
        core: FootprintCore,
    }

    impl Env {
        fn new(notes: &[(&str, &str)]) -> Env {
            let dir = tempfile::tempdir().unwrap();
            let core = FootprintCore::new(dir.path().to_path_buf());
            let env = Env { dir, core };
            for (rel, text) in notes {
                env.write(rel, text);
            }
            env
        }

        fn vault(&self) -> String {
            self.dir.path().to_string_lossy().into_owned()
        }

        fn abs(&self, rel: &str) -> String {
            format!("{}/{}", self.vault(), rel)
        }

        /// Write a note file through to the real disk.
        fn write(&self, rel: &str, text: &str) {
            let full = self.dir.path().join(rel);
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            fs::write(full, text).unwrap();
        }

        fn remove(&self, rel: &str) {
            fs::remove_file(self.dir.path().join(rel)).unwrap();
        }

        /// Seed the v1 metadata file (baseline keys must be absolute paths).
        fn set_v1_meta(&self, day: &str, baseline: &[(&str, &str)]) {
            let pairs: Vec<String> =
                baseline.iter().map(|(p, t)| format!("\"{}\":\"{}\"", self.abs(p), t)).collect();
            let raw = format!(
                "{{\"version\":1,\"day\":\"{}\",\"baselines\":{{{}}}}}",
                day,
                pairs.join(",")
            );
            self.set_meta_raw(&raw);
        }

        fn set_meta_raw(&self, raw: &str) {
            let path = self.dir.path().join(".bnote").join("daily-footprints.json");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, raw).unwrap();
        }

        fn meta_raw(&self) -> String {
            fs::read_to_string(self.dir.path().join(".bnote").join("daily-footprints.json"))
                .unwrap()
        }

        /// Owned scan closure over the real tempdir contents (walks the
        /// metadata-free note tree).
        fn scan_fn(&self) -> impl Fn() -> Vec<(String, String)> {
            let root = self.dir.path().to_path_buf();
            move || {
                let mut out = Vec::new();
                for entry in walkdir::WalkDir::new(&root).into_iter().filter_map(Result::ok) {
                    if !entry.file_type().is_file() {
                        continue;
                    }
                    if entry.path().components().any(|c| c.as_os_str() == ".bnote") {
                        continue;
                    }
                    let path = entry.path().to_string_lossy().into_owned();
                    let Ok(text) = fs::read_to_string(entry.path()) else { continue };
                    out.push((path, text));
                }
                out
            }
        }

        fn init(&self, today: &str) {
            let scan = self.scan_fn();
            self.core.init(today, &scan);
        }
    }

    fn block(text: &str, line: usize) -> FootprintBlock {
        FootprintBlock { text: text.into(), start: line, end: line }
    }

    // ---- FootprintCore 轮转 (store.test.ts)

    #[test]
    fn first_init_without_metadata_snapshots_whole_vault_today_empty_footprints() {
        let env = Env::new(&[
            (NOTE_REL, "旧内容 A\n\n旧内容 B"),
            ("Daily/2026-01-01.md", "日记不进基线"),
            ("image.png", "binary"),
        ]);
        env.init("2026-09-30");
        assert_eq!(env.core.baseline_day().as_deref(), Some("2026-09-30"));
        assert!(env.core.today_entries().is_empty());

        env.core.flush_persist();
        let stored: serde_json::Value = serde_json::from_str(&env.meta_raw()).unwrap();
        assert_eq!(stored["version"], 2);
        assert_eq!(stored["day"], "2026-09-30");
        // Only aggregate files enter the baseline: dailies and assets excluded.
        let baselines = stored["baselines"].as_object().unwrap();
        assert_eq!(baselines.len(), 1);
        assert_eq!(baselines[&env.abs(NOTE_REL)].as_str().unwrap(), "旧内容 A\n\n旧内容 B");
        // First use has no "that day": empty archive.
        assert_eq!(stored["history"].as_object().unwrap().len(), 0);
    }

    #[test]
    fn same_day_metadata_keeps_baseline_refresh_all_builds_index() {
        let env = Env::new(&[(NOTE_REL, "盘上已经改过的内容")]);
        env.set_v1_meta("2026-09-30", &[(NOTE_REL, "基线文本")]);
        env.init("2026-09-30");
        // Today's baseline is 「基线文本」; the on-disk content diffs into today's record.
        let scan = env.scan_fn();
        env.core.refresh_all("2026-09-30", true, Instant::now(), &scan);
        assert_eq!(env.core.footprints_for(&env.abs(NOTE_REL)), vec![block("盘上已经改过的内容", 1)]);
    }

    #[test]
    fn cross_day_init_discards_yesterdays_baseline_resnaps_today() {
        let env = Env::new(&[(NOTE_REL, "今天的内容"), (OTHER_REL, "别的文件")]);
        env.set_v1_meta("2026-09-29", &[(NOTE_REL, "昨天的")]);
        env.init("2026-09-30");
        assert_eq!(env.core.baseline_day().as_deref(), Some("2026-09-30"));
        assert!(env.core.today_entries().is_empty());
        assert!(env.core.footprints_for(&env.abs(NOTE_REL)).is_empty());
    }

    #[test]
    fn v1_metadata_loads_with_baseline_and_empty_archive() {
        let env = Env::new(&[(NOTE_REL, "基线文本\n\n今天的段")]);
        env.set_v1_meta("2026-09-30", &[(NOTE_REL, "基线文本")]);
        env.init("2026-09-30");
        let scan = env.scan_fn();
        env.core.refresh_all("2026-09-30", true, Instant::now(), &scan);
        assert_eq!(
            env.core.today_entries(),
            vec![FootprintEntry {
                path: env.abs(NOTE_REL),
                blocks: vec![block("今天的段", 3)],
            }]
        );
        assert!(env.core.entries_for("2026-09-29").is_empty());
    }

    #[test]
    fn broken_metadata_counts_as_never_rotated() {
        let env = Env::new(&[(NOTE_REL, "正文")]);
        env.set_meta_raw("{{{not json");
        env.init("2026-09-30");
        assert_eq!(env.core.baseline_day().as_deref(), Some("2026-09-30"));
        assert!(env.core.today_entries().is_empty());
    }

    // ---- FootprintCore 增量刷新(noteDirty) (store.test.ts)

    #[test]
    fn dirty_paths_diff_after_1s_debounce() {
        let env = Env::new(&[(NOTE_REL, "基线段落")]);
        env.init("2026-09-30");
        let note = env.abs(NOTE_REL);
        let t0 = Instant::now();

        env.write(NOTE_REL, "基线段落\n\n今天写的新段");
        env.core.note_dirty(&[&note], t0);
        assert!(env.core.footprints_for(&note).is_empty()); // debounce window: untouched

        let scan = env.scan_fn();
        env.core.tick("2026-09-30", t0 + Duration::from_millis(1100), &scan);
        assert_eq!(env.core.footprints_for(&note), vec![block("今天写的新段", 3)]);
    }

    #[test]
    fn repeated_dirty_feeds_within_debounce_merge_into_one_refresh() {
        let env = Env::new(&[(NOTE_REL, "基线段落")]);
        env.init("2026-09-30");
        let note = env.abs(NOTE_REL);
        let t0 = Instant::now();

        env.write(NOTE_REL, "基线段落\n\n第一段");
        env.core.note_dirty(&[&note], t0);
        let scan = env.scan_fn();
        env.core.tick("2026-09-30", t0 + Duration::from_millis(500), &scan); // not due yet

        env.write(NOTE_REL, "基线段落\n\n第一段\n\n第二段");
        env.core.note_dirty(&[&note], t0 + Duration::from_millis(500));
        let scan = env.scan_fn();
        env.core.tick("2026-09-30", t0 + Duration::from_millis(1100), &scan);
        assert_eq!(env.core.footprints_for(&note), vec![block("第一段", 3), block("第二段", 5)]);
    }

    #[test]
    fn daily_dir_and_non_notes_are_filtered() {
        let env = Env::new(&[(NOTE_REL, "基线")]);
        env.init("2026-09-30");
        let t0 = Instant::now();
        let scan = env.scan_fn();

        env.core.note_dirty(
            &[&env.abs("Daily/2026-09-30.md"), &env.abs("x.png"), &env.abs("Daily/sub/a.md")],
            t0,
        );
        env.core.tick("2026-09-30", t0 + Duration::from_secs(2), &scan);
        assert!(env.core.today_entries().is_empty());
    }

    #[test]
    fn deleted_file_is_removed_from_index() {
        let env = Env::new(&[(NOTE_REL, "基线段落")]);
        env.init("2026-09-30");
        let note = env.abs(NOTE_REL);
        let t0 = Instant::now();

        env.write(NOTE_REL, "基线段落\n\n新段");
        env.core.note_dirty(&[&note], t0);
        let scan = env.scan_fn();
        env.core.tick("2026-09-30", t0 + Duration::from_millis(1100), &scan);
        assert_eq!(env.core.footprints_for(&note).len(), 1);

        env.remove(NOTE_REL);
        env.core.note_dirty(&[&note], t0 + Duration::from_secs(2));
        let scan = env.scan_fn();
        env.core.tick("2026-09-30", t0 + Duration::from_secs(3), &scan);
        assert!(env.core.footprints_for(&note).is_empty());
    }

    #[test]
    fn dirty_refresh_uses_the_baseline_consistently() {
        let env = Env::new(&[(NOTE_REL, "基线\n\n昨天写下的段")]);
        env.set_v1_meta("2026-09-29", &[(NOTE_REL, "基线\n\n昨天写下的段")]);
        env.init("2026-09-29"); // day=09-29, baseline as stored
        let note = env.abs(NOTE_REL);
        let t0 = Instant::now();

        env.write(NOTE_REL, "基线\n\n昨天写下的段\n\n今天写的段");
        env.core.note_dirty(&[&note], t0);
        let scan = env.scan_fn();
        env.core.tick("2026-09-29", t0 + Duration::from_millis(1100), &scan);
        // From the 09-29 baseline's view: 「昨天写下的段」 is known, not new.
        assert_eq!(env.core.footprints_for(&note), vec![block("今天写的段", 5)]);
    }

    // ---- FootprintCore 全量兜底(refreshAll) (store.test.ts)

    #[test]
    fn refresh_all_rebuilds_index_for_offline_changes() {
        let env = Env::new(&[(NOTE_REL, "基线段落")]);
        env.init("2026-09-30");
        let note = env.abs(NOTE_REL);
        let other = env.abs(OTHER_REL);
        let t0 = Instant::now();

        // Changes made while the app was down: disk changes, no watcher event.
        env.write(NOTE_REL, "基线段落\n\n离线写的新段");
        env.write(OTHER_REL, "另一篇今天改的");
        let scan = env.scan_fn();
        env.core.refresh_all("2026-09-30", true, t0, &scan);
        assert_eq!(env.core.footprints_for(&note), vec![block("离线写的新段", 3)]);
        assert_eq!(env.core.footprints_for(&other), vec![block("另一篇今天改的", 1)]);
    }

    #[test]
    fn refresh_all_is_throttled_within_5s() {
        let env = Env::new(&[(NOTE_REL, "基线段落")]);
        env.init("2026-09-30");
        let note = env.abs(NOTE_REL);
        let t0 = Instant::now();
        let scan = env.scan_fn();
        env.core.refresh_all("2026-09-30", false, t0, &scan);

        env.write(NOTE_REL, "基线段落\n\n新段");
        let scan = env.scan_fn();
        env.core.refresh_all("2026-09-30", false, t0 + Duration::from_millis(100), &scan); // swallowed by throttle
        assert!(env.core.footprints_for(&note).is_empty());

        let scan = env.scan_fn();
        env.core.refresh_all("2026-09-30", false, t0 + Duration::from_millis(5001), &scan);
        assert_eq!(env.core.footprints_for(&note), vec![block("新段", 3)]);
    }

    // ---- FootprintCore × 待办排除:端到端 (store.test.ts)

    #[test]
    fn pure_todo_file_leaves_no_footprints_mixed_file_keeps_non_todo_blocks() {
        let env = Env::new(&[(
            NOTE_REL,
            "- [ ] 纯待办甲\n- [x] 纯待办乙\n\n普通段落\n\n- 普通列表项",
        )]);
        env.set_v1_meta("2026-09-30", &[]);
        env.init("2026-09-30");
        let scan = env.scan_fn();
        env.core.refresh_all("2026-09-30", true, Instant::now(), &scan);
        assert_eq!(
            env.core.today_entries(),
            vec![FootprintEntry {
                path: env.abs(NOTE_REL),
                blocks: vec![block("普通段落", 4), block("- 普通列表项", 6)],
            }]
        );
    }

    // ---- FootprintCore 历史档 (store.test.ts)

    #[test]
    fn cross_day_rotation_freezes_old_day_archive_today_starts_empty() {
        let env = Env::new(&[(NOTE_REL, "基线段落")]);
        env.set_v1_meta("2026-09-29", &[(NOTE_REL, "基线段落")]);
        // Disk state at rotation time (09-29's new content still on disk).
        env.write(NOTE_REL, "基线段落\n\n09-29 写的段");
        env.write(OTHER_REL, "09-29 也写了");
        let scan = env.scan_fn();
        env.core.init("2026-09-30", &scan);

        // 09-29's footprints are frozen; today (09-30) starts from zero.
        assert_eq!(
            env.core.entries_for("2026-09-29"),
            vec![
                FootprintEntry {
                    path: env.abs(NOTE_REL),
                    blocks: vec![block("09-29 写的段", 3)],
                },
                FootprintEntry {
                    path: env.abs(OTHER_REL),
                    blocks: vec![block("09-29 也写了", 1)],
                },
            ]
        );
        assert!(env.core.entries_for("2026-09-30").is_empty());
        env.core.flush_persist();
        let persisted: serde_json::Value = serde_json::from_str(&env.meta_raw()).unwrap();
        assert_eq!(persisted["version"], 2);
        assert_eq!(
            persisted["history"]["2026-09-29"][env.abs(NOTE_REL)],
            serde_json::json!([{ "text": "09-29 写的段", "start": 3, "end": 3 }])
        );
    }

    #[test]
    fn archive_is_frozen_after_rotation_disk_changes_do_not_rewrite_it() {
        let env = Env::new(&[(NOTE_REL, "基线段落\n\n09-29 写的段")]);
        env.set_v1_meta("2026-09-29", &[(NOTE_REL, "基线段落")]);
        let scan = env.scan_fn();
        env.core.init("2026-09-30", &scan);
        let note = env.abs(NOTE_REL);
        let t0 = Instant::now();

        env.write(NOTE_REL, "基线段落\n\n09-29 写的段\n\n09-30 写的段");
        env.core.note_dirty(&[&note], t0);
        let scan = env.scan_fn();
        env.core.tick("2026-09-30", t0 + Duration::from_millis(1100), &scan);
        assert_eq!(
            env.core.entries_for("2026-09-29"),
            vec![FootprintEntry { path: note.clone(), blocks: vec![block("09-29 写的段", 3)] }]
        );
        assert_eq!(
            env.core.entries_for("2026-09-30"),
            vec![FootprintEntry { path: note, blocks: vec![block("09-30 写的段", 5)] }]
        );
    }

    #[test]
    fn todo_exclusion_applies_to_archive_empty_day_no_entries() {
        let env = Env::new(&[(NOTE_REL, "基线\n\n- [ ] 纯待办不进档案")]);
        env.set_v1_meta("2026-09-29", &[(NOTE_REL, "基线")]);
        let scan = env.scan_fn();
        env.core.init("2026-09-30", &scan);
        assert!(env.core.entries_for("2026-09-29").is_empty());
        env.core.flush_persist();
        let persisted: serde_json::Value = serde_json::from_str(&env.meta_raw()).unwrap();
        assert_eq!(persisted["history"]["2026-09-29"].as_object().unwrap().len(), 0);
    }

    #[test]
    fn multi_day_absence_gives_last_active_day_everything_middle_days_missing() {
        let env = Env::new(&[(NOTE_REL, "基线\n\n几天间写的段")]);
        env.set_v1_meta("2026-09-27", &[(NOTE_REL, "基线")]);
        let scan = env.scan_fn();
        env.core.init("2026-09-30", &scan);
        assert_eq!(
            env.core.entries_for("2026-09-27"),
            vec![FootprintEntry {
                path: env.abs(NOTE_REL),
                blocks: vec![block("几天间写的段", 3)],
            }]
        );
        assert!(env.core.entries_for("2026-09-28").is_empty());
        assert!(env.core.entries_for("2026-09-29").is_empty());
    }

    #[test]
    fn ensure_day_is_idempotent_within_a_day() {
        let env = Env::new(&[(NOTE_REL, "基线\n\n昨天的段")]);
        env.set_v1_meta("2026-09-29", &[(NOTE_REL, "基线")]);
        let scan = env.scan_fn();
        env.core.init("2026-09-30", &scan);
        let first = env.core.entries_for("2026-09-29");
        env.core.ensure_day("2026-09-30", &scan);
        env.core.ensure_day("2026-09-30", &scan);
        assert_eq!(env.core.entries_for("2026-09-29"), first);
        assert_eq!(env.core.baseline_day().as_deref(), Some("2026-09-30"));
    }

    #[test]
    fn unrotated_core_reads_the_live_index_for_any_day() {
        // store.test.ts "未轮转的 core(day 为空串)任何日期都走实时索引"
        let env = Env::new(&[]); // init NOT called: day = ""
        let note = env.abs(NOTE_REL);
        env.core
            .install_index_for_test(BTreeMap::from([(note.clone(), vec![block("注入块", 1)])]));
        assert_eq!(
            env.core.entries_for("2099-01-01"),
            vec![FootprintEntry { path: note, blocks: vec![block("注入块", 1)] }]
        );
    }

    // ---- revision (store.test.ts installIndexForTest 的版本号断言)

    #[test]
    fn revision_bumps_on_content_changes_only() {
        let env = Env::new(&[(NOTE_REL, "基线")]);
        env.init("2026-09-30");
        let before = env.core.revision();

        let t0 = Instant::now();
        let scan = env.scan_fn();
        env.core.tick("2026-09-30", t0, &scan); // no-op tick must not bump
        assert_eq!(env.core.revision(), before);

        env.write(NOTE_REL, "基线\n\n新段");
        env.core.note_dirty(&[&env.abs(NOTE_REL)], t0);
        let scan = env.scan_fn();
        env.core.tick("2026-09-30", t0 + Duration::from_secs(2), &scan);
        assert!(env.core.revision() > before);
    }
}
