//! The document index + FTS5 retrieval plane.
//!
//! The Markdown files under `.bnote/invest/` are the source of truth; this
//! module keeps the index rows and the FTS5 mirror. FTS5 runs with
//! `tokenize='unicode61'`, which has no CJK word boundaries — the WeKnora
//! trick applies: index and query text both get overlapped **bigrams** for
//! runs of CJK characters, so a Chinese phrase match becomes a consecutive
//! bigram match. ASCII text passes through unchanged.
//!
//! Indexing is content-addressed: a document whose `file_hash` did not change
//! is not re-tokenized.

use rusqlite::Connection;

use crate::invest::model::DocInfo;

/// Registers/reindexes one document. `body` is the full markdown (stored only
/// inside FTS; the row keeps metadata). Returns true when the index changed.
pub fn index_doc(
    conn: &Connection,
    rel_path: &str,
    scope: &str,
    kind: &str,
    title: &str,
    body: &str,
    mtime: i64,
    file_hash: &str,
) -> Result<bool, String> {
    let existing: Option<(i64, String)> = match conn.query_row(
        "SELECT id, file_hash FROM docs WHERE rel_path=?1",
        rusqlite::params![rel_path],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ) {
        Ok(pair) => Some(pair),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(format!("DB_QUERY_FAILED: {}", e)),
    };

    if let Some((id, hash)) = &existing {
        if hash == file_hash {
            return Ok(false);
        }
        // Contentless FTS requires an explicit delete of the old row first.
        conn.execute("DELETE FROM docs_fts WHERE rowid=?1", rusqlite::params![id])
            .map_err(|e| format!("DB_WRITE_FAILED: {}", e))?;
        conn.execute("DELETE FROM docs WHERE id=?1", rusqlite::params![id])
            .map_err(|e| format!("DB_WRITE_FAILED: {}", e))?;
    }

    conn.execute(
        "INSERT INTO docs(rel_path, scope, kind, title, mtime, file_hash, indexed) VALUES (?1,?2,?3,?4,?5,?6,1)",
        rusqlite::params![rel_path, scope, kind, title, mtime, file_hash],
    )
    .map_err(|e| format!("DB_WRITE_FAILED: doc {}: {}", rel_path, e))?;
    let id = conn.last_insert_rowid();
    let index_title = bigram(title);
    let index_body = bigram(body);
    conn.execute(
        "INSERT INTO docs_fts(rowid, title, body) VALUES (?1, ?2, ?3)",
        rusqlite::params![id, index_title, index_body],
    )
    .map_err(|e| format!("DB_WRITE_FAILED: fts {}: {}", rel_path, e))?;
    Ok(true)
}

/// Removes one document from the index (the file was deleted).
pub fn remove_doc(conn: &Connection, rel_path: &str) -> Result<bool, String> {
    let id: Option<i64> = conn
        .query_row(
            "SELECT id FROM docs WHERE rel_path=?1",
            rusqlite::params![rel_path],
            |r| r.get(0),
        )
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            _ => Err(format!("DB_QUERY_FAILED: {}", e)),
        })
        .map_err(|e| format!("DB_QUERY_FAILED: {}", e))?;
    let Some(id) = id else { return Ok(false) };
    conn.execute("DELETE FROM docs_fts WHERE rowid=?1", rusqlite::params![id])
        .map_err(|e| format!("DB_WRITE_FAILED: {}", e))?;
    conn.execute("DELETE FROM docs WHERE id=?1", rusqlite::params![id])
        .map_err(|e| format!("DB_WRITE_FAILED: {}", e))?;
    Ok(true)
}

/// The documents of one scope, newest first (the "scan the directory
/// summaries first" list the agent reads before opening anything).
pub fn list_by_scope(conn: &Connection, scope: &str) -> Result<Vec<DocInfo>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT rel_path, scope, kind, title, mtime FROM docs
             WHERE scope=?1 ORDER BY mtime DESC, rel_path",
        )
        .map_err(|e| format!("DB_PREPARE_FAILED: {}", e))?;
    let rows = stmt
        .query_map(rusqlite::params![scope], |r| {
            Ok(DocInfo {
                rel_path: r.get(0)?,
                scope: r.get(1)?,
                kind: r.get(2)?,
                title: r.get(3)?,
                mtime: r.get(4)?,
            })
        })
        .map_err(|e| format!("DB_QUERY_FAILED: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("DB_READ_FAILED: {}", e))?);
    }
    Ok(out)
}

/// Full-text search over the whole vault's invest corpus. Returns matches
/// newest-first within the same rank band (rowid desc), capped at `limit`.
pub fn search(conn: &Connection, query: &str, limit: usize) -> Result<Vec<DocInfo>, String> {
    let q = bigram(query);
    if q.trim().is_empty() {
        return Ok(Vec::new());
    }
    // Phrase-quoted tokens: the bigram text of the user query is matched as a
    // phrase so multi-char CJK queries behave like a substring search.
    let phrase = format!("\"{}\"", q.replace('"', "\"\""));
    let mut stmt = conn
        .prepare(
            "SELECT d.rel_path, d.scope, d.kind, d.title, d.mtime
             FROM docs_fts f JOIN docs d ON d.id = f.rowid
             WHERE docs_fts MATCH ?1
             ORDER BY rank, d.mtime DESC LIMIT ?2",
        )
        .map_err(|e| format!("DB_PREPARE_FAILED: {}", e))?;
    let rows = stmt
        .query_map(rusqlite::params![phrase, limit.clamp(1, 100)], |r| {
            Ok(DocInfo {
                rel_path: r.get(0)?,
                scope: r.get(1)?,
                kind: r.get(2)?,
                title: r.get(3)?,
                mtime: r.get(4)?,
            })
        })
        .map_err(|e| format!("DB_QUERY_FAILED: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("DB_READ_FAILED: {}", e))?);
    }
    Ok(out)
}

/// Builds a ±`ctx`-char excerpt around the first occurrence of `query` in
/// `body`, matched case-insensitively. Falls back to the head of `body` when
/// the query appears nowhere in it (FTS can match the title column alone).
/// The match position is converted from the lowered string to a CHAR offset
/// before slicing the original, so a multibyte character is never cut in
/// half; newlines collapse to spaces for the UI.
pub fn snippet_around(body: &str, query: &str, ctx: usize) -> String {
    let trimmed = query.trim();
    let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() || flat.is_empty() {
        return String::new();
    }
    let lower = flat.to_lowercase();
    let needle = trimmed.to_lowercase();
    let out = match lower.find(&needle) {
        Some(byte_pos) => {
            let pos_chars = lower[..byte_pos].chars().count();
            let q_chars = trimmed.chars().count();
            let start = pos_chars.saturating_sub(ctx);
            let total = flat.chars().count();
            let end = (pos_chars + q_chars + ctx).min(total);
            let mut text = String::new();
            if start > 0 {
                text.push('…');
            }
            text.extend(flat.chars().skip(start).take(end - start));
            if end < total {
                text.push('…');
            }
            text
        }
        None => {
            let mut text: String = flat.chars().take(ctx * 2).collect();
            if flat.chars().count() > ctx * 2 {
                text.push('…');
            }
            text
        }
    };
    out.trim().to_string()
}

/// CJK bigram transform: every run of CJK chars becomes its overlapping
/// two-grams; other chars pass through. "茅台酒" → "茅台 台酒".
pub fn bigram(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if is_cjk(chars[i]) {
            let start = i;
            while i < chars.len() && is_cjk(chars[i]) {
                i += 1;
            }
            let run = &chars[start..i];
            if run.len() == 1 {
                out.push(run[0]);
            } else {
                for w in run.windows(2) {
                    out.push(w[0]);
                    out.push(w[1]);
                    out.push(' ');
                }
                out.pop(); // trailing space
            }
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

fn is_cjk(c: char) -> bool {
    // The main CJK ideograph blocks + common punctuation the corpus holds.
    matches!(c as u32,
        0x4E00..=0x9FFF       // CJK Unified Ideographs
        | 0x3400..=0x4DBF     // Extension A
        | 0xF900..=0xFAFF     // Compatibility Ideographs
    )
}

// ---------------------------------------------------------------------------
// Scope document directories (OpenViking-style: a README summary per scope,
// the agent scans it before reading anything else)
// ---------------------------------------------------------------------------

/// The directory of one scope (`stocks/<code>` / `sectors/<code>`), derived
/// strictly from the parsed scope — a scope string is never used as a path.
pub fn scope_dir(vault_root: &std::path::Path, scope: &str) -> Result<std::path::PathBuf, String> {
    let (kind, code) = crate::invest::model::parse_scope(scope)
        .filter(|(k, _)| matches!(*k, "stock" | "sector"))
        .ok_or_else(|| format!("INVALID_SCOPE: {scope}"))?;
    let safe = !code.is_empty()
        && !code.starts_with('.')
        && code
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !safe {
        return Err(format!("INVALID_SCOPE: {scope}"));
    }
    let dir_name = match kind {
        "stock" => "stocks",
        _ => "sectors",
    };
    Ok(crate::invest::root_dir(vault_root)
        .join(dir_name)
        .join(code))
}

/// Creates the scope's document skeleton when missing and registers every
/// file in the index. Returns the directory (absolute).
pub fn ensure_scope_docs(
    conn: &Connection,
    vault_root: &std::path::Path,
    scope: &str,
    title: &str,
) -> Result<std::path::PathBuf, String> {
    let dir = scope_dir(vault_root, scope)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("WRITE_FAILED: {} ({})", dir.display(), e))?;
    for (file, kind, default_body) in [
        ("README.md", "summary", readme_body(scope, title)),
        ("analysis.md", "analysis", analysis_body(title)),
        ("events.md", "event", events_body(title)),
    ] {
        let path = dir.join(file);
        if !path.exists() {
            std::fs::write(&path, default_body)
                .map_err(|e| format!("WRITE_FAILED: {} ({})", path.display(), e))?;
        }
        register_file(conn, scope, kind, &path)?;
    }
    Ok(dir)
}

/// Registers one file of a scope directory in the index (content-addressed).
fn register_file(
    conn: &Connection,
    scope: &str,
    kind: &str,
    path: &std::path::Path,
) -> Result<(), String> {
    let Some(rel) = path
        .to_str()
        .and_then(|p| p.rsplit(".bnote/invest/").next().map(|s| s.to_string()))
    else {
        return Err("INVALID_PATH: doc path is not UTF-8".to_string());
    };
    let content = std::fs::read_to_string(path).unwrap_or_default();
    let mtime = std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let hash = format!("{}-{}", mtime, content.len());
    let title = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("doc")
        .trim_end_matches(".md")
        .to_string();
    crate::invest::docs::index_doc(conn, &rel, scope, kind, &title, &content, mtime, &hash)?;
    Ok(())
}

/// Scans one scope's directory: every `.md` file, registered + listed (the
/// "open the directory, see every document" the right column tabs read).
pub fn list_scope_files(
    conn: &Connection,
    vault_root: &std::path::Path,
    scope: &str,
) -> Result<Vec<DocInfo>, String> {
    let dir = scope_dir(vault_root, scope)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let entries =
        std::fs::read_dir(&dir).map_err(|e| format!("READ_FAILED: {} ({})", dir.display(), e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        register_file(conn, scope, "note", &path)?;
        let rel = path
            .to_str()
            .and_then(|p| p.rsplit(".bnote/invest/").next().map(|s| s.to_string()))
            .unwrap_or_default();
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let title = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("doc")
            .trim_end_matches(".md")
            .to_string();
        out.push(DocInfo {
            rel_path: rel,
            scope: scope.to_string(),
            kind: "note".into(),
            title,
            mtime,
        });
    }
    out.sort_by(|a, b| {
        doc_order(&a.title)
            .cmp(&doc_order(&b.title))
            .then(a.title.cmp(&b.title))
    });
    Ok(out)
}

/// README first, analysis second, the rest alphabetical — the fixed tabs the
/// UI shows before user-created documents.
fn doc_order(title: &str) -> i32 {
    match title {
        "README" => 0,
        "analysis" => 1,
        "events" => 2,
        _ => 3,
    }
}

/// Reads one document by its index-relative path. Only paths under
/// `.bnote/invest/` are allowed, and `..` never passes.
pub fn read_doc(vault_root: &std::path::Path, rel_path: &str) -> Result<String, String> {
    let root = crate::invest::root_dir(vault_root);
    let path = root.join(rel_path);
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.clone());
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("READ_FAILED: {} ({})", path.display(), e))?;
    if !canonical.starts_with(&canonical_root) {
        return Err(format!("INVALID_PATH: {rel_path} escapes the invest root"));
    }
    std::fs::read_to_string(&canonical)
        .map_err(|e| format!("READ_FAILED: {} ({})", canonical.display(), e))
}

/// Writes one document by its index-relative path (same containment rule),
/// refreshing the index row.
pub fn write_doc(
    conn: &Connection,
    vault_root: &std::path::Path,
    rel_path: &str,
    content: &str,
    scope: &str,
    kind: &str,
) -> Result<(), String> {
    if rel_path
        .split('/')
        .any(|seg| seg == ".." || seg.starts_with('.'))
    {
        return Err(format!("INVALID_PATH: {rel_path}"));
    }
    let path = crate::invest::root_dir(vault_root).join(rel_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("WRITE_FAILED: {} ({})", parent.display(), e))?;
    }
    std::fs::write(&path, content)
        .map_err(|e| format!("WRITE_FAILED: {} ({})", path.display(), e))?;
    register_file(conn, scope, kind, &path)?;
    Ok(())
}

fn readme_body(scope: &str, title: &str) -> String {
    format!(
        "# {title}\n\n- **作用域**: `{scope}`\n- **说明**: 本目录收纳与「{title}」相关的全部文档；Agent 先读本卡再决定读哪些文档。\n\n## 文档目录\n- `analysis.md` — 分析结论（时间倒序追加）\n- `events.md` — 事件时间线（摄取管线自动追加）\n"
    )
}

fn analysis_body(title: &str) -> String {
    format!("# {title} · 分析结论\n\n> 用户与 Agent 的结论按时间倒序追加。格式：`## YYYY-MM-DD 结论标题`\n\n")
}

fn events_body(title: &str) -> String {
    format!("# {title} · 事件时间线\n\n> 由摄取管线与用户手动追加。\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::path::PathBuf;

    fn temp_vault(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bnote-invest-docs-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scope_docs_create_list_read_write() {
        let conn = Connection::open_in_memory().unwrap();
        crate::invest::db::migrate(&conn).unwrap();
        let vault = temp_vault("crud");

        let dir = ensure_scope_docs(&conn, &vault, "stock:600519", "贵州茅台").unwrap();
        assert!(dir.join("README.md").exists());
        assert!(dir.join("analysis.md").exists());
        assert!(dir.join("events.md").exists());

        let files = list_scope_files(&conn, &vault, "stock:600519").unwrap();
        let titles: Vec<&str> = files.iter().map(|f| f.title.as_str()).collect();
        assert_eq!(
            titles,
            vec!["README", "analysis", "events"],
            "fixed tab order"
        );

        // Write + read through the containment-checked helpers.
        write_doc(
            &conn,
            &vault,
            "stocks/600519/analysis.md",
            "# 茅台分析\n提价预期",
            "stock:600519",
            "analysis",
        )
        .unwrap();
        let content = read_doc(&vault, "stocks/600519/analysis.md").unwrap();
        assert!(content.contains("提价预期"));

        // A user-created doc joins the list after the fixed ones.
        write_doc(
            &conn,
            &vault,
            "stocks/600519/thoughts.md",
            "随想",
            "stock:600519",
            "note",
        )
        .unwrap();
        let files = list_scope_files(&conn, &vault, "stock:600519").unwrap();
        assert_eq!(files.len(), 4);
        assert_eq!(files[3].title, "thoughts");

        // Escapes are rejected.
        assert!(read_doc(&vault, "../vault.json").is_err());
        assert!(write_doc(&conn, &vault, "stocks/../../evil.md", "x", "s", "note").is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn scope_dirs_are_strict() {
        let vault = temp_vault("strict");
        assert!(scope_dir(&vault, "stock:600519")
            .unwrap()
            .ends_with("stocks/600519"));
        assert!(scope_dir(&vault, "sector:801120")
            .unwrap()
            .ends_with("sectors/801120"));
        assert!(scope_dir(&vault, "market").is_err());
        assert!(
            scope_dir(&vault, "portfolio:x").is_err(),
            "portfolio docs live under skills, not scope dirs"
        );
        assert!(scope_dir(&vault, "stock:../x").is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn bigram_transforms_cjk_and_keeps_ascii() {
        assert_eq!(bigram("茅台酒"), "茅台 台酒");
        assert_eq!(bigram("AB"), "AB");
        assert_eq!(bigram("AI 芯片"), "AI 芯片");
        assert_eq!(bigram("单"), "单");
    }

    #[test]
    fn snippet_cuts_a_char_safe_window() {
        // A CJK window: the excerpt shows the phrase with ellipses both sides
        // (the hit sits deep enough that both sides get clipped).
        let body = "白酒板块龙头地位稳固。提价预期升温带动估值修复。渠道库存健康。";
        let s = snippet_around(body, "提价预期", 6);
        assert!(s.contains("提价预期"));
        assert!(s.starts_with('…'));
        assert!(s.ends_with('…'));
        // Head hit: no leading ellipsis.
        let head = snippet_around("白酒龙头，提价预期升温。", "白酒", 4);
        assert!(head.starts_with("白酒"));
        assert!(!head.starts_with('…'));
        // Title-only match (the query is absent from the body) falls back to
        // the body head with a trailing ellipsis.
        let fallback = snippet_around("茅台酒是高端消费代表", "白酒", 2);
        assert!(fallback.starts_with("茅台"));
        assert!(fallback.ends_with('…'));
        let ascii = snippet_around("MAOTAI strong brand. 提价预期升温", "STRONG", 4);
        assert!(ascii.contains("strong"), "case-insensitive ASCII hit");
        // Empty query / empty body never panic.
        assert_eq!(snippet_around("", "茅台", 4), "");
        assert_eq!(snippet_around("正文", "  ", 4), "");
    }

    #[test]
    fn index_search_and_remove() {
        let conn = Connection::open_in_memory().unwrap();
        crate::invest::db::migrate(&conn).unwrap();
        index_doc(
            &conn,
            "stocks/600519/analysis.md",
            "stock:600519",
            "analysis",
            "贵州茅台分析",
            "白酒龙头，高端消费代表，主要产品为茅台酒。",
            100,
            "h1",
        )
        .unwrap();
        // Same hash: no re-index (still one row).
        assert!(!index_doc(
            &conn,
            "stocks/600519/analysis.md",
            "stock:600519",
            "analysis",
            "贵州茅台分析",
            "白酒龙头，高端消费代表，主要产品为茅台酒。",
            101,
            "h1"
        )
        .unwrap());

        let hits = search(&conn, "茅台酒", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rel_path, "stocks/600519/analysis.md");

        let scoped = list_by_scope(&conn, "stock:600519").unwrap();
        assert_eq!(scoped.len(), 1);
        assert!(list_by_scope(&conn, "stock:000858").unwrap().is_empty());

        // Content change re-indexes; the new body is searchable.
        assert!(index_doc(
            &conn,
            "stocks/600519/analysis.md",
            "stock:600519",
            "analysis",
            "贵州茅台分析",
            "白酒龙头，2026 年提价预期升温。",
            102,
            "h2"
        )
        .unwrap());
        let hits = search(&conn, "提价", 10).unwrap();
        assert_eq!(hits.len(), 1);
        let stale = search(&conn, "高端消费代表", 10).unwrap();
        assert_eq!(stale.len(), 0, "the old body left the FTS mirror");

        assert!(remove_doc(&conn, "stocks/600519/analysis.md").unwrap());
        assert!(search(&conn, "提价", 10).unwrap().is_empty());
    }
}
