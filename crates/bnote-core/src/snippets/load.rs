//! Port of `src/editor/snippets/load.ts` — the user snippet source.
//!
//! The real snippets live in `<vault>/.bnote/snippets.js` as a JS module, and
//! the TS loader imports it through a blob URL and reads its default export.
//! **The JS runtime wrapper is a shell concern**: this module defines the
//! snippet-definition *data shape* (the same fields, JSON) and its validation,
//! and the shell extracts the array from the module (or parses the JSON file)
//! and hands it over as text.
//!
//! Also host-side (documented, not ported): the async importer, the
//! content-cache (`SnippetLoader.load`: the same source is never re-imported,
//! a source-unchanged call only flips the enable switch) and the source
//! ownership invariant — only the loader path replaces the snippet source
//! ([`store_from_file`]), the settings path must only flip
//! [`SnippetStore::enabled`] (replacing the source there was a real regression:
//! every file open reset the user snippets to the built-ins).
//!
//! Regex triggers: the JS module may carry a regex *literal*, which JSON cannot
//! express. In the data shape they are written the way the latex-suite file
//! format does it — a string trigger plus the `r` option (or the explicit
//! `"regex": true` field).

use serde::Deserialize;

use super::default_snippets::DEFAULT_SNIPPETS;
use super::engine::{
    CompiledSnippets, RawReplacement, RawSnippet, RawTrigger, Snippet, SnippetSource,
    compile_snippets,
};

/// One snippet definition, the data shape shared with `.bnote/snippets.js`
/// entries (and the plugin's `data.json`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SnippetDef {
    pub trigger: String,
    pub replacement: String,
    #[serde(default)]
    pub options: String,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub description: String,
    /// Explicit regex trigger (`true` = the trigger string is a pattern).
    #[serde(default)]
    pub regex: bool,
}

impl SnippetDef {
    /// Borrows this definition as a raw snippet for compilation.
    pub fn to_raw(&self) -> RawSnippet<'_> {
        RawSnippet {
            trigger: if self.regex {
                RawTrigger::Regex { source: &self.trigger, flags: "" }
            } else {
                RawTrigger::Literal(&self.trigger)
            },
            replacement: RawReplacement::Text(&self.replacement),
            options: &self.options,
            priority: self.priority,
            description: &self.description,
            source: SnippetSource::User,
        }
    }
}

/// A snippet source that could not be loaded (the TS `SnippetLoader`'s error
/// path; the message is what the host shows the user).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnippetFileError {
    pub message: String,
}

impl std::fmt::Display for SnippetFileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SnippetFileError {}

fn not_an_array() -> SnippetFileError {
    // Mirrors the TS `normalizeSnippetExport` message (the JS wrapper is the
    // shell's; the array requirement is the same).
    SnippetFileError {
        message: "snippets 定义必须是片段数组(export default [...] / JSON array)".to_string(),
    }
}

/// Port of the TS `normalizeSnippetExport`: the top level must be the snippet
/// array — either bare (the module body) or under `default` (the ESM default
/// export). Regex/type errors inside the entries are surfaced too.
pub fn parse_snippet_defs(src: &str) -> Result<Vec<SnippetDef>, SnippetFileError> {
    let value: serde_json::Value = serde_json::from_str(src).map_err(|e| SnippetFileError {
        message: format!("snippets 定义不是合法 JSON: {e}"),
    })?;
    let array = match value {
        serde_json::Value::Array(items) => serde_json::Value::Array(items),
        serde_json::Value::Object(mut map) => match map.remove("default") {
            Some(serde_json::Value::Array(items)) => serde_json::Value::Array(items),
            _ => return Err(not_an_array()),
        },
        _ => return Err(not_an_array()),
    };
    serde_json::from_value(array).map_err(|e| SnippetFileError {
        message: format!("片段定义的字段不合法: {e}"),
    })
}

/// Compiles parsed definitions into snippets (bad regex triggers are dropped,
/// like the TS `parseSnippet` `catch → null`; that is why the compiled count can
/// be lower than the definition count).
pub fn compile_snippet_defs(defs: &[SnippetDef]) -> Vec<Snippet> {
    let raws: Vec<RawSnippet<'_>> = defs.iter().map(SnippetDef::to_raw).collect();
    compile_snippets(&raws)
}

/// `parse_snippet_file(src) -> Vec<Snippet>`: the definition array → compiled
/// snippets, ready for a [`super::engine::SnippetStore`].
pub fn parse_snippet_file(src: &str) -> Result<Vec<Snippet>, SnippetFileError> {
    let defs = parse_snippet_defs(src)?;
    Ok(compile_snippet_defs(&defs))
}

/// The TS `applySnippetSource(raws, enabled)` write: a user file replaces the
/// whole snippet source (it does **not** stack on the built-ins).
pub fn store_from_file(src: &str, enabled: bool) -> Result<super::engine::SnippetStore, SnippetFileError> {
    Ok(super::engine::SnippetStore {
        enabled,
        compiled: CompiledSnippets { list: parse_snippet_file(src)? },
    })
}

/// The built-in fallback with its count (TS `builtinOutcome`).
pub fn builtin_store(enabled: bool) -> (super::engine::SnippetStore, usize) {
    let mut store = super::engine::SnippetStore::builtin();
    store.enabled = enabled;
    (store, DEFAULT_SNIPPETS.len())
}

/// Port of the TS `SnippetLoadOutcome` — the shape the host reports with.
/// Computing it (async import, caching, fallback) stays host-side; the
/// invariant to keep is in the module docs: a failed load must fall back to the
/// built-ins and must not leave the previous user snippets in place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnippetLoadOutcome {
    pub status: SnippetSourceStatus,
    /// The effective snippet count: user = the definitions loaded, builtin =
    /// the built-in count, error = 0 — a `count` of a *user* load may be lower
    /// than the compiled count, exactly like the TS reports `raws.length`.
    pub count: usize,
    pub error: Option<String>,
}

/// Port of the TS `SnippetLoadOutcome["status"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnippetSourceStatus {
    /// The user snippets are in effect.
    User,
    /// Fell back to the built-ins.
    Builtin,
    /// The load failed (the editor already fell back to the built-ins).
    Error,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::context::context_at_scan;
    use crate::markdown::math_scan::scan_math;
    use crate::snippets::engine::{MatchOptions, SnippetStore};

    const USER_SRC: &str =
        r#"[{ "trigger": "uq", "replacement": "USER$0", "options": "A" }]"#;
    const USER_SRC_V2: &str =
        r#"[{ "trigger": "uq2", "replacement": "USER2$0", "options": "A" }]"#;
    const USER_SRC_ESM: &str =
        r#"{ "default": [{ "trigger": "uq", "replacement": "USER$0", "options": "A" }] }"#;

    /// `expandsUser`: the user snippet is really in effect — `findSnippet`
    /// expands the trigger (the engine reads the store live at each keystroke).
    /// `typed_key` is the character just typed, as in the real input path.
    fn expands_user(
        store: &SnippetStore,
        doc: &str,
        cursor: usize,
        typed_key: &str,
    ) -> Option<String> {
        let math = scan_math(doc);
        let ctx = context_at_scan(doc, cursor, &math);
        store
            .match_at(doc, cursor, &ctx, &MatchOptions::new(true, Some(typed_key), None))
            .map(|m| m.replacement.text)
    }

    /// `SnippetLoader:装载语义` — the user source takes effect immediately.
    #[test]
    fn a_user_source_takes_effect_on_load() {
        let store = store_from_file(USER_SRC, true).unwrap();
        assert_eq!(store.compiled.list.len(), 1);
        assert_eq!(expands_user(&store, "xuq", 3, "q").as_deref(), Some("USER"));
    }

    /// The module-shape variant: the ESM default export wrapper.
    #[test]
    fn the_default_export_shape_is_accepted_too() {
        let defs = parse_snippet_defs(USER_SRC_ESM).unwrap();
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].trigger, "uq");
    }

    /// `空文件(null)回退内置`.
    #[test]
    fn no_source_falls_back_to_the_builtins() {
        let (store, count) = builtin_store(true);
        assert_eq!(count, DEFAULT_SNIPPETS.len());
        assert_eq!(store.compiled.list.len(), DEFAULT_SNIPPETS.len());
        assert!(expands_user(&store, "xuq", 3, "q").is_none());
    }

    /// `导入失败回退内置并把错误带给调用方,不留上一次的用户片段`.
    #[test]
    fn a_broken_source_is_an_explicit_error_and_falls_back() {
        let broken = parse_snippet_file("export default [ /* js, not json */ ]");
        let err = broken.unwrap_err();
        assert!(err.message.contains("合法 JSON"), "{}", err.message);

        let wrong_shape = parse_snippet_file(r#"{"nope": true}"#).unwrap_err();
        assert!(wrong_shape.message.contains("片段数组"), "{}", wrong_shape.message);

        // The host falls back to the built-ins and drops the previous user set.
        let (store, _) = builtin_store(true);
        assert!(expands_user(&store, "xuq", 3, "q").is_none());
    }

    /// `导出形状不对是显式错误,不是静默 0 条`.
    #[test]
    fn a_wrong_export_shape_is_an_explicit_error() {
        let err = parse_snippet_file(r#"{"nope": true}"#).unwrap_err();
        assert!(err.message.contains("片段数组"));
        assert_eq!(parse_snippet_defs(USER_SRC).unwrap().len(), 1);
        assert_eq!(parse_snippet_defs(USER_SRC_ESM).unwrap().len(), 1);
    }

    /// `内容变化重新导入,新片段生效`.
    #[test]
    fn changed_content_loads_the_new_snippets() {
        let first = store_from_file(USER_SRC, true).unwrap();
        assert_eq!(expands_user(&first, "xuq", 3, "q").as_deref(), Some("USER"));
        let second = store_from_file(USER_SRC_V2, true).unwrap();
        assert_eq!(expands_user(&second, "xuq2", 4, "2").as_deref(), Some("USER2"));
        assert!(expands_user(&second, "xuq", 3, "q").is_none());
    }

    /// `来源所有权:applySnippetsEnabled 只翻开关不动来源` — the data-level part
    /// (the settings path must not replace the source).
    #[test]
    fn flipping_enabled_keeps_the_loaded_source() {
        let mut store = store_from_file(USER_SRC, true).unwrap();
        store.enabled = false;
        assert!(!store.enabled);
        assert_eq!(store.compiled.list.len(), 1); // the source is untouched
        store.enabled = true;
        assert_eq!(expands_user(&store, "xuq", 3, "q").as_deref(), Some("USER"));
    }

    /// The TS outcome shape, and the invariant that a failed load carries the
    /// error and no user snippets.
    #[test]
    fn outcome_shape_matches_the_ts_loader() {
        let ok = SnippetLoadOutcome {
            status: SnippetSourceStatus::User,
            count: parse_snippet_defs(USER_SRC).unwrap().len(),
            error: None,
        };
        assert_eq!(ok.status, SnippetSourceStatus::User);
        assert_eq!(ok.count, 1);

        let (_, builtin_count) = builtin_store(true);
        let fallback = SnippetLoadOutcome {
            status: SnippetSourceStatus::Builtin,
            count: builtin_count,
            error: None,
        };
        assert_eq!(fallback.count, DEFAULT_SNIPPETS.len());

        let failed = SnippetLoadOutcome {
            status: SnippetSourceStatus::Error,
            count: 0,
            error: Some(parse_snippet_file("boom").unwrap_err().message),
        };
        assert_eq!(failed.count, 0);
        assert!(failed.error.is_some());
    }

    /// A definition from the file format: regex triggers go through the `r`
    /// option exactly like the plugin's `data.json`.
    #[test]
    fn the_r_option_compiles_the_trigger_as_a_regex() {
        let src = r#"[{ "trigger": "iden(\\d)", "replacement": "X$0", "options": "mAr" }]"#;
        let store = store_from_file(src, true).unwrap();
        assert!(store.compiled.list[0].regex);
        assert_eq!(expands_user(&store, "$iden3$", 6, "3").as_deref(), Some("X"));
    }

    /// The explicit `regex` field is the JSON stand-in for a JS regex literal.
    #[test]
    fn the_explicit_regex_field_is_a_regex_trigger() {
        let src = r#"[{ "trigger": "iden(\\d)", "replacement": "X", "options": "mA", "regex": true }]"#;
        let store = store_from_file(src, true).unwrap();
        assert!(store.compiled.list[0].regex);
        assert_eq!(expands_user(&store, "$iden3$", 6, "3").as_deref(), Some("X"));
    }

    /// A definition whose regex does not compile is dropped, not fatal.
    #[test]
    fn a_bad_regex_drops_only_that_snippet() {
        let src = r#"[{ "trigger": "(unclosed", "replacement": "X", "options": "mAr" },
                      { "trigger": "ok", "replacement": "Y", "options": "mA" }]"#;
        let defs = parse_snippet_defs(src).unwrap();
        assert_eq!(defs.len(), 2);
        let compiled = compile_snippet_defs(&defs);
        assert_eq!(compiled.len(), 1);
        assert!(compiled[0].trigger_is("ok"));
    }
}
