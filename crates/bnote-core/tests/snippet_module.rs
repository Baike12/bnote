//! The vault snippet file, read end to end.
//!
//! `tests/data/snippets-owner.js` is a **byte-for-byte copy** of the owner's
//! real `<vault>/.bnote/snippets.js` (sha1 `cd725eda…`, 24 405 bytes) — the
//! file the TS host `import()`s. The reader must load it without a single
//! skip: any entry it cannot handle is a line in the user's everyday config
//! that silently stops working.

use bnote_core::markdown::context::context_at_scan;
use bnote_core::markdown::math_scan::scan_math;
use bnote_core::snippets::engine::MatchOptions;
use bnote_core::snippets::js_module::{JsReplacement, JsTrigger, parse_snippet_module};
use bnote_core::snippets::load::{ParsedSnippetSource, parse_snippet_source};

const OWNER_FILE: &str = include_str!("data/snippets-owner.js");

fn parse_owner() -> ParsedSnippetSource {
    parse_snippet_source(OWNER_FILE).expect("the owner's file parses")
}

/// The module reader itself: every entry is a definition (the file's own
/// comment header, regex literals, the one function replacement).
#[test]
fn the_owner_module_reads_completely() {
    let defs = parse_snippet_module(OWNER_FILE).expect("the module parses");
    assert_eq!(defs.len(), 232, "the file declares 232 entries");
    assert!(defs.iter().all(|def| !def.options.is_empty() || !def.description.is_empty()));

    let regexes = defs.iter().filter(|d| matches!(d.trigger, JsTrigger::Regex { .. })).count();
    assert_eq!(regexes, 19, "19 regex-literal triggers");
    let functions = defs
        .iter()
        .filter(|d| matches!(d.replacement, JsReplacement::Function { .. }))
        .count();
    assert_eq!(functions, 1, "exactly one function replacement");
}

/// Loading the file yields the user's snippets, with nothing skipped: the one
/// function replacement binds to the engine's `iden` implementation.
#[test]
fn the_owner_file_loads_without_a_single_skip() {
    let parsed = parse_owner();
    assert_eq!(parsed.declared, 232);
    assert_eq!(
        parsed.snippets.len(),
        parsed.declared,
        "skipped: {:?}",
        parsed.skipped
    );
    assert!(parsed.skipped.is_empty(), "{:?}", parsed.skipped);
}

/// Spot checks in the user's own words — a literal trigger, the `r`-option
/// regex, a regex literal with capture groups, and the function replacement
/// producing the identity matrix.
#[test]
fn the_owner_snippets_expand() {
    let store = bnote_core::snippets::load::store_from_file(OWNER_FILE, true).unwrap().store;

    // `dm` (auto-expand) → the align block. The doc keeps a leading space so
    // the higher-priority `/(\S\s*)dm/` entry (which wants a character before
    // the trigger) does not win.
    assert_eq!(
        expand(&store, " dm", 3, "m").as_deref(),
        Some("$$\n\\begin{align}\n\n\\end{align}\n$$")
    );

    // Priority is honoured across the two `dm` entries: at the end of a line the
    // regex one (priority 1) wins and keeps the captured character.
    assert_eq!(
        expand(&store, "$dm", 3, "m").as_deref(),
        Some("$\n$$\n\\begin{align}\n\n\\end{align}\n$$")
    );

    // `aa` → \alpha, driven by the auto-expand flag.
    assert_eq!(expand(&store, "$aa$", 3, "a").as_deref(), Some("\\alpha"));

    // A regex trigger with capture groups, manual (no auto-expand): the Tab
    // path, `pa` + two letters → \frac (the two capture groups fill [[0]]/[[1]]).
    assert_eq!(
        expand_on_tab(&store, "$paxy$", 5).as_deref(),
        Some("\\frac{ \\partial x }{ \\partial y }")
    );

    // The function replacement: `iden3` → a 3×3 identity matrix.
    let matrix = expand(&store, "$iden3$", 6, "3").unwrap();
    assert!(matrix.starts_with("\\begin{pmatrix}\n"), "{matrix}");
    assert_eq!(matrix.matches(" \\\\\n").count(), 2, "3 rows: {matrix}");
}

/// The engine's expansion path, exactly as the key handler calls it.
fn expand(
    store: &bnote_core::snippets::engine::SnippetStore,
    doc: &str,
    cursor: usize,
    typed: &str,
) -> Option<String> {
    let math = scan_math(doc);
    let ctx = context_at_scan(doc, cursor, &math);
    store
        .match_at(doc, cursor, &ctx, &MatchOptions::new(true, Some(typed), None))
        .map(|m| m.replacement.text)
}

/// The manual path (Tab): auto-expand snippets do not participate.
fn expand_on_tab(
    store: &bnote_core::snippets::engine::SnippetStore,
    doc: &str,
    cursor: usize,
) -> Option<String> {
    let math = scan_math(doc);
    let ctx = context_at_scan(doc, cursor, &math);
    store
        .match_at(doc, cursor, &ctx, &MatchOptions::new(false, None, None))
        .map(|m| m.replacement.text)
}
