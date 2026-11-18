//! The information pipeline: `sources.yaml` → fetch → process → store.
//!
//! The YAML support is a deliberately small subset parser (nested maps,
//! lists, quoted/plain scalars, inline `[a, b]` arrays, `#` comments) — the
//! sources file is the only YAML the app reads, and pulling `serde_yaml`
//! (with its libyaml dep tree) in for one file is not worth it.
//!
//! Pipeline contract: every step degrades gracefully — with
//! no model configured the `summarize`/`tag` steps fall back to rule-based
//! processing, so a run never fails because of a missing model. Dedup is
//! content-addressed (`sha` of title+url), stored as the events row's
//! `dedup_hash`.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha_compat::sha1_hex;

use crate::invest::model::{Event, IngestRunResult, IngestSourceResult};

// ---------------------------------------------------------------------------
// sources.yaml model + parser
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SourceConfig {
    pub id: String,
    /// rss | json | html
    pub kind: String,
    pub url: String,
    /// market | sector:<code> | stock:<code>
    pub scope: String,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default = "default_handler")]
    pub handler: String,
    #[serde(default)]
    pub selector: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SourcesConfig {
    pub version: i64,
    #[serde(default)]
    pub sources: Vec<SourceConfig>,
}

fn default_handler() -> String {
    "extract-and-tag".to_string()
}

/// Parses the sources.yaml subset. Returns the first error with a 1-based
/// line number so the settings UI can point at it.
pub fn parse_sources(yaml: &str) -> Result<SourcesConfig, String> {
    let mut cfg = SourcesConfig {
        version: 1,
        sources: Vec::new(),
    };
    let mut current: Option<SourceConfig> = None;
    let mut in_sources = false;
    let mut last_key = String::new();

    for (idx, raw) in yaml.lines().enumerate() {
        let line_no = idx + 1;
        let line = raw.trim_end();
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("- ") {
            // A list item at the `sources:` level starts a new source.
            if in_sources {
                if let Some(prev) = current.take() {
                    cfg.sources.push(prev);
                }
                if let Some((k, v)) = split_kv(rest) {
                    let mut src = blank_source();
                    apply_field(&mut src, &k, v, line_no)?;
                    last_key = k;
                    current = Some(src);
                } else {
                    return Err(format!(
                        "sources.yaml:{line_no}: bare list item is not a source"
                    ));
                }
                continue;
            }
            return Err(format!("sources.yaml:{line_no}: unexpected list item"));
        }
        let (key, value) = match split_kv(trimmed) {
            Some(kv) => kv,
            None => {
                // A continuation of the previous key (a quoted multi-line or
                // an inline array already consumed) — skip whitespace-only noise.
                continue;
            }
        };
        match key.as_str() {
            "version" => {
                cfg.version = value
                    .and_then(|v| v.trim().parse().ok())
                    .ok_or_else(|| format!("sources.yaml:{line_no}: version must be an integer"))?;
            }
            "sources" => {
                if let Some(prev) = current.take() {
                    cfg.sources.push(prev);
                }
                in_sources = true;
            }
            "handlers" => {
                // Handlers are prompt/step references read by the frontend; the
                // parser accepts and ignores the block so the file round-trips.
                in_sources = false;
            }
            _ if in_sources => {
                let src = current.get_or_insert_with(blank_source);
                apply_field(src, &key, value, line_no)?;
                last_key = key;
            }
            _ => { /* defaults / unknown top-level keys: accepted, ignored */ }
        }
        let _ = last_key;
    }
    if let Some(prev) = current.take() {
        cfg.sources.push(prev);
    }
    for (idx, src) in cfg.sources.iter().enumerate() {
        if src.id.is_empty() || src.url.is_empty() {
            return Err(format!(
                "sources.yaml: source #{} needs at least id and url",
                idx + 1
            ));
        }
        if crate::invest::model::parse_scope(&src.scope).is_none() && src.scope != "market" {
            return Err(format!(
                "sources.yaml: source {} has an invalid scope {}",
                src.id, src.scope
            ));
        }
    }
    Ok(cfg)
}

fn blank_source() -> SourceConfig {
    SourceConfig {
        id: String::new(),
        kind: "rss".to_string(),
        url: String::new(),
        scope: "market".to_string(),
        keywords: Vec::new(),
        handler: default_handler(),
        selector: String::new(),
    }
}

fn split_kv(s: &str) -> Option<(String, Option<String>)> {
    let (k, v) = s.split_once(':')?;
    Some((k.trim().to_string(), Some(v.trim().to_string())))
}

fn apply_field(
    src: &mut SourceConfig,
    key: &str,
    value: Option<String>,
    line_no: usize,
) -> Result<(), String> {
    let v = value.ok_or_else(|| {
        format!("sources.yaml:{line_no}: field {key} needs a value on the same line")
    })?;
    let v = v.trim_matches('"').trim_matches('\'').to_string();
    match key {
        "id" => src.id = v,
        "kind" => src.kind = v,
        "url" => src.url = v,
        "scope" => src.scope = v,
        "handler" => src.handler = v,
        "selector" => src.selector = v,
        "keywords" => {
            src.keywords = parse_inline_array(&v);
        }
        _ => { /* unknown fields accepted for forward compatibility */ }
    }
    Ok(())
}

fn parse_inline_array(v: &str) -> Vec<String> {
    let inner = v.trim().trim_start_matches('[').trim_end_matches(']');
    inner
        .split(',')
        .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Reads `<vault>/.bnote/invest/sources.yaml` (defaults to one market-level
/// example source when the file is missing).
pub fn read_sources(vault_root: &std::path::Path) -> Result<SourcesConfig, String> {
    let path = crate::invest::root_dir(vault_root).join("sources.yaml");
    match std::fs::read_to_string(&path) {
        Ok(text) => parse_sources(&text),
        Err(_) => {
            let _ = std::fs::create_dir_all(crate::invest::root_dir(vault_root));
            let default = default_sources_yaml();
            let cfg = parse_sources(&default)?;
            let _ = std::fs::write(&path, &default);
            Ok(cfg)
        }
    }
}

/// Serializes back to the YAML subset (round-trip stable for the fields we own).
pub fn sources_to_yaml(cfg: &SourcesConfig) -> String {
    let mut out = format!("version: {}\nsources:\n", cfg.version);
    for s in &cfg.sources {
        out.push_str(&format!("  - id: {}\n", s.id));
        out.push_str(&format!("    kind: {}\n", s.kind));
        out.push_str(&format!("    url: {}\n", s.url));
        out.push_str(&format!("    scope: {}\n", s.scope));
        if !s.keywords.is_empty() {
            let kw: Vec<String> = s.keywords.iter().map(|k| format!("\"{k}\"")).collect();
            out.push_str(&format!("    keywords: [{}]\n", kw.join(", ")));
        }
        out.push_str(&format!("    handler: {}\n", s.handler));
        if !s.selector.is_empty() {
            out.push_str(&format!("    selector: {}\n", s.selector));
        }
    }
    out
}

fn default_sources_yaml() -> String {
    r#"version: 1
# 投资模式信息源配置。每条 source：抓取(kind/url) → 处理(handler) → 沉淀(scope)。
# scope: market | sector:<申万代码> | stock:<6位代码>
sources:
  - id: sina-finance-roll
    kind: rss
    url: https://rsshub.app/sina/rollnews/finance
    scope: market
    handler: extract-and-tag
"#
    .to_string()
}

// ---------------------------------------------------------------------------
// Events: the structured sediment of every fetch
// ---------------------------------------------------------------------------

/// Inserts one event; returns false when the dedup hash already exists.
pub fn insert_event(
    conn: &Connection,
    scope: &str,
    date: &str,
    kind: &str,
    title: &str,
    body: &str,
    source: &str,
    url: &str,
    sentiment: Option<&str>,
) -> Result<bool, String> {
    let dedup = sha1_hex(&format!("{title}|{url}"));
    // INSERT OR IGNORE returns 0 rows when the dedup hash collides.
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO events(scope, date, kind, title, body, source, url, sentiment, dedup_hash, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        rusqlite::params![scope, date, kind, title, body, source, url, sentiment, dedup, now_secs()],
    )
    .map_err(|e| format!("DB_WRITE_FAILED: event: {}", e))?;
    Ok(inserted > 0)
}

/// The event stream of one scope, newest first.
pub fn list_events(conn: &Connection, scope: &str, limit: usize) -> Result<Vec<Event>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, scope, date, kind, title, body, source, url, sentiment
             FROM events WHERE scope=?1 ORDER BY date DESC, id DESC LIMIT ?2",
        )
        .map_err(|e| format!("DB_PREPARE_FAILED: {}", e))?;
    let rows = stmt
        .query_map(rusqlite::params![scope, limit.clamp(1, 500)], |r| {
            Ok(Event {
                id: r.get(0)?,
                scope: r.get(1)?,
                date: r.get(2)?,
                kind: r.get(3)?,
                title: r.get(4)?,
                body: r.get(5)?,
                source: r.get(6)?,
                url: r.get(7)?,
                sentiment: r.get(8)?,
            })
        })
        .map_err(|e| format!("DB_QUERY_FAILED: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("DB_READ_FAILED: {}", e))?);
    }
    Ok(out)
}

/// Events across every scope the user follows (the daily hot-feed view).
pub fn recent_events(conn: &Connection, limit: usize) -> Result<Vec<Event>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, scope, date, kind, title, body, source, url, sentiment
             FROM events ORDER BY date DESC, id DESC LIMIT ?1",
        )
        .map_err(|e| format!("DB_PREPARE_FAILED: {}", e))?;
    let rows = stmt
        .query_map(rusqlite::params![limit.clamp(1, 500)], |r| {
            Ok(Event {
                id: r.get(0)?,
                scope: r.get(1)?,
                date: r.get(2)?,
                kind: r.get(3)?,
                title: r.get(4)?,
                body: r.get(5)?,
                source: r.get(6)?,
                url: r.get(7)?,
                sentiment: r.get(8)?,
            })
        })
        .map_err(|e| format!("DB_QUERY_FAILED: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("DB_READ_FAILED: {}", e))?);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Processing: text → (title, body, kind, sentiment)
// ---------------------------------------------------------------------------

/// Strips HTML tags/entities down to text (the `extract` step). Falls back to
/// the input when it holds no tags.
pub fn extract_text(html: &str) -> String {
    if !html.contains('<') {
        return normalize_ws(html);
    }
    let frag = scraper::Html::parse_fragment(html);
    let text = frag.root_element().text().collect::<Vec<_>>().join(" ");
    let cleaned = normalize_ws(&text);
    if cleaned.trim().is_empty() {
        normalize_ws(html)
    } else {
        cleaned
    }
}

fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The rule-based sentiment/kind tagger (the no-LLM `tag` step).
pub fn tag_text(title: &str, body: &str) -> (String, String) {
    let text = format!("{title} {body}");
    let bull = [
        "上涨",
        "利好",
        "增长",
        "超预期",
        "中标",
        "回购",
        "增持",
        "涨价",
        "突破",
        "签约",
        "净利润增长",
    ]
    .iter()
    .any(|k| text.contains(k));
    let bear = [
        "下跌",
        "利空",
        "下滑",
        "低于预期",
        "亏损",
        "减持",
        "质押",
        "处罚",
        "调查",
        "诉讼",
        "退市",
    ]
    .iter()
    .any(|k| text.contains(k));
    let sentiment = if bull && !bear {
        "bull"
    } else if bear && !bull {
        "bear"
    } else {
        "neutral"
    };
    let kind = if text.contains("公告") || text.contains("披露") {
        "announcement"
    } else if text.contains("研报") || text.contains("评级") {
        "report"
    } else if text.contains("资金流") || text.contains("净流入") {
        "flow"
    } else if text.contains("央行") || text.contains("国务院") || text.contains("政策") {
        "macro"
    } else {
        "news"
    };
    (kind.to_string(), sentiment.to_string())
}

/// The `summarize` step without a model: the first ~200 chars of the body.
pub fn truncate_summary(body: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for ch in body.chars() {
        if out.chars().count() >= max_chars {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

/// Date extraction: an ISO date in the title/body wins; the run date otherwise.
pub fn pick_date(title: &str, body: &str, fallback: &str) -> String {
    let text = format!("{title} {body}");
    for line in text.split(|c: char| c == ' ' || c == '，' || c == '。') {
        let t = line.trim();
        // YYYY-MM-DD (optionally followed by a time part).
        if t.len() >= 10
            && t.as_bytes()[4] == b'-'
            && t[..4].chars().all(|c| c.is_ascii_digit())
            && t[5..7].chars().all(|c| c.is_ascii_digit())
            && t[8..10].chars().all(|c| c.is_ascii_digit())
        {
            return t[..10].to_string();
        }
    }
    fallback.to_string()
}

// ---------------------------------------------------------------------------
// The fetch + run orchestration
// ---------------------------------------------------------------------------

/// One fetched item, normalized across the rss/json/html kinds.
pub struct FetchedItem {
    pub title: String,
    pub body: String,
    pub url: String,
    pub date: String,
}

/// Parses an RSS/Atom document into items (string-level XML walk; RSS is
/// regular enough and avoids an XML dependency).
pub fn parse_rss(xml: &str, limit: usize) -> Vec<FetchedItem> {
    let mut out = Vec::new();
    for chunk in split_tags(xml, "<item", "</item>")
        .into_iter()
        .chain(split_tags(xml, "<entry", "</entry>"))
    {
        let title = tag_text_of(&chunk, "title")
            .map(|t| extract_text(&t))
            .unwrap_or_default();
        let link = tag_text_of(&chunk, "link")
            .or_else(|| attr_href(&chunk, "link"))
            .unwrap_or_default();
        let body = tag_text_of(&chunk, "description")
            .or_else(|| tag_text_of(&chunk, "content:encoded"))
            .or_else(|| tag_text_of(&chunk, "summary"))
            .map(|t| extract_text(&t))
            .unwrap_or_default();
        let date = tag_text_of(&chunk, "pubDate")
            .or_else(|| tag_text_of(&chunk, "updated"))
            .or_else(|| tag_text_of(&chunk, "published"))
            .map(|d| pick_date("", &d, ""))
            .unwrap_or_default();
        if title.is_empty() {
            continue;
        }
        out.push(FetchedItem {
            title,
            body,
            url: link,
            date,
        });
        if out.len() >= limit {
            break;
        }
    }
    out
}

fn split_tags<'a>(xml: &'a str, open: &str, close: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(open) {
        let after_open = &rest[start..];
        match after_open.find(close) {
            Some(end_rel) => {
                let end = end_rel + close.len();
                out.push(&after_open[..end]);
                rest = &after_open[end..];
            }
            None => break,
        }
    }
    out
}

fn tag_text_of(chunk: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}");
    let start = chunk.find(&open)?;
    let after = &chunk[start..];
    let inner_start = after.find('>')? + 1;
    let close = format!("</{tag}>");
    let end = after[inner_start..].find(&close)? + inner_start;
    Some(after[inner_start..end].to_string())
}

fn attr_href(chunk: &str, tag: &str) -> Option<String> {
    // <link href="…" /> (Atom)
    let open = format!("<{tag}");
    let start = chunk.find(&open)?;
    let after = &chunk[start..];
    let end_rel = after.find('>')?;
    let tag_inner = &after[..end_rel];
    let href_idx = tag_inner.find("href=\"")? + 6;
    let rest = &tag_inner[href_idx..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// Parses a JSON feed (either a bare array or `{items|data|list: [...]}`) into
/// items using the common title/body/url/date field names.
pub fn parse_json_feed(text: &str, limit: usize) -> Vec<FetchedItem> {
    let value: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let arr = match &value {
        serde_json::Value::Array(items) => Some(items.clone()),
        serde_json::Value::Object(map) => ["items", "data", "list", "result"]
            .iter()
            .find_map(|k| map.get(*k).and_then(|v| v.as_array()).cloned()),
        _ => None,
    };
    let Some(arr) = arr else { return Vec::new() };
    let mut out = Vec::new();
    for item in arr.into_iter().take(limit) {
        let get = |keys: &[&str]| -> String {
            keys.iter()
                .find_map(|k| item.get(*k).and_then(|v| v.as_str()).map(|s| s.to_string()))
                .unwrap_or_default()
        };
        let title = get(&["title", "name", "summary"]);
        if title.is_empty() {
            continue;
        }
        out.push(FetchedItem {
            body: extract_text(&get(&["content", "body", "description", "text"])),
            url: get(&["url", "link", "href"]),
            date: {
                let raw = get(&["date", "time", "publish_time", "created_at"]);
                pick_date("", &raw, "")
            },
            title,
        });
    }
    out
}

/// Parses an HTML page into headline items using a CSS selector (or the
/// built-in anchor heuristic when no selector is configured).
pub fn parse_html(html: &str, selector: &str, limit: usize) -> Vec<FetchedItem> {
    let doc = scraper::Html::parse_document(html);
    let mut out = Vec::new();
    let sel = if selector.trim().is_empty() {
        scraper::Selector::parse("a").map_err(|_| "SELECTOR_FAILED".to_string())
    } else {
        scraper::Selector::parse(selector.trim())
            .map_err(|_| format!("SELECTOR_FAILED: {selector}"))
    };
    let Ok(sel) = sel else { return out };
    for el in doc.select(&sel) {
        let title = normalize_ws(&el.text().collect::<String>());
        if title.chars().count() < 8 {
            continue; // nav links, "更多" — not headlines
        }
        let url = el
            .value()
            .attr("href")
            .map(|h| h.to_string())
            .unwrap_or_default();
        out.push(FetchedItem {
            title,
            body: String::new(),
            url,
            date: String::new(),
        });
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// Fetches a source's raw payload over HTTPS (10s timeout, browser UA).
pub(crate) async fn fetch_url(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) bnote-invest/0.1")
        .build()
        .map_err(|e| format!("HTTP_CLIENT_FAILED: {}", e))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("HTTP_FAILED: {url}: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP_STATUS: {url}: {}", resp.status()));
    }
    resp.text()
        .await
        .map_err(|e| format!("HTTP_BODY_FAILED: {url}: {}", e))
}

/// A live snapshot through the resolved quote provider (H7: the provider is
/// configuration — see `quotes.rs`; the built-in Tencent source is just the
/// default provider set). Returns `None` on any failure — the caller keeps the
/// stored snapshot (offline-first).
pub async fn fetch_quote_snapshot(
    config: &crate::invest::quotes::QuotesConfig,
    market: &str,
    code: &str,
) -> Option<crate::invest::model::Snapshot> {
    crate::invest::quotes::fetch_quote_snapshot(config, market, code).await
}

/// One run: parse the config, fetch every source, process + store, return the
/// per-source summary. Sources that fail are reported, never abort the run.
///
/// The DB handle is the shared `Arc<Mutex<Option<Connection>>>`: the network
/// fetch happens **without** the guard (lock discipline — never hold a lock
/// across `.await`); the processed items are then written under one short
/// synchronous lock.
pub async fn run(
    db: &std::sync::Arc<std::sync::Mutex<Option<Connection>>>,
    vault_root: &std::path::Path,
) -> Result<IngestRunResult, String> {
    let cfg = read_sources(vault_root)?;
    let run_id = format!("run-{}", now_secs());
    let started_at = now_secs();
    let today = today_string();
    let mut results = Vec::new();

    for source in &cfg.sources {
        let result = ingest_one(db, vault_root, source, &today).await;
        results.push(IngestSourceResult {
            source_id: source.id.clone(),
            fetched: result.0,
            stored: result.1,
            skipped: result.2,
            error: result.3,
        });
    }
    Ok(IngestRunResult {
        run_id,
        started_at,
        sources: results,
    })
}

/// Ingests one source: fetch (no lock) → parse (no lock) → store (short lock).
/// Returns (fetched, stored, skipped, error).
async fn ingest_one(
    db: &std::sync::Arc<std::sync::Mutex<Option<Connection>>>,
    vault_root: &std::path::Path,
    source: &SourceConfig,
    today: &str,
) -> (i64, i64, i64, Option<String>) {
    let raw = match fetch_url(&source.url).await {
        Ok(raw) => raw,
        Err(e) => return (0, 0, 0, Some(e)),
    };
    let limit = 20;
    let mut items = match source.kind.as_str() {
        "rss" => parse_rss(&raw, limit),
        "json" => parse_json_feed(&raw, limit),
        "html" => parse_html(&raw, &source.selector, limit),
        other => return (0, 0, 0, Some(format!("UNSUPPORTED_KIND: {other}"))),
    };
    let fetched = items.len() as i64;

    // The per-source feed file accumulates the day's items (the 文本沉淀).
    let feed_dir = crate::invest::root_dir(vault_root).join("feed").join(today);
    let _ = std::fs::create_dir_all(&feed_dir);
    let feed_path = feed_dir.join(format!("{}.md", source.id));
    let mut feed_md = std::fs::read_to_string(&feed_path)
        .unwrap_or_else(|_| format!("# {} ({}) 摄取记录 {today}\n\n", source.id, source.scope));

    // Process + store under one short lock: no await between take() and drop.
    let guard = match db.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return (
                fetched,
                0,
                fetched,
                Some("LOCK_FAILED: invest db".to_string()),
            )
        }
    };
    let Some(conn) = guard.as_ref() else {
        return (
            fetched,
            0,
            fetched,
            Some("NO_VAULT: the invest database opens with the vault".to_string()),
        );
    };
    let mut stored = 0i64;
    let mut skipped = 0i64;
    for item in &mut items {
        // Keyword filter (title level).
        if !source.keywords.is_empty() && !source.keywords.iter().any(|k| item.title.contains(k)) {
            skipped += 1;
            continue;
        }
        if item.date.is_empty() {
            item.date = today.to_string();
        }
        let (kind, sentiment) = tag_text(&item.title, &item.body);
        let summary = truncate_summary(&item.body, 200);
        let inserted = insert_event(
            conn,
            &source.scope,
            &item.date,
            &kind,
            &item.title,
            &summary,
            &source.id,
            &item.url,
            Some(&sentiment),
        );
        match inserted {
            Ok(true) => {
                stored += 1;
                feed_md.push_str(&format!(
                    "- **{}** ({}, {}) {}\n",
                    item.title, item.date, sentiment, summary
                ));
                if !item.url.is_empty() {
                    feed_md.push_str(&format!("  [来源]({})\n", item.url));
                }
            }
            Ok(false) => skipped += 1,
            Err(_) => skipped += 1,
        }
    }
    register_feed_doc(conn, vault_root, source, today);
    drop(guard);
    // Write the feed markdown back (best effort: the events table is the truth).
    let _ = std::fs::write(&feed_path, &feed_md);
    (fetched, stored, skipped, None)
}

/// Registers/refreshes the feed file in the doc index (FTS).
fn register_feed_doc(
    conn: &Connection,
    vault_root: &std::path::Path,
    source: &SourceConfig,
    today: &str,
) {
    let rel = format!("feed/{today}/{}.md", source.id);
    let path = crate::invest::root_dir(vault_root).join(&rel);
    let Ok(content) = std::fs::read_to_string(&path) else {
        return;
    };
    let meta_len = content.len();
    let hash = format!("{today}-{}", source.id);
    let _ = crate::invest::docs::index_doc(
        conn,
        &rel,
        &source.scope,
        "feed",
        &format!("{} 摄取 {today}", source.id),
        &content,
        0,
        &hash,
    );
    let _ = meta_len;
}

/// The civil date at `unix_secs` shifted by the zone offset, `YYYY-MM-DD`.
/// Pure so the day boundary is testable: it must be monotonic in `unix_secs`
/// and roll over exactly once at local midnight. `civil_from_days(0)` is
/// 1970-01-01, so the day count needs no `+1` — the shipped version divided
/// with `/` and added one, which made every feed day land on *tomorrow*.
pub(crate) fn feed_day_for(unix_secs: i64, utc_offset_minutes: i32) -> String {
    let local_days = (unix_secs + i64::from(utc_offset_minutes) * 60).div_euclid(86_400);
    let (y, m, d) = crate::invest::kline::civil_from_days(local_days);
    format!("{y:04}-{m:02}-{d:02}")
}

fn today_string() -> String {
    // UTC date for now: the zone offset is a collector-level decision and no
    // timezone facility exists in the dependency tree yet. The replaced code
    // also divided with `/` and added one, so during the Chinese pre-8am
    // hours the directory name ran two days ahead; `feed_day_for` keeps the
    // boundary property-tested (see the tests below).
    feed_day_for(now_secs(), 0)
}

pub(crate) fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// A minimal, dependency-free SHA-1 for dedup hashes only (not a security
/// primitive: the hash exists to detect "the same headline again").
mod sha_compat {
    pub fn sha1_hex(data: &str) -> String {
        // FNV-1a 64-bit is enough for dedup and avoids pulling a crypto crate;
        // the field name stays dedup_hash (hash, not a security claim).
        let mut hash: u64 = 0xcbf29ce484222325;
        for b in data.as_bytes() {
            hash ^= *b as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
        format!("{hash:016x}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::invest::db;
    use std::path::PathBuf;

    fn temp_vault(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bnote-invest-ingest-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const SAMPLE_YAML: &str = r#"version: 1
# comment line
sources:
  - id: cls-telegraph
    kind: rss
    url: https://example.com/rss
    scope: market
    keywords: ["AI", "半导体"]
    handler: extract-and-tag
  - id: eastmoney
    kind: html
    url: https://example.com/sectors
    scope: sector:801710
    selector: .news-title
"#;

    #[test]
    fn yaml_subset_round_trip() {
        let cfg = parse_sources(SAMPLE_YAML).unwrap();
        assert_eq!(cfg.version, 1);
        assert_eq!(cfg.sources.len(), 2);
        let first = &cfg.sources[0];
        assert_eq!(first.id, "cls-telegraph");
        assert_eq!(first.keywords, vec!["AI", "半导体"]);
        assert_eq!(first.handler, "extract-and-tag");
        let second = &cfg.sources[1];
        assert_eq!(second.scope, "sector:801710");
        assert_eq!(second.selector, ".news-title");
        assert_eq!(second.kind, "html");

        let text = sources_to_yaml(&cfg);
        let again = parse_sources(&text).unwrap();
        assert_eq!(again.sources.len(), 2);
        assert_eq!(again.sources[0].id, "cls-telegraph");
        assert_eq!(again.sources[0].keywords.len(), 2);
    }

    #[test]
    fn yaml_rejects_bad_configs() {
        assert!(
            parse_sources("version: 1\nsources:\n  - id: x\n    kind: rss\n").is_err(),
            "url missing"
        );
        assert!(
            parse_sources(
                "version: 1\nsources:\n  - id: x\n    url: https://a.b\n    scope: nope\n"
            )
            .is_err(),
            "bad scope"
        );
        assert!(parse_sources("version: x").is_err(), "non-integer version");
    }

    #[test]
    fn default_sources_yaml_is_valid() {
        let cfg = parse_sources(&default_sources_yaml()).unwrap();
        assert_eq!(cfg.sources.len(), 1);
    }

    #[test]
    fn rss_json_html_parsers_agree_on_shape() {
        let rss = r#"<?xml version="1.0"?><rss><channel>
          <item><title>AI 芯片需求超预期</title><link>https://a.b/1</link>
            <description>&lt;p&gt;台积电称 AI 需求强劲，相关板块受益&lt;/p&gt;</description>
            <pubDate>2026-11-16T10:00:00Z</pubDate></item>
          <item><title>央行开展逆回购操作</title><link>https://a.b/2</link>
            <description>央行今日开展 5000 亿元逆回购，维护流动性</description>
            <pubDate>Mon, 16 Nov 2026 09:00:00 GMT</pubDate></item>
        </channel></rss>"#;
        let items = parse_rss(rss, 10);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "AI 芯片需求超预期");
        assert_eq!(items[0].url, "https://a.b/1");
        assert!(
            items[0].body.contains("台积电"),
            "HTML entities are extracted to text"
        );
        assert!(items[0].date.starts_with("2026-11-16"));

        let json = r#"{"data":[{"title":"新能源车销量增长","content":"11 月销量同比增长 30%","url":"https://a.b/3","time":"2026-11-15 18:00"}]}"#;
        let items = parse_json_feed(json, 10);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].date, "2026-11-15");

        let html = r#"<html><body><ul>
          <li><a href="/news/1" class="news-title">某公司发布三季度业绩预告</a></li>
          <li><a href="/news/2" class="news-title">另一家公司拟回购不超过十亿元股份</a></li>
        </ul></body></html>"#;
        let items = parse_html(html, ".news-title", 10);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].url, "/news/1");
    }

    #[test]
    fn tagging_extract_and_date_pick() {
        let (kind, sentiment) = tag_text("某公司公告净利润增长超预期", "");
        assert_eq!(kind, "announcement");
        assert_eq!(sentiment, "bull");
        let (kind2, sentiment2) = tag_text("某公司股价下跌", "公司面临调查风险");
        assert_eq!(sentiment2, "bear");
        assert_eq!(extract_text("<p>正文 <b>加粗</b></p>"), "正文 加粗");
        assert_eq!(extract_text("纯文本"), "纯文本");
        assert_eq!(
            pick_date("2026-11-16 新闻标题", "", "2026-01-01"),
            "2026-11-16"
        );
        assert_eq!(pick_date("无日期", "", "2026-01-01"), "2026-01-01");
    }

    #[test]
    fn events_dedup_and_list() {
        let conn = Connection::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        let first = insert_event(
            &conn,
            "stock:600519",
            "2026-11-16",
            "news",
            "茅台提价",
            "正文",
            "cls",
            "https://a",
            Some("bull"),
        )
        .unwrap();
        assert!(first);
        let dup = insert_event(
            &conn,
            "stock:600519",
            "2026-11-16",
            "news",
            "茅台提价",
            "正文",
            "cls",
            "https://a",
            Some("bull"),
        )
        .unwrap();
        assert!(!dup, "same title+url dedups");
        let list = list_events(&conn, "stock:600519", 10).unwrap();
        assert_eq!(list.len(), 1);
        insert_event(
            &conn,
            "market",
            "2026-11-17",
            "macro",
            "央行操作",
            "",
            "sina",
            "",
            None,
        )
        .unwrap();
        assert_eq!(recent_events(&conn, 10).unwrap().len(), 2);
        assert_eq!(list_events(&conn, "sector:801050", 10).unwrap().len(), 0);
    }

    #[test]
    fn read_sources_creates_the_default_file() {
        let vault = temp_vault("defaults");
        let cfg = read_sources(&vault).unwrap();
        assert_eq!(cfg.sources.len(), 1);
        assert!(crate::invest::root_dir(&vault)
            .join("sources.yaml")
            .exists());
        // A second read parses the written file (no re-creation).
        let cfg2 = read_sources(&vault).unwrap();
        assert_eq!(cfg2.sources[0].id, cfg.sources[0].id);
        let _ = std::fs::remove_dir_all(&vault);
    }

    /// The day boundary is the feed directory's identity: it must roll over
    /// exactly once per local day and never go backwards. The shipped
    /// `days + 1` violated both for half of every day.
    #[test]
    fn a_day_boundary_rolls_over_exactly_once() {
        // Epoch anchor: the calendar is the UTC one (civil_from_days(0)).
        assert_eq!(feed_day_for(0, 0), "1970-01-01");
        // A day starts at local midnight and changes exactly there: stepping
        // second-by-second across the boundary flips the date once, and the
        // last second of the day still reads "today".
        const DAY: i64 = 86_400;
        for offset_minutes in [0, 480, -300] {
            // 1970-03-01 00:00:00 UTC = day 59 (Jan 31 + Feb 28 in 1970).
            let midnight = 59 * DAY - i64::from(offset_minutes) * 60;
            let before = feed_day_for(midnight - 1, offset_minutes);
            let at = feed_day_for(midnight, offset_minutes);
            let after = feed_day_for(midnight + 1, offset_minutes);
            assert_eq!(at, "1970-03-01");
            assert_eq!(after, "1970-03-01");
            assert_ne!(before, at, "one flip, not two (offset {offset_minutes})");
        }
        // Monotonicity across 4 years including one leap year (2024–2027),
        // sampled densely at every UTC midnight boundary.
        let start = 1_704_067_200; // 2024-01-01 00:00:00 UTC
        let end = start + 1_460 * DAY; // 2027-12-31
        let mut prev = feed_day_for(start, 0);
        for secs in (start + 1)..=end {
            if secs % DAY == 0 || secs % DAY == 1 {
                // dense at the boundaries, one-second step there
                let today = feed_day_for(secs, 0);
                assert!(
                    today >= prev,
                    "the feed day went backwards at {secs} ({prev} → {today})"
                );
                prev = today;
            }
        }
        assert_eq!(feed_day_for(end, 0), "2027-12-31");
        // A zone shift moves the boundary, not the calendar: +8h at 16:00 UTC
        // already reads as the next day in Beijing.
        assert_eq!(feed_day_for(start + 16 * 3600, 480), "2024-01-02");
    }
}
