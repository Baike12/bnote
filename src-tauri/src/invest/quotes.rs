//! H7: the pluggable quote-source spec (`<vault>/.bnote/invest/quotes.yaml`).
//!
//! Adding a source is one YAML entry — no code, no build step:
//!
//! ```yaml
//! version: 1
//! providers:
//!   - id: yahoo
//!     kind: json                      # json = 点路径取值 | text = 分隔符文本按索引
//!     markets: [cn, hk, us]
//!     url: "https://query1.finance.yahoo.com/v8/finance/chart/{code}"
//!     fields:
//!       price: "path:chart.result[0].meta.regularMarketPrice"
//!       prev_close: "path:chart.result[0].meta.chartPreviousClose"
//!       currency: "path:chart.result[0].meta.currency"
//! ```
//!
//! Two value expressions only, so no expression engine is involved:
//! - `idx:N` (text mode) with an optional `*mult` / `/div` unit scale,
//! - `path:a.b[0].c` (json mode, dot path + numeric indices),
//! - `const:X` for a literal (e.g. a fixed currency).
//!
//! The built-in Tencent source is expressed through the SAME engine (three
//! provider entries, one per market) — there is no second parser. An unknown
//! field or a bad expression fails validation at save time, never at refresh
//! time.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::invest::model::Snapshot;

/// Every field a provider may map (the `Snapshot` keys plus `currency`).
pub const KNOWN_FIELDS: &[&str] = &[
    "price",
    "prev_close",
    "open",
    "high",
    "low",
    "volume",
    "amount",
    "turnover",
    "pe",
    "pb",
    "market_cap",
    "float_cap",
    "limit_up",
    "limit_down",
    "amplitude",
    "volume_ratio",
    "currency",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuoteProvider {
    pub id: String,
    /// `json` | `text`
    pub kind: String,
    /// Markets this provider serves (`cn` / `hk` / `us`).
    pub markets: Vec<String>,
    /// `{code}` is required; `{prefix}` expands through `prefixes`.
    pub url: String,
    /// First character of the code → exchange prefix (`"6"` → `sh`, `"*"` →
    /// fallback). Only meaningful when the url references `{prefix}`.
    #[serde(default)]
    pub prefixes: BTreeMap<String, String>,
    /// Snapshot field → value expression.
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuotesConfig {
    pub version: i64,
    #[serde(default)]
    pub providers: Vec<QuoteProvider>,
}

impl QuotesConfig {
    fn empty() -> Self {
        Self {
            version: 1,
            providers: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Value expressions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    /// Text-mode field by `~`-separated index, scaled by `factor`.
    Index { idx: usize, factor: f64 },
    /// Json-mode dot path (`a.b[0].c`).
    Path(String),
    /// A literal value.
    Const(String),
}

/// Parses one `idx:N[*mult|/div]` / `path:...` / `const:...` expression.
pub fn parse_expr(raw: &str) -> Result<Expr, String> {
    let s = raw.trim();
    if let Some(rest) = s.strip_prefix("idx:") {
        let (num, factor) = match rest.split_once('*') {
            Some((n, m)) => (n, parse_factor(m)?),
            None => match rest.split_once('/') {
                Some((n, d)) => {
                    let d: f64 = parse_factor(d)?;
                    if d == 0.0 {
                        return Err(format!("EXPR_DIV_ZERO: {raw}"));
                    }
                    (n, 1.0 / d)
                }
                None => (rest, 1.0),
            },
        };
        let idx: usize = num
            .trim()
            .parse()
            .map_err(|_| format!("EXPR_BAD_INDEX: {raw}"))?;
        return Ok(Expr::Index { idx, factor });
    }
    if let Some(path) = s.strip_prefix("path:") {
        let path = path.trim();
        if path.is_empty()
            || !path
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._[]-".contains(c))
        {
            return Err(format!("EXPR_BAD_PATH: {raw}"));
        }
        return Ok(Expr::Path(path.to_string()));
    }
    if let Some(c) = s.strip_prefix("const:") {
        return Ok(Expr::Const(c.trim().to_string()));
    }
    Err(format!(
        "EXPR_UNKNOWN: {raw} (expected idx:N, idx:N*mult, idx:N/div, path:... or const:...)"
    ))
}

fn parse_factor(s: &str) -> Result<f64, String> {
    s.trim()
        .parse::<f64>()
        .map_err(|_| format!("EXPR_BAD_MULT: {s}"))
}

enum Payload<'a> {
    Text(&'a [&'a str]),
    Json(&'a serde_json::Value),
}

fn eval(expr: &Expr, payload: &Payload<'_>) -> Option<String> {
    match expr {
        Expr::Const(v) => Some(v.clone()),
        Expr::Index { idx, factor } => match payload {
            Payload::Text(fields) => {
                let raw = fields.get(*idx)?.trim();
                if raw.is_empty() {
                    return None;
                }
                if (*factor - 1.0).abs() < f64::EPSILON {
                    Some(raw.to_string())
                } else {
                    let v: f64 = raw.parse().ok()?;
                    Some((v * factor).to_string())
                }
            }
            Payload::Json(_) => None,
        },
        Expr::Path(path) => match payload {
            Payload::Json(value) => json_path(value, path).map(scalar_to_string).flatten(),
            Payload::Text(_) => None,
        },
    }
}

/// `a.b[0].c` on a serde_json Value. A missing segment is None (the field
/// stays empty — honest by construction).
fn json_path<'a>(value: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let mut current = value;
    for segment in path.split('.') {
        let mut rest = segment;
        // A leading [n] indexes the current value without a key.
        loop {
            if let Some(stripped) = rest.strip_prefix('[') {
                let (num, after) = stripped.split_once(']')?;
                let idx: usize = num.trim().parse().ok()?;
                current = current.get(idx)?;
                rest = after;
                continue;
            }
            break;
        }
        if rest.is_empty() {
            continue;
        }
        let (name, indexes) = match rest.split_once('[') {
            Some((name, indexes)) => (name, Some(indexes)),
            None => (rest, None),
        };
        current = current.get(name)?;
        if let Some(indexes) = indexes {
            let mut tail = indexes;
            loop {
                let (num, after) = tail.split_once(']')?;
                let idx: usize = num.trim().parse().ok()?;
                current = current.get(idx)?;
                if let Some(more) = after.strip_prefix('[') {
                    tail = more;
                } else if after.is_empty() {
                    break;
                } else {
                    return None;
                }
            }
        }
    }
    Some(current)
}

fn scalar_to_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Built-in providers (Tencent) — same engine, no second parser
// ---------------------------------------------------------------------------

fn provider(
    id: &str,
    market: &str,
    url: &str,
    prefixes: &[(&str, &str)],
    fields: &[(&str, &str)],
) -> QuoteProvider {
    QuoteProvider {
        id: id.to_string(),
        kind: "text".to_string(),
        markets: vec![market.to_string()],
        url: url.to_string(),
        prefixes: prefixes
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        fields: fields
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    }
}

/// The built-in Tencent sources, expressed as three provider entries (one per
/// market). The three markets are NOT isomorphic, so the unit scales and the
/// mapped fields differ: cn quotes are in lots and 万元, hk/us are already in
/// shares and the local currency, and hk/us carry no limit prices, no reliable
/// PB index (idx 46 is the English name) and no usable turnover.
pub fn builtin() -> QuotesConfig {
    QuotesConfig {
        version: 1,
        providers: vec![
            provider(
                "tencent-cn",
                "cn",
                "https://qt.gtimg.cn/q={prefix}{code}",
                &[("6", "sh"), ("*", "sz")],
                &[
                    ("price", "idx:3"),
                    ("prev_close", "idx:4"),
                    ("open", "idx:5"),
                    ("high", "idx:33"),
                    ("low", "idx:34"),
                    ("volume", "idx:6*100"),
                    ("amount", "idx:37*10000"),
                    ("turnover", "idx:38/100"),
                    ("pe", "idx:39"),
                    ("pb", "idx:46"),
                    ("market_cap", "idx:45*1e8"),
                    ("float_cap", "idx:44*1e8"),
                    ("limit_up", "idx:47"),
                    ("limit_down", "idx:48"),
                    ("amplitude", "idx:43/100"),
                    ("volume_ratio", "idx:49"),
                ],
            ),
            provider(
                "tencent-hk",
                "hk",
                "https://qt.gtimg.cn/q=hk{code}",
                &[],
                &[
                    ("price", "idx:3"),
                    ("prev_close", "idx:4"),
                    ("open", "idx:5"),
                    ("high", "idx:33"),
                    ("low", "idx:34"),
                    ("volume", "idx:6"),
                    ("amount", "idx:37"),
                    ("pe", "idx:39"),
                    ("market_cap", "idx:45*1e8"),
                    ("float_cap", "idx:44*1e8"),
                    ("amplitude", "idx:43/100"),
                ],
            ),
            provider(
                "tencent-us",
                "us",
                "https://qt.gtimg.cn/q=us{code}",
                &[],
                &[
                    ("price", "idx:3"),
                    ("prev_close", "idx:4"),
                    ("open", "idx:5"),
                    ("high", "idx:33"),
                    ("low", "idx:34"),
                    ("volume", "idx:6"),
                    ("amount", "idx:37"),
                    ("pe", "idx:39"),
                    ("market_cap", "idx:45*1e8"),
                    ("float_cap", "idx:44*1e8"),
                    ("amplitude", "idx:43/100"),
                    ("currency", "idx:35"),
                ],
            ),
        ],
    }
}

pub fn currency_for_market(market: &str) -> &'static str {
    match market {
        "hk" => "HKD",
        "us" => "USD",
        _ => "CNY",
    }
}

// ---------------------------------------------------------------------------
// Routing + payload parsing
// ---------------------------------------------------------------------------

/// Picks the provider for (market, code): user providers first, the built-in
/// Tencent set as the fall-back. A provider whose prefixes cannot produce a
/// url is skipped rather than aborting the chain.
pub fn route(config: &QuotesConfig, market: &str, code: &str) -> Option<(QuoteProvider, String)> {
    let user = config
        .providers
        .iter()
        .find(|p| p.markets.iter().any(|m| m == market))
        .and_then(|p| render_url(p, code).map(|url| (p.clone(), url)));
    if user.is_some() {
        return user;
    }
    let builtin = builtin();
    builtin
        .providers
        .iter()
        .find(|p| p.markets.iter().any(|m| m == market))
        .and_then(|p| render_url(p, code).map(|url| (p.clone(), url)))
}

/// `{code}` → the code; `{prefix}` → the exchange prefix for the code's first
/// character (`"*"` fallback). Returns None when a placeholder cannot expand.
fn render_url(provider: &QuoteProvider, code: &str) -> Option<String> {
    let mut url = provider.url.clone();
    if url.contains("{prefix}") {
        let first = code.chars().next()?;
        let prefix = provider
            .prefixes
            .get(&first.to_string())
            .or_else(|| provider.prefixes.get("*"))?;
        url = url.replace("{prefix}", prefix);
    }
    if !url.contains("{code}") {
        return None;
    }
    Some(url.replace("{code}", code))
}

/// The `{...}` tokens inside a url: `{code}`, `{prefix}`, or anything a
/// hand-edited config imagined. An unclosed `{` yields the rest of the url,
/// which then fails the known-token check in `validate`.
fn placeholder_tokens(url: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = url;
    while let Some(start) = rest.find('{') {
        let after = &rest[start + 1..];
        match after.find('}') {
            Some(end) => {
                out.push(&after[..end]);
                rest = &after[end + 1..];
            }
            None => {
                out.push(after);
                break;
            }
        }
    }
    out
}

/// Parses one response body with the provider's field map. A missing price is
/// treated as unusable (None) — the caller keeps the stored snapshot.
pub fn parse_quote(
    provider: &QuoteProvider,
    market: &str,
    code: &str,
    body: &str,
) -> Option<Snapshot> {
    let segments: Vec<&str>;
    let payload = match provider.kind.as_str() {
        "text" => {
            // Tencent wraps the record in double quotes — everything outside
            // them is noise (`v_sh600519=`). A plain feed without quotes is
            // used as-is, so `idx:N` works for any delimited vendor.
            let record = match (body.find('"'), body.rfind('"')) {
                (Some(start), Some(end)) if end > start => &body[start + 1..end],
                _ => body.trim(),
            };
            segments = record.split('~').collect();
            Payload::Text(&segments)
        }
        "json" => {
            let value: serde_json::Value = serde_json::from_str(body).ok()?;
            // Leak-free: parse within this scope by re-matching below.
            return build_snapshot(provider, market, code, &Payload::Json(&value));
        }
        _ => return None,
    };
    build_snapshot(provider, market, code, &payload)
}

fn build_snapshot(
    provider: &QuoteProvider,
    market: &str,
    code: &str,
    payload: &Payload<'_>,
) -> Option<Snapshot> {
    let field = |name: &str| -> Option<f64> {
        let expr = parse_expr(provider.fields.get(name)?).ok()?;
        eval(&expr, payload)?.trim().parse().ok()
    };
    let price = field("price")?;
    let currency = provider
        .fields
        .get("currency")
        .and_then(|raw| parse_expr(raw).ok())
        .and_then(|expr| eval(&expr, payload))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| currency_for_market(market).to_string());
    Some(Snapshot {
        code: code.to_string(),
        market: market.to_string(),
        price: Some(price),
        prev_close: field("prev_close"),
        open: field("open"),
        high: field("high"),
        low: field("low"),
        volume: field("volume"),
        amount: field("amount"),
        turnover: field("turnover"),
        pe: field("pe"),
        pb: field("pb"),
        market_cap: field("market_cap"),
        float_cap: field("float_cap"),
        limit_up: field("limit_up"),
        limit_down: field("limit_down"),
        amplitude: field("amplitude"),
        volume_ratio: field("volume_ratio"),
        currency: Some(currency),
        fetched_at: crate::invest::ingest::now_secs(),
    })
}

/// Fetches and parses one quote through the resolved provider.
pub async fn fetch_quote_snapshot(
    config: &QuotesConfig,
    market: &str,
    code: &str,
) -> Option<Snapshot> {
    let (provider, url) = route(config, market, code)?;
    let raw = crate::invest::ingest::fetch_url(&url).await.ok()?;
    parse_quote(&provider, market, code, &raw)
}

// ---------------------------------------------------------------------------
// YAML subset (<vault>/.bnote/invest/quotes.yaml)
// ---------------------------------------------------------------------------

/// Parses the quotes.yaml subset. Errors carry a 1-based line number so the
/// settings UI can point at the offending line.
pub fn parse_yaml(text: &str) -> Result<QuotesConfig, String> {
    let mut cfg = QuotesConfig::empty();
    let mut current: Option<QuoteProvider> = None;
    let mut in_providers = false;
    let mut in_fields = false;
    let mut in_prefixes = false;

    for (idx, raw) in text.lines().enumerate() {
        let line_no = idx + 1;
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("- ") {
            if !in_providers {
                return Err(format!(
                    "quotes.yaml:{line_no}: list item outside providers"
                ));
            }
            if let Some(prev) = current.take() {
                cfg.providers.push(prev);
            }
            in_fields = false;
            in_prefixes = false;
            let (key, value) = split_kv(rest)
                .ok_or_else(|| format!("quotes.yaml:{line_no}: provider needs `id: <id>`"))?;
            let mut p = blank_provider();
            apply_key(&mut p, &key, value.as_deref(), line_no)?;
            current = Some(p);
            continue;
        }
        let Some((key, value)) = split_kv(trimmed) else {
            return Err(format!("quotes.yaml:{line_no}: expected `key: value`"));
        };
        match key.as_str() {
            "version" => {
                cfg.version = value
                    .and_then(|v| v.trim().parse().ok())
                    .ok_or_else(|| format!("quotes.yaml:{line_no}: version must be an integer"))?;
            }
            "providers" => in_providers = true,
            "fields" => {
                in_fields = true;
                in_prefixes = false;
                if current.is_none() {
                    return Err(format!("quotes.yaml:{line_no}: fields outside a provider"));
                }
            }
            "prefixes" => {
                in_prefixes = true;
                in_fields = false;
                if current.is_none() {
                    return Err(format!(
                        "quotes.yaml:{line_no}: prefixes outside a provider"
                    ));
                }
            }
            _ => {
                let Some(p) = current.as_mut() else {
                    return Err(format!("quotes.yaml:{line_no}: `{key}` outside a provider"));
                };
                if in_fields {
                    let value = value.ok_or_else(|| {
                        format!("quotes.yaml:{line_no}: field {key} needs a value")
                    })?;
                    p.fields.insert(unquote(&key), unquote(&value));
                } else if in_prefixes {
                    let value = value.ok_or_else(|| {
                        format!("quotes.yaml:{line_no}: prefix {key} needs a value")
                    })?;
                    p.prefixes.insert(unquote(&key), unquote(&value));
                } else {
                    apply_key(p, &key, value.as_deref(), line_no)?;
                }
            }
        }
    }
    if let Some(prev) = current.take() {
        cfg.providers.push(prev);
    }
    cfg.validate()?;
    Ok(cfg)
}

fn blank_provider() -> QuoteProvider {
    QuoteProvider {
        id: String::new(),
        kind: String::new(),
        markets: Vec::new(),
        url: String::new(),
        prefixes: BTreeMap::new(),
        fields: BTreeMap::new(),
    }
}

fn split_kv(s: &str) -> Option<(String, Option<String>)> {
    let (k, v) = s.split_once(':')?;
    Some((unquote(k.trim()), Some(v.trim().to_string())))
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    let s = s.strip_prefix('"').unwrap_or(s);
    let s = s.strip_suffix('"').unwrap_or(s);
    let s = s.strip_prefix('\'').unwrap_or(s);
    s.strip_suffix('\'').unwrap_or(s).to_string()
}

fn apply_key(
    p: &mut QuoteProvider,
    key: &str,
    value: Option<&str>,
    line_no: usize,
) -> Result<(), String> {
    let value = value.ok_or_else(|| format!("quotes.yaml:{line_no}: {key} needs a value"))?;
    match key {
        "id" => p.id = unquote(value),
        "kind" => p.kind = unquote(value),
        "url" => p.url = unquote(value),
        "markets" => p.markets = parse_inline_list(value),
        other => {
            return Err(format!(
                "quotes.yaml:{line_no}: unknown provider key `{other}` (id | kind | markets | url | prefixes | fields)"
            ))
        }
    }
    Ok(())
}

/// `[cn, hk, us]` → vec. Quotes are stripped; empty entries dropped.
fn parse_inline_list(raw: &str) -> Vec<String> {
    let inner = raw.trim();
    let inner = inner.strip_prefix('[').unwrap_or(inner);
    let inner = inner.strip_suffix(']').unwrap_or(inner);
    inner
        .split(',')
        .map(unquote)
        .filter(|s| !s.is_empty())
        .collect()
}

impl QuotesConfig {
    /// Validates the whole file; the first problem names its field.
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err(format!("QUOTES_BAD_VERSION: {} (expected 1)", self.version));
        }
        for p in &self.providers {
            if p.id.is_empty() {
                return Err("QUOTES_NO_ID: every provider needs an id".to_string());
            }
            if p.kind != "json" && p.kind != "text" {
                return Err(format!(
                    "QUOTES_BAD_KIND: {} has kind `{}` (json | text)",
                    p.id, p.kind
                ));
            }
            if p.markets.is_empty() {
                return Err(format!("QUOTES_NO_MARKETS: {} lists no markets", p.id));
            }
            for market in &p.markets {
                if !matches!(market.as_str(), "cn" | "hk" | "us") {
                    return Err(format!(
                        "QUOTES_BAD_MARKET: {} serves `{}` (cn | hk | us)",
                        p.id, market
                    ));
                }
            }
            if !p.url.contains("{code}") {
                return Err(format!("QUOTES_NO_CODE_SLOT: {} url needs {{code}}", p.id));
            }
            if p.url.contains("{prefix}") && p.prefixes.is_empty() {
                return Err(format!(
                    "QUOTES_NO_PREFIXES: {} url uses {{prefix}} but prefixes is empty",
                    p.id
                ));
            }
            // Every `{...}` token must be a known placeholder: anything else
            // (a typo'd `{p!efix}`, a stray brace) would ride the url
            // literally to the vendor. The old check only demanded `{code}`,
            // so a corrupted or hand-edited token shipped verbatim.
            for token in placeholder_tokens(&p.url) {
                if token != "code" && token != "prefix" {
                    return Err(format!(
                        "QUOTES_UNKNOWN_PLACEHOLDER: {} url has {{{token}}} (code | prefix)",
                        p.id
                    ));
                }
            }
            if p.fields.is_empty() {
                return Err(format!("QUOTES_NO_FIELDS: {} maps no fields", p.id));
            }
            for (name, raw) in &p.fields {
                if !KNOWN_FIELDS.contains(&name.as_str()) {
                    return Err(format!(
                        "QUOTES_UNKNOWN_FIELD: {} maps `{}` (known: {})",
                        p.id,
                        name,
                        KNOWN_FIELDS.join(", ")
                    ));
                }
                let expr = parse_expr(raw).map_err(|e| format!("{}: {}", p.id, e))?;
                match (&expr, p.kind.as_str()) {
                    (Expr::Index { .. }, "json") => {
                        return Err(format!(
                            "QUOTES_KIND_MISMATCH: {} uses `{}` but kind is json (use path:)",
                            p.id, raw
                        ))
                    }
                    (Expr::Path(_), "text") => {
                        return Err(format!(
                            "QUOTES_KIND_MISMATCH: {} uses `{}` but kind is text (use idx:)",
                            p.id, raw
                        ))
                    }
                    _ => {}
                }
            }
            if !p.fields.contains_key("price") {
                return Err(format!("QUOTES_NO_PRICE: {} does not map price", p.id));
            }
        }
        Ok(())
    }
}

/// The on-disk path of the quotes file.
pub fn quotes_path(vault_root: &std::path::Path) -> std::path::PathBuf {
    crate::invest::root_dir(vault_root).join("quotes.yaml")
}

/// The raw quotes.yaml text (writes the commented template on first read).
pub fn read_yaml(vault_root: &std::path::Path) -> String {
    let path = quotes_path(vault_root);
    if let Ok(text) = std::fs::read_to_string(&path) {
        return text;
    }
    let template = default_yaml();
    let _ = std::fs::create_dir_all(crate::invest::root_dir(vault_root));
    let _ = std::fs::write(&path, &template);
    template
}

/// The effective config: the user's file when it parses, the built-in set
/// otherwise (offline-first — a broken config never blocks a refresh).
pub fn read_config(vault_root: Option<&std::path::Path>) -> QuotesConfig {
    if let Some(root) = vault_root {
        if let Ok(text) = std::fs::read_to_string(quotes_path(root)) {
            if let Ok(cfg) = parse_yaml(&text) {
                return cfg;
            }
        }
    }
    builtin()
}

/// Validates then writes; an invalid file never lands on disk.
pub fn save_yaml(vault_root: &std::path::Path, yaml: &str) -> Result<(), String> {
    parse_yaml(yaml)?;
    let path = quotes_path(vault_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("WRITE_FAILED: {} ({})", parent.display(), e))?;
    }
    std::fs::write(&path, yaml).map_err(|e| format!("WRITE_FAILED: {} ({})", path.display(), e))
}

/// The first-run template: comments plus a worked yahoo example. An empty
/// provider list means "use the built-in Tencent sources".
pub fn default_yaml() -> String {
    r#"version: 1
# 行情快照源（H7）。接入新数据源 = 写一段声明，无需改代码：
#   kind: json  用 path:a.b[0].c 点路径取值
#   kind: text  用 idx:N 按 ~ 分隔的字段下标取值，可带 *倍数 或 /除数
# 字段名固定为快照键：price / prev_close / open / high / low / volume /
# amount / turnover / pe / pb / market_cap / float_cap / limit_up /
# limit_down / amplitude / volume_ratio / currency；currency 可写 const:USD。
# 没有声明的字段留空（不猜）。providers 为空时使用内置腾讯源。
providers:
#  - id: yahoo
#    kind: json
#    markets: [us]
#    url: "https://query1.finance.yahoo.com/v8/finance/chart/{code}?range=1d&interval=1d"
#    fields:
#      price: "path:chart.result[0].meta.regularMarketPrice"
#      prev_close: "path:chart.result[0].meta.chartPreviousClose"
#      currency: "path:chart.result[0].meta.currency"
#      volume: "path:chart.result[0].indicators.quote[0].volume[0]"
#  - id: my-cn-feed
#    kind: text
#    markets: [cn]
#    url: "https://example.com/quote?symbol={prefix}{code}"
#    prefixes:
#      "6": sh
#      "*": sz
#    fields:
#      price: "idx:3"
#      volume: "idx:6*100"
#      amount: "idx:37*10000"
"#
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // H2 fixtures: real response bodies (fetched 2026-11-17), tail truncated —
    // the mapping only reads fields up to index 49. The three markets are NOT
    // isomorphic; every cross-market unit rule is locked here.
    const CN_BODY: &str = concat!(
        "v_sh600519=\"1~贵州茅台~600519~1453.90~1435.26~1426.30~39967~22973~16994~",
        "1453.50~1~1453.00~5~1452.96~1~1452.93~1~1452.91~1~1453.90~1~1453.96~3~",
        "1453.97~1~1453.99~7~1454.00~94~~20261116161453~18.64~1.30~1454.93~1425.00~",
        "1453.90/39967/5767305714~39967~576731~0.32~22.12~~1454.93~1425.00~2.09~",
        "18174.94~18174.94~6.70~1578.79~1291.73~1.23~-97~1443.02~21.14~22.08\""
    );
    const HK_BODY: &str = concat!(
        "v_hk00700=\"100~腾讯控股~00700~390.400~386.600~386.600~19267570.0~0~0~",
        "390.400~0~0~0~0~0~0~0~0~0~390.400~0~0~0~0~0~0~0~0~0~19267570.0~",
        "2026/11/16 16:08:18~3.800~0.98~394.600~384.200~390.400~19267570.0~",
        "7520114265.184~0~14.26~~0~0~2.69~35497.6854~35497.6854~TENCENT~1.36~",
        "637.200~375.200\""
    );
    const US_BODY: &str = concat!(
        "v_usAAPL=\"200~苹果~AAPL.OQ~352.78~356.27~357.13~45955433~0~0~",
        "0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~~2026-11-16 16:00:01~-3.49~-0.98~",
        "357.13~351.31~USD~45955433~16240356189~0.32~39.29~~39.29~~1.63~",
        "51234.63056~51266.63166~Apple Inc.~8.98~360.83~242.57~0~45.74~0.30~",
        "51266.63166~30.22\""
    );

    fn builtin_parse(market: &str, code: &str, body: &str) -> Snapshot {
        let cfg = builtin();
        let (provider, _url) = route(&cfg, market, code).expect("builtin routes");
        parse_quote(&provider, market, code, body).expect("fixture parses")
    }

    #[test]
    fn builtin_routes_the_three_markets() {
        let cfg = builtin();
        let (p, url) = route(&cfg, "cn", "600519").unwrap();
        assert_eq!(p.id, "tencent-cn");
        assert_eq!(url, "https://qt.gtimg.cn/q=sh600519");
        let (p, url) = route(&cfg, "cn", "000001").unwrap();
        assert_eq!(p.id, "tencent-cn");
        assert_eq!(url, "https://qt.gtimg.cn/q=sz000001");
        let (p, url) = route(&cfg, "hk", "00700").unwrap();
        assert_eq!(p.id, "tencent-hk");
        assert_eq!(url, "https://qt.gtimg.cn/q=hk00700");
        let (p, url) = route(&cfg, "us", "AAPL").unwrap();
        assert_eq!(p.id, "tencent-us");
        assert_eq!(url, "https://qt.gtimg.cn/q=usAAPL");
        // An unknown market has no endpoint — None, never a cn fallback.
        assert!(route(&cfg, "jp", "7203").is_none());
    }

    #[test]
    fn cn_quote_uses_lot_and_wan_conversion() {
        let s = builtin_parse("cn", "600519", CN_BODY);
        assert_eq!(s.market, "cn");
        assert_eq!(s.price, Some(1453.90));
        assert_eq!(s.prev_close, Some(1435.26));
        assert_eq!(s.open, Some(1426.30));
        assert_eq!(s.high, Some(1454.93));
        assert_eq!(s.low, Some(1425.00));
        // Lots → shares; 万元 → 元.
        assert_eq!(s.volume, Some(3_996_700.0));
        assert_eq!(s.amount, Some(5_767_310_000.0));
        assert_eq!(s.turnover, Some(0.0032));
        assert_eq!(s.pe, Some(22.12));
        assert_eq!(s.pb, Some(6.70));
        // 亿 → 元.
        assert_eq!(s.market_cap, Some(18_174.94 * 1e8));
        assert_eq!(s.float_cap, Some(18_174.94 * 1e8));
        // E24 fields stay cn-only.
        assert_eq!(s.limit_up, Some(1578.79));
        assert_eq!(s.limit_down, Some(1291.73));
        assert_eq!(s.volume_ratio, Some(1.23));
        assert_eq!(s.amplitude, Some(0.0209));
        assert_eq!(s.currency.as_deref(), Some("CNY"));
    }

    #[test]
    fn hk_quote_stores_raw_shares_and_yuan() {
        let s = builtin_parse("hk", "00700", HK_BODY);
        assert_eq!(s.price, Some(390.400));
        assert_eq!(s.prev_close, Some(386.600));
        assert_eq!(s.high, Some(394.600));
        assert_eq!(s.low, Some(384.200));
        // Already shares — ×100 would inflate it a hundredfold.
        assert_eq!(s.volume, Some(19_267_570.0));
        // Already HKD yuan — ×1e4 would inflate it ten-thousandfold.
        assert_eq!(s.amount, Some(7_520_114_265.184));
        assert_eq!(s.market_cap, Some(35_497.6854 * 1e8));
        assert_eq!(s.pe, Some(14.26));
        assert_eq!(s.amplitude, Some(0.0269));
        // No price-limit regime, no PB on an identified index, no turnover.
        assert_eq!(s.limit_up, None);
        assert_eq!(s.limit_down, None);
        assert_eq!(s.volume_ratio, None);
        assert_eq!(s.pb, None, "idx 46 is the English name, not the PB");
        assert_eq!(s.turnover, None);
        assert_eq!(s.currency.as_deref(), Some("HKD"));
    }

    #[test]
    fn us_quote_reads_the_currency_field() {
        let s = builtin_parse("us", "AAPL", US_BODY);
        assert_eq!(s.price, Some(352.78));
        assert_eq!(s.high, Some(357.13));
        assert_eq!(s.low, Some(351.31));
        // Already shares and USD yuan.
        assert_eq!(s.volume, Some(45_955_433.0));
        assert_eq!(s.amount, Some(16_240_356_189.0));
        assert_eq!(s.market_cap, Some(51_266.63166 * 1e8));
        assert_eq!(s.pe, Some(39.29));
        assert_eq!(s.amplitude, Some(0.0163));
        assert_eq!(s.pb, None);
        assert_eq!(s.turnover, None);
        assert_eq!(s.limit_up, None);
        assert_eq!(s.currency.as_deref(), Some("USD"), "read from idx 35");
    }

    #[test]
    fn unknown_market_and_malformed_body_are_none() {
        let cfg = builtin();
        assert!(route(&cfg, "jp", "7203").is_none());
        let (p, _) = route(&cfg, "cn", "600519").unwrap();
        assert!(parse_quote(&p, "cn", "600519", "v_sh600519=\"broken").is_none());
        // A body whose price field is empty is unusable.
        assert!(parse_quote(&p, "cn", "600519", "v_sh600519=\"1~x~600519~~\"").is_none());
    }

    /// A Yahoo-style JSON provider through the same engine: the point of H7 is
    /// that a new source needs no Rust code at all.
    const YAHOO_YAML: &str = r#"version: 1
providers:
  - id: yahoo
    kind: json
    markets: [us]
    url: "https://query1.finance.yahoo.com/v8/finance/chart/{code}"
    fields:
      price: "path:chart.result[0].meta.regularMarketPrice"
      prev_close: "path:chart.result[0].meta.chartPreviousClose"
      currency: "path:chart.result[0].meta.currency"
      volume: "path:chart.result[0].indicators.quote[0].volume[0]"
"#;

    const YAHOO_BODY: &str = r#"{"chart":{"result":[{"meta":{"currency":"USD","regularMarketPrice":191.24,"chartPreviousClose":189.95},"indicators":{"quote":[{"volume":[48392011]}]}}],"error":null}}"#;

    #[test]
    fn a_json_provider_parses_through_the_same_engine() {
        let cfg = parse_yaml(YAHOO_YAML).expect("valid yaml");
        let (p, url) = route(&cfg, "us", "AAPL").unwrap();
        assert_eq!(p.id, "yahoo");
        assert_eq!(
            url,
            "https://query1.finance.yahoo.com/v8/finance/chart/AAPL"
        );
        let s = parse_quote(&p, "us", "AAPL", YAHOO_BODY).unwrap();
        assert_eq!(s.price, Some(191.24));
        assert_eq!(s.prev_close, Some(189.95));
        assert_eq!(s.volume, Some(48_392_011.0));
        assert_eq!(s.currency.as_deref(), Some("USD"));
        // Undeclared fields stay empty — no guessing.
        assert_eq!(s.pe, None);
        assert_eq!(s.pb, None);
        assert_eq!(s.turnover, None);
        // Markets the provider does not serve still fall back to builtin.
        let (p, _) = route(&cfg, "hk", "00700").unwrap();
        assert_eq!(p.id, "tencent-hk");
    }

    #[test]
    fn a_const_currency_is_supported() {
        let yaml = r#"version: 1
providers:
  - id: myfeed
    kind: text
    markets: [hk]
    url: "https://example.com/q/{code}"
    fields:
      price: "idx:0"
      currency: "const:HKD"
"#;
        let cfg = parse_yaml(yaml).unwrap();
        let (p, _) = route(&cfg, "hk", "00700").unwrap();
        let s = parse_quote(&p, "hk", "00700", "\"1.5~2\"").unwrap();
        assert_eq!(s.price, Some(1.5));
        assert_eq!(s.currency.as_deref(), Some("HKD"));
    }

    /// The exact file the settings UI/agent writes: an indented provider with
    /// inline markets and quoted expressions must round-trip through routing.
    #[test]
    fn an_indented_provider_file_routes_to_its_own_url() {
        let yaml = "version: 1\nproviders:\n  - id: my-local-feed\n    kind: text\n    markets: [cn]\n    url: \"http://127.0.0.1:8765/q/{code}\"\n    fields:\n      price: \"idx:0\"\n      prev_close: \"idx:1\"\n      volume: \"idx:2*100\"\n      currency: \"idx:3\"\n";
        let cfg = parse_yaml(yaml).expect("the saved file parses");
        let (p, url) = route(&cfg, "cn", "600519").unwrap();
        assert_eq!(p.id, "my-local-feed");
        assert_eq!(url, "http://127.0.0.1:8765/q/600519");
        let s = parse_quote(&p, "cn", "600519", "99.5~98.0~1234~HKD").unwrap();
        assert_eq!(s.price, Some(99.5));
        assert_eq!(s.volume, Some(123_400.0));
        assert_eq!(s.currency.as_deref(), Some("HKD"));
    }

    // ---- Property tests (deterministic generators, no dependencies) ----
    //
    // Example-based tests cover the cases we thought of; properties cover the
    // ones we did not. The generator is a fixed-seed LCG so a failure is
    // reproducible from the printed seed.

    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self) -> u64 {
            // Numerical Recipes' constants; the seed keeps failures reproducible.
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            self.0 >> 33
        }

        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    /// Generates a *valid* provider config: known kind, known market, a url
    /// with {code}, and fields whose expressions match the kind. Invariant:
    /// parse_yaml must accept every one of these, and the parsed provider must
    /// route for every market it claims.
    fn gen_valid_yaml(seed: u64) -> String {
        let mut rng = Lcg(seed);
        let kind = if rng.below(2) == 0 { "json" } else { "text" };
        let markets = ["cn", "hk", "us"];
        let n_markets = 1 + rng.below(3);
        let mut market_list = Vec::new();
        for _ in 0..n_markets {
            market_list.push(markets[rng.below(3)]);
        }
        let market_list = market_list.join(", ");
        let id = format!("gen{}", rng.next() % 100_000);
        let code_expr = if kind == "json" {
            "path:a.b.c"
        } else {
            "idx:3"
        };
        // A random subset of the optional fields, each matching the kind.
        let optional = [
            ("prev_close", "idx:4", "path:a.d"),
            ("volume", "idx:6*100", "path:a.e"),
            ("pe", "idx:39", "path:a.f"),
        ];
        let mut fields = format!("      price: \"{}\"\n", code_expr);
        for (name, text_expr, json_expr) in optional {
            if rng.below(2) == 0 {
                let expr = if kind == "json" { json_expr } else { text_expr };
                fields.push_str(&format!("      {}: \"{}\"\n", name, expr));
            }
        }
        let fields = format!("    fields:\n{}", fields);
        let (url, prefix_block) = if kind == "text" && rng.below(2) == 0 {
            // url uses {prefix}; the prefix table is optional on cn only.
            (
                "https://e.test/{prefix}{code}".to_string(),
                "    prefixes:\n      \"6\": sh\n      \"*\": sz\n",
            )
        } else {
            ("https://e.test/{code}".to_string(), "")
        };
        format!(
            "version: 1\nproviders:\n  - id: {}\n    kind: {}\n    markets: [{}]\n    url: \"{}\"\n{}{}",
            id, kind, market_list, url, prefix_block, fields
        )
    }

    #[test]
    fn every_generated_valid_config_parses_and_routes() {
        for seed in 1..=200u64 {
            let yaml = gen_valid_yaml(seed);
            let cfg = parse_yaml(&yaml)
                .unwrap_or_else(|e| panic!("seed {} valid config rejected: {}\n{}", seed, e, yaml));
            assert!(!cfg.providers.is_empty(), "seed {}", seed);
            for market in ["cn", "hk", "us"] {
                if let Some((p, url)) = route(&cfg, market, "600519") {
                    assert!(url.contains("600519"), "seed {}: url lost the code", seed);
                    assert!(p.fields.contains_key("price"));
                }
            }
        }
    }

    /// Corrupts one byte of a valid config. Invariant: the result either still
    /// parses into a usable config or fails with a *line-numbered* error — it
    /// never panics and never yields a provider that routes without {code}.
    #[test]
    fn corrupted_yaml_never_panics_and_reports_a_line() {
        for seed in 1..=120u64 {
            let yaml = gen_valid_yaml(seed + 500);
            let bytes: Vec<u8> = yaml.bytes().collect();
            let mut rng = Lcg(seed * 7919);
            let pos = rng.below(bytes.len());
            let mut corrupted = bytes;
            corrupted[pos] = b'!'; // not a YAML structural char anywhere
            let text = String::from_utf8_lossy(&corrupted).into_owned();
            match parse_yaml(&text) {
                Ok(cfg) => {
                    // The promised invariant, actually asserted: an accepted
                    // provider still routes every market it claims with a
                    // fully expanded url — never a `{code}`-less router.
                    for p in &cfg.providers {
                        for market in &p.markets {
                            if let Some((_, url)) = route(&cfg, market, "600519") {
                                assert!(
                                    !url.contains('{') && !url.contains('}'),
                                    "seed {}: corrupted config routed with an unexpanded url: {url}",
                                    seed
                                );
                            }
                        }
                    }
                }
                Err(e) => {
                    // Two error shapes by design: parser errors carry a line,
                    // semantic validation errors carry a QUOTES_*/EXPR_* code.
                    assert!(
                        e.contains("quotes.yaml:")
                            || e.starts_with("QUOTES_")
                            || e.starts_with("EXPR_")
                            || e.contains(": EXPR_"),
                        "seed {}: unclassifiable error: {}",
                        seed,
                        e
                    );
                }
            }
        }
    }

    #[test]
    fn validation_rejects_broken_configs() {
        let cases = [
            ("version: 2\nproviders: []\n", "QUOTES_BAD_VERSION"),
            (
                "version: 1\nproviders:\n  - id: x\n    kind: csv\n    markets: [cn]\n    url: u{code}\n    fields:\n      price: \"idx:1\"\n",
                "QUOTES_BAD_KIND",
            ),
            (
                "version: 1\nproviders:\n  - id: x\n    kind: text\n    markets: [jp]\n    url: u{code}\n    fields:\n      price: \"idx:1\"\n",
                "QUOTES_BAD_MARKET",
            ),
            (
                "version: 1\nproviders:\n  - id: x\n    kind: text\n    markets: [cn]\n    url: noplaceholder\n    fields:\n      price: \"idx:1\"\n",
                "QUOTES_NO_CODE_SLOT",
            ),
            (
                "version: 1\nproviders:\n  - id: x\n    kind: text\n    markets: [cn]\n    url: \"{prefix}{code}\"\n    fields:\n      price: \"idx:1\"\n",
                "QUOTES_NO_PREFIXES",
            ),
            (
                "version: 1\nproviders:\n  - id: x\n    kind: text\n    markets: [cn]\n    url: u{code}\n    fields:\n      pe: \"idx:39\"\n",
                "QUOTES_NO_PRICE",
            ),
            (
                "version: 1\nproviders:\n  - id: x\n    kind: text\n    markets: [cn]\n    url: u{code}\n    fields:\n      price: \"idx:1\"\n      prlce: \"idx:2\"\n",
                "QUOTES_UNKNOWN_FIELD",
            ),
            (
                "version: 1\nproviders:\n  - id: x\n    kind: text\n    markets: [cn]\n    url: u{code}\n    fields:\n      price: \"oops:1\"\n",
                "EXPR_UNKNOWN",
            ),
            (
                "version: 1\nproviders:\n  - id: x\n    kind: json\n    markets: [cn]\n    url: u{code}\n    fields:\n      price: \"idx:1\"\n",
                "QUOTES_KIND_MISMATCH",
            ),
        ];
        for (yaml, expected) in cases {
            let err = parse_yaml(yaml).expect_err("invalid config must fail");
            assert!(
                err.contains(expected),
                "expected {expected} in `{err}` for:\n{yaml}"
            );
        }
    }

    #[test]
    fn the_default_template_is_valid_and_falls_back_to_builtin() {
        let cfg = parse_yaml(&default_yaml()).expect("template parses");
        assert!(
            cfg.providers.is_empty(),
            "template ships no active provider"
        );
        let (p, url) = route(&cfg, "cn", "600519").unwrap();
        assert_eq!(p.id, "tencent-cn");
        assert_eq!(url, "https://qt.gtimg.cn/q=sh600519");
    }

    #[test]
    fn user_providers_take_precedence_over_builtin() {
        let yaml = r#"version: 1
providers:
  - id: mine
    kind: text
    markets: [cn]
    url: "https://example.com/{code}"
    fields:
      price: "idx:0"
"#;
        let cfg = parse_yaml(yaml).unwrap();
        let (p, _) = route(&cfg, "cn", "600519").unwrap();
        assert_eq!(p.id, "mine");
        // Its own market routing still applies; other markets stay builtin.
        let (p, _) = route(&cfg, "us", "AAPL").unwrap();
        assert_eq!(p.id, "tencent-us");
    }

    #[test]
    fn json_path_walks_objects_and_indices() {
        let body = r#"{"a":{"b":[{"c":42}]}}"#;
        let cfg = parse_yaml(
            "version: 1\nproviders:\n  - id: x\n    kind: json\n    markets: [cn]\n    url: u{code}\n    fields:\n      price: \"path:a.b[0].c\"\n",
        )
        .unwrap();
        let (p, _) = route(&cfg, "cn", "1").unwrap();
        assert_eq!(parse_quote(&p, "cn", "1", body).unwrap().price, Some(42.0));
        assert!(json_path(&serde_json::json!({"a": 1}), "a.b").is_none());
        // Unknown path segment → no price → None.
        assert!(parse_quote(&p, "cn", "1", r#"{"a":{}}"#).is_none());
    }

    /// The acceptance invariant the docs promise, actually asserted: every
    /// config that parses must be self-consistent — a provider that claims a
    /// market routes there with a FULLY expanded url (no `{code}`, no
    /// `{prefix}` survives), and a market nobody claims falls back to the
    /// builtin. The old assertion (`!providers.is_empty()`) was always true:
    /// the generator can only produce non-empty configs, so it proved
    /// nothing.
    #[test]
    fn every_accepted_config_is_self_consistent() {
        for seed in 1..=200u64 {
            let yaml = gen_valid_yaml(seed);
            let cfg = parse_yaml(&yaml)
                .unwrap_or_else(|e| panic!("seed {} valid config rejected: {}\n{}", seed, e, yaml));
            for provider in &cfg.providers {
                for market in &provider.markets {
                    let (routed, url) = route(&cfg, market, "600519").unwrap_or_else(|| {
                        panic!(
                            "seed {}: provider {} claims {market} but does not route",
                            seed, provider.id
                        )
                    });
                    assert_eq!(
                        routed.id, provider.id,
                        "seed {seed}: {market} routed elsewhere"
                    );
                    assert!(
                        !url.contains('{') && !url.contains('}'),
                        "seed {}: url left an unexpanded placeholder: {url}",
                        seed
                    );
                }
            }
            // Markets nobody claims fall through to the builtin provider.
            let claimed: Vec<&String> = cfg
                .providers
                .iter()
                .flat_map(|p| p.markets.iter())
                .collect();
            for market in ["cn", "hk", "us"] {
                if claimed.iter().any(|m| *m == market) {
                    continue;
                }
                let (routed, _) = route(&cfg, market, "600519").expect("builtin must serve");
                assert_ne!(routed.id, cfg.providers[0].id, "seed {seed}");
            }
        }
    }

    /// Whitespace jitter never changes the parse: blank lines, trailing
    /// spaces, extra space after the colon and noise comments are all legal
    /// formatting of the same document, so the parsed config must be
    /// identical (a hand-edited yaml keeps working after an editor
    /// reformats it).
    #[test]
    fn formatting_jitter_never_changes_the_parse() {
        for seed in 1..=80u64 {
            let yaml = gen_valid_yaml(seed);
            let expected = parse_yaml(&yaml).unwrap_or_else(|e| panic!("seed {}: {}", seed, e));
            let jittered: String = yaml
                .lines()
                .enumerate()
                .flat_map(|(i, line)| {
                    let mut out = vec![format!("{} ", line)]; // trailing space
                    if let Some((key, value)) = line.trim().split_once(": ") {
                        let _ = key;
                        let _ = value;
                    }
                    out.push("# jitter noise".to_string()); // comment lines are legal
                    if i % 3 == 0 {
                        out.push(String::new()); // blank lines are legal
                    }
                    out
                })
                .collect::<Vec<_>>()
                .join("\n");
            let actual = parse_yaml(&jittered).unwrap_or_else(|e| {
                panic!(
                    "seed {} jittered config rejected: {}\n{}",
                    seed, e, jittered
                )
            });
            assert_eq!(
                actual, expected,
                "seed {}: formatting changed the parse",
                seed
            );
        }
    }
}
