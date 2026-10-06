//! Internal-link helpers — the port of `src/editor/ops.ts`'s
//! `wikilinkTargetOnLine` / `insertWikilinkText` scan plus
//! `src/lib/path.ts`'s `wikilinkText` and `src/app/actions.ts`'s
//! `wikiLinkTargetPath`.
//!
//! All byte offsets are UTF-8 into the input `&str` (see [`crate::markdown`]).

use super::context::fence_state_scan;
use super::ops;

/// `/\[\[([^\[\]\n]+?)\]\]/g` — every wikilink in `line`, as `(target_range
/// in line bytes)`. Hand-scanned: the body may hold neither bracket nor
/// newline, and must be non-empty.
pub fn links_in_line(line: &str) -> Vec<std::ops::Range<usize>> {
    let bytes = line.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            let body = i + 2;
            let mut j = body;
            while j + 1 < bytes.len()
                && !(bytes[j] == b']' && bytes[j + 1] == b']')
                && bytes[j] != b'['
                && bytes[j] != b']'
                && bytes[j] != b'\n'
            {
                j += 1;
            }
            if j + 1 < bytes.len() && bytes[j] == b']' && bytes[j + 1] == b']' && j > body {
                out.push(body..j);
                i = j + 2;
                continue;
            }
            i = body;
        } else {
            i += 1;
        }
    }
    out
}

/// The target portion of a link body: drop the alias (`|...`) and the heading
/// (`#...`), trim. `None` when nothing is left.
pub fn target_of_body(body: &str) -> Option<String> {
    let target = body.split('|').next().unwrap_or(body);
    let target = target.split('#').next().unwrap_or(target).trim();
    (!target.is_empty()).then(|| target.to_string())
}

/// Byte ranges the line's backtick spans cover — the cheap stand-in for the
/// TS `getContextAt(...).code` check (`ops.ts:719-722`).
fn inline_code_spans(line: &str) -> Vec<std::ops::Range<usize>> {
    let mut spans = Vec::new();
    let mut open: Option<usize> = None;
    for (i, ch) in line.char_indices() {
        if ch == '`' {
            match open.take() {
                Some(from) => spans.push(from..i),
                None => open = Some(i),
            }
        }
    }
    spans
}

/// The first link target on `cursor`'s line (`[[目标|别名]]` / `[[目标#标题]]`
/// both give the target), or `None` when the line has no usable link. Links
/// inside fenced code or inline code do not count — those are example text,
/// not links. One line holds at most one link, so the first is the line's.
pub fn target_on_line(text: &str, cursor: usize) -> Option<String> {
    let mut cursor = cursor.min(text.len());
    while cursor > 0 && !text.is_char_boundary(cursor) {
        cursor -= 1;
    }
    let line_start = text[..cursor].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let line_end = text[line_start..]
        .find('\n')
        .map(|i| line_start + i)
        .unwrap_or(text.len());
    let line = &text[line_start..line_end];
    if !line.contains("[[") {
        return None;
    }
    // Inside a fenced block the whole line is example text.
    let line_no = text[..line_start].bytes().filter(|b| *b == b'\n').count();
    if fence_state_scan(text).get(line_no).copied().unwrap_or(false) {
        return None;
    }
    let code = inline_code_spans(line);
    for link in links_in_line(line) {
        if code.iter().any(|span| span.start < link.end && span.end > link.start) {
            continue;
        }
        if let Some(target) = target_of_body(&line[link.clone()]) {
            return Some(target);
        }
    }
    None
}

/// Resolve a link target to a vault-relative file path — the same three
/// matches `wikiLinkTargetPath` tries, in order, over the flat file list:
/// full path without extension, basename without extension, exact `x.md`.
pub fn target_rel(target: &str, files: &[String]) -> Option<String> {
    let wanted = target.trim().to_lowercase();
    let wanted = wanted.strip_suffix(".md").unwrap_or(&wanted).to_string();
    files
        .iter()
        .find(|rel| {
            let base = rel.to_lowercase();
            let base = base.strip_suffix(".md").unwrap_or(&base).to_string();
            base == wanted
                || base.rsplit('/').next() == Some(wanted.as_str())
                || rel.to_lowercase() == format!("{wanted}.md")
        })
        .cloned()
}

/// `/\.(md|markdown|txt)$/i` — note extensions dropped from the link text.
fn strip_note_ext(path: &str) -> &str {
    let lower = path.to_ascii_lowercase();
    for ext in [".md", ".markdown", ".txt"] {
        if lower.ends_with(ext) {
            return &path[..path.len() - ext.len()];
        }
    }
    path
}

/// `/\.(md|markdown|txt)$/i` — the file's stem: basename without its note
/// extension (`notes/a.md` → `a`).
pub fn note_stem(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    strip_note_ext(name)
}

/// `[\[\]|#^]` — a target containing one of these cannot be written as
/// `[[…]]`: `]]` would end the link early, `|` reads as alias, `#` as heading.
fn has_link_syntax(text: &str) -> bool {
    text.chars().any(|c| matches!(c, '[' | ']' | '|' | '#' | '^'))
}

/// The shortest text linking to `rel` inside a vault: the bare note name, or
/// the vault-relative path when another note shares that name (a bare name
/// resolves to the first match, so a duplicate name must not be used).
/// `None` when the name cannot be written as a link at all.
pub fn link_text(rel: &str, all_rels: &[String]) -> Option<String> {
    let base = note_stem(rel);
    let lower = base.to_lowercase();
    let ambiguous = all_rels
        .iter()
        .any(|r| r != rel && note_stem(r).to_lowercase() == lower);
    let text = if ambiguous { strip_note_ext(rel) } else { base };
    (!text.is_empty() && !has_link_syntax(text)).then(|| text.to_string())
}

/// Largest char boundary at or below `at` — the engine hands out boundaries;
/// the clamp keeps a malformed offset from panicking a slice.
fn clamp_boundary(text: &str, at: usize) -> usize {
    let mut at = at.min(text.len());
    while at > 0 && !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// Port of `ops.ts::insertWikilinkText`'s edit shape: a selection with text
/// becomes the alias, its text replaced wholesale by the link; otherwise the
/// link is inserted at the caret. The caret lands after the link either way.
///
/// The alias is sanitized first — a link syntax character would end the link
/// early (`]]`), read as alias (`|`) or heading (`#`) — each becomes a space,
/// and an all-blank alias is dropped rather than written as `[[x|]]`.
pub fn link_insert(
    doc: &str,
    selection: std::ops::Range<usize>,
    target: &str,
) -> ops::OpsOutcome {
    let from = clamp_boundary(doc, selection.start.min(selection.end));
    let to = clamp_boundary(doc, selection.start.max(selection.end));
    let alias: String = doc[from..to]
        .chars()
        .map(|c| if matches!(c, '[' | ']' | '|' | '\r' | '\n') { ' ' } else { c })
        .collect();
    let alias = alias.trim();
    let text = if alias.is_empty() {
        format!("[[{target}]]")
    } else {
        format!("[[{target}|{alias}]]")
    };
    let caret = from + text.len();
    ops::OpsOutcome {
        edits: vec![ops::Edit { start: from, end: to, text }],
        cursors: vec![(caret, caret)],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_usable_link_on_the_cursor_line_wins() {
        // Alias, heading and padding all reduce to the target.
        assert_eq!(
            target_on_line("see [[Note|alias]] and [[Other]]", 0).as_deref(),
            Some("Note")
        );
        assert_eq!(
            target_on_line("[[目标#标题]]", 4).as_deref(),
            Some("目标")
        );
        assert_eq!(target_on_line("[[  spaced  ]]", 0).as_deref(), Some("spaced"));

        // Only the cursor's line counts.
        let doc = "[[First]]\nplain\n";
        assert_eq!(target_on_line(doc, 0).as_deref(), Some("First"));
        assert_eq!(target_on_line(doc, doc.len() - 1), None);

        // An empty body is not a link, but a later usable one still is.
        assert_eq!(target_on_line("[[|x]]", 0), None);
        assert_eq!(
            target_on_line("[[ ]] then [[Real]]", 0).as_deref(),
            Some("Real")
        );
        assert_eq!(target_on_line("no link here", 0), None);
    }

    #[test]
    fn code_contexts_do_not_hold_links() {
        // Inline code.
        assert_eq!(target_on_line("`[[x]]`", 0), None);
        assert_eq!(
            target_on_line("`[[x]]` but [[real]]", 0).as_deref(),
            Some("real")
        );
        // Fenced code.
        let doc = "```\n[[inside]]\n```\n";
        assert_eq!(target_on_line(doc, 8), None);
        // A link on a normal line after the fence works.
        let doc = "```\nbody\n```\n[[after]]\n";
        assert_eq!(target_on_line(doc, doc.len() - 1).as_deref(), Some("after"));
    }

    #[test]
    fn targets_resolve_by_path_then_basename_then_extension() {
        let files = vec![
            "notes/a.md".to_string(),
            "archive/a.md".to_string(),
            "b.md".to_string(),
        ];
        // Full path without extension.
        assert_eq!(target_rel("notes/a", &files).as_deref(), Some("notes/a.md"));
        // Basename resolves to the first match, path order decided by the list.
        assert_eq!(target_rel("a", &files).as_deref(), Some("notes/a.md"));
        // Case-insensitive, `.md` optional.
        assert_eq!(target_rel("B.MD", &files).as_deref(), Some("b.md"));
        assert_eq!(target_rel("b", &files).as_deref(), Some("b.md"));
        assert_eq!(target_rel("missing", &files), None);
    }

    #[test]
    fn link_text_prefers_the_bare_name_and_guards_syntax() {
        let files = vec!["notes/a.md".to_string(), "archive/a.md".to_string()];
        // An ambiguous name uses the path without its extension.
        assert_eq!(link_text("notes/a.md", &files).as_deref(), Some("notes/a"));
        // A unique name stays bare.
        let files = vec!["notes/a.md".to_string(), "b.md".to_string()];
        assert_eq!(link_text("notes/a.md", &files).as_deref(), Some("a"));
        assert_eq!(link_text("b.markdown", &files).as_deref(), Some("b"));
        // A name carrying link syntax cannot be written.
        let files = vec!["odd|name.md".to_string()];
        assert_eq!(link_text("odd|name.md", &files), None);
    }

    #[test]
    fn link_insert_writes_at_the_caret_and_lands_after_the_link() {
        let out = link_insert("ab", 2..2, "Note");
        assert_eq!(out.edits.len(), 1);
        assert_eq!((out.edits[0].start, out.edits[0].end), (2, 2));
        assert_eq!(out.edits[0].text, "[[Note]]");
        // The caret follows the inserted text (2 + 8).
        assert_eq!(out.cursors, vec![(10, 10)]);
    }

    #[test]
    fn link_insert_turns_the_selection_into_a_sanitized_alias() {
        // The selection text is replaced by the whole link, alias inside.
        let doc = "hello title world";
        let out = link_insert(doc, 6..11, "Note");
        assert_eq!((out.edits[0].start, out.edits[0].end), (6, 11));
        assert_eq!(out.edits[0].text, "[[Note|title]]");
        assert_eq!(out.cursors, vec![(6 + 14, 6 + 14)]);

        // Link syntax in the alias becomes spaces, then trims away.
        let doc = "a [bad] | alias";
        let out = link_insert(doc, 2..15, "N");
        assert_eq!(out.edits[0].text, "[[N|bad    alias]]");

        // An all-blank alias is dropped: `[[N|]]` would not parse as a link.
        let out = link_insert("a  b", 1..3, "N");
        assert_eq!(out.edits[0].text, "[[N]]");

        // Reversed selection ends still cover the same range.
        let out = link_insert(doc, 15..2, "N");
        assert_eq!((out.edits[0].start, out.edits[0].end), (2, 15));
    }
}
