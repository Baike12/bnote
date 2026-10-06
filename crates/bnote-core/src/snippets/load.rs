//! Port of `src/editor/snippets/load.ts` — the user snippet source.
//!
//! The snippets live in `<vault>/.bnote/snippets.js` as a JS module, and the TS
//! loader imports it through a blob URL. A Rust host cannot execute the module,
//! so the definitions are read **statically** by [`super::js_module`] (regex
//! literals, function bodies, comments — all preserved as written) and turned
//! into compiled snippets here. The one thing static reading cannot do is run a
//! function replacement; those bind to the engine's native implementation by
//! trigger ([`native_function`]) and are **skipped with a reason** when there
//! is none — never silently dropped.
//!
//! Also host-side (documented, not ported): the async importer and the
//! content-cache (`SnippetLoader.load`: the same source is never re-imported,
//! a source-unchanged call only flips the enable switch) and the source
//! ownership invariant — only the loader path replaces the snippet source
//! ([`store_from_file`]), the settings path must only flip
//! [`SnippetStore::enabled`] (replacing the source there was a real regression:
//! every file open reset the user snippets to the built-ins).
//!
//! Regex triggers: a regex literal keeps its source and flags verbatim, and a
//! string trigger turned into a regex by the `r` option goes through the same
//! compile path — see [`super::engine::parse_snippet`] for the JS → Rust
//! regex dialect notes (a pattern the Rust engine cannot compile drops that
//! snippet, the TS `parseSnippet` `catch → null`).

use super::default_snippets::{DEFAULT_SNIPPETS, iden_replacement};
use super::engine::{
    CompiledSnippets, RawReplacement, RawSnippet, RawTrigger, ReplacementFn, Snippet,
    SnippetSource, SnippetStore, compile_snippets,
};
use super::js_module::{JsReplacement, JsSnippetDef, JsTrigger, parse_snippet_module};

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

/// The engine's binding for a JS function replacement, or `None` when the
/// engine has no implementation for it.
///
/// A function replacement is JS *code*; a Rust host cannot run it, so the
/// reader accepts exactly the ones whose behaviour the engine already ships,
/// matched by the trigger they hang off — today one, the plugin's own
/// `iden(\d)` N​×​N identity-matrix generator (the same function the built-in
/// set defines, [`iden_replacement`]).
fn native_function(trigger: &JsTrigger) -> Option<ReplacementFn> {
    match trigger {
        JsTrigger::Regex { source, .. } if source == r"iden(\d)" => Some(iden_replacement),
        _ => None,
    }
}

/// One definition as a raw snippet, or `None` when its replacement is a
/// function the engine cannot bind (the caller reports it).
fn js_raw(def: &JsSnippetDef) -> Option<RawSnippet<'_>> {
    let replacement = match &def.replacement {
        JsReplacement::Text(text) => RawReplacement::Text(text),
        JsReplacement::Function { .. } => {
            RawReplacement::Fn(native_function(&def.trigger)?)
        }
    };
    let trigger = match &def.trigger {
        JsTrigger::Literal(text) => RawTrigger::Literal(text),
        JsTrigger::Regex { source, flags } => RawTrigger::Regex { source, flags },
    };
    Some(RawSnippet {
        trigger,
        replacement,
        options: &def.options,
        priority: def.priority,
        description: &def.description,
        source: SnippetSource::User,
    })
}

/// A parsed snippet source: the compiled snippets, how many definitions the
/// file declared, and one human-readable line per entry that had to be
/// skipped (a form the engine cannot express).
#[derive(Debug, Clone)]
pub struct ParsedSnippetSource {
    pub snippets: Vec<Snippet>,
    /// Definitions the module declared (the TS loader reports this count).
    pub declared: usize,
    /// Why entries did not make it: a function replacement with no native
    /// binding, or a regex the Rust dialect cannot compile (the TS
    /// `catch → null` gap — JS-only syntax such as lookbehind).
    pub skipped: Vec<String>,
}

/// Reads a snippet module (`.bnote/snippets.js`, or the JSON/bare-array shape
/// the port accepts) into compiled snippets. A malformed file is a hard error
/// naming its line; a well-formed file whose entries the engine cannot bind is
/// reported through [`ParsedSnippetSource::skipped`].
pub fn parse_snippet_source(src: &str) -> Result<ParsedSnippetSource, SnippetFileError> {
    let defs = parse_snippet_module(src)?;
    let declared = defs.len();
    let mut raws: Vec<RawSnippet<'_>> = Vec::with_capacity(defs.len());
    let mut skipped: Vec<String> = Vec::new();
    for def in &defs {
        match js_raw(def) {
            Some(raw) => raws.push(raw),
            None => skipped.push(format!(
                "第 {} 行:{} 是函数型 replacement,引擎没有对应实现",
                def.line,
                def.trigger.display()
            )),
        }
    }
    let snippets = compile_snippets(&raws);
    if snippets.len() < raws.len() {
        // `compile_snippets` drops a snippet whose regex trigger the Rust
        // dialect cannot compile (TS parity); the count is what a caller can
        // report without re-implementing the compile step.
        skipped.push(format!(
            "{} 条片段的正则触发器无法在 Rust 正则下编译(JS 专有语法,如 lookbehind),已跳过",
            raws.len() - snippets.len()
        ));
    }
    Ok(ParsedSnippetSource { snippets, declared, skipped })
}

/// The TS `applySnippetSource(raws, enabled)` write: a user file replaces the
/// whole snippet source (it does **not** stack on the built-ins).
pub fn store_from_file(src: &str, enabled: bool) -> Result<SnippetStoreLoad, SnippetFileError> {
    let parsed = parse_snippet_source(src)?;
    let count = parsed.snippets.len();
    Ok(SnippetStoreLoad {
        store: SnippetStore {
            enabled,
            compiled: CompiledSnippets { list: parsed.snippets },
        },
        declared: parsed.declared,
        count,
        skipped: parsed.skipped,
    })
}

/// A loaded snippet source: the store, the counts the host reports with, and
/// the skipped entries it should surface.
#[derive(Debug, Clone)]
pub struct SnippetStoreLoad {
    pub store: SnippetStore,
    /// Definitions the source declared.
    pub declared: usize,
    /// Snippets in effect (lower than `declared` when entries were skipped).
    pub count: usize,
    pub skipped: Vec<String>,
}

/// The built-in fallback with its count (TS `builtinOutcome`).
pub fn builtin_store(enabled: bool) -> (SnippetStore, usize) {
    let mut store = SnippetStore::builtin();
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
        r#"export default [{ trigger: "uq", replacement: "USER$0", options: "A" }];"#;
    const USER_SRC_V2: &str =
        r#"export default [{ trigger: "uq2", replacement: "USER2$0", options: "A" }];"#;
    const USER_SRC_JSON: &str =
        r#"[{ "trigger": "uq", "replacement": "USER$0", "options": "A" }]"#;

    /// The plugin's own function replacement, exactly as the vault file writes
    /// it (the `iden` identity-matrix generator).
    const IDEN_SRC: &str = r#"export default [
  { trigger: /iden(\d)/, replacement: (match) => {
      const n = Number(match[1]);
      const rows = [];
      for (let j = 0; j < n; j++) {
        rows.push(Array.from({ length: n }, (_, i) => (i === j ? "1" : "0")).join(" & "));
      }
      return `\\begin{pmatrix}\n${rows.join(String.raw` \\` + "\n")}\n\\end{pmatrix}`;
    }, options: "mA", description: "N×N 单位阵" },
]"#;

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
        let load = store_from_file(USER_SRC, true).unwrap();
        assert_eq!(load.count, 1);
        assert_eq!(load.declared, 1);
        assert!(load.skipped.is_empty());
        assert_eq!(expands_user(&load.store, "xuq", 3, "q").as_deref(), Some("USER"));
    }

    /// The port's JSON stand-in shape goes through the same reader.
    #[test]
    fn the_json_shape_loads_too() {
        let load = store_from_file(USER_SRC_JSON, true).unwrap();
        assert_eq!(load.count, 1);
        assert_eq!(expands_user(&load.store, "xuq", 3, "q").as_deref(), Some("USER"));
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
        let broken = store_from_file("export default [ { trigger: } ];", true);
        let err = broken.unwrap_err();
        assert!(err.message.starts_with("第 1 行"), "{}", err.message);

        let wrong_shape = store_from_file(r#"{"nope": true}"#, true).unwrap_err();
        assert!(wrong_shape.message.contains("片段数组"), "{}", wrong_shape.message);

        // The host falls back to the built-ins and drops the previous user set.
        let (store, _) = builtin_store(true);
        assert!(expands_user(&store, "xuq", 3, "q").is_none());
    }

    /// `导出形状不对是显式错误,不是静默 0 条`, and an empty array is a
    /// deliberate empty set (the file exists and declares nothing).
    #[test]
    fn a_wrong_export_shape_is_an_explicit_error() {
        let err = store_from_file(r#"{"nope": true}"#, true).unwrap_err();
        assert!(err.message.contains("片段数组"));
        assert_eq!(store_from_file("export default [];", true).unwrap().count, 0);
    }

    /// `内容变化重新导入,新片段生效`.
    #[test]
    fn changed_content_loads_the_new_snippets() {
        let first = store_from_file(USER_SRC, true).unwrap().store;
        assert_eq!(expands_user(&first, "xuq", 3, "q").as_deref(), Some("USER"));
        let second = store_from_file(USER_SRC_V2, true).unwrap().store;
        assert_eq!(expands_user(&second, "xuq2", 4, "2").as_deref(), Some("USER2"));
        assert!(expands_user(&second, "xuq", 3, "q").is_none());
    }

    /// `来源所有权:applySnippetsEnabled 只翻开关不动来源` — the data-level part
    /// (the settings path must not replace the source).
    #[test]
    fn flipping_enabled_keeps_the_loaded_source() {
        let mut store = store_from_file(USER_SRC, true).unwrap().store;
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
            count: store_from_file(USER_SRC, true).unwrap().declared,
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
            error: Some(store_from_file("boom", true).unwrap_err().message),
        };
        assert_eq!(failed.count, 0);
        assert!(failed.error.is_some());
    }

    /// A definition from the file format: a string trigger with the `r` option
    /// compiles as a regex, exactly like the plugin's `data.json`.
    #[test]
    fn the_r_option_compiles_the_trigger_as_a_regex() {
        let src = r#"export default [{ trigger: "iden(\\d)", replacement: "X$0", options: "mAr" }];"#;
        let load = store_from_file(src, true).unwrap();
        assert!(load.store.compiled.list[0].regex);
        assert_eq!(expands_user(&load.store, "$iden3$", 6, "3").as_deref(), Some("X"));
    }

    /// A function replacement binds to the engine's native implementation when
    /// there is one: `iden(\d)` produces the identity matrix (the same bytes
    /// the built-in entry and the JS function produce).
    #[test]
    fn the_identity_matrix_function_binds_to_the_engine() {
        let load = store_from_file(IDEN_SRC, true).unwrap();
        assert_eq!(load.declared, 1);
        assert_eq!(load.count, 1);
        assert!(load.skipped.is_empty(), "{:?}", load.skipped);
        assert_eq!(
            expands_user(&load.store, "$iden2$", 6, "2").as_deref(),
            Some("\\begin{pmatrix}\n1 & 0 \\\\\n0 & 1\n\\end{pmatrix}")
        );
    }

    /// A function replacement the engine has no implementation for is skipped
    /// **with a reason** — never silently, and never taking the file down.
    #[test]
    fn an_unknown_function_replacement_is_reported() {
        let src = r#"export default [
  { trigger: "keep", replacement: "x", options: "mA" },
  { trigger: /fancy(\d)/, replacement: (m) => m[1].toUpperCase(), options: "mA" },
];"#;
        let load = store_from_file(src, true).unwrap();
        assert_eq!(load.declared, 2);
        assert_eq!(load.count, 1);
        assert_eq!(load.skipped.len(), 1);
        assert!(load.skipped[0].starts_with("第 3 行"), "{}", load.skipped[0]);
        assert!(load.skipped[0].contains("/fancy(\\d)/"), "{}", load.skipped[0]);
        assert!(expands_user(&load.store, "$keep$", 5, "p").is_some());
    }

    /// A definition whose regex does not compile is dropped, not fatal (the TS
    /// `parseSnippet` `catch → null`) — and the drop is reported by count.
    #[test]
    fn a_bad_regex_drops_only_that_snippet() {
        let src = r#"export default [
  { trigger: "(unclosed", replacement: "X", options: "mAr" },
  { trigger: "ok", replacement: "Y", options: "mA" },
];"#;
        let load = store_from_file(src, true).unwrap();
        assert_eq!(load.declared, 2);
        assert_eq!(load.count, 1);
        assert_eq!(load.skipped.len(), 1);
        assert!(load.skipped[0].contains("无法在 Rust 正则下编译"), "{}", load.skipped[0]);
        assert!(load.store.compiled.list[0].trigger_is("ok"));
    }

    /// JS-only regex syntax (lookbehind) is accepted through the fallback:
    /// the owner's file has two such triggers and both must work.
    #[test]
    fn a_js_only_regex_syntax_compiles_through_the_fallback() {
        let src = r#"export default [{ trigger: /(?<!\\)log/, replacement: "\\log", options: "mA" }];"#;
        let load = store_from_file(src, true).unwrap();
        assert_eq!(load.declared, 1);
        assert_eq!(load.count, 1);
        assert!(load.skipped.is_empty(), "{:?}", load.skipped);
        assert_eq!(expands_user(&load.store, "$log$", 4, "g").as_deref(), Some("\\log"));
        assert!(expands_user(&load.store, "$\\log$", 5, "g").is_none());
    }
}
