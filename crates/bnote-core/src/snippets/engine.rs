//! Port of `src/editor/snippets/engine.ts` — the snippet model (trigger,
//! options, mode gates, tabstops), compilation, trigger matching at the cursor
//! and the snippet store.
//!
//! # Why the `regex` crate
//!
//! The latex-suite snippet format *is* regex-based: the `r` option marks a
//! trigger as a regular expression and 30+ of the 223 built-in triggers are
//! genuinely regex-shaped (capture groups, `\d+`, alternations over the 40-name
//! Greek/symbol tables in [`super::default_snippets::DEFAULT_SNIPPET_VARIABLES`]).
//! Each compiled snippet carries exactly one precompiled anchored pattern
//! (`(?:src)$`, the TS `anchored` variant), built once at load time; matching
//! runs one `captures` over the current line prefix only. A hand-written
//! matcher would have to re-implement alternation + capture-group semantics for
//! no gain, and the crate is already in the workspace dependency graph.
//!
//! Dialect note (JS → Rust): `\d`/`\w`/`\s` are Unicode-aware in Rust while the
//! JS engine keeps `\d`/`\w` ASCII. For LaTeX sources this only shifts
//! behaviour on exotic characters the trigger tables never contain. Patterns
//! using JS-only syntax (lookaround, backreferences) fail to compile and the
//! snippet is dropped — the same as the TS `parseSnippet` `catch → null` path.

use regex::{Regex, RegexBuilder};

use crate::markdown::context::EditContext;

use super::config::{LATEX_SUITE_WORD_DELIMITERS, LatexConfig};
use super::default_snippets::{DEFAULT_SNIPPETS, DEFAULT_SNIPPET_VARIABLES};
use super::replacement::{ParsedReplacement, parse_replacement, trim_snippet_whitespace};
use super::session::Session;
use super::{Range, Replace, char_at, line_start, prev_char};

/// Port of the TS `SnippetReplacement` parameter union: a regex trigger gets
/// the capture groups, a string trigger its own trigger text, a visual snippet
/// the selected text.
#[derive(Debug, Clone, Copy)]
pub enum ReplacementArg<'a> {
    /// Capture groups, index 0 = first group (the TS `match.slice(1)` shape).
    Groups(&'a [String]),
    Trigger(&'a str),
    Visual(&'a str),
}

/// Function-type replacement. Returns `None` when the snippet must be treated
/// as non-matching (TS: a non-string return value).
pub type ReplacementFn = fn(ReplacementArg<'_>) -> Option<String>;

/// Snippet replacement in raw (file) form.
#[derive(Debug, Clone, Copy)]
pub enum RawReplacement<'a> {
    Text(&'a str),
    Fn(ReplacementFn),
}

/// Snippet trigger in raw (file) form. Regex triggers keep their source and
/// flags exactly as JS writes them (`/src/flags`).
#[derive(Debug, Clone, Copy)]
pub enum RawTrigger<'a> {
    Literal(&'a str),
    Regex { source: &'a str, flags: &'a str },
}

/// Where a snippet came from (TS `source`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnippetSource {
    Builtin,
    User,
}

/// Port of the TS `RawSnippet` — the snippet-definition data shape shared by
/// the built-in set and user files.
#[derive(Debug, Clone, Copy)]
pub struct RawSnippet<'a> {
    pub trigger: RawTrigger<'a>,
    pub replacement: RawReplacement<'a>,
    pub options: &'a str,
    pub priority: i32,
    pub description: &'a str,
    pub source: SnippetSource,
}

/// Literal trigger, text replacement.
pub const fn lit(
    trigger: &'static str,
    replacement: &'static str,
    options: &'static str,
) -> RawSnippet<'static> {
    lit_pd(trigger, replacement, options, 0, "")
}

/// Literal trigger, text replacement, explicit priority.
pub const fn lit_p(
    trigger: &'static str,
    replacement: &'static str,
    options: &'static str,
    priority: i32,
) -> RawSnippet<'static> {
    lit_pd(trigger, replacement, options, priority, "")
}

/// Literal trigger, text replacement, priority and description.
pub const fn lit_pd(
    trigger: &'static str,
    replacement: &'static str,
    options: &'static str,
    priority: i32,
    description: &'static str,
) -> RawSnippet<'static> {
    RawSnippet {
        trigger: RawTrigger::Literal(trigger),
        replacement: RawReplacement::Text(replacement),
        options,
        priority,
        description,
        source: SnippetSource::Builtin,
    }
}

/// Regex trigger (`r` option), text replacement.
pub const fn rx(
    trigger: &'static str,
    replacement: &'static str,
    options: &'static str,
) -> RawSnippet<'static> {
    rx_pd(trigger, replacement, options, 0, "")
}

/// Regex trigger, text replacement, explicit priority.
pub const fn rx_p(
    trigger: &'static str,
    replacement: &'static str,
    options: &'static str,
    priority: i32,
) -> RawSnippet<'static> {
    rx_pd(trigger, replacement, options, priority, "")
}

/// Regex trigger, text replacement, priority and description.
pub const fn rx_pd(
    trigger: &'static str,
    replacement: &'static str,
    options: &'static str,
    priority: i32,
    description: &'static str,
) -> RawSnippet<'static> {
    RawSnippet {
        trigger: RawTrigger::Regex { source: trigger, flags: "" },
        replacement: RawReplacement::Text(replacement),
        options,
        priority,
        description,
        source: SnippetSource::Builtin,
    }
}

/// Port of the TS `SnippetMode`: the six context flags plus `catchall`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SnippetMode {
    pub text: bool,
    pub inline_math: bool,
    pub block_math: bool,
    pub text_env: bool,
    pub code: bool,
    pub code_block: bool,
    /// No mode flag at all → the snippet matches everywhere.
    pub catchall: bool,
}

/// Parsed trigger: a literal string (variables already substituted) or a
/// compiled regex with its original source kept for display.
#[derive(Debug, Clone)]
pub enum Trigger {
    Literal(String),
    Regex { source: String },
}

/// Port of the TS `ParsedSnippet`.
#[derive(Debug, Clone)]
pub struct Snippet {
    pub trigger: Trigger,
    /// Trigger with snippet variables substituted (display purposes).
    pub display_trigger: String,
    /// Anchored-at-cursor variant of a regex trigger (TS `anchored`).
    anchored: Option<Regex>,
    pub replacement: RawReplacementOwned,
    pub auto: bool,
    pub regex: bool,
    pub word: bool,
    pub visual: bool,
    pub mode: SnippetMode,
    pub priority: i32,
    pub description: String,
    pub source: SnippetSource,
}

/// Owned replacement for the compiled form.
#[derive(Debug, Clone)]
pub enum RawReplacementOwned {
    Text(String),
    Fn(ReplacementFn),
}

impl Snippet {
    /// True when the trigger is the literal `text` (the TS `snippet.trigger`
    /// string comparisons in tests/visual matching).
    pub fn trigger_is(&self, text: &str) -> bool {
        matches!(&self.trigger, Trigger::Literal(t) if t == text)
    }

    /// Port of the TS `matchesContext`: a snippet runs when any of its mode
    /// flags match the cursor context (or it has no mode flags at all).
    pub fn matches_context(&self, ctx: &EditContext) -> bool {
        let m = &self.mode;
        if m.catchall {
            return true;
        }
        if m.text_env {
            return ctx.text_env;
        }
        if m.text && ctx.is_text {
            return true;
        }
        if m.inline_math && ctx.inline_math {
            return true;
        }
        if m.block_math && ctx.block_math {
            return true;
        }
        if m.code && ctx.code {
            return true;
        }
        if m.code_block && ctx.code_block.is_some() {
            return true;
        }
        false
    }
}

/// Substitutes `${GREEK}`-style variables into a trigger (TS
/// `substituteVariables`: plain split/join, all occurrences).
fn substitute_variables(s: &str) -> String {
    let mut out = s.to_string();
    for (name, value) in DEFAULT_SNIPPET_VARIABLES {
        if out.contains(name) {
            out = out.replace(name, value);
        }
    }
    out
}

/// Rewrites a JS regex source into the Rust dialect where the two differ on
/// brace handling: JS (Annex B) treats a `{`/`}` that does not form a valid
/// repetition quantifier as a literal, while the Rust parser rejects it. A real
/// built-in trigger relies on this — `(\\${GREEK}|[A-Za-z])_{(\d+)}(\d)` has a
/// literal `{` in front of a group — so those braces are escaped here. Escaped
/// sequences are copied verbatim and valid quantifiers (`{n}`/`{n,}`/`{n,m}`)
/// pass through unchanged.
fn js_pattern_to_rust(source: &str) -> String {
    let b = source.as_bytes();
    let mut out = String::with_capacity(source.len() + 8);
    let mut i = 0usize;
    while i < b.len() {
        let c = b[i];
        if c == b'\\' {
            // Escaped sequence: copy the backslash and the escaped char as-is.
            out.push('\\');
            i += 1;
            if i < b.len() {
                let next = source[i..].chars().next().expect("char boundary");
                out.push(next);
                i += next.len_utf8();
            }
            continue;
        }
        if c == b'{' {
            if let Some(end) = quantifier_end(source, i) {
                out.push_str(&source[i..end]);
                i = end;
                continue;
            }
            out.push_str("\\{");
            i += 1;
            continue;
        }
        if c == b'}' {
            // Never reached through a quantifier: JS reads it as a literal.
            out.push_str("\\}");
            i += 1;
            continue;
        }
        let ch = source[i..].chars().next().expect("char boundary");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// `{n}` / `{n,}` / `{n,m}` starting at `at` -> the index just past the closing
/// `}`; `None` when the braces are not a valid quantifier (a JS literal).
fn quantifier_end(s: &str, at: usize) -> Option<usize> {
    let rest = &s[at + 1..];
    let digits = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digits == 0 {
        return None;
    }
    let rb = rest.as_bytes();
    let mut i = digits;
    if rb.get(i) == Some(&b',') {
        i += 1;
        i += rb[i..].iter().take_while(|b| b.is_ascii_digit()).count();
    }
    if rb.get(i) == Some(&b'}') {
        Some(at + 1 + i + 1)
    } else {
        None
    }
}

/// Builds a regex from a JS-shaped source + flags. `g`/`y`/`u` are JS execution
/// flags with no Rust equivalent (a global regex is only ever used with
/// `lastIndex = 0` here, i.e. as a normal search) and are ignored; `i`/`m`/`s`
/// map onto the Rust builder. Literal braces are translated first (see
/// [`js_pattern_to_rust`]). Returns `None` for a pattern the Rust dialect cannot
/// compile — the caller drops the snippet, exactly like the TS `catch`.
fn build_regex(source: &str, flags: &str) -> Option<Regex> {
    let source = js_pattern_to_rust(source);
    let mut builder = RegexBuilder::new(&source);
    builder.case_insensitive(flags.contains('i'));
    builder.multi_line(flags.contains('m'));
    builder.dot_matches_new_line(flags.contains('s'));
    builder.build().ok()
}

/// Port of `src/editor/snippets/engine.ts::parseSnippet`. Returns `None` for a
/// snippet whose regex trigger cannot be compiled (the TS `catch → null`).
pub fn parse_snippet(raw: &RawSnippet<'_>) -> Option<Snippet> {
    let options = raw.options;
    let (trigger, anchored, regex) = match &raw.trigger {
        RawTrigger::Literal(src) => {
            let substituted = substitute_variables(src);
            // latex-suite file format: regex triggers are strings carrying the
            // `r` option — compile them, or they would only match as literals.
            if options.contains('r') {
                build_regex(&substituted, "")?;
                let anchored = build_regex(&format!("(?:{})$", substituted), "")?;
                (Trigger::Regex { source: substituted }, Some(anchored), true)
            } else {
                (Trigger::Literal(substituted), None, false)
            }
        }
        RawTrigger::Regex { source, flags } => {
            // Regex triggers: substitute variables in the source, keep flags.
            let substituted = substitute_variables(source);
            build_regex(&substituted, flags)?;
            let anchored =
                build_regex(&format!("(?:{})$", substituted), &flags.replace('g', ""))?;
            (Trigger::Regex { source: substituted }, Some(anchored), true)
        }
    };

    let mut mode = SnippetMode::default();
    let mut saw_mode_flag = false;
    for ch in options.chars() {
        match ch {
            'm' => {
                mode.block_math = true;
                mode.inline_math = true;
                saw_mode_flag = true;
            }
            'n' => {
                mode.inline_math = true;
                saw_mode_flag = true;
            }
            'M' => {
                mode.block_math = true;
                saw_mode_flag = true;
            }
            't' => {
                mode.text = true;
                saw_mode_flag = true;
            }
            'T' => {
                mode.text_env = true;
                saw_mode_flag = true;
            }
            'c' => {
                mode.code_block = true;
                saw_mode_flag = true;
            }
            'C' => {
                mode.code = true;
                saw_mode_flag = true;
            }
            _ => {}
        }
    }
    if !saw_mode_flag {
        mode.catchall = true;
    }

    let visual = options.contains('v')
        || matches!(&raw.replacement, RawReplacement::Text(t) if t.contains("${VISUAL}"));

    let display_trigger = match &trigger {
        Trigger::Literal(t) => t.clone(),
        Trigger::Regex { source } => source.clone(),
    };

    Some(Snippet {
        trigger,
        display_trigger,
        anchored,
        replacement: match raw.replacement {
            RawReplacement::Text(t) => RawReplacementOwned::Text(t.to_string()),
            RawReplacement::Fn(f) => RawReplacementOwned::Fn(f),
        },
        auto: options.contains('A'),
        regex,
        word: options.contains('w'),
        visual,
        mode,
        priority: raw.priority,
        description: raw.description.to_string(),
        source: raw.source,
    })
}

/// Port of `src/editor/snippets/engine.ts::isWordBoundary`.
///
/// latex-suite's `w` rule: the trigger must be surrounded by delimiters on
/// both sides; non-ASCII (CJK) also counts as a boundary — otherwise 「测试dm」
/// would never expand in a Chinese note. The settings string writes `\n` as two
/// literal characters; those are restored to a real newline here.
pub fn is_word_boundary(doc: &str, trigger_pos: usize, cursor: usize, delimiters: &str) -> bool {
    let prev = prev_char(doc, trigger_pos);
    let next = char_at(doc, cursor);
    let set = delimiters.replace("\\n", "\n");
    let boundary = |ch: Option<char>| match ch {
        None => true, // document start/end
        Some(c) => !c.is_ascii() || set.contains(c),
    };
    boundary(prev) && boundary(next)
}

/// Port of `src/editor/snippets/engine.ts::compileSnippets`: priority desc,
/// then longer literal triggers first (regex triggers sort last within a
/// priority band). Stable, like the TS `Array.prototype.sort`.
pub fn compile_snippets(raws: &[RawSnippet<'_>]) -> Vec<Snippet> {
    let mut list: Vec<Snippet> = raws.iter().filter_map(parse_snippet).collect();
    list.sort_by(|a, b| {
        b.priority.cmp(&a.priority).then_with(|| {
            let la = if a.regex { 0 } else { a.display_trigger.chars().count() };
            let lb = if b.regex { 0 } else { b.display_trigger.chars().count() };
            lb.cmp(&la)
        })
    });
    list
}

/// Port of the TS `CompiledSnippetList`.
#[derive(Debug, Clone)]
pub struct CompiledSnippets {
    /// Sorted: priority desc, then longer triggers first.
    pub list: Vec<Snippet>,
}

impl CompiledSnippets {
    pub fn new(raws: &[RawSnippet<'_>]) -> Self {
        Self { list: compile_snippets(raws) }
    }

    /// The TS module-level `builtinSnippets` constant, compiled once.
    pub fn builtin() -> &'static CompiledSnippets {
        static BUILTIN: std::sync::OnceLock<CompiledSnippets> = std::sync::OnceLock::new();
        BUILTIN.get_or_init(|| CompiledSnippets::new(DEFAULT_SNIPPETS))
    }

    /// Port of `src/editor/snippets/engine.ts::findSnippet` — finds the best
    /// snippet matching the text right before `cursor`.
    pub fn match_at<'s>(
        &'s self,
        doc: &str,
        cursor: usize,
        ctx: &EditContext,
        opts: &MatchOptions<'_>,
    ) -> Option<Expansion<'s>> {
        let line_from = line_start(doc, cursor);
        let prefix = &doc[line_from..cursor];
        let delimiters = opts.word_delimiters;
        // Trim only inside inline math (a whitespace before a block-math line
        // break is part of the layout).
        let trim = opts.remove_snippet_whitespace && ctx.inline_math;

        for snippet in &self.list {
            if opts.auto && !snippet.auto {
                continue;
            }

            // Visual snippets only fire when there is a selection to operate on.
            if snippet.visual {
                match (&snippet.trigger, opts.visual_text, opts.typed_key) {
                    (Trigger::Literal(t), Some(_), Some(key)) if t == key => {}
                    _ => continue,
                }
            } else if opts.visual_text.is_some() {
                // Selection being replaced: only visual snippets apply.
                continue;
            }

            if !snippet.matches_context(ctx) {
                continue;
            }

            if snippet.regex {
                let Some(anchored) = &snippet.anchored else { continue };
                let Some(caps) = anchored.captures(prefix) else { continue };
                let whole = caps.get(0).expect("group 0 always present");
                let start = line_from + whole.start();
                let end = line_from + whole.end();
                if snippet.word && !is_word_boundary(doc, end - whole.as_str().len(), end, delimiters) {
                    continue;
                }
                // latex-suite semantics: [[0]] refers to the FIRST capture
                // group, so pass groups[0] = caps[1] (the TS `m.slice(1)`).
                let groups: Vec<String> = caps
                    .iter()
                    .skip(1)
                    .map(|g| g.map(|m| m.as_str().to_string()).unwrap_or_default())
                    .collect();
                let Some(resolved) = resolve_replacement(snippet, ReplacementArg::Groups(&groups), opts.visual_text) else {
                    continue;
                };
                let text = if trim {
                    trim_snippet_whitespace(&resolved.text)
                } else {
                    resolved.text
                };
                return Some(Expansion {
                    snippet,
                    start,
                    end,
                    replacement: parse_replacement(&text, &groups, opts.visual_text, resolved.raw),
                });
            }

            let Trigger::Literal(trigger) = &snippet.trigger else { continue };
            if let Some(key) = opts.typed_key {
                if !trigger.ends_with(key) {
                    continue;
                }
            }
            if !prefix.ends_with(trigger.as_str()) {
                continue;
            }
            let start = cursor - trigger.len();
            if snippet.word && !is_word_boundary(doc, start, cursor, delimiters) {
                continue;
            }
            let Some(resolved) =
                resolve_replacement(snippet, ReplacementArg::Trigger(trigger), opts.visual_text)
            else {
                continue;
            };
            let text = if trim { trim_snippet_whitespace(&resolved.text) } else { resolved.text };
            return Some(Expansion {
                snippet,
                start,
                end: cursor,
                replacement: parse_replacement(&text, &[], opts.visual_text, resolved.raw),
            });
        }
        None
    }
}

/// Resolution of a snippet's replacement: the text plus whether it came from a
/// function (the raw channel — see [`parse_replacement`]).
struct Resolved {
    text: String,
    raw: bool,
}

/// TS `resolveReplacement`: function-type replacements take the visual text
/// when the snippet is visual, otherwise `arg` (groups / trigger); a returned
/// non-string means the snippet does not match.
fn resolve_replacement(
    snippet: &Snippet,
    arg: ReplacementArg<'_>,
    visual_text: Option<&str>,
) -> Option<Resolved> {
    match &snippet.replacement {
        RawReplacementOwned::Text(t) => Some(Resolved { text: t.clone(), raw: false }),
        RawReplacementOwned::Fn(f) => {
            let argument = if snippet.visual {
                ReplacementArg::Visual(visual_text?)
            } else {
                arg
            };
            f(argument).map(|text| Resolved { text, raw: true })
        }
    }
}

/// Match options for [`CompiledSnippets::match_at`] (the TS `MatchOptions`).
#[derive(Debug, Clone, Copy)]
pub struct MatchOptions<'a> {
    /// Only snippets with the `A` option are considered.
    pub auto: bool,
    /// The character just typed (None on the manual Tab path).
    pub typed_key: Option<&'a str>,
    /// The selected text when a selection is being replaced.
    pub visual_text: Option<&'a str>,
    /// latex-suite `removeSnippetWhitespace` (on by default, like the plugin).
    pub remove_snippet_whitespace: bool,
    /// latex-suite `wordDelimiters` (plugin default by default, see `config`).
    pub word_delimiters: &'a str,
}

impl<'a> MatchOptions<'a> {
    /// Plugin defaults (`findSnippet` called without a configured extension).
    pub fn new(auto: bool, typed_key: Option<&'a str>, visual_text: Option<&'a str>) -> Self {
        Self {
            auto,
            typed_key,
            visual_text,
            remove_snippet_whitespace: true,
            word_delimiters: LATEX_SUITE_WORD_DELIMITERS,
        }
    }

    /// The TS `findSnippetHere`: expansion-time settings come from the config.
    pub fn from_config(
        config: &'a LatexConfig,
        auto: bool,
        typed_key: Option<&'a str>,
        visual_text: Option<&'a str>,
    ) -> Self {
        Self {
            auto,
            typed_key,
            visual_text,
            remove_snippet_whitespace: config.remove_snippet_whitespace,
            word_delimiters: &config.word_delimiters,
        }
    }
}

/// Port of the TS `MatchResult`: a matched snippet plus the document region it
/// replaces and the expanded replacement.
#[derive(Debug, Clone)]
pub struct Expansion<'a> {
    pub snippet: &'a Snippet,
    /// Replacement region start in the document.
    pub start: usize,
    /// Cursor position (replacement region end).
    pub end: usize,
    pub replacement: ParsedReplacement,
}

impl<'a> Expansion<'a> {
    /// The document edit that applies this expansion.
    pub fn replace(&self) -> Replace {
        Replace::new(self.start, self.end, self.replacement.text.clone())
    }

    /// The snippet session this expansion starts (None without tabstops).
    pub fn session(&self) -> Option<Session> {
        Session::build(self.start, &self.replacement)
    }

    /// TS `startSessionAt`'s cursor: the first tabstop range, or a caret at the
    /// end of the inserted text when the replacement has no tabstops.
    pub fn initial_selection(&self) -> Range {
        let end_caret = Range::caret(self.start + self.replacement.text.len());
        match self.session() {
            Some(s) => s.initial_selection().unwrap_or(end_caret),
            None => end_caret,
        }
    }
}

/// Port of the TS `snippetStore` plus `reloadSnippets`: the compiled list and
/// the enable switch. The TS module-global becomes host-owned state; the
/// source-ownership invariant of `load.ts` (only the snippet loader replaces
/// the source, the settings path only flips `enabled`) is the host's.
#[derive(Debug, Clone)]
pub struct SnippetStore {
    pub enabled: bool,
    pub compiled: CompiledSnippets,
}

impl SnippetStore {
    /// The built-in snippet set, enabled.
    pub fn builtin() -> Self {
        Self { enabled: true, compiled: CompiledSnippets::builtin().clone() }
    }

    /// TS `reloadSnippets(raws, enabled)`.
    pub fn from_raw(raws: &[RawSnippet<'_>], enabled: bool) -> Self {
        Self { enabled, compiled: CompiledSnippets::new(raws) }
    }

    /// TS `findSnippet` against this store's compiled list.
    pub fn match_at<'s>(
        &'s self,
        doc: &str,
        cursor: usize,
        ctx: &EditContext,
        opts: &MatchOptions<'_>,
    ) -> Option<Expansion<'s>> {
        self.compiled.match_at(doc, cursor, ctx, opts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::context::context_at_scan;
    use crate::markdown::math_scan::scan_math;

    /// engine.test.ts FIXTURE — a minimal set, independent of the built-in data.
    const FIXTURE: &[RawSnippet<'static>] = &[
        lit("dm", "$$\n$0\n$$", "tAw"),
        lit("(", "($0)$1", "mA"),
        lit("bf", "\\mathbf{$0}$1", "mA"),
        rx("([a-zA-Z])hat", "\\hat{[[0]]}", "rmA"),
    ];

    fn store_with(raws: &[RawSnippet<'_>]) -> SnippetStore {
        SnippetStore::from_raw(raws, true)
    }

    fn fixture_store() -> SnippetStore {
        store_with(FIXTURE)
    }

    /// The TS tests create a document and compute the context internally; here
    /// the context is explicit (see the module contract).
    fn ctx(doc: &str, pos: usize) -> EditContext {
        let math = scan_math(doc);
        context_at_scan(doc, pos, &math)
    }

    fn find<'s>(
        store: &'s SnippetStore,
        doc: &str,
        cursor: usize,
        opts: MatchOptions<'_>,
    ) -> Option<Expansion<'s>> {
        let c = ctx(doc, cursor);
        store.match_at(doc, cursor, &c, &opts)
    }

    fn find_auto<'s>(store: &'s SnippetStore, doc: &str, cursor: usize, typed: &str) -> Option<Expansion<'s>> {
        find(store, doc, cursor, MatchOptions::new(true, Some(typed), None))
    }

    /// `findSnippet:w 片段的词边界`.
    #[test]
    fn word_boundary_line_start_expands() {
        // A real case: previous line is prose, the new line starts with `dm`.
        let store = fixture_store();
        let doc = "正文\n\ndm";
        let m = find_auto(&store, doc, doc.len(), "m");
        assert!(m.unwrap().snippet.trigger_is("dm"));
    }

    #[test]
    fn word_boundary_document_start_expands() {
        let store = fixture_store();
        let m = find_auto(&store, "dm", 2, "m");
        assert!(m.unwrap().snippet.trigger_is("dm"));
    }

    #[test]
    fn word_boundary_newline_after_trigger_expands() {
        let store = fixture_store();
        let m = find_auto(&store, "dm\n下一行", 2, "m");
        assert!(m.unwrap().snippet.trigger_is("dm"));
    }

    #[test]
    fn letter_glued_to_letter_is_not_a_boundary() {
        let store = fixture_store();
        assert!(find_auto(&store, "xdm", 3, "m").is_none());
    }

    #[test]
    fn cjk_neighbour_is_a_boundary() {
        let store = fixture_store();
        let doc = "公式dm";
        let m = find_auto(&store, doc, doc.len(), "m");
        assert!(m.unwrap().snippet.trigger_is("dm"));
    }

    /// `findSnippet:模式上下文`.
    #[test]
    fn inline_math_paren_expands_to_a_pair() {
        let store = fixture_store();
        let doc = "$x()$";
        let m = find_auto(&store, doc, 3, "(").unwrap();
        assert!(m.snippet.trigger_is("("));
        assert_eq!(m.start, 2);
        assert_eq!(m.replacement.text, "()");
    }

    #[test]
    fn text_context_paren_does_not_expand() {
        let store = fixture_store();
        let doc = "普通(x";
        assert!(find_auto(&store, doc, doc.len(), "(").is_none());
    }

    #[test]
    fn regex_trigger_anchors_at_the_cursor() {
        let store = fixture_store();
        let doc = "$xhat$";
        let m = find_auto(&store, doc, 5, "t").unwrap();
        assert_eq!(m.replacement.text, "\\hat{x}");
        assert_eq!(m.start, 1);
    }

    #[test]
    fn manual_tab_path_matches_with_null_typed_key() {
        let store = fixture_store();
        let m = find(&store, "dm", 2, MatchOptions::new(false, None, None));
        assert!(m.unwrap().snippet.trigger_is("dm"));
    }

    /// `compileSnippets:排序契约`.
    #[test]
    fn compile_sorts_by_priority_then_trigger_length() {
        let raws = [
            lit("a", "1", "tA"),
            lit("abc", "2", "tA"),
            rx("ab", "3", "rA"),
            lit_p("abx", "4", "tA", 1),
        ];
        let compiled = CompiledSnippets::new(&raws);
        let triggers: Vec<&str> = compiled.list.iter().map(|s| s.display_trigger.as_str()).collect();
        assert_eq!(triggers, vec!["abx", "abc", "a", "ab"]);
    }

    /// `函数型 replacement(latex-suite 语义)`.
    fn fn_replacement(arg: ReplacementArg<'_>) -> Option<String> {
        match arg {
            ReplacementArg::Groups(groups) => Some(format!("n={}", groups.first()?)),
            ReplacementArg::Trigger(t) => Some(format!("[{}]", t)),
            ReplacementArg::Visual(v) => Some(format!("({})", v)),
        }
    }

    #[test]
    fn regex_function_replacement_receives_capture_groups() {
        let store = store_with(&[RawSnippet {
            trigger: RawTrigger::Regex { source: "iden(\\d)", flags: "" },
            replacement: RawReplacement::Fn(fn_replacement),
            options: "mA",
            priority: 0,
            description: "",
            source: SnippetSource::Builtin,
        }]);
        let doc = "$iden3$";
        let m = find_auto(&store, doc, 6, "3").unwrap();
        assert_eq!(m.replacement.text, "n=3");
    }

    #[test]
    fn string_function_replacement_receives_the_trigger() {
        let store = store_with(&[RawSnippet {
            trigger: RawTrigger::Literal("zz"),
            replacement: RawReplacement::Fn(fn_replacement),
            options: "mA",
            priority: 0,
            description: "",
            source: SnippetSource::Builtin,
        }]);
        let doc = "$zz$";
        let m = find_auto(&store, doc, 3, "z").unwrap();
        assert_eq!(m.replacement.text, "[zz]");
    }

    #[test]
    fn visual_function_replacement_receives_the_selection() {
        let store = store_with(&[RawSnippet {
            trigger: RawTrigger::Literal("("),
            replacement: RawReplacement::Fn(fn_replacement),
            options: "mAv",
            priority: 0,
            description: "",
            source: SnippetSource::Builtin,
        }]);
        let doc = "$($";
        let m = find(&store, doc, 2, MatchOptions::new(false, Some("("), Some("a+b"))).unwrap();
        assert_eq!(m.replacement.text, "(a+b)");
    }

    #[test]
    fn function_return_still_scans_tabstops() {
        fn hat(_: ReplacementArg<'_>) -> Option<String> {
            Some("\\hat{$0}$1".to_string())
        }
        let store = store_with(&[RawSnippet {
            trigger: RawTrigger::Literal("hh"),
            replacement: RawReplacement::Fn(hat),
            options: "mA",
            priority: 0,
            description: "",
            source: SnippetSource::Builtin,
        }]);
        let doc = "$hh$";
        let m = find_auto(&store, doc, 3, "h").unwrap();
        assert_eq!(m.replacement.text, "\\hat{}");
        assert_eq!(
            m.replacement.stops,
            vec![
                crate::snippets::Stop { index: 0, from: 5, to: 5 },
                crate::snippets::Stop { index: 1, from: 6, to: 6 },
            ]
        );
    }

    #[test]
    fn non_string_function_return_means_no_match() {
        fn nothing(_: ReplacementArg<'_>) -> Option<String> {
            None
        }
        let raws = [
            RawSnippet {
                trigger: RawTrigger::Literal("kk"),
                replacement: RawReplacement::Fn(nothing),
                options: "mA",
                priority: 0,
                description: "",
                source: SnippetSource::Builtin,
            },
            lit("kk", "fallback", "mA"),
        ];
        let store = store_with(&raws);
        let doc = "$kk$";
        let m = find_auto(&store, doc, 3, "k").unwrap();
        assert_eq!(m.replacement.text, "fallback");
    }

    #[test]
    fn builtin_iden3_builds_a_3x3_identity_matrix() {
        let store = SnippetStore::builtin();
        let doc = "$iden3$";
        let m = find_auto(&store, doc, 6, "3").unwrap();
        assert_eq!(
            m.replacement.text,
            "\\begin{pmatrix}\n1 & 0 & 0 \\\\\n0 & 1 & 0 \\\\\n0 & 0 & 1\n\\end{pmatrix}"
        );
    }

    /// `removeSnippetWhitespace(仅行内公式)`.
    #[test]
    fn inline_math_trims_trailing_whitespace() {
        let store = store_with(&[lit("sp", "a ", "mA")]);
        let doc = "$sp$";
        let m = find_auto(&store, doc, 3, "p").unwrap();
        assert_eq!(m.replacement.text, "a");
    }

    #[test]
    fn inline_math_keeps_the_stop_and_drops_the_space_before_it() {
        let store = store_with(&[lit("tu", "a x $2", "mA")]);
        let doc = "$tu$";
        let m = find_auto(&store, doc, 3, "u").unwrap();
        assert_eq!(m.replacement.text, "a x");
    }

    #[test]
    fn block_math_is_not_trimmed() {
        let store = store_with(&[lit("sp", "a ", "MA")]);
        let doc = "$$\nsp\n$$";
        let m = find_auto(&store, doc, 5, "p").unwrap();
        assert_eq!(m.replacement.text, "a ");
    }

    #[test]
    fn trimming_can_be_switched_off() {
        let store = store_with(&[lit("sp", "a ", "mA")]);
        let doc = "$sp$";
        let opts = MatchOptions {
            auto: true,
            typed_key: Some("p"),
            visual_text: None,
            remove_snippet_whitespace: false,
            word_delimiters: LATEX_SUITE_WORD_DELIMITERS,
        };
        let m = find(&store, doc, 3, opts).unwrap();
        assert_eq!(m.replacement.text, "a ");
    }

    /// `wordDelimiters 可配`.
    #[test]
    fn default_delimiters_exclude_star() {
        let store = store_with(&[lit("dm", "x", "tAw")]);
        assert!(find_auto(&store, "*dm", 3, "m").is_none());
    }

    #[test]
    fn widened_delimiters_make_star_a_boundary() {
        let store = store_with(&[lit("dm", "x", "tAw")]);
        let opts = MatchOptions {
            auto: true,
            typed_key: Some("m"),
            visual_text: None,
            remove_snippet_whitespace: true,
            word_delimiters: "*",
        };
        let m = find(&store, "*dm", 3, opts).unwrap();
        assert!(m.snippet.trigger_is("dm"));
    }

    #[test]
    fn literal_backslash_n_in_the_settings_becomes_a_real_newline() {
        let store = store_with(&[lit("dm", "x", "tAw")]);
        let doc = "正文\ndm";
        let opts = MatchOptions {
            auto: true,
            typed_key: Some("m"),
            visual_text: None,
            remove_snippet_whitespace: true,
            word_delimiters: LATEX_SUITE_WORD_DELIMITERS,
        };
        let m = find(&store, doc, doc.len(), opts).unwrap();
        assert!(m.snippet.trigger_is("dm"));
    }

    #[test]
    fn cjk_neighbour_is_a_boundary_whatever_the_delimiters() {
        let store = store_with(&[lit("dm", "x", "tAw")]);
        let doc = "测试dm";
        let opts = MatchOptions {
            auto: true,
            typed_key: Some("m"),
            visual_text: None,
            remove_snippet_whitespace: true,
            word_delimiters: "",
        };
        let m = find(&store, doc, doc.len(), opts).unwrap();
        assert!(m.snippet.trigger_is("dm"));
    }

    /// Snippet-model details not covered by the TS suites but relied upon by
    /// the host: mode gating and visual gating.
    #[test]
    fn mode_gates_and_visual_gating() {
        let store = fixture_store();
        // `dm` is `tAw` (text only): inside math it must not match…
        let in_math = "$dm$";
        assert!(find_auto(&store, in_math, 3, "m").is_none());
        // …while in plain text it does.
        assert!(find_auto(&store, "dm", 2, "m").is_some());
        // A selection being replaced suppresses non-visual snippets.
        assert!(
            find(&store, "dm", 2, MatchOptions::new(false, Some("m"), Some("sel"))).is_none()
        );
        // Visual snippets need a selection and the exact typed key.
        let visual = store_with(&[RawSnippet {
            trigger: RawTrigger::Literal("("),
            replacement: RawReplacement::Text("(${VISUAL})"),
            options: "mAv",
            priority: 0,
            description: "",
            source: SnippetSource::Builtin,
        }]);
        assert!(
            find(&visual, "$($", 2, MatchOptions::new(false, Some("("), Some("a+b")))
                .is_some()
        );
        assert!(find(&visual, "$($", 2, MatchOptions::new(false, None, Some("a+b"))).is_none());
    }

    #[test]
    fn typed_key_must_equal_the_trigger_tail() {
        let store = fixture_store();
        // `typed_key` is the character just typed; a mismatching key must not
        // match even though the prefix ends with the trigger.
        assert!(find_auto(&store, "dm", 2, "x").is_none());
        assert!(find_auto(&store, "dm", 2, "m").is_some());
    }
}
