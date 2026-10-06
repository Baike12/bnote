//! Persistent store for cross-file todo links. Port of
//! `bnote/src/daily/links.ts` — the data model, JSON (de)serialization with
//! the exact v1 on-disk shape the Tauri/TS shell writes (camelCase fields,
//! 2-space pretty print), and the lookup/normalize logic. The module-level
//! singleton, 300ms debounce and listener broadcast of the TS version are
//! shell concerns: the GPUI shell owns caching/timing and calls
//! [`load_links`]/[`save_links`] synchronously.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::model::links_file_path;

/// One link binds a source todo block (project note) to a daily entry. The
/// two sides recognize each other by the todo identity text (line content
/// minus checkbox/✅ stamp); line numbers are proximity hints only.
/// Port of `daily/links.ts::DailyLink`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyLink {
    pub id: String,
    /// copied = sent via shortcut; recorded = auto-logged on check-off;
    /// auto = existence itself aggregates (touch-to-sync).
    pub kind: LinkKind,
    /// Owning day (YYYY-MM-DD) at creation time.
    pub day: String,
    /// Absolute path of the source file (project note).
    pub src_path: String,
    /// Absolute path of the daily file.
    pub daily_path: String,
    /// Shared todo identity text (mirror keeps both sides equal).
    pub text: String,
    /// Source root line at last sync (proximity hint).
    pub src_line: usize,
    /// Daily entry start line at last sync (proximity hint).
    pub daily_line: usize,
}

/// Port of `daily/links.ts` `kind: "copied" | "recorded" | "auto"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    Copied,
    Recorded,
    Auto,
}

/// On-disk shape: `{ version: 1, links: [...] }`.
/// Port of `daily/links.ts::StoredLinks`.
#[derive(Debug, Serialize, Deserialize)]
struct StoredLinks {
    version: u32,
    links: Vec<DailyLink>,
}

/// In-memory link collection with insertion-order preservation (the TS uses
/// a `Map`, and the serialized file inherits that order).
#[derive(Debug, Default, Clone)]
pub struct LinkStore {
    links: Vec<DailyLink>,
    revision: u64,
}

impl LinkStore {
    pub fn new() -> LinkStore {
        LinkStore::default()
    }

    /// Parse a stored JSON dump. `None`, broken JSON, wrong version or a
    /// non-array `links` all yield an empty store (broken metadata never
    /// blocks the notebook — sync just rebuilds from zero). Links missing
    /// required fields are skipped (normalize guard of
    /// `daily/links.ts::LinkStore.fromJSON`).
    pub fn from_json(raw: Option<&str>) -> LinkStore {
        let mut store = LinkStore::new();
        let Some(raw) = raw else { return store };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw) else {
            return store;
        };
        if parsed.get("version").and_then(|v| v.as_i64()) != Some(1) {
            return store;
        }
        let Some(links) = parsed.get("links").and_then(|v| v.as_array()) else {
            return store;
        };
        for l in links {
            let Ok(link) = serde_json::from_value::<DailyLink>(l.clone()) else {
                continue;
            };
            store.upsert(link);
        }
        store.revision = 0;
        store
    }

    /// Serialize with the exact shape of the TS shell:
    /// `JSON.stringify({version: 1, links}, null, 2)`.
    pub fn to_json(&self) -> String {
        let data = StoredLinks { version: 1, links: self.links.clone() };
        serde_json::to_string_pretty(&data).unwrap_or_else(|_| "{\"version\":1,\"links\":[]}".into())
    }

    /// All links in insertion order. Port of `LinkStore.all`.
    pub fn all(&self) -> Vec<&DailyLink> {
        self.links.iter().collect()
    }

    pub fn get_by_id(&self, id: &str) -> Option<&DailyLink> {
        self.links.iter().find(|l| l.id == id)
    }

    /// Every link where `path` participates (source or daily side).
    /// Port of `LinkStore.forFile`.
    pub fn for_file(&self, path: &str) -> Vec<&DailyLink> {
        self.links.iter().filter(|l| l.src_path == path || l.daily_path == path).collect()
    }

    /// Find by identity text among links where `path` participates; ties go
    /// to the smallest line-hint distance. Port of `LinkStore.findByText`.
    pub fn find_by_text(&self, path: &str, text: &str, near_line: usize) -> Option<&DailyLink> {
        let mut best: Option<&DailyLink> = None;
        let mut best_dist = usize::MAX;
        for l in &self.links {
            if l.text != text {
                continue;
            }
            if l.src_path != path && l.daily_path != path {
                continue;
            }
            let dist = [
                (l.src_path == path).then(|| l.src_line.abs_diff(near_line)),
                (l.daily_path == path).then(|| l.daily_line.abs_diff(near_line)),
            ]
            .into_iter()
            .flatten()
            .min()
            .unwrap_or(usize::MAX);
            if dist < best_dist {
                best_dist = dist;
                best = Some(l);
            }
        }
        best
    }

    /// Insert or replace in place (existing id keeps its position, matching
    /// `Map.set`). Port of `LinkStore.upsert`.
    pub fn upsert(&mut self, link: DailyLink) {
        match self.links.iter_mut().find(|l| l.id == link.id) {
            Some(slot) => *slot = link,
            None => self.links.push(link),
        }
        self.revision += 1;
    }

    /// Patch a link in place; no-op when the id is unknown.
    /// Port of `LinkStore.update`.
    pub fn update(&mut self, id: &str, patch: impl FnOnce(&mut DailyLink)) {
        if let Some(l) = self.links.iter_mut().find(|l| l.id == id) {
            patch(l);
            self.revision += 1;
        }
    }

    /// Port of `LinkStore.remove`.
    pub fn remove(&mut self, id: &str) {
        if let Some(pos) = self.links.iter().position(|l| l.id == id) {
            self.links.remove(pos);
            self.revision += 1;
        }
    }

    /// Bumped on every mutation; UI layers use it to detect "something
    /// changed" (the TS broadcasts via listeners; here the shell polls or
    /// diffs). Port of `linksRevision` + `markLinksChanged`.
    pub fn revision(&self) -> u64 {
        self.revision
    }
}

/// Read `<vault>/.bnote/daily-links.json`; missing or broken metadata folds
/// into an empty store. Synchronous port of `links.ts::ensureLinks` (the
/// per-vault caching is the shell's job).
pub fn load_links(vault_root: &Path) -> LinkStore {
    let raw = std::fs::read_to_string(vault_root.join(".bnote").join("daily-links.json")).ok();
    LinkStore::from_json(raw.as_deref())
}

/// Write the store to `<vault>/.bnote/daily-links.json` (creating `.bnote/`
/// when missing), in the same byte shape the TS shell writes.
/// Synchronous port of `links.ts::writeNow`.
pub fn save_links(vault_root: &Path, store: &LinkStore) -> io::Result<()> {
    let path = PathBuf::from(links_file_path(&vault_root.to_string_lossy()));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, store.to_json())
}

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;

    fn link(id: &str, patch: impl FnOnce(&mut DailyLink)) -> DailyLink {
        let mut l = DailyLink {
            id: id.to_string(),
            kind: LinkKind::Copied,
            day: "2026-09-23".into(),
            src_path: "/vault/proj/a.md".into(),
            daily_path: "/vault/Daily/2026-09-23.md".into(),
            text: "任务甲".into(),
            src_line: 3,
            daily_line: 3,
        };
        patch(&mut l);
        l
    }

    // ---- LinkStore 序列化往返 (links.test.ts)

    #[test]
    fn upsert_tojson_fromjson_round_trip_keeps_all_fields() {
        let mut s = LinkStore::new();
        s.upsert(link("l1", |_| {}));
        s.upsert(link("l2", |l| {
            l.kind = LinkKind::Recorded;
            l.text = "任务乙".into();
        }));
        let back = LinkStore::from_json(Some(&s.to_json()));
        assert_eq!(back.all().len(), 2);
        let l2 = back.get_by_id("l2").unwrap();
        assert_eq!(l2.kind, LinkKind::Recorded);
        assert_eq!(l2.text, "任务乙");
        assert_eq!(l2.src_line, 3);
    }

    #[test]
    fn null_broken_json_wrong_version_all_yield_empty_store() {
        assert!(LinkStore::from_json(None).all().is_empty());
        assert!(LinkStore::from_json(Some("{broken")).all().is_empty());
        assert!(LinkStore::from_json(Some(r#"{"version":99,"links":[]}"#)).all().is_empty());
    }

    #[test]
    fn serialized_shape_is_byte_compatible_with_the_ts_shell() {
        let mut s = LinkStore::new();
        s.upsert(link("l1", |_| {}));
        assert_eq!(
            s.to_json(),
            format!(
                "{{\n  \"version\": 1,\n  \"links\": [\n    {{\n      \"id\": \"l1\",\n      \"kind\": \"copied\",\n      \"day\": \"2026-09-23\",\n      \"srcPath\": \"/vault/proj/a.md\",\n      \"dailyPath\": \"/vault/Daily/2026-09-23.md\",\n      \"text\": \"任务甲\",\n      \"srcLine\": 3,\n      \"dailyLine\": 3\n    }}\n  ]\n}}",
            )
        );
    }

    #[test]
    fn empty_store_serializes_like_ts_json_stringify() {
        assert_eq!(LinkStore::new().to_json(), "{\n  \"version\": 1,\n  \"links\": []\n}");
    }

    #[test]
    fn sample_ts_shell_output_stays_readable() {
        // A file exactly as the Tauri shell writes it must parse field-for-field.
        let raw = r#"{
  "version": 1,
  "links": [
    {
      "id": "l1",
      "kind": "recorded",
      "day": "2026-09-23",
      "srcPath": "/vault/proj/a.md",
      "dailyPath": "/vault/Daily/2026-09-23.md",
      "text": "任务甲",
      "srcLine": 7,
      "dailyLine": 9
    }
  ]
}"#;
        let s = LinkStore::from_json(Some(raw));
        let l = s.get_by_id("l1").unwrap();
        assert_eq!(l.kind, LinkKind::Recorded);
        assert_eq!(l.src_path, "/vault/proj/a.md");
        assert_eq!(l.daily_path, "/vault/Daily/2026-09-23.md");
        assert_eq!((l.src_line, l.daily_line), (7, 9));
    }

    // ---- forFile / findByText (links.test.ts)

    fn seeded() -> LinkStore {
        let mut s = LinkStore::new();
        s.upsert(link("a", |_| {}));
        s.upsert(link("b", |l| {
            l.src_path = "/vault/proj/b.md".into();
            l.text = "任务乙".into();
        }));
        s.upsert(link("c", |l| {
            l.src_path = "/vault/proj/c.md".into();
            l.daily_path = "/vault/Daily/2026-09-22.md".into();
            l.text = "昨天的".into();
        }));
        s
    }

    #[test]
    fn for_file_hits_source_side_or_daily_side() {
        let s = seeded();
        let a = s.for_file("/vault/proj/a.md").into_iter().map(|l| l.id.as_str()).collect::<Vec<_>>();
        assert_eq!(a, vec!["a"]);
        let mut daily = s
            .for_file("/vault/Daily/2026-09-23.md")
            .into_iter()
            .map(|l| l.id.as_str())
            .collect::<Vec<_>>();
        daily.sort_unstable();
        assert_eq!(daily, vec!["a", "b"]);
        assert!(s.for_file("/vault/none.md").is_empty());
    }

    #[test]
    fn find_by_text_requires_file_participation_and_prefers_near_hint() {
        let s = seeded();
        assert_eq!(s.find_by_text("/vault/proj/a.md", "任务甲", 10).unwrap().id, "a");
        assert_eq!(s.find_by_text("/vault/Daily/2026-09-23.md", "任务乙", 5).unwrap().id, "b");
        assert_eq!(s.find_by_text("/vault/proj/b.md", "任务甲", 3), None); // file not a party
        assert_eq!(s.find_by_text("/vault/proj/a.md", "不存在", 3), None);
    }

    #[test]
    fn update_and_remove() {
        let mut s = seeded();
        s.update("a", |l| {
            l.src_line = 9;
            l.text = "改名了".into();
        });
        let a = s.get_by_id("a").unwrap();
        assert_eq!((a.src_line, a.text.as_str()), (9, "改名了"));
        s.remove("a");
        assert_eq!(s.get_by_id("a"), None);
        // removing an unknown id leaves the store untouched
        let before = s.revision();
        s.remove("nope");
        s.update("nope", |_| {});
        assert_eq!(s.revision(), before);
    }

    // ---- 磁盘读写 (ensureLinks / writeNow 的同步端口)

    #[test]
    fn save_then_load_round_trips_through_a_tempdir_vault() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        assert!(load_links(vault).all().is_empty()); // missing file = empty store

        let mut s = LinkStore::new();
        s.upsert(link("l1", |_| {}));
        save_links(vault, &s).unwrap();
        // Same bytes the TS shell would have on disk
        let raw = std::fs::read_to_string(vault.join(".bnote").join("daily-links.json")).unwrap();
        assert!(raw.starts_with("{\n  \"version\": 1,"));
        let back = load_links(vault);
        assert_eq!(back.all().len(), 1);
        assert_eq!(back.get_by_id("l1").unwrap().text, "任务甲");
        assert_eq!(back.to_json(), s.to_json());
    }

    #[test]
    fn broken_file_on_disk_loads_as_empty_store() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        std::fs::create_dir_all(vault.join(".bnote")).unwrap();
        std::fs::write(vault.join(".bnote").join("daily-links.json"), "{oops").unwrap();
        assert!(load_links(vault).all().is_empty());
    }
}
