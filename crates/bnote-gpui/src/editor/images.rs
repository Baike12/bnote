//! Image loading for the live preview: resolve → read → decode, all of it on
//! the background executor, plus the cache the UI thread reads back.
//!
//! The engine's seam fixes the shape of this module: a widget span carries an
//! **explicit pixel width** and there is no "measure later" channel
//! (gpui-kit `base/src/input/base/preview.rs`), so a span is emitted only
//! when the display size is already in the cache. A miss keeps the source
//! text visible and starts a load; when the result lands the host re-scans
//! and the next frame emits the widget (see `PreviewHost`).
//!
//! Division of labor:
//!
//! * [`ImageStore`] — pure bookkeeping, UI thread. It resolves a reference to
//!   candidate paths ([`bnote_core::images`], no filesystem), decides
//!   hit/miss, and hands out [`LoadRequest`]s.
//! * [`load`] — blocking filesystem + decode work, background executor only.
//!   It reports the file identity (size + mtime) it read, which is what the
//!   cache is keyed by, so an edited or re-exported file is decoded again.
//! * [`ImageStore::finish`] — installs a result only when the entry it
//!   describes is still the current one (the key is present and its
//!   generation still matches); a stale result is dropped, never written.
//!   This is the ownership rule from AGENTS.md: one writer per state, and
//!   every async callback proves it still belongs to the current state.
//!
//! Failures are terminal for the file version they describe: a missing file
//! or a decode error leaves the source text in place and does not retry —
//! only the vault watcher (a change on disk) makes the entry loadable again.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use bnote_core::images::{self as core_images, FileId};
use gpui::{Pixels, RenderImage, Size, px, size};
use image::{Frame, ImageBuffer, Rgba};

/// How many decoded images stay cached (LRU). A note rarely shows more than a
/// handful at once; the cap is what keeps a long scroll through a media-heavy
/// vault from accumulating bitmaps forever.
const CACHE_CAP: usize = 32;

/// How many loads may be in flight at once. The rest of the references stay
/// un-requested and are picked up by later scans (each finished load triggers
/// one), so a document with a hundred images decodes them in waves instead of
/// allocating a hundred decodes at once.
const INFLIGHT_CAP: usize = 8;

/// A reference as the note spells it, plus the directory it resolves against
/// (the same `Images/a.png` in two notes can be two different files).
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct ImageKey {
    doc_dir: Option<PathBuf>,
    src: String,
}

/// One unit of background work: the key to report back under, the generation
/// captured at spawn time, and the paths to try in order.
pub struct LoadRequest {
    key: ImageKey,
    generation: u64,
    candidates: Vec<PathBuf>,
}

/// A decoded image plus where it came from.
pub struct LoadedImage {
    pub path: PathBuf,
    pub id: FileId,
    pub image: Arc<RenderImage>,
    /// The decoded bitmap's pixel size.
    pub size: Size<Pixels>,
}

/// The result of [`load`], handed back to [`ImageStore::finish`].
pub struct LoadOutcome {
    key: ImageKey,
    generation: u64,
    result: Result<LoadedImage, String>,
}

enum Entry {
    /// A load is in flight; the generation proves it is still the current one.
    Loading {
        generation: u64,
        candidates: Vec<PathBuf>,
    },
    Ready {
        path: PathBuf,
        /// The file version this bitmap was decoded from; two entries with
        /// the same `path` + `id` describe the same bytes.
        id: FileId,
        image: Arc<RenderImage>,
        intrinsic: Size<Pixels>,
        used: u64,
    },
    /// Missing file or a decode error: the source text stays, no retry.
    Failed {
        used: u64,
    },
}

impl Entry {
    fn used(&self) -> u64 {
        match self {
            Entry::Loading { .. } => u64::MAX,
            Entry::Ready { used, .. } | Entry::Failed { used } => *used,
        }
    }

    #[cfg(test)]
    fn path(&self) -> Option<&Path> {
        match self {
            Entry::Ready { path, .. } => Some(path),
            _ => None,
        }
    }
}

/// The image cache and request bookkeeping. Lives on the UI thread inside
/// [`super::preview::PreviewHost`]; every filesystem call happens in [`load`].
pub struct ImageStore {
    vault_root: RefCell<PathBuf>,
    doc_dir: RefCell<Option<PathBuf>>,
    assets: RefCell<Vec<String>>,
    entries: RefCell<HashMap<ImageKey, Entry>>,
    pending: RefCell<Vec<LoadRequest>>,
    generation: Cell<u64>,
    tick: Cell<u64>,
    cap: usize,
    inflight_cap: usize,
}

impl Default for ImageStore {
    fn default() -> Self {
        Self::new()
    }
}

impl ImageStore {
    pub fn new() -> Self {
        Self::with_caps(CACHE_CAP, INFLIGHT_CAP)
    }

    pub fn with_caps(cap: usize, inflight_cap: usize) -> Self {
        Self {
            vault_root: RefCell::new(PathBuf::new()),
            doc_dir: RefCell::new(None),
            assets: RefCell::new(Vec::new()),
            entries: RefCell::new(HashMap::new()),
            pending: RefCell::new(Vec::new()),
            generation: Cell::new(0),
            tick: Cell::new(0),
            cap,
            inflight_cap,
        }
    }

    pub fn set_vault_root(&self, root: PathBuf) {
        *self.vault_root.borrow_mut() = root;
    }

    pub fn set_doc_dir(&self, dir: Option<PathBuf>) {
        *self.doc_dir.borrow_mut() = dir;
    }

    /// Replaces the vault's media index; `true` when it actually changed (the
    /// caller then re-scans, since by-name references may resolve elsewhere).
    pub fn set_assets(&self, assets: Vec<String>) -> bool {
        let mut current = self.assets.borrow_mut();
        if *current == assets {
            return false;
        }
        *current = assets;
        true
    }

    /// The width `src` reserves in a text column `column` pixels wide, when
    /// the image is decoded. `None` while the load is in flight or after a
    /// failure — the caller keeps the source text.
    ///
    /// A miss records a [`LoadRequest`] (drained by [`Self::take_pending`]);
    /// a hit never touches the filesystem.
    pub fn hit(&self, src: &str, column: Pixels) -> Option<Pixels> {
        let key = self.key_for(src);
        let mut entries = self.entries.borrow_mut();
        match entries.get_mut(&key) {
            Some(Entry::Ready {
                intrinsic, used, ..
            }) => {
                let used_now = self.bump();
                *used = used_now;
                Some(px(core_images::fit_width(
                    intrinsic.width.as_f32(),
                    column.as_f32(),
                )))
            }
            Some(_) => None,
            None => {
                drop(entries);
                self.request(key);
                None
            }
        }
    }

    /// The image and the height it takes when laid out `width` wide. Read
    /// during render, so it never creates work; a vanished entry (evicted
    /// between the scan and the paint) just falls back to the source text.
    pub fn image_at(&self, src: &str, width: Pixels) -> Option<(Arc<RenderImage>, Pixels)> {
        let key = self.key_for(src);
        let mut entries = self.entries.borrow_mut();
        let Some(Entry::Ready {
            image,
            intrinsic,
            used,
            ..
        }) = entries.get_mut(&key)
        else {
            return None;
        };
        *used = self.bump();
        let ratio = intrinsic.height.as_f32() / intrinsic.width.as_f32();
        Some((image.clone(), width * ratio))
    }

    /// Loads the last scan asked for; the caller spawns each one on the
    /// background executor.
    pub fn take_pending(&self) -> Vec<LoadRequest> {
        std::mem::take(&mut *self.pending.borrow_mut())
    }

    /// Installs a finished load. Returns `true` when the cache now holds a
    /// decoded image (the caller re-scans so the widget can be emitted);
    /// `false` covers both a stale result and a failure, neither of which
    /// changes what the preview shows.
    pub fn finish(&self, outcome: LoadOutcome) -> bool {
        let load_ready = outcome.result.is_ok();
        {
            let entries = self.entries.borrow();
            match entries.get(&outcome.key) {
                // The entry moved on (invalidated by the watcher, cleared, or
                // re-requested) while the load was in flight: this result
                // describes a state that is no longer the current one.
                Some(Entry::Loading { generation, .. }) if *generation == outcome.generation => {}
                _ => return false,
            }
        }
        let used = self.bump();
        let entry = match outcome.result {
            Ok(loaded) => {
                // The same file version may already be decoded under another
                // reference (`![[x.png]]` in two notes, `![](x.png)` next to
                // it): the identity is what proves it is the same bytes, and
                // sharing the bitmap keeps one copy.
                let shared = self
                    .entries
                    .borrow()
                    .values()
                    .find_map(|entry| match entry {
                        Entry::Ready { path, id, image, .. }
                            if *path == loaded.path && *id == loaded.id =>
                        {
                            Some(image.clone())
                        }
                        _ => None,
                    });
                Entry::Ready {
                    path: loaded.path,
                    id: loaded.id,
                    image: shared.unwrap_or(loaded.image),
                    intrinsic: loaded.size,
                    used,
                }
            }
            Err(_) => Entry::Failed { used },
        };
        self.entries.borrow_mut().insert(outcome.key, entry);
        self.evict();
        load_ready
    }

    /// Drops every entry that names `abs` (a changed file on disk). Returns
    /// true when something was dropped. The next scan re-requests it.
    pub fn invalidate_path(&self, abs: &Path) -> bool {
        let mut entries = self.entries.borrow_mut();
        let before = entries.len();
        entries.retain(|_, entry| match entry {
            Entry::Ready { path, .. } => path != abs,
            // The resolved path is not known until the load reports back; a
            // candidate that matches is close enough to drop the in-flight
            // load, whose result would have been read from the old file.
            Entry::Loading { candidates, .. } => !candidates.iter().any(|c| c == abs),
            Entry::Failed { .. } => true,
        });
        before != entries.len()
    }

    pub fn clear(&self) {
        self.entries.borrow_mut().clear();
        self.pending.borrow_mut().clear();
        self.generation.set(self.generation.get() + 1);
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.borrow().len()
    }

    #[cfg(test)]
    pub fn is_failed(&self, src: &str) -> bool {
        matches!(
            self.entries.borrow().get(&self.key_for(src)),
            Some(Entry::Failed { .. })
        )
    }

    #[cfg(test)]
    pub fn has_pending(&self) -> bool {
        !self.pending.borrow().is_empty()
    }

    #[cfg(test)]
    pub fn resolved_path(&self, src: &str) -> Option<PathBuf> {
        self.entries
            .borrow()
            .get(&self.key_for(src))
            .and_then(|entry| entry.path().map(Path::to_path_buf))
    }

    #[cfg(test)]
    fn candidate_paths(&self, src: &str) -> Vec<PathBuf> {
        core_images::resolve_candidates(
            src,
            self.doc_dir.borrow().as_deref(),
            &self.vault_root.borrow(),
            &self.assets.borrow(),
        )
    }

    fn key_for(&self, src: &str) -> ImageKey {
        ImageKey {
            doc_dir: self.doc_dir.borrow().clone(),
            src: src.to_string(),
        }
    }

    fn bump(&self) -> u64 {
        let tick = self.tick.get() + 1;
        self.tick.set(tick);
        tick
    }

    /// Marks `key` as loading and queues its request, unless the in-flight
    /// budget is spent (the reference is picked up by a later scan) or there
    /// is nothing local to try (a remote URL, a drawing with no export) — the
    /// latter is a permanent failure for this reference, recorded so it is
    /// not re-resolved on every frame.
    fn request(&self, key: ImageKey) {
        if self.pending.borrow().len() >= self.inflight_cap {
            return;
        }
        let candidates = core_images::resolve_candidates(
            &key.src,
            self.doc_dir.borrow().as_deref(),
            &self.vault_root.borrow(),
            &self.assets.borrow(),
        );
        if candidates.is_empty() {
            let used = self.bump();
            self.entries
                .borrow_mut()
                .insert(key, Entry::Failed { used });
            return;
        }
        let generation = self.generation.get() + 1;
        self.generation.set(generation);
        self.entries.borrow_mut().insert(
            key.clone(),
            Entry::Loading {
                generation,
                candidates: candidates.clone(),
            },
        );
        self.pending.borrow_mut().push(LoadRequest {
            key,
            generation,
            candidates,
        });
        self.evict();
    }

    /// Keeps the cache bounded: the least recently used entry goes first, and
    /// an in-flight load is never evicted (it has no bitmap to free yet).
    fn evict(&self) {
        loop {
            let mut entries = self.entries.borrow_mut();
            if entries.len() <= self.cap {
                return;
            }
            let victim = entries
                .iter()
                .filter(|(_, entry)| !matches!(entry, Entry::Loading { .. }))
                .min_by_key(|(_, entry)| entry.used())
                .map(|(key, _)| key.clone());
            match victim {
                Some(key) => {
                    entries.remove(&key);
                }
                None => return,
            }
        }
    }
}

/// Resolves, reads and decodes one reference. **Blocking** — the caller runs
/// it on the background executor.
///
/// Candidates are tried in order (note directory, vault root, by name), the
/// first one that reads and decodes wins.
pub fn load(request: &LoadRequest) -> LoadOutcome {
    let mut last_error = "没有找到图片文件".to_string();
    for candidate in &request.candidates {
        let Ok(meta) = std::fs::metadata(candidate) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let id = FileId::of(&meta);
        let Ok(bytes) = std::fs::read(candidate) else {
            continue;
        };
        match decode(&bytes) {
            Ok((image, size)) => {
                return LoadOutcome {
                    key: request.key.clone(),
                    generation: request.generation,
                    result: Ok(LoadedImage {
                        path: candidate.clone(),
                        id,
                        image,
                        size,
                    }),
                };
            }
            Err(error) => last_error = error,
        }
    }
    LoadOutcome {
        key: request.key.clone(),
        generation: request.generation,
        result: Err(last_error),
    }
}

/// PNG/JPEG/GIF/WebP/BMP/TIFF/ICO bytes → a `RenderImage`.
///
/// gpui paints `RenderImage` in BGRA and the `image` crate decodes to RGBA, so
/// the channels swap — exactly what gpui's own asset loader does
/// (gpui-pre `src/elements/img.rs`, GIF/WebP arms). SVG is not an `image`
/// format: those references fail to decode and keep their source text.
pub fn decode(bytes: &[u8]) -> Result<(Arc<RenderImage>, Size<Pixels>), String> {
    let decoded = image::load_from_memory(bytes).map_err(|error| error.to_string())?;
    let rgba = decoded.to_rgba8();
    let (width, height) = rgba.dimensions();
    if width == 0 || height == 0 {
        return Err("图片尺寸为 0".to_string());
    }
    let mut raw = rgba.into_raw();
    for pixel in raw.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    let buffer = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(width, height, raw)
        .ok_or_else(|| "图片缓冲不合法".to_string())?;
    // One frame: static formats only (an animated GIF/WebP shows its first
    // frame; gpui's own loader is the one that plays frames).
    let image = RenderImage::new(vec![Frame::new(buffer)]);
    Ok((
        Arc::new(image),
        size(px(width as f32), px(height as f32)),
    ))
}

#[cfg(test)]
mod tests {
    use gpui::DevicePixels;

    use super::*;

    /// Writes a real PNG (solid colour) and returns its path.
    fn write_png(dir: &Path, name: &str, width: u32, height: u32) -> PathBuf {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        image::RgbaImage::from_pixel(width, height, Rgba([180, 40, 60, 255]))
            .save(&path)
            .unwrap();
        path
    }

    /// A store over `root` with `root/Notes` as the open note's directory.
    fn store(root: &Path) -> ImageStore {
        let store = ImageStore::new();
        store.set_vault_root(root.to_path_buf());
        store.set_doc_dir(Some(root.join("Notes")));
        store
    }

    /// Runs one queued request through the real loader, like the workspace does.
    fn run_one(store: &ImageStore) -> bool {
        let mut pending = store.take_pending();
        assert_eq!(pending.len(), 1, "one request expected");
        let outcome = load(&pending.remove(0));
        store.finish(outcome)
    }

    #[test]
    fn a_miss_requests_a_load_and_the_hit_is_synchronous() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_png(root, "Notes/pic.png", 2, 2);
        let store = store(root);

        // Miss: nothing to reserve yet, but the work is queued.
        assert!(store.hit("pic.png", px(700.)).is_none());
        assert!(store.has_pending());

        // The real loader reads + decodes the fixture; the display size is
        // then known and the width is the fit computation's.
        assert!(run_one(&store));
        let width = store.hit("pic.png", px(700.)).expect("decoded image");
        assert_eq!(width, px(core_images::fit_width(2., 700.)));
        assert_eq!(width, px(420.), "a 2px figure is scaled up to 420");
        let (_, height) = store.image_at("pic.png", width).unwrap();
        assert_eq!(height, width, "2×2 keeps its ratio");

        // A hit is synchronous and creates no further work.
        assert!(store.hit("pic.png", px(700.)).is_some());
        assert!(!store.has_pending());
        assert_eq!(store.resolved_path("pic.png"), Some(root.join("Notes/pic.png")));

        // A narrow column scales the same image down instead.
        let narrow = store.hit("pic.png", px(300.)).unwrap();
        assert_eq!(narrow, px(300.));
        let (_, height) = store.image_at("pic.png", narrow).unwrap();
        assert_eq!(height, px(300.));
        // The render path never queues work, even for an unknown reference.
        assert!(store.image_at("never-asked.png", px(100.)).is_none());
        assert!(!store.has_pending());
    }

    #[test]
    fn a_missing_file_fails_once_and_is_not_retried() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());

        assert!(store.hit("nope.png", px(700.)).is_none());
        assert!(!run_one(&store), "a failure changes nothing on screen");
        assert!(store.is_failed("nope.png"));
        // No retry while scrolling or typing: the entry answers every miss.
        assert!(store.hit("nope.png", px(700.)).is_none());
        assert!(!store.has_pending());
    }

    #[test]
    fn an_undecodable_file_fails_and_keeps_the_source() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // A note exported as an image, or an SVG: not an `image` format.
        std::fs::create_dir_all(root.join("Notes")).unwrap();
        std::fs::write(root.join("Notes/notes.png"), b"<svg>not a bitmap</svg>").unwrap();
        let store = store(root);
        assert!(store.hit("notes.png", px(700.)).is_none());
        assert!(!run_one(&store));
        assert!(store.is_failed("notes.png"));
    }

    #[test]
    fn an_edited_file_is_decoded_again() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let path = write_png(root, "Notes/pic.png", 4, 2);
        let store = store(root);
        assert!(store.hit("pic.png", px(700.)).is_none());
        assert!(run_one(&store));
        let first = store.hit("pic.png", px(700.)).unwrap();
        let (_, height) = store.image_at("pic.png", first).unwrap();
        assert_eq!(height, first / 2., "4×2 keeps its ratio");

        // The watcher reports the file changed on disk: the entry goes, the
        // next scan re-loads — and the new version's size is what is served.
        assert!(store.invalidate_path(&path));
        write_png(root, "Notes/pic.png", 4, 4);
        assert!(store.hit("pic.png", px(700.)).is_none());
        assert!(run_one(&store));
        let second = store.hit("pic.png", px(700.)).unwrap();
        let (_, height) = store.image_at("pic.png", second).unwrap();
        assert_eq!(height, second, "4×4 is square");
        // Invalidating an unknown path is a no-op.
        assert!(!store.invalidate_path(Path::new("/nope/none.png")));
    }

    #[test]
    fn two_references_to_one_file_share_the_bitmap() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // At the vault root, so both notes' references land on the same file.
        write_png(root, "pic.png", 2, 2);
        let store = store(root);

        // Note A refers to it; `Notes/pic.png` does not exist, so the vault
        // root wins and the entry records the file it actually read.
        assert!(store.hit("pic.png", px(700.)).is_none());
        assert!(run_one(&store));
        // The same file referred from another note: a different key, the same
        // path + identity — the bitmap is shared, not decoded twice.
        store.set_doc_dir(Some(root.join("Daily")));
        assert!(store.hit("pic.png", px(700.)).is_none());
        assert!(run_one(&store));

        store.set_doc_dir(Some(root.join("Notes")));
        let (first, _) = store.image_at("pic.png", px(100.)).unwrap();
        store.set_doc_dir(Some(root.join("Daily")));
        let (second, _) = store.image_at("pic.png", px(100.)).unwrap();
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn a_stale_result_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let path = write_png(root, "Notes/pic.png", 2, 2);
        let store = store(root);

        assert!(store.hit("pic.png", px(700.)).is_none());
        let mut pending = store.take_pending();
        let request = pending.remove(0);
        // The file changes (or the vault is switched) while the load runs.
        assert!(store.invalidate_path(&path));

        let outcome = load(&request);
        assert!(!store.finish(outcome), "the entry it describes is gone");
        assert!(store.hit("pic.png", px(700.)).is_none());
        assert!(store.has_pending(), "and the reference is queued again");
    }

    #[test]
    fn the_cache_is_bounded_and_evicts_the_least_recently_used() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let store = ImageStore::with_caps(2, 8);
        store.set_vault_root(root.to_path_buf());
        store.set_doc_dir(Some(root.join("Notes")));
        for name in ["a.png", "b.png", "c.png"] {
            write_png(root, &format!("Notes/{name}"), 2, 2);
        }

        for name in ["a.png", "b.png"] {
            assert!(store.hit(name, px(700.)).is_none());
            assert!(run_one(&store));
        }
        // Touch `a` so `b` is the least recently used one.
        assert!(store.hit("a.png", px(700.)).is_some());
        assert!(store.hit("c.png", px(700.)).is_none());
        assert!(run_one(&store));

        assert_eq!(store.len(), 2);
        assert!(store.resolved_path("c.png").is_some());
        assert!(store.resolved_path("a.png").is_some());
        assert!(store.resolved_path("b.png").is_none(), "b was evicted");
        // The evicted entry simply loads again.
        assert!(store.hit("b.png", px(700.)).is_none());
        assert!(store.has_pending());
    }

    #[test]
    fn new_references_are_not_queued_beyond_the_inflight_budget() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let store = ImageStore::with_caps(8, 2);
        store.set_vault_root(root.to_path_buf());
        store.set_doc_dir(Some(root.join("Notes")));
        for name in ["a.png", "b.png", "c.png"] {
            write_png(root, &format!("Notes/{name}"), 2, 2);
            assert!(store.hit(name, px(700.)).is_none());
        }
        assert_eq!(store.take_pending().len(), 2, "budget spent on two loads");
        // The third reference is picked up by a later scan.
        assert!(store.hit("c.png", px(700.)).is_none());
        assert!(store.has_pending());
    }

    #[test]
    fn remote_urls_and_empty_sources_fail_without_reading() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        for src in ["https://example.com/a.png", "data:image/png;base64,AA", ""] {
            assert!(store.hit(src, px(700.)).is_none());
            assert!(!store.has_pending(), "{src} has no local reader");
            assert!(store.is_failed(src));
        }
    }

    #[test]
    fn the_asset_index_resolves_a_bare_name_to_the_shortest_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let short = write_png(root, "Pasted image 1.png", 2, 2);
        write_png(root, "Daily/Pasted image 1.png", 2, 2);
        let store = store(root);
        assert!(store.set_assets(vec![
            "Daily/Pasted image 1.png".to_string(),
            "Pasted image 1.png".to_string(),
        ]));

        assert!(store.hit("Pasted image 1.png", px(700.)).is_none());
        // Two index entries end in that name; the shortest wins (Obsidian's
        // "shortest path" rule), and it is already in the list, so the
        // by-name search adds nothing.
        assert_eq!(
            store.candidate_paths("Pasted image 1.png"),
            vec![
                root.join("Notes/Pasted image 1.png"),
                root.join("Pasted image 1.png"),
            ]
        );
        assert!(run_one(&store));
        assert_eq!(store.resolved_path("Pasted image 1.png"), Some(short));
        // Re-setting the same list is not a change.
        assert!(!store.set_assets(vec![
            "Daily/Pasted image 1.png".to_string(),
            "Pasted image 1.png".to_string(),
        ]));
    }

    #[test]
    fn a_drawing_embed_renders_the_exported_png() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let png = write_png(root, "Excalidraw/画图.png", 2, 2);
        std::fs::write(root.join("Excalidraw/画图.excalidraw"), b"{}").unwrap();
        let store = store(root);
        store.set_assets(vec![
            "Excalidraw/画图.excalidraw".to_string(),
            "Excalidraw/画图.png".to_string(),
        ]);

        assert!(store.hit("Excalidraw/画图.excalidraw", px(700.)).is_none());
        assert!(run_one(&store));
        assert_eq!(store.resolved_path("Excalidraw/画图.excalidraw"), Some(png));
    }

    #[test]
    fn decode_reports_the_bitmap_size_and_swaps_to_bgra() {
        let png = write_png(
            &std::env::temp_dir(),
            &format!("bnote-decode-{}.png", std::process::id()),
            // A 3×1 image whose one opaque pixel is pure red in RGBA.
            3,
            1,
        );
        let bytes = std::fs::read(&png).unwrap();
        let _ = std::fs::remove_file(&png);
        let (image, size) = decode(&bytes).unwrap();
        assert_eq!(size, gpui::size(px(3.), px(1.)));
        assert_eq!(image.frame_count(), 1);
        assert_eq!(
            image.size(0),
            Size {
                width: DevicePixels(3),
                height: DevicePixels(1),
            }
        );
        let raw = image.as_bytes(0).unwrap();
        // The fixture's only opaque pixel is pure red in RGBA; the render
        // image's channels are swapped (BGR(A), as gpu paint expects).
        assert_eq!(&raw[0..4], &[60, 40, 180, 255]);
        assert!(decode(b"not an image").is_err());
        assert!(decode(&[]).is_err());
    }
}
