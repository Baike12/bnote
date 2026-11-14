//! On-disk layout for one study material: annotations and agent session
//! records live side by side.
//!
//! ```text
//! <vault>/.bnote/materials/
//!   index.json                    material identity -> dir name
//!                                 (written once, reused forever)
//!   pdfs/<slug>/annotations.json
//!   pdfs/<slug>/sessions/<session>.jsonl
//!   webpages/<slug>/...
//!   wxreads/<slug>/...
//! ```
//!
//! Directory names are generated from the material name: Chinese text goes
//! through `pinyin_pro` (word-level polyphonic handling, no tones), and every
//! non-alphanumeric character of a file name (dots included) becomes an
//! underscore; web pages use "<domain>_<first 6 chars of the last segment>".
//! Once a name is written into `index.json` it is never recomputed - a title
//! that only arrives later, a renamed title, or two materials sharing a title
//! can never split existing annotations or sessions across two directories.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use pinyin_pro::options::PinyinOutput;
use pinyin_pro::options::{NonZh, PinyinOptions, ToneType};
use pinyin_pro::pinyin;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{ensure_within, require_vault, CmdResult};
use crate::agent::tools::StudyContent;
use crate::state::AppState;

const MATERIALS_DIR: &str = "materials";
const REGISTRY_FILE: &str = "index.json";
const KIND_PDF: &str = "pdfs";
const KIND_WEB: &str = "webpages";
const KIND_WEREAD: &str = "wxreads";
/// Directory name cap: an APFS path component holds 255 bytes, and the file
/// name nested inside the directory (e.g. `annotations.json`) has to fit too.
const MAX_SLUG_CHARS: usize = 60;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaterialInfo {
    /// `pdfs` / `webpages` / `wxreads`
    pub kind: String,
    /// Material directory name (already converted to pinyin).
    pub dir: String,
    /// Directory relative to `.bnote/`: `materials/pdfs/<dir>`.
    pub rel_dir: String,
    /// Material title (stored in the registry, for display only).
    pub title: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct RegistryEntry {
    kind: String,
    dir: String,
    #[serde(default)]
    title: String,
    /// File name of the PDF inside the material directory (empty = this material
    /// points at a PDF stored elsewhere in the vault, e.g. an old file kept in
    /// `<vault>/pdfs/` before the migration).
    #[serde(default)]
    file: String,
}

#[derive(Serialize, Deserialize, Default, Debug)]
struct Registry {
    version: u32,
    materials: BTreeMap<String, RegistryEntry>,
}

impl Registry {
    fn load(path: &Path) -> Registry {
        let Ok(raw) = std::fs::read_to_string(path) else {
            return Registry {
                version: 1,
                materials: BTreeMap::new(),
            };
        };
        serde_json::from_str(&raw).unwrap_or(Registry {
            version: 1,
            materials: BTreeMap::new(),
        })
    }

    fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("WRITE_FAILED: {}", e))?;
        }
        let raw = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, raw).map_err(|e| format!("WRITE_FAILED: {}", e))
    }
}

/// Stable identity of a material inside the vault. A PDF is identified by its
/// vault-relative path (moving the vault does not change it); web pages and
/// WeRead books by their URL.
fn identity(study: &StudyContent, vault: &Path) -> String {
    match study {
        StudyContent::Pdf { path, .. } => {
            let p = PathBuf::from(path);
            let rel = p.strip_prefix(vault).unwrap_or(&p);
            format!("pdf:{}", rel.to_string_lossy().replace('\\', "/"))
        }
        StudyContent::Url { url, .. } => format!("url:{}", url.trim_end_matches('/')),
    }
}

fn is_weread(url: &str) -> bool {
    match tauri::Url::parse(url) {
        Ok(u) => matches!(
            u.host_str(),
            Some("weread.qq.com") | Some("www.weread.qq.com")
        ),
        Err(_) => false,
    }
}

/// Filesystem-friendly slug: lower case, only `[a-z0-9_-]` kept, runs of
/// separators collapsed into one.
fn sanitize_slug(raw: &str) -> String {
    let mut out = String::new();
    let mut last_sep = false;
    for ch in raw.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_sep = false;
        } else if !last_sep {
            out.push('_');
            last_sep = true;
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "material".to_string()
    } else {
        trimmed
            .chars()
            .take(MAX_SLUG_CHARS)
            .collect::<String>()
            .trim_end_matches('_')
            .to_string()
    }
}

/// Chinese -> toneless pinyin (word-level polyphonic handling); non-Chinese
/// text is kept as is, then `sanitize_slug` turns dots and the like into
/// underscores.
pub fn pinyin_slug(text: &str) -> String {
    let opts = PinyinOptions {
        tone_type: ToneType::None,
        non_zh: NonZh::Consecutive,
        ..PinyinOptions::default()
    };
    let converted = match pinyin(text.trim(), opts) {
        PinyinOutput::Str(s) => s,
        _ => text.to_string(),
    };
    sanitize_slug(&converted)
}

/// Web page directory name: domain (without www, dots and dashes turned into
/// underscores) plus the first 6 characters of the last path segment.
/// `https://x.com/thedankoe/status/2010751592346030461` -> `x_com_201075`.
pub fn url_slug(url: &str) -> String {
    let Ok(parsed) = tauri::Url::parse(url) else {
        return sanitize_slug(url);
    };
    let host = parsed.host_str().unwrap_or("").trim_start_matches("www.");
    let host = sanitize_slug(host);
    let last = parsed
        .path_segments()
        .and_then(|s| s.filter(|p| !p.is_empty()).last())
        .unwrap_or("");
    let tail: String = last.chars().take(6).collect();
    let tail = sanitize_slug(&tail);
    if tail == "material" {
        host
    } else {
        format!("{}_{}", host, tail)
    }
}

/// The stem of a local page's file name (`file:///tmp/01-hello.html` ->
/// `01-hello`); `None` for a remote URL.
pub fn local_page_stem(url: &str) -> Option<String> {
    let parsed = tauri::Url::parse(url).ok()?;
    if parsed.scheme() != "file" {
        return None;
    }
    let path = parsed.to_file_path().ok()?;
    path.file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
}

fn desired_slug(study: &StudyContent) -> String {
    match study {
        StudyContent::Pdf { path, title } => {
            let stem = Path::new(path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let name = if title.trim().is_empty() {
                stem
            } else {
                title.clone()
            };
            pinyin_slug(&name)
        }
        StudyContent::Url { url, title } => {
            // A local page has no domain to name the directory after; its file
            // name is what the user recognizes.
            if let Some(stem) = local_page_stem(url) {
                return pinyin_slug(&stem);
            }
            // Only a WeRead book title identifies the material; without one
            // (shelf or store pages) fall back to the URL rule.
            if is_weread(url) && !title.trim().is_empty() && title != "微信读书" {
                pinyin_slug(title)
            } else {
                url_slug(url)
            }
        }
    }
}

/// Make the directory name unique within one kind: append `-2`, `-3`, ...
/// when another material already took the base name.
fn unique_dir(registry: &Registry, kind: &str, key: &str, base: &str) -> String {
    let taken: Vec<&str> = registry
        .materials
        .iter()
        .filter(|(k, e)| k.as_str() != key && e.kind == kind)
        .map(|(_, e)| e.dir.as_str())
        .collect();
    if !taken.contains(&base) {
        return base.to_string();
    }
    for n in 2..1000 {
        let candidate = format!("{}-{}", base, n);
        if !taken.contains(&candidate.as_str()) {
            return candidate;
        }
    }
    format!("{}-{}", base, std::process::id())
}

/// Location of the imported PDF (both the study reader and the agent use this copy).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPdf {
    pub pdf_path: String,
    /// Vault-relative path (for display; history records only store this).
    pub rel_path: String,
    pub title: String,
}

/// Only strips what cannot be written to disk (path separators and friends);
/// Chinese characters and spaces are kept (only directory names become pinyin).
fn safe_file_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == '\0' {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').to_string();
    if trimmed.is_empty() {
        "paper.pdf".to_string()
    } else if trimmed.chars().count() > 120 {
        trimmed.chars().take(120).collect()
    } else {
        trimmed
    }
}

fn import_pdf_sync(
    vault: &Path,
    source: &Path,
    title_hint: Option<&str>,
) -> Result<ImportedPdf, String> {
    let _guard = MATERIAL_LOCK.lock().map_err(|e| e.to_string())?;
    if !source.is_file() {
        return Err(format!("PDF_NOT_FOUND: {}", source.display()));
    }
    let is_pdf = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false);
    if !is_pdf {
        return Err(format!("NOT_A_PDF: {}", source.display()));
    }
    let canonical = source
        .canonicalize()
        .map_err(|e| format!("PDF_NOT_FOUND: {}", e))?;
    let pdfs_root = vault.join(".bnote").join(MATERIALS_DIR).join(KIND_PDF);
    let registry_path = vault.join(".bnote").join(MATERIALS_DIR).join(REGISTRY_FILE);

    let fallback_title = canonical
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let title = title_hint
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or(fallback_title);
    let file_name = safe_file_name(
        &canonical
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "paper.pdf".into()),
    );

    // Already inside the materials directory (dragged in or opened from
    // history): use it in place, do not copy.
    if let Ok(rel) = canonical.strip_prefix(&pdfs_root) {
        let parts: Vec<String> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect();
        if parts.len() >= 2 {
            let dir = parts[0].clone();
            let mut registry = Registry::load(&registry_path);
            let key = format!(
                "pdf:.bnote/{}/{}/{}",
                MATERIALS_DIR,
                KIND_PDF,
                parts.join("/")
            );
            let entry = registry.materials.get(&key).cloned();
            if entry.is_none() {
                registry.materials.insert(
                    key,
                    RegistryEntry {
                        kind: KIND_PDF.to_string(),
                        dir: dir.clone(),
                        title: title.clone(),
                        file: parts[parts.len() - 1].clone(),
                    },
                );
                registry.save(&registry_path)?;
            }
            let rel_path = format!(".bnote/{}/{}/{}", MATERIALS_DIR, KIND_PDF, parts.join("/"));
            return Ok(ImportedPdf {
                pdf_path: canonical.to_string_lossy().to_string(),
                rel_path,
                title,
            });
        }
    }

    let mut registry = Registry::load(&registry_path);

    // A file with the same title and the same size was already imported: open
    // the existing copy (dragging the same file twice must not produce a second
    // copy).
    let existing = registry
        .materials
        .iter()
        .find(|(_, e)| e.kind == KIND_PDF && e.title == title && !e.file.is_empty())
        .map(|(_, e)| (e.dir.clone(), e.file.clone()));
    if let Some((dir, file)) = existing {
        let dest = pdfs_root.join(&dir).join(&file);
        let same_size = std::fs::metadata(&dest)
            .ok()
            .zip(std::fs::metadata(&canonical).ok())
            .map(|(a, b)| a.len() == b.len())
            .unwrap_or(false);
        if same_size {
            let rel_path = format!(".bnote/{}/{}/{}/{}", MATERIALS_DIR, KIND_PDF, dir, file);
            return Ok(ImportedPdf {
                pdf_path: dest.to_string_lossy().to_string(),
                rel_path,
                title,
            });
        }
    }

    // Fresh import: directory name = pinyin of the title (-2, -3 when the name
    // is taken; never overwrite another material).
    let base = pinyin_slug(&title);
    let mut candidate = base.clone();
    let mut n = 2;
    loop {
        let taken = registry
            .materials
            .values()
            .any(|e| e.kind == KIND_PDF && e.dir == candidate);
        if !taken && !pdfs_root.join(&candidate).join(&file_name).exists() {
            break;
        }
        candidate = format!("{}-{}", base, n);
        n += 1;
    }
    let dir = pdfs_root.join(&candidate);
    let dest = dir.join(&file_name);
    // The target does not exist yet: the containment check is lexical, because
    // canonicalizing an existing path resolves symlinks (/var -> /private/var),
    // which would no longer match the unresolved vault prefix.
    ensure_within(vault, &dest)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("MKDIR_FAILED: {}", e))?;
    std::fs::copy(&canonical, &dest).map_err(|e| format!("COPY_FAILED: {}", e))?;

    // Shaped like `identity()` (vault-relative path) so that opening this copy
    // later resolves to the same directory through `ensure_material_sync`.
    let key = format!(
        "pdf:.bnote/{}/{}/{}/{}",
        MATERIALS_DIR, KIND_PDF, candidate, file_name
    );
    registry.materials.insert(
        key,
        RegistryEntry {
            kind: KIND_PDF.to_string(),
            dir: candidate.clone(),
            title: title.clone(),
            file: file_name.clone(),
        },
    );
    registry.save(&registry_path)?;

    Ok(ImportedPdf {
        pdf_path: dest.to_string_lossy().to_string(),
        rel_path: format!(
            ".bnote/{}/{}/{}/{}",
            MATERIALS_DIR, KIND_PDF, candidate, file_name
        ),
        title,
    })
}

/// Files a PDF into the materials directory
/// (`.bnote/materials/pdfs/<pinyin dir>/<original file name>`).
/// Materials, sessions and annotations share one place on disk, so they survive
/// closing the app.
#[tauri::command]
pub async fn study_import_pdf(
    state: State<'_, AppState>,
    pdf_path: String,
    title: Option<String>,
) -> CmdResult<ImportedPdf> {
    let vault = require_vault(&state)?;
    let source = PathBuf::from(&pdf_path);
    tauri::async_runtime::spawn_blocking(move || import_pdf_sync(&vault, &source, title.as_deref()))
        .await
        .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Concurrency guard: only one material at a time may look up / modify / write
/// the registry and create directories.
static MATERIAL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn ensure_material_sync(vault: &Path, study: &StudyContent) -> Result<MaterialInfo, String> {
    let _guard = MATERIAL_LOCK.lock().map_err(|e| e.to_string())?;
    let kind = match study {
        StudyContent::Pdf { .. } => KIND_PDF,
        StudyContent::Url { url, .. } => {
            if is_weread(url) {
                KIND_WEREAD
            } else {
                KIND_WEB
            }
        }
    };
    let key = identity(study, vault);
    let registry_path = vault.join(".bnote").join(MATERIALS_DIR).join(REGISTRY_FILE);
    let mut registry = Registry::load(&registry_path);

    let existing = registry.materials.get(&key).cloned();
    let entry = match existing {
        Some(mut e) => {
            // The book or page title often arrives after the directory was
            // created, so backfill it into the registry (the directory name
            // never changes).
            let title = match study {
                StudyContent::Pdf { title, .. } | StudyContent::Url { title, .. } => title.clone(),
            };
            if !title.trim().is_empty() && e.title != title {
                e.title = title;
                registry.materials.insert(key.clone(), e.clone());
                registry.save(&registry_path)?;
            }
            e
        }
        None => {
            let title = match study {
                StudyContent::Pdf { title, .. } | StudyContent::Url { title, .. } => title.clone(),
            };
            let base = desired_slug(study);
            let dir = unique_dir(&registry, kind, &key, &base);
            let entry = RegistryEntry {
                kind: kind.to_string(),
                dir,
                title,
                file: String::new(),
            };
            registry.materials.insert(key.clone(), entry.clone());
            registry.save(&registry_path)?;
            entry
        }
    };

    let rel_dir = format!("{}/{}/{}", MATERIALS_DIR, entry.kind, entry.dir);
    let abs = vault.join(".bnote").join(&rel_dir);
    // Register only, never create an empty directory: write_file/append_file
    // create the parent directory when an annotation or session is first
    // actually written. Otherwise every page and book the user merely browses
    // would leave an empty folder behind.
    ensure_within(vault, &abs)?;

    Ok(MaterialInfo {
        kind: entry.kind,
        dir: entry.dir,
        rel_dir,
        title: entry.title,
    })
}

/// Resolve or create the storage directory of a material (the same identity
/// always resolves to the same directory).
#[tauri::command]
pub async fn study_material_ensure(
    state: State<'_, AppState>,
    study: StudyContent,
) -> CmdResult<MaterialInfo> {
    let vault = require_vault(&state)?;
    tauri::async_runtime::spawn_blocking(move || ensure_material_sync(&vault, &study))
        .await
        .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    /// Session title: the `title` of the metadata line (newer records); without
    /// it the first user message, then the assistant's first sentence, then
    /// "(empty session)".
    pub title: String,
    /// File id of the session this one was forked from (absent for a root
    /// session). Restart recovery uses it to reattach auxiliary sessions to
    /// their root session - otherwise only "the most recently updated one" is
    /// restored and the root session has no entry point.
    pub parent: Option<String>,
    /// Summary of the message an auxiliary session was forked from.
    pub based_on: Option<String>,
    /// Number of prefix messages copied at fork time (the session's own
    /// messages count from that one on).
    pub fork_at: Option<u32>,
    pub created_at: u64,
    pub updated_at: u64,
    pub bytes: u64,
}

fn line_type_title(line: &str) -> Option<(String, u64, String)> {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
        let at = v.get("at").and_then(|x| x.as_u64()).unwrap_or(0);
        let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let text = v
            .get("text")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        return Some((ty.to_string(), at, text));
    }
    // The head window is only 16KB: when the first user message carries a few
    // MB of base64 screenshot, this line is always cut. Records are serialized
    // by the frontend in the order type -> at -> text -> images, so truncation
    // only breaks the image data that follows; the first three fields are
    // intact and can be read from the prefix.
    let ty = prefix_string_field(line, "type")?;
    let at = prefix_u64_field(line, "at").unwrap_or(0);
    let text = prefix_string_field(line, "text").unwrap_or_default();
    Some((ty, at, text))
}

/// Start of the value after `"key"` (skipping the colon and whitespace).
fn prefix_field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{}\"", key);
    let start = line.find(&needle)? + needle.len();
    line[start..]
        .trim_start()
        .strip_prefix(':')
        .map(|r| r.trim_start())
}

/** Reads the value of `"key":"..."`; None when truncated (no closing quote). */
fn prefix_string_field(line: &str, key: &str) -> Option<String> {
    let rest = prefix_field(line, key)?.strip_prefix('"')?;
    let mut escaped = false;
    for (i, c) in rest.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' => escaped = true,
            '"' => return serde_json::from_str(&format!("\"{}\"", &rest[..i])).ok(),
            _ => {}
        }
    }
    None
}

fn prefix_u64_field(line: &str, key: &str) -> Option<u64> {
    let rest = prefix_field(line, key)?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// The fields the session list needs from the metadata line
/// (`{"type":"meta","title":...}`).
#[derive(Default, Clone)]
struct MetaLine {
    title: String,
    parent: Option<String>,
    based_on: Option<String>,
    fork_at: Option<u32>,
}

fn meta_line(line: &str) -> Option<MetaLine> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("type").and_then(|x| x.as_str()) != Some("meta") {
        return None;
    }
    let text = |key: &str| {
        v.get(key)
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    Some(MetaLine {
        title: text("title").unwrap_or_default(),
        parent: text("parent"),
        based_on: text("basedOn"),
        fork_at: v
            .get("forkAt")
            .and_then(|x| x.as_u64())
            .map(|n| n.min(u32::MAX as u64) as u32),
    })
}

/// Read a slice of the head and one of the tail (sessions reach tens of MB and
/// are never read whole): the title and creation time live in the head, the
/// last timestamp in the tail. Middle lines never take part in the list.
fn read_head_tail(path: &Path, head_len: usize, tail_len: usize) -> Option<(String, String)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let head_n = head_len.min(len as usize);
    let mut head = vec![0u8; head_n];
    file.read_exact(&mut head).ok()?;
    if len == 0 {
        return Some((String::new(), String::new()));
    }
    let tail_n = tail_len.min(len as usize);
    file.seek(SeekFrom::Start(len.saturating_sub(tail_n as u64)))
        .ok()?;
    let mut tail = vec![0u8; tail_n];
    file.read_exact(&mut tail).ok()?;
    Some((
        String::from_utf8_lossy(&head).to_string(),
        String::from_utf8_lossy(&tail).to_string(),
    ))
}

pub(crate) fn summarize_session(path: &Path) -> Option<SessionMeta> {
    let bytes = std::fs::metadata(path).ok()?.len();
    if bytes == 0 {
        return None;
    }
    let (head, tail) = read_head_tail(path, 16 * 1024, 8 * 1024)?;
    let mut first_at = 0u64;
    let mut meta = MetaLine::default();
    let mut title = String::new();
    let mut first_assistant = String::new();
    for line in head.lines() {
        if meta.title.is_empty() {
            if let Some(m) = meta_line(line) {
                // Keep scanning the next line while the title is empty (a
                // broken record); the parent/child fields are still kept.
                if meta.parent.is_none() {
                    meta.parent = m.parent.clone();
                }
                if meta.based_on.is_none() {
                    meta.based_on = m.based_on.clone();
                }
                if meta.fork_at.is_none() {
                    meta.fork_at = m.fork_at;
                }
                if !m.title.is_empty() {
                    meta.title = m.title;
                }
                continue;
            }
        }
        let Some((ty, at, text)) = line_type_title(line) else {
            continue;
        };
        if first_at == 0 {
            first_at = at;
        }
        if title.is_empty() && ty == "user" && !text.is_empty() {
            title = text.clone();
        }
        if first_assistant.is_empty() && ty == "assistant" && !text.is_empty() {
            first_assistant = text;
        }
        if !title.is_empty() && !first_assistant.is_empty() && first_at > 0 {
            // The head only needs scanning until the title; the timestamp
            // comes from the tail.
            break;
        }
    }
    // The tail may start mid-line: parse line by line and take the last one
    // that yields a timestamp.
    let mut last_at = 0u64;
    for line in tail.lines().skip(1) {
        if let Some((_, at, _)) = line_type_title(line) {
            last_at = last_at.max(at);
        }
    }
    // The title prefers the metadata line (the first user message, written when
    // the session was created), then the user's first sentence, then the
    // assistant's first sentence. The metadata line is tiny and always at the
    // very front of the file, so it is unaffected by the head window cutting
    // into a first message that carries a large image.
    let title = if !meta.title.is_empty() {
        meta.title.clone()
    } else if title.is_empty() {
        first_assistant
    } else {
        title
    };
    let title: String = title.replace(['\r', '\n'], " ").chars().take(80).collect();
    let updated = std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(last_at);
    Some(SessionMeta {
        id: path.file_stem()?.to_string_lossy().to_string(),
        title: if title.is_empty() {
            "(空会话)".to_string()
        } else {
            title
        },
        parent: meta.parent,
        based_on: meta.based_on,
        fork_at: meta.fork_at,
        created_at: first_at,
        updated_at: updated.max(last_at),
        bytes,
    })
}

/// List the sessions saved under one material (newest first). The directory
/// comes from `study_material_ensure`; only `.bnote/materials/...` is accepted.
#[tauri::command]
pub async fn study_sessions_list(
    state: State<'_, AppState>,
    rel_dir: String,
) -> CmdResult<Vec<SessionMeta>> {
    let vault = require_vault(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let parts: Vec<&str> = rel_dir.split('/').filter(|p| !p.is_empty()).collect();
        if parts.first() != Some(&MATERIALS_DIR) || parts.iter().any(|p| *p == ".." || *p == ".") {
            return Err(format!("INVALID_DIR: {}", rel_dir));
        }
        let dir = vault.join(".bnote").join(&rel_dir).join("sessions");
        ensure_within(&vault, &dir)?;
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Ok(out);
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(meta) = summarize_session(&path) {
                out.push(meta);
            }
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Replace the metadata title on the first line of a transcript (after the
/// model generated a title).
///
/// The metadata line must stay on the first line: the list only reads the first
/// 16KB of the file, so a title moved further down would be invisible. For
/// legacy records whose first line is not a meta line (no metadata line at
/// all), one is prepended.
pub(crate) fn retitle_transcript(raw: &str, title: &str) -> String {
    let (first, rest) = match raw.split_once('\n') {
        Some((head, tail)) => (head, tail),
        None => (raw, ""),
    };
    let existing = serde_json::from_str::<serde_json::Value>(first.trim())
        .ok()
        .filter(|v| v.get("type").and_then(|x| x.as_str()) == Some("meta"));
    let (line, body) = match existing {
        Some(mut v) => {
            v["title"] = serde_json::Value::String(title.to_string());
            v["titleSource"] = serde_json::Value::String("llm".to_string());
            (v, rest)
        }
        // Legacy record without a metadata line: the new meta goes first, the
        // original text follows unchanged.
        None => (
            serde_json::json!({"type": "meta", "at": 0, "title": title, "titleSource": "llm"}),
            raw,
        ),
    };
    let mut out = String::new();
    out.push_str(&line.to_string());
    out.push('\n');
    out.push_str(body);
    out
}

/// Write a session title back into the transcript file (called after the model
/// generated a title).
///
/// Only the first-line metadata changes, every other byte is kept as is; the
/// new content goes to a temp file and is renamed, so a crash mid-write never
/// leaves a truncated record behind.
#[tauri::command]
pub async fn study_session_set_title(
    state: State<'_, AppState>,
    rel_dir: String,
    id: String,
    title: String,
) -> CmdResult<()> {
    let vault = require_vault(&state)?;
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("BAD_ARGS: title".into());
    }
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(format!("INVALID_ID: {}", id));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let parts: Vec<&str> = rel_dir.split('/').filter(|p| !p.is_empty()).collect();
        // Study materials and sessions live under .bnote; creative sessions
        // never show up in the list, but the title is still written back to the
        // file so the data is correct once that is supported.
        let allowed_root =
            parts.first() == Some(&MATERIALS_DIR) || parts.first() == Some(&"creative");
        if !allowed_root || parts.iter().any(|p| *p == ".." || *p == ".") {
            return Err(format!("INVALID_DIR: {}", rel_dir));
        }
        let dir = vault.join(".bnote").join(&rel_dir).join("sessions");
        ensure_within(&vault, &dir)?;
        let path = dir.join(format!("{}.jsonl", id));
        ensure_within(&vault, &path)?;
        let raw = std::fs::read_to_string(&path).map_err(|e| format!("IO: {}", e))?;
        let next = retitle_transcript(&raw, &title);
        if next == raw {
            return Ok(());
        }
        let tmp = dir.join(format!(".{}.jsonl.tmp", id));
        std::fs::write(&tmp, next).map_err(|e| format!("IO: {}", e))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("IO: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_file_names_become_pinyin_without_tones() {
        assert_eq!(pinyin_slug("机器学习"), "ji_qi_xue_xi");
        assert_eq!(pinyin_slug("深度学习 第2版"), "shen_du_xue_xi_di_2_ban");
    }

    #[test]
    fn dots_and_symbols_become_underscores() {
        assert_eq!(pinyin_slug("LLM-TAP-v2.0"), "llm_tap_v2_0");
        assert_eq!(pinyin_slug("  《论文》  "), "lun_wen");
    }

    #[test]
    fn polyphonic_characters_are_resolved_by_word() {
        // pinyin-pro's word-level dictionary: "yin hang", not "yin xing".
        assert_eq!(pinyin_slug("银行"), "yin_hang");
    }

    #[test]
    fn a_web_url_slug_is_the_domain_plus_the_first_six_characters_of_the_last_segment() {
        assert_eq!(
            url_slug("https://x.com/thedankoe/status/2010751592346030461"),
            "x_com_201075"
        );
        assert_eq!(url_slug("https://www.example.com/"), "example_com");
        assert_eq!(url_slug("https://example.com/a/b"), "example_com_b");
    }

    #[test]
    fn a_pdf_identity_is_vault_relative_so_moving_the_vault_keeps_the_material() {
        let vault = Path::new("/notes/vault");
        let study = StudyContent::Pdf {
            path: "/notes/vault/pdfs/paper.pdf".into(),
            title: "Paper".into(),
        };
        assert_eq!(identity(&study, vault), "pdf:pdfs/paper.pdf");
        // A PDF outside the vault keeps its absolute path (no relative form
        // exists), so two different files cannot collide.
        let outside = StudyContent::Pdf {
            path: "/elsewhere/paper.pdf".into(),
            title: String::new(),
        };
        assert_eq!(identity(&outside, vault), "pdf:/elsewhere/paper.pdf");
    }

    #[test]
    fn a_url_identity_ignores_a_trailing_slash_but_not_the_query() {
        let vault = Path::new("/v");
        let with = StudyContent::Url {
            url: "https://x.com/a/?q=1".into(),
            title: String::new(),
        };
        assert_eq!(identity(&with, vault), "url:https://x.com/a/?q=1");
        let bare = StudyContent::Url {
            url: "https://x.com/a/".into(),
            title: String::new(),
        };
        let same = StudyContent::Url {
            url: "https://x.com/a".into(),
            title: String::new(),
        };
        assert_eq!(identity(&bare, vault), identity(&same, vault));
    }

    #[test]
    fn only_the_weread_hosts_are_recognized_including_www() {
        assert!(is_weread("https://weread.qq.com/web/reader/abc"));
        assert!(is_weread("https://www.weread.qq.com/web/reader/abc"));
        assert!(!is_weread("https://weread.qq.com.evil.test/x"));
        // `host_str` is host-only, so a port does not change the identity.
        assert!(is_weread("http://weread.qq.com:8080/x"));
        assert!(!is_weread("not a url"));
    }

    #[test]
    fn a_slug_is_lower_case_bounded_and_never_empty() {
        assert_eq!(sanitize_slug("Hello__World"), "hello_world");
        assert_eq!(sanitize_slug("  ...  "), "material");
        assert_eq!(sanitize_slug(""), "material");
        // Overlong names are cut to the component budget and never end in a
        // separator (an APFS component limit, not a preference).
        let long = sanitize_slug(&"a".repeat(200));
        assert_eq!(long.chars().count(), MAX_SLUG_CHARS);
        assert!(!long.ends_with('_'));
        assert_eq!(
            sanitize_slug(&format!("{}!", "a".repeat(MAX_SLUG_CHARS))).len(),
            MAX_SLUG_CHARS
        );
    }

    #[test]
    fn a_file_name_keeps_chinese_but_drops_separators_and_leading_dots() {
        assert_eq!(safe_file_name("论 文.pdf"), "论 文.pdf");
        assert_eq!(safe_file_name(r"a/b\c.pdf"), "a_b_c.pdf");
        assert_eq!(safe_file_name("  .hidden.pdf"), "hidden.pdf");
        assert_eq!(safe_file_name("   "), "paper.pdf");
        // 120 characters is the cap; the extension is not preserved specially,
        // the name is simply truncated.
        assert_eq!(safe_file_name(&"x".repeat(200)).chars().count(), 120);
    }

    #[test]
    fn a_conflicting_directory_name_gets_a_numeric_suffix() {
        let mut r = Registry {
            version: 1,
            materials: BTreeMap::new(),
        };
        r.materials.insert(
            "pdf:a.pdf".into(),
            RegistryEntry {
                kind: "pdfs".into(),
                dir: "lun_wen".into(),
                title: String::new(),
                file: String::new(),
            },
        );
        assert_eq!(unique_dir(&r, "pdfs", "pdf:b.pdf", "lun_wen"), "lun_wen-2");
        // Different kinds are independent, so this is not a conflict.
        assert_eq!(unique_dir(&r, "webpages", "url:x", "lun_wen"), "lun_wen");
        // Reusing its own name is not a conflict.
        assert_eq!(unique_dir(&r, "pdfs", "pdf:a.pdf", "lun_wen"), "lun_wen");
    }

    #[test]
    fn importing_a_pdf_lands_in_the_materials_dir_reuses_the_title_and_returns_it_in_place() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("bnote-material-import-{}", stamp));
        let vault = root.join("vault");
        let src_dir = root.join("src");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::create_dir_all(&src_dir).unwrap();

        let src = src_dir.join("LLM-TAP-v2.pdf");
        std::fs::write(&src, b"%PDF-1.4 test").unwrap();
        let a = import_pdf_sync(&vault, &src, None).unwrap();
        assert_eq!(
            a.rel_path,
            ".bnote/materials/pdfs/llm_tap_v2/LLM-TAP-v2.pdf"
        );
        assert!(Path::new(&a.pdf_path).is_file());

        // Importing the same file again opens the existing copy instead of
        // creating a -2.
        let b = import_pdf_sync(&vault, &src, None).unwrap();
        assert_eq!(a.pdf_path, b.pdf_path);

        // A Chinese title becomes a pinyin directory.
        let src2 = src_dir.join("论文.pdf");
        std::fs::write(&src2, b"%PDF-1.4 other").unwrap();
        let c = import_pdf_sync(&vault, &src2, Some("论 文")).unwrap();
        assert!(c.rel_path.starts_with(".bnote/materials/pdfs/lun_wen/"));

        // A PDF already inside the materials directory is returned in place,
        // not copied again.
        let d = import_pdf_sync(&vault, Path::new(&a.pdf_path), None).unwrap();
        assert_eq!(d.pdf_path, a.pdf_path);

        // The registry key is shaped like `identity()`, so ensureMaterial on the
        // copy hits the same directory.
        let reg = Registry::load(&vault.join(".bnote/materials/index.json"));
        let key = "pdf:.bnote/materials/pdfs/llm_tap_v2/LLM-TAP-v2.pdf";
        let entry = reg
            .materials
            .get(key)
            .expect("the registry must record the imported PDF");
        assert_eq!(entry.dir, "llm_tap_v2");
        assert_eq!(entry.file, "LLM-TAP-v2.pdf");
        // Resolve once more with the same identity rules `ensure` uses; the
        // directory is unchanged.
        let study = StudyContent::Pdf {
            path: a.pdf_path.clone(),
            title: a.title.clone(),
        };
        let info = ensure_material_sync(&vault, &study).unwrap();
        assert_eq!(info.dir, "llm_tap_v2");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn weread_uses_the_book_title_while_web_pages_use_the_url_rule() {
        let book = StudyContent::Url {
            url: "https://weread.qq.com/web/reader/abc123".into(),
            title: "三体".into(),
        };
        assert_eq!(desired_slug(&book), "san_ti");
        let shelf = StudyContent::Url {
            url: "https://weread.qq.com/".into(),
            title: "微信读书".into(),
        };
        assert_eq!(desired_slug(&shelf), "weread_qq_com");
        let page = StudyContent::Url {
            url: "https://x.com/thedankoe/status/2010751592346030461".into(),
            title: "x.com".into(),
        };
        assert_eq!(desired_slug(&page), "x_com_201075");
    }

    #[test]
    fn a_local_page_is_named_after_its_file() {
        let page = StudyContent::Url {
            url: "file:///Users/me/learning/01-electron-model.html".into(),
            title: "01-electron-model.html".into(),
        };
        // The URL rule would give `material_01_ele` (no domain to name the
        // directory after); the file stem is what the user recognizes.
        assert_eq!(desired_slug(&page), "01_electron_model");
        assert_eq!(local_page_stem("https://x.com/a"), None);
    }

    fn tmp_session(name: &str, body: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("bnote-session-{}-{}", name, stamp));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{}.jsonl", name));
        std::fs::write(&path, body).unwrap();
        path
    }

    /// When the first user message carries a few MB of screenshot, the list
    /// cannot read the title and shows "(empty session)": the 16KB head window
    /// lands inside the base64 image, so parsing the whole line as JSON fails.
    /// Reading the text from the prefix is enough.
    #[test]
    fn the_title_is_read_even_when_the_first_message_carries_a_large_image() {
        let image = "A".repeat(64 * 1024);
        let body = format!(
            "{{\"type\":\"user\",\"at\":1793000793461,\"text\":\"这里为什么是4倍\",\"images\":[{{\"mediaType\":\"image/png\",\"data\":\"{}\"}}]}}\n",
            image
        );
        let path = tmp_session("big-image", &body);
        let meta = summarize_session(&path).unwrap();
        assert_eq!(meta.title, "这里为什么是4倍");
        assert_eq!(meta.created_at, 1793000793461);
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    /// The metadata line is always at the very front and very small: take the
    /// title from it directly instead of parsing the user message.
    #[test]
    fn the_metadata_line_title_wins_over_the_first_user_message() {
        let body = concat!(
            r#"{"type":"meta","at":100,"title":"会话标题","model":{"provider":"anthropic","model":"m","baseUrl":"","maxTokens":1,"contextWindow":2}}"#,
            "\n",
            r#"{"type":"user","at":101,"text":"用户原话"}"#,
            "\n",
            r#"{"type":"assistant","at":102,"text":"回答"}"#,
            "\n"
        );
        let path = tmp_session("meta", body);
        let meta = summarize_session(&path).unwrap();
        assert_eq!(meta.title, "会话标题");
        assert_eq!(meta.created_at, 101);
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    /// Legacy records without a metadata line fall back to the user's first
    /// sentence; empty files never show up in the list.
    #[test]
    fn old_records_fall_back_to_the_first_user_message_and_empty_files_are_skipped() {
        let body = concat!(
            r#"{"type":"user","at":1,"text":"  第一行\n第二行  "}"#,
            "\n",
            r#"{"type":"assistant","at":2,"text":"回答"}"#,
            "\n"
        );
        let path = tmp_session("legacy", body);
        assert_eq!(summarize_session(&path).unwrap().title, "第一行 第二行");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();

        let empty = tmp_session("empty", "");
        assert!(summarize_session(&empty).is_none());
        std::fs::remove_dir_all(empty.parent().unwrap()).ok();
    }

    /// The parent/child relation comes from the metadata line: restart
    /// recovery uses it to reattach auxiliary sessions to their root session.
    #[test]
    fn the_metadata_line_carries_the_parent_relation_and_the_fork_prefix() {
        let body = concat!(
            r#"{"type":"meta","at":100,"title":"↳ 父会话的提问","parent":"s1-0","basedOn":"父会话的提问","forkAt":4}"#,
            "\n",
            r#"{"type":"user","at":101,"text":"子会话的问题"}"#,
            "\n"
        );
        let path = tmp_session("aux", body);
        let meta = summarize_session(&path).unwrap();
        assert_eq!(meta.parent.as_deref(), Some("s1-0"));
        assert_eq!(meta.based_on.as_deref(), Some("父会话的提问"));
        assert_eq!(meta.fork_at, Some(4));
        std::fs::remove_dir_all(path.parent().unwrap()).ok();

        // A root session has none of these three -> None (the frontend treats
        // that as the root).
        let main = tmp_session(
            "main",
            "{\"type\":\"meta\",\"at\":1,\"title\":\"主会话\"}\n",
        );
        let meta = summarize_session(&main).unwrap();
        assert_eq!(meta.parent, None);
        assert_eq!(meta.fork_at, None);
        std::fs::remove_dir_all(main.parent().unwrap()).ok();
    }

    /// A model-generated title only changes the first-line metadata; the body
    /// and the remaining metadata fields are kept as is.
    #[test]
    fn retitling_only_touches_the_first_metadata_line() {
        let raw = concat!(
            r#"{"type":"meta","at":1,"title":"旧标题","parent":"s1-0","forkAt":2}"#,
            "\n",
            r#"{"type":"user","at":2,"text":"问题"}"#,
            "\n"
        );
        let next = retitle_transcript(raw, "特征值与矩阵对角化");
        let lines: Vec<&str> = next.lines().collect();
        assert_eq!(lines.len(), 2);
        let meta: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(meta["title"], "特征值与矩阵对角化");
        assert_eq!(meta["titleSource"], "llm");
        // Retitling must not lose the parent link or the fork point.
        assert_eq!(meta["parent"], "s1-0");
        assert_eq!(meta["forkAt"], 2);
        assert_eq!(lines[1], r#"{"type":"user","at":2,"text":"问题"}"#);

        // Legacy record (no metadata line): one is prepended, the original
        // text is not touched.
        let legacy = "{\"type\":\"user\",\"at\":2,\"text\":\"问题\"}\n";
        let next = retitle_transcript(legacy, "新标题");
        let mut lines = next.lines();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(lines.next().unwrap()).unwrap()["title"],
            "新标题"
        );
        assert_eq!(lines.next().unwrap(), legacy.trim_end());
    }
}
