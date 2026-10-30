//! 每份学习材料的落盘目录:批注 + agent 会话记录放在一起。
//!
//! ```text
//! <vault>/.bnote/materials/
//!   index.json                    材料身份 → 目录名(只写一次,之后永远复用)
//!   pdfs/<slug>/annotations.json
//!   pdfs/<slug>/sessions/<会话>.jsonl
//!   webpages/<slug>/...
//!   wxreads/<slug>/...
//! ```
//!
//! 目录名由材料名生成:中文走 `pinyin_pro`(词级多音字、无声调),文件名里
//! 的小数点等非字母数字统一变成下划线;网页按「域名_末段前 6 个字符」。
//! 一旦写进 `index.json` 就不再重算——书名后补、标题改名、同名材料都不会
//! 把已有批注/会话分到两个目录去。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use pinyin_pro::options::{NonZh, PinyinOptions, ToneType};
use pinyin_pro::options::PinyinOutput;
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
/// 目录名上限:APFS 单段 255 字节,留足 `annotations.json` 等文件名的余量。
const MAX_SLUG_CHARS: usize = 60;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaterialInfo {
    /// `pdfs` / `webpages` / `wxreads`
    pub kind: String,
    /// 材料目录名(已 pinyin 化)
    pub dir: String,
    /// 相对 `.bnote/` 的目录:`materials/pdfs/<dir>`
    pub rel_dir: String,
    /// 材料标题(写入 registry,仅用于展示)
    pub title: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct RegistryEntry {
    kind: String,
    dir: String,
    #[serde(default)]
    title: String,
    /// 材料目录里那份 PDF 的文件名(空 = 这份材料指向仓库里别处的 PDF,
    /// 例如迁移前收在 `<vault>/pdfs/` 的旧文件)。
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
            return Registry { version: 1, materials: BTreeMap::new() };
        };
        serde_json::from_str(&raw).unwrap_or(Registry { version: 1, materials: BTreeMap::new() })
    }

    fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("WRITE_FAILED: {}", e))?;
        }
        let raw = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, raw).map_err(|e| format!("WRITE_FAILED: {}", e))
    }
}

/// 材料在仓库内的稳定身份。PDF 用仓库相对路径(搬库不受影响),网页/微信
/// 读书用网址。
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
        Ok(u) => matches!(u.host_str(), Some("weread.qq.com") | Some("www.weread.qq.com")),
        Err(_) => false,
    }
}

/// 文件系统友好的 slug:小写、只留 `[a-z0-9_-]`,连续分隔符合成一个。
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
        trimmed.chars().take(MAX_SLUG_CHARS).collect::<String>().trim_end_matches('_').to_string()
    }
}

/// 中文 → 无声调拼音(词级多音字);非中文原样保留,再由 `sanitize_slug`
/// 把小数点等换成下划线。
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

/// 网页目录名:域名(去 www,点/横线变下划线)+ 末段前 6 个字符。
/// `https://x.com/thedankoe/status/2010751592346030461` → `x_com_201075`。
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

fn desired_slug(study: &StudyContent) -> String {
    match study {
        StudyContent::Pdf { path, title } => {
            let stem = Path::new(path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let name = if title.trim().is_empty() { stem } else { title.clone() };
            pinyin_slug(&name)
        }
        StudyContent::Url { url, title } => {
            // 微信读书的书名才是材料身份;缺书名(书架/商城页)时退回网址规则。
            if is_weread(url) && !title.trim().is_empty() && title != "微信读书" {
                pinyin_slug(title)
            } else {
                url_slug(url)
            }
        }
    }
}

/// 同一 kind 下目录名去重:已被别的材料占用就追加 `-2`、`-3`。
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

/// 导入后的 PDF 位置(学习阅读器与 agent 都用这份副本)。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPdf {
    pub pdf_path: String,
    /// 仓库相对路径(展示用;历史记录也只存这个)。
    pub rel_path: String,
    pub title: String,
}

/// 文件名里只去掉路径分隔符等无法落盘的东西;中文/空格保留(目录名才转拼音)。
fn safe_file_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if c == '/' || c == '\\' || c == '\0' { '_' } else { c })
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

    // 已经躺在材料目录里(拖进来 / 从历史打开):就地使用,不复制。
    if let Ok(rel) = canonical.strip_prefix(&pdfs_root) {
        let parts: Vec<String> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect();
        if parts.len() >= 2 {
            let dir = parts[0].clone();
            let mut registry = Registry::load(&registry_path);
            let key = format!("pdf:.bnote/{}/{}/{}", MATERIALS_DIR, KIND_PDF, parts.join("/"));
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
            let rel_path = format!(
                ".bnote/{}/{}/{}",
                MATERIALS_DIR,
                KIND_PDF,
                parts.join("/")
            );
            return Ok(ImportedPdf {
                pdf_path: canonical.to_string_lossy().to_string(),
                rel_path,
                title,
            });
        }
    }

    let mut registry = Registry::load(&registry_path);

    // 同一个标题、同样大小的文件已经导入过:打开已有副本(重复拖同一份不产副本)。
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

    // 新导入:目录名 = 标题的拼音(同名被占则 -2、-3;不覆盖别人的材料)。
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
    // 目标还不存在:词法归一的越界检查(存在后再 canonicalize 会被
    // /var → /private/var 这类符号链接坑到,和未解析的 vault 前缀对不上)。
    ensure_within(vault, &dest)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("MKDIR_FAILED: {}", e))?;
    std::fs::copy(&canonical, &dest).map_err(|e| format!("COPY_FAILED: {}", e))?;

    // 与 identity() 同形(仓库相对路径):下次打开这份副本时 ensure 能命中同一目录。
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
        rel_path: format!(".bnote/{}/{}/{}/{}", MATERIALS_DIR, KIND_PDF, candidate, file_name),
        title,
    })
}

/// 把一份 PDF 收进材料目录(`.bnote/materials/pdfs/<拼音目录>/<原文件名>`)。
/// 材料目录与会话/批注同处一地,关掉应用后仍然在。
#[tauri::command]
pub async fn study_import_pdf(
    state: State<'_, AppState>,
    pdf_path: String,
    title: Option<String>,
) -> CmdResult<ImportedPdf> {
    let vault = require_vault(&state)?;
    let source = PathBuf::from(&pdf_path);
    tauri::async_runtime::spawn_blocking(move || {
        import_pdf_sync(&vault, &source, title.as_deref())
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// 并发保护:同一时刻只有一个材料在「查/改/写 registry + 建目录」。
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
            // 书名/标题后续才拿到时补进 registry(目录名不动)。
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
            let entry = RegistryEntry { kind: kind.to_string(), dir, title, file: String::new() };
            registry.materials.insert(key.clone(), entry.clone());
            registry.save(&registry_path)?;
            entry
        }
    };

    let rel_dir = format!("{}/{}/{}", MATERIALS_DIR, entry.kind, entry.dir);
    let abs = vault.join(".bnote").join(&rel_dir);
    // 只登记、不建空目录:批注/会话第一次真正写盘时由 write_file/append_file
    // 建父目录。否则随手翻过的每个网页、每本书都会留下一个空文件夹。
    ensure_within(vault, &abs)?;

    Ok(MaterialInfo {
        kind: entry.kind,
        dir: entry.dir,
        rel_dir,
        title: entry.title,
    })
}

/// 解析/创建一份材料的存储目录(同身份永远返回同一个目录)。
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
    /// 会话标题:元数据行的 title(新记录),没有就取第一条用户消息,
    /// 再退回助手首句/「(空会话)」。
    pub title: String,
    /// 分叉来源会话的文件 id(主会话没有)。重启恢复靠它把辅助会话挂回
    /// 主会话——否则只恢复「最近更新的一条」,主会话就没入口了。
    pub parent: Option<String>,
    /// 辅助会话的来源消息摘要。
    pub based_on: Option<String>,
    /// 分叉时复制过来的前缀条数(自有消息从这一条起算)。
    pub fork_at: Option<u32>,
    pub created_at: u64,
    pub updated_at: u64,
    pub bytes: u64,
}

fn line_type_title(line: &str) -> Option<(String, u64, String)> {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
        let at = v.get("at").and_then(|x| x.as_u64()).unwrap_or(0);
        let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let text = v.get("text").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        return Some((ty.to_string(), at, text));
    }
    // 头部只读文件前 16KB:首条用户消息带着几 MB 的 base64 截图时,这一行
    // 必然被截断。记录由前端按 type→at→text→images 的顺序序列化,截断只
    // 会打断后面的图片数据,前面三个字段本身是完整的——按前缀取即可。
    let ty = prefix_string_field(line, "type")?;
    let at = prefix_u64_field(line, "at").unwrap_or(0);
    let text = prefix_string_field(line, "text").unwrap_or_default();
    Some((ty, at, text))
}

/// `"key"` 之后的值起点(跳过冒号与空白)。
fn prefix_field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{}\"", key);
    let start = line.find(&needle)? + needle.len();
    line[start..].trim_start().strip_prefix(':').map(|r| r.trim_start())
}

/** 取 `"key":"..."` 的值;字符串被截断(没有收尾引号)时返回 None。 */
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

/// 会话元数据行(`{"type":"meta","title":...}`)里列表需要的字段。
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


/// 读文件首尾各一段(会话大到几十 MB 时也不整份读):标题/创建时间在头部,
/// 最后一条时间戳在尾部。中间行不参与列表。
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
    file.seek(SeekFrom::Start(len.saturating_sub(tail_n as u64))).ok()?;
    let mut tail = vec![0u8; tail_n];
    file.read_exact(&mut tail).ok()?;
    Some((
        String::from_utf8_lossy(&head).to_string(),
        String::from_utf8_lossy(&tail).to_string(),
    ))
}

fn summarize_session(path: &Path) -> Option<SessionMeta> {
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
                // 标题为空时继续扫下一行(坏记录),父子字段仍保留。
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
        let Some((ty, at, text)) = line_type_title(line) else { continue };
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
            // 头部只需扫到标题;时间戳继续从尾部取。
            break;
        }
    }
    // 尾部可能从半行开始:逐行解析,取最后一个能读出时间戳的。
    let mut last_at = 0u64;
    for line in tail.lines().skip(1) {
        if let Some((_, at, _)) = line_type_title(line) {
            last_at = last_at.max(at);
        }
    }
    // 标题优先用元数据行(会话创建时写的首条用户消息),其次用户首句,
    // 再退回助手首句。元数据行很小、永远在文件最前面,不受首条大图消息
    // 被头部窗口截断的影响。
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
        title: if title.is_empty() { "(空会话)".to_string() } else { title },
        parent: meta.parent,
        based_on: meta.based_on,
        fork_at: meta.fork_at,
        created_at: first_at,
        updated_at: updated.max(last_at),
        bytes,
    })
}

/// 列出某份材料下保存过的会话(新的在前)。目录由 `study_material_ensure`
/// 给出,只接受 `.bnote/materials/...`。
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

/// 把记录原文第一行的元数据标题换成新标题(模型生成标题后落盘)。
///
/// 元数据行必须留在第一行:列表侧只读文件头部 16KB,标题挪到后面就看不
/// 见了。首行不是 meta 的旧记录(没有元数据行)则补一行到最前面。
fn retitle_transcript(raw: &str, title: &str) -> String {
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
        // 旧记录没有元数据行:新 meta 放最前,原文整体接在后面。
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

/// 把一条会话的标题写回记录文件(模型生成标题后调用)。
///
/// 只改第一行元数据,其余字节原样保留;写临时文件再 rename,写一半崩溃
/// 不会留下截断的记录。
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
        // 学习材料与会话统一落在 .bnote 下;creative 的会话进不了列表,但
        // 标题照样写回文件,将来支持时数据是对的。
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
    fn 中文文件名转无声调拼音() {
        assert_eq!(pinyin_slug("机器学习"), "ji_qi_xue_xi");
        assert_eq!(pinyin_slug("深度学习 第2版"), "shen_du_xue_xi_di_2_ban");
    }

    #[test]
    fn 小数点与符号变下划线() {
        assert_eq!(pinyin_slug("LLM-TAP-v2.0"), "llm_tap_v2_0");
        assert_eq!(pinyin_slug("  《论文》  "), "lun_wen");
    }

    #[test]
    fn 多音字按词判定() {
        // pinyin-pro 的词级词典:银行读 yin hang,不是 yin xing。
        assert_eq!(pinyin_slug("银行"), "yin_hang");
    }

    #[test]
    fn 网页取域名加末段前六位() {
        assert_eq!(
            url_slug("https://x.com/thedankoe/status/2010751592346030461"),
            "x_com_201075"
        );
        assert_eq!(url_slug("https://www.example.com/"), "example_com");
        assert_eq!(url_slug("https://example.com/a/b"), "example_com_b");
    }

    #[test]
    fn 目录名冲突时追加序号() {
        let mut r = Registry { version: 1, materials: BTreeMap::new() };
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
        // 不同 kind 各自独立,不算冲突。
        assert_eq!(unique_dir(&r, "webpages", "url:x", "lun_wen"), "lun_wen");
        // 自己复用自己。
        assert_eq!(unique_dir(&r, "pdfs", "pdf:a.pdf", "lun_wen"), "lun_wen");
    }

    #[test]
    fn 导入pdf落在材料目录_同标题复用_已在材料目录就地返回() {
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

        // 同一份再导一次:打开已有副本,不产生 -2。
        let b = import_pdf_sync(&vault, &src, None).unwrap();
        assert_eq!(a.pdf_path, b.pdf_path);

        // 中文标题走拼音目录。
        let src2 = src_dir.join("论文.pdf");
        std::fs::write(&src2, b"%PDF-1.4 other").unwrap();
        let c = import_pdf_sync(&vault, &src2, Some("论 文")).unwrap();
        assert!(c.rel_path.starts_with(".bnote/materials/pdfs/lun_wen/"));

        // 已经在材料目录里的 PDF:就地返回,不再复制。
        let d = import_pdf_sync(&vault, Path::new(&a.pdf_path), None).unwrap();
        assert_eq!(d.pdf_path, a.pdf_path);

        // 注册表键与 identity() 同形:ensureMaterial(打开副本)命中同一目录。
        let reg = Registry::load(&vault.join(".bnote/materials/index.json"));
        let key = "pdf:.bnote/materials/pdfs/llm_tap_v2/LLM-TAP-v2.pdf";
        let entry = reg.materials.get(key).expect("registry 应记录导入的 PDF");
        assert_eq!(entry.dir, "llm_tap_v2");
        assert_eq!(entry.file, "LLM-TAP-v2.pdf");
        // 用 ensure 的同一套身份规则再解析一次,目录不变。
        let study = StudyContent::Pdf {
            path: a.pdf_path.clone(),
            title: a.title.clone(),
        };
        let info = ensure_material_sync(&vault, &study).unwrap();
        assert_eq!(info.dir, "llm_tap_v2");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn 微信读书用书名_网页用网址规则() {
        let book = StudyContent::Url {
            url: "https://weread.qq.com/web/reader/abc123".into(),
            title: "三体".into(),
        };
        assert_eq!(desired_slug(&book), "san_ti");
        let shelf = StudyContent::Url { url: "https://weread.qq.com/".into(), title: "微信读书".into() };
        assert_eq!(desired_slug(&shelf), "weread_qq_com");
        let page = StudyContent::Url {
            url: "https://x.com/thedankoe/status/2010751592346030461".into(),
            title: "x.com".into(),
        };
        assert_eq!(desired_slug(&page), "x_com_201075");
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

    /// 首条用户消息带几 MB 截图时,列表读不到标题会被显示成「(空会话)」——
    /// 头部 16KB 落在 base64 图片中间,整行 JSON 解析失败。按前缀取文本即可。
    #[test]
    fn 首条消息带大图也能读出标题() {
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

    /// 元数据行永远在文件最前面且很小:标题直接取它,不必再解析用户消息。
    #[test]
    fn 元数据行标题优先于用户首句() {
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

    /// 没有元数据行的旧记录:退回用户首句;空文件不出现在列表里。
    #[test]
    fn 旧记录退回用户首句_空文件跳过() {
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

    /// 父子关系从元数据行读出来:重启恢复靠它把辅助会话挂回主会话。
    #[test]
    fn 元数据行带出父子关系与分叉前缀() {
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

        // 主会话没有这三项 → None(前端据此判定为根)。
        let main = tmp_session("main", "{\"type\":\"meta\",\"at\":1,\"title\":\"主会话\"}\n");
        let meta = summarize_session(&main).unwrap();
        assert_eq!(meta.parent, None);
        assert_eq!(meta.fork_at, None);
        std::fs::remove_dir_all(main.parent().unwrap()).ok();
    }

    /// 模型生成的标题只改第一行元数据,正文与其余元数据字段原样保留。
    #[test]
    fn 改标题只动第一行元数据() {
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
        // 父链与分叉点不因改标题丢失。
        assert_eq!(meta["parent"], "s1-0");
        assert_eq!(meta["forkAt"], 2);
        assert_eq!(lines[1], r#"{"type":"user","at":2,"text":"问题"}"#);

        // 旧记录(没有元数据行):补一行到最前面,原文一字不改。
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
