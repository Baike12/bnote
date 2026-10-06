//! Image references in markdown: where they point, and how big they draw.
//!
//! Mirrors the Tauri shell's resolution order (`imageCandidates` and
//! `drawingEmbedCandidates` in `src/editor/livePreview.ts`) so the same note
//! shows the same picture in both shells. Nothing here touches the
//! filesystem: a reference resolves to a *candidate list*, and the host's
//! loader walks it on the background executor (read + decode never run on the
//! UI thread — see the GPUI shell's `editor::images`).
//!
//! Three facts drive the candidate order, all inherited from the shell:
//!
//! 1. `![](…)` is relative to the note's own directory (the standard markdown
//!    reading, and what the PDF converter writes next to its `<stem>.md`);
//! 2. it is also relative to the vault root (Obsidian's reading of `![](…)`);
//! 3. `![[Pasted image 1.png]]` is found by bare file name anywhere in the
//!    vault — Obsidian stores attachments where it likes, so the assets index
//!    (`VaultIndex::assets`, already collected for the file tree) is the only
//!    way to find those. Same name in several places → shortest path wins,
//!    Obsidian's "shortest path" rule.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Width small figures are scaled up to when the column has room. Mirrors
/// `min-width: min(100%, 420px)` on `.cw-image img` (`src/styles/global.css`):
/// PDF-extracted figures are stored at page-point size (an 85×76 SVG would be
/// unreadable in a 700px column), and the shell deliberately enlarges them.
pub const MIN_DISPLAY_WIDTH: f32 = 420.;

/// The display width an image takes in a text column `column` pixels wide:
/// the intrinsic width, clamped to `[min(column, 420), column]`.
///
/// The result is always finite and `> 0`, so the live preview never reserves
/// a zero-width box for an image (the engine lays the widget out with this
/// exact width; see gpui-kit `PreviewSpan::widget`).
pub fn fit_width(intrinsic: f32, column: f32) -> f32 {
    let column = if column.is_finite() { column.max(1.) } else { MIN_DISPLAY_WIDTH };
    let floor = column.min(MIN_DISPLAY_WIDTH);
    if !intrinsic.is_finite() || intrinsic <= 0. {
        return column;
    }
    intrinsic.clamp(floor, column)
}

/// A file's identity for cache reuse: byte length + mtime. Two loads with the
/// same id saw the same bytes as far as the cache is concerned; anything else
/// (an edit, a re-export, a replacement) is a different file and must be
/// decoded again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileId {
    pub len: u64,
    /// Nanoseconds since the Unix epoch, `-1` when the platform cannot say.
    pub mtime_ns: i128,
}

impl FileId {
    pub fn of(meta: &std::fs::Metadata) -> Self {
        let mtime_ns = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos() as i128)
            .unwrap_or(-1);
        Self {
            len: meta.len(),
            mtime_ns,
        }
    }
}

/// Absolute paths `src` may denote, in the order the shell tries them.
///
/// `doc_dir` is the directory of the note the reference lives in, `vault_root`
/// the vault it belongs to, `assets` the vault-relative media paths from
/// `VaultIndex::assets`. An empty result means "no reader for this reference"
/// (a remote URL, an inline `data:` payload) — the caller keeps the source
/// text visible rather than reserving a box for it.
pub fn resolve_candidates(
    src: &str,
    doc_dir: Option<&Path>,
    vault_root: &Path,
    assets: &[String],
) -> Vec<PathBuf> {
    let raw = src.trim();
    if raw.is_empty() {
        return Vec::new();
    }
    let target: &str = match scheme_of(raw) {
        None => raw,
        // `convertFileSrc` form: `asset://localhost/<abs path>`.
        Some("asset") => strip_host(after_scheme(raw)),
        Some("file") => strip_host(raw.trim_start_matches("file://")),
        // The WebView loaded http/data/blob URLs itself; the native shell has
        // no reader for them, so they stay source text.
        Some(_) => return Vec::new(),
    };
    let decoded = percent_decode(target);
    let decoded: &str = decoded.as_ref();

    if decoded.starts_with('/') {
        // A real absolute path, or Obsidian's vault-root form — try both, in
        // that order, like the shell does.
        let mut out = vec![PathBuf::from(decoded)];
        let rel = decoded.trim_start_matches('/');
        if !rel.is_empty() {
            out.push(vault_root.join(rel));
        }
        return dedup(out);
    }

    // `![[x.excalidraw]]` shows the preview PNG the canvas exports next to
    // the scene file, never the scene JSON itself.
    if let Some(stem) = drawing_stem(file_name(decoded)) {
        let mut out = Vec::new();
        // The scene's own directory first. (The shell's candidate joins the
        // whole stem — directory included — to the found scene's directory,
        // which doubles the path for `Excalidraw/x.excalidraw`; joining the
        // *file name* stem lands on the same export on the first try.)
        if let Some(rel) = find_asset(assets, decoded) {
            out.push(vault_root.join(parent_of(rel)).join(format!("{stem}.png")));
        }
        if let Some(png) = find_asset(assets, &format!("{stem}.png")) {
            out.push(vault_root.join(png));
        }
        return dedup(out);
    }

    let mut out = Vec::new();
    if let Some(dir) = doc_dir {
        out.push(dir.join(decoded));
    }
    out.push(vault_root.join(decoded));
    // A bare file name may live anywhere in the vault (`Pasted image 1.png`);
    // a reference that carries a path is not second-guessed by a same-named
    // file elsewhere.
    if !decoded.contains('/') {
        if let Some(rel) = find_asset(assets, decoded) {
            out.push(vault_root.join(rel));
        }
    }
    dedup(out)
}

/// The URL scheme of `raw`, lowercased, when it has one. One-letter prefixes
/// are not schemes (a Windows drive letter is not a scheme).
fn scheme_of(raw: &str) -> Option<&str> {
    let colon = raw.find(':')?;
    if colon < 2 {
        return None;
    }
    let scheme = &raw[..colon];
    let mut chars = scheme.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-') {
        return None;
    }
    Some(scheme)
}

fn after_scheme(raw: &str) -> &str {
    raw.split_once("://").map(|(_, rest)| rest).unwrap_or(raw)
}

/// Strips the authority (`localhost`) Tauri's asset protocol URLs carry.
fn strip_host(rest: &str) -> &str {
    rest.strip_prefix("localhost").unwrap_or(rest)
}

/// A scheme's payload is percent-encoded like a URL; the note may also spell
/// the escape by hand. An invalid escape leaves the whole reference untouched
/// (`decodeURIComponent` throws and the shell keeps the raw string).
pub fn percent_decode(s: &str) -> Cow<'_, str> {
    if !s.contains('%') {
        return Cow::Borrowed(s);
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let (Some(hi), Some(lo)) = (
                bytes.get(i + 1).and_then(|b| hex(*b)),
                bytes.get(i + 2).and_then(|b| hex(*b)),
            ) else {
                return Cow::Borrowed(s);
            };
            out.push(hi * 16 + lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map(Cow::Owned).unwrap_or(Cow::Borrowed(s))
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// `foo.excalidraw` / `foo.excalidraw.md` → `Some("foo")` (case-insensitive,
/// `drawingStem` in `src/lib/excalidrawFile.ts`); anything else → `None`.
fn drawing_stem(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    let cut = if lower.ends_with(".excalidraw.md") {
        name.len() - ".excalidraw.md".len()
    } else if lower.ends_with(".excalidraw") {
        name.len() - ".excalidraw".len()
    } else {
        return None;
    };
    Some(name[..cut].to_string())
}

/// The vault-relative media path `name` denotes: an exact match or any path
/// ending in `/<name>`; the shortest match wins (`findAssetByName`).
fn find_asset<'a>(assets: &'a [String], name: &str) -> Option<&'a str> {
    let suffix = format!("/{name}");
    let mut best: Option<&str> = None;
    for rel in assets {
        if rel != name && !rel.ends_with(&suffix) {
            continue;
        }
        if best.is_none_or(|b| rel.len() < b.len()) {
            best = Some(rel);
        }
    }
    best
}

fn parent_of(rel: &str) -> &str {
    match rel.rfind('/') {
        Some(i) => &rel[..i],
        None => "",
    }
}

fn file_name(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[i + 1..],
        None => path,
    }
}

/// Keeps the first occurrence of every path (the loader tries them in order).
fn dedup(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::with_capacity(paths.len());
    for path in paths {
        if !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> PathBuf {
        PathBuf::from("/vault")
    }

    fn assets() -> Vec<String> {
        vec![
            "Images/foo.png".to_string(),
            "Images/deep/shape.png".to_string(),
            "Daily/Pasted image 1.png".to_string(),
            "Pasted image 1.png".to_string(),
            "Excalidraw/画图.excalidraw".to_string(),
            "Excalidraw/画图.png".to_string(),
        ]
    }

    fn resolve(src: &str, doc_dir: Option<&str>) -> Vec<String> {
        resolve_candidates(
            src,
            doc_dir.map(Path::new),
            &vault(),
            &assets(),
        )
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect()
    }

    #[test]
    fn relative_refs_try_the_note_dir_then_the_vault() {
        assert_eq!(
            resolve("Images/foo.png", Some("/vault/Daily")),
            vec!["/vault/Daily/Images/foo.png", "/vault/Images/foo.png"]
        );
        // No directory part: the by-name index is consulted last, shortest wins.
        assert_eq!(
            resolve("Pasted image 1.png", Some("/vault/Daily")),
            vec![
                "/vault/Daily/Pasted image 1.png",
                "/vault/Pasted image 1.png",
            ]
        );
        // Without an open note there is no note directory.
        assert_eq!(
            resolve("Images/foo.png", None),
            vec!["/vault/Images/foo.png"]
        );
    }

    #[test]
    fn bare_names_search_the_asset_index_shortest_path_first() {
        // Two index entries end in the same name; the shortest one is the
        // index's contribution (the vault-root spelling is already there, so
        // the candidate list stays at two).
        assert_eq!(
            resolve("Pasted image 1.png", Some("/vault/Notes")),
            vec![
                "/vault/Notes/Pasted image 1.png",
                "/vault/Pasted image 1.png",
            ]
        );
        // A name that exists only inside a directory is still found.
        assert_eq!(
            resolve("shape.png", Some("/vault/Notes")),
            vec![
                "/vault/Notes/shape.png",
                "/vault/shape.png",
                "/vault/Images/deep/shape.png",
            ]
        );
        // A missing name resolves to the two direct guesses only.
        assert_eq!(resolve("nope.png", None), vec!["/vault/nope.png"]);
    }

    #[test]
    fn absolute_and_url_forms() {
        assert_eq!(
            resolve("/Users/me/pic.png", Some("/vault/Daily")),
            vec!["/Users/me/pic.png", "/vault/Users/me/pic.png"]
        );
        // convertFileSrc's form on macOS.
        assert_eq!(
            resolve("asset://localhost/Users/me/pic.png", None),
            vec!["/Users/me/pic.png", "/vault/Users/me/pic.png"]
        );
        assert_eq!(
            resolve("file:///Users/me/pic.png", None),
            vec!["/Users/me/pic.png", "/vault/Users/me/pic.png"]
        );
        // Obsidian's vault-root form: "/Images/x.png" is not an absolute path
        // the machine has; the vault-root reading is tried second.
        assert_eq!(
            resolve("/Images/foo.png", None),
            vec!["/Images/foo.png", "/vault/Images/foo.png"]
        );
    }

    #[test]
    fn percent_escapes_are_decoded() {
        assert_eq!(
            resolve("My%20Image.png", Some("/vault/Daily")),
            vec![
                "/vault/Daily/My Image.png",
                "/vault/My Image.png",
            ]
        );
        // A malformed escape is not decoded at all (`decodeURIComponent`
        // throws and the shell keeps the raw reference).
        assert_eq!(percent_decode("100%zz.png"), "100%zz.png");
        assert_eq!(percent_decode("100%.png"), "100%.png");
        assert_eq!(percent_decode("%41%42"), "AB");
        assert_eq!(percent_decode("plain.png"), "plain.png");
    }

    #[test]
    fn unsupported_schemes_resolve_to_nothing() {
        for src in [
            "https://example.com/a.png",
            "http://example.com/a.png",
            "data:image/png;base64,AAAA",
            "blob:abc",
            "  ",
            "",
        ] {
            assert!(
                resolve_candidates(src, Some(Path::new("/vault/Daily")), &vault(), &assets())
                    .is_empty(),
                "{src} should have no local reader"
            );
        }
        // A one-letter prefix is not a scheme (Windows drive letters).
        assert_eq!(resolve("C:/pics/a.png", None), vec!["/vault/C:/pics/a.png"]);
    }

    #[test]
    fn drawing_embeds_resolve_to_the_exported_png() {
        // Same directory as the scene file, then the by-name search.
        assert_eq!(
            resolve("Excalidraw/画图.excalidraw", None),
            vec!["/vault/Excalidraw/画图.png"]
        );
        // The `.excalidraw.md` wrapper is the same scene file.
        assert_eq!(
            resolve("Excalidraw/画图.excalidraw.md", None),
            vec!["/vault/Excalidraw/画图.png"]
        );
        // A scene that is not in the index still gets the by-name PNG.
        assert_eq!(
            resolve("画图.excalidraw", None),
            vec!["/vault/Excalidraw/画图.png"]
        );
        // No export yet → no candidates, the source stays visible.
        assert!(resolve("Missing.excalidraw", None).is_empty());
    }

    #[test]
    fn fit_width_clamps_to_the_column_and_never_returns_zero() {
        // Wide image: scaled down to the column.
        assert_eq!(fit_width(1200., 700.), 700.);
        // Mid-size image: untouched.
        assert_eq!(fit_width(500., 700.), 500.);
        // Small figure: enlarged to 420 when the column allows it.
        assert_eq!(fit_width(85., 700.), 420.);
        // Narrow column: the column is both floor and ceiling.
        assert_eq!(fit_width(85., 300.), 300.);
        assert_eq!(fit_width(1200., 300.), 300.);
        // Degenerate inputs never yield 0 or NaN.
        for (intrinsic, column) in [
            (0., 700.),
            (-5., 700.),
            (f32::NAN, 700.),
            (f32::INFINITY, 700.),
            (100., 0.),
            (100., -10.),
            (100., f32::NAN),
        ] {
            let width = fit_width(intrinsic, column);
            assert!(width.is_finite() && width > 0., "{intrinsic}/{column} → {width}");
        }
    }

    #[test]
    fn file_id_separates_edited_files() {
        let dir = std::env::temp_dir().join("bnote-images-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("id.txt");
        std::fs::write(&path, b"one").unwrap();
        let first = FileId::of(&std::fs::metadata(&path).unwrap());
        assert_eq!(first.len, 3);
        assert!(first.mtime_ns >= 0);
        // Same bytes read twice: same identity.
        assert_eq!(first, FileId::of(&std::fs::metadata(&path).unwrap()));
        // A different length is a different file even when the mtime is coarse.
        std::fs::write(&path, b"one more").unwrap();
        assert_ne!(first, FileId::of(&std::fs::metadata(&path).unwrap()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
