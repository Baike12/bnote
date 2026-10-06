//! Port of `src/editor/snippets/brackets.ts` — all the bracket geometry:
//! pair lookup, colored pairing and cursor-bracket highlighting. Shared with
//! auto-fraction and enlarge.
//!
//! * Pair lookup is a **literal count** scan with no escape skipping (the
//!   plugin's `findMatchingBracket` slices and counts, so the `{` inside `\{`
//!   counts too — and `\{`/`\}` do get colored, matching the plugin).
//! * Colored pairing is fixed at 3 colors (plugin `Ncolors = 3`): a closing
//!   bracket takes the color of the stack depth *after* the pop, so the
//!   outermost pair is always color 0 and colors rotate inward.
//! * Cursor highlighting looks at the cursor and the character before it; when
//!   neither is a bracket and the range is empty it falls back to the innermost
//!   enclosing bracket pair.

use crate::markdown::math_scan::MathRegion;

use super::{Range, char_at, next_char_start, prev_char_start};

/// The opener of a single-character closing bracket (the plugin only knows
/// these three).
pub fn get_open_bracket(close: char) -> Option<char> {
    match close {
        ')' => Some('('),
        ']' => Some('['),
        '}' => Some('{'),
        _ => None,
    }
}

/// The closer of a single-character opening bracket.
pub fn get_close_bracket(open: char) -> Option<char> {
    match open {
        '(' => Some(')'),
        '[' => Some(']'),
        '{' => Some('}'),
        _ => None,
    }
}

const OPEN_BRACKETS: [char; 3] = ['{', '[', '('];
const ALL_BRACKETS: [char; 6] = ['{', '[', '(', '}', ']', ')'];

/// Plugin `Ncolors`.
pub const BRACKET_COLOR_COUNT: usize = 3;

/// Finds the partner of the bracket at `from`, scanning rightwards (or
/// leftwards with `backwards`). Literal counting; `stop` bounds the forward
/// scan; `None` when there is no partner. `backwards` is only used for the
/// single-character brackets (color/highlight/enclosing all use it that way).
pub fn find_matching_bracket(
    text: &str,
    from: usize,
    open: &str,
    close: &str,
    backwards: bool,
    stop: usize,
) -> Option<usize> {
    if backwards {
        let mut depth: i64 = 0;
        let mut i = from;
        loop {
            if text[i..].starts_with(close) {
                depth += 1;
            } else if text[i..].starts_with(open) {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            i = prev_char_start(text, i)?;
        }
    }
    let mut depth: i64 = 0;
    let mut i = from;
    let stop = stop.min(text.len());
    while i < stop {
        if text[i..].starts_with(open) {
            depth += 1;
        } else if text[i..].starts_with(close) {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
        match next_char_start(text, i) {
            Some(next) => i = next,
            None => break,
        }
    }
    None
}

/// An innermost enclosing bracket pair, in region-relative offsets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BracketPair {
    pub left: usize,
    pub right: usize,
}

/// Innermost bracket pair enclosing `pos` (relative offsets); `None` when there
/// is none.
pub fn enclosing_brackets(text: &str, pos: usize) -> Option<BracketPair> {
    let mut i = prev_char_start(text, pos.min(text.len()))?;
    loop {
        let ch = char_at(text, i)?;
        if ALL_BRACKETS.contains(&ch) {
            if let Some(open) = get_open_bracket(ch) {
                // A closing bracket: skip the whole group it belongs to (that
                // group ends at or before `pos`, so it cannot enclose it).
                let j =
                    find_matching_bracket(text, i, &open.to_string(), &ch.to_string(), true, text.len())?;
                if j == 0 {
                    return None;
                }
                i = prev_char_start(text, j)?;
                continue;
            }
            let close = get_close_bracket(ch)?;
            let j = find_matching_bracket(text, i, &ch.to_string(), &close.to_string(), false, text.len());
            if let Some(j) = j {
                if j >= pos {
                    return Some(BracketPair { left: i, right: j });
                }
            }
        }
        match prev_char_start(text, i) {
            Some(prev) => i = prev,
            None => return None,
        }
    }
}

/// Last occurrence of `needle` starting at or before `max_start`
/// (`String.prototype.lastIndexOf(needle, max_start)`: the match may extend
/// past `max_start`).
fn last_index_at_most(text: &str, needle: &str, max_start: usize) -> Option<usize> {
    let mut best = None;
    let mut from = 0usize;
    while let Some(rel) = text[from..].find(needle) {
        let at = from + rel;
        if at > max_start {
            break;
        }
        best = Some(at);
        match next_char_start(text, at) {
            Some(next) => from = next,
            None => break,
        }
    }
    best
}

/// Whether `pos` (relative offset) is strictly inside an
/// `open_symbol`…`close_symbol` environment. Two shapes (the plugin's
/// `isWithinEnvironment`):
///
/// * **single-bracket envs** (`\pu{`, `^{`): the opener ends in a `{`/`[`/`(`
///   and the closer is its partner, so the count starts at that bracket itself;
/// * **multi-character envs** (`\begin{pmatrix}`…`\end{pmatrix}`): both ends are
///   whole commands, counted as strings.
///
/// Same-name environments may nest; candidates are searched backwards for the
/// one that actually encloses `pos`.
pub fn within_env(text: &str, pos: usize, open_symbol: &str, close_symbol: &str) -> bool {
    let trailing = open_symbol.chars().next_back();
    let single_bracket = matches!(trailing, Some('{') | Some('[') | Some('('))
        && trailing.and_then(get_close_bracket).map(|c| c.to_string()).as_deref() == Some(close_symbol);
    // Locate by the FULL opener (searching for a bare `{` would hit ordinary
    // braces); only the counting scan starts at the bracket itself.
    let match_open = if single_bracket { trailing.unwrap().to_string() } else { open_symbol.to_string() };
    let offset = if single_bracket { open_symbol.len() - 1 } else { 0 };
    let mut left = last_index_at_most(text, open_symbol, pos.saturating_sub(1));
    while let Some(l) = left {
        let right = find_matching_bracket(text, l + offset, &match_open, close_symbol, false, text.len());
        let Some(right) = right else { return false };
        if right >= pos && pos >= l + open_symbol.len() {
            return true;
        }
        if l == 0 {
            return false;
        }
        left = last_index_at_most(text, open_symbol, l - 1);
    }
    false
}

/// A colored paired-bracket mark: the host renders `cw-bracket-{depth}` over
/// the single bracket character in `[from, to)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BracketColor {
    pub from: usize,
    pub to: usize,
    pub depth: u8,
}

/// A cursor-bracket highlight mark (`cw-bracket-match` over one character).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BracketHighlight {
    pub from: usize,
    pub to: usize,
}

/// Colored pairing: 3-color rotation by nesting depth (outermost = color 0).
///
/// The geometry comes from the document + the visible ranges only — **never
/// from the selection** (the TS plugin therefore does not rebuild on
/// `selectionSet`; this function keeps that invariant by not taking a cursor).
pub fn build_bracket_colors(doc: &str, visible: &[Range], math: &[MathRegion]) -> Vec<BracketColor> {
    let mut out = Vec::new();
    for range in visible {
        for region in math {
            if region.to < range.from || region.from > range.to {
                continue;
            }
            let text = &doc[region.from..region.to];
            let mut stack: Vec<char> = Vec::new();
            let mut pos_stack: Vec<usize> = Vec::new();
            for (i, ch) in text.char_indices() {
                if OPEN_BRACKETS.contains(&ch) {
                    stack.push(ch);
                    pos_stack.push(i);
                } else if ALL_BRACKETS.contains(&ch) {
                    // Type mismatch: ignore the closing bracket.
                    if stack.last().and_then(|c| get_close_bracket(*c)) != Some(ch) {
                        continue;
                    }
                    stack.pop();
                    let open_pos = pos_stack.pop().expect("a closer always has an opener");
                    let depth = (stack.len() % BRACKET_COLOR_COUNT) as u8;
                    out.push(BracketColor {
                        from: open_pos + region.from,
                        to: open_pos + region.from + 1,
                        depth,
                    });
                    out.push(BracketColor { from: i + region.from, to: i + region.from + 1, depth });
                }
            }
        }
    }
    // `Decoration.set(..., true)` sorts; keep the same deterministic order.
    out.sort_by_key(|m| (m.from, m.to));
    out
}

/// Cursor-bracket highlight: the bracket at the cursor (or the one right before
/// it) and its partner. `selections[0]` is the primary range; the first range
/// that produces marks wins, exactly like the TS loop.
pub fn build_cursor_brackets(
    doc: &str,
    selections: &[Range],
    math: &[MathRegion],
) -> Vec<BracketHighlight> {
    let Some(main) = selections.first() else { return Vec::new() };
    let head = main.to;
    let Some(region) = math.iter().find(|r| head >= r.from && head <= r.to) else {
        return Vec::new();
    };
    let eqn = &doc[region.from..region.to];

    let mut out: Vec<BracketHighlight> = Vec::new();
    let mut done = false;
    for range in selections {
        // The character at the cursor and the one before it (the TS loop walks
        // `i` from `range.to` down to `range.from - 1`).
        let lower = range.from.saturating_sub(1);
        let mut p = range.to;
        loop {
            if let Some(ch) = char_at(doc, p) {
                if ALL_BRACKETS.contains(&ch) && p >= region.from && p <= region.to {
                    let is_open = OPEN_BRACKETS.contains(&ch);
                    let open = if is_open { Some(ch) } else { get_open_bracket(ch) };
                    let close = if is_open { get_close_bracket(ch) } else { Some(ch) };
                    if let (Some(open), Some(close)) = (open, close) {
                        let j = find_matching_bracket(
                            eqn,
                            p - region.from,
                            &open.to_string(),
                            &close.to_string(),
                            !is_open,
                            eqn.len(),
                        );
                        if let Some(j) = j {
                            out.push(BracketHighlight { from: p, to: p + 1 });
                            out.push(BracketHighlight {
                                from: j + region.from,
                                to: j + region.from + 1,
                            });
                            done = true;
                            break;
                        }
                    }
                }
            }
            if p == 0 || p <= lower {
                break;
            }
            match prev_char_start(doc, p) {
                Some(prev) => p = prev,
                None => break,
            }
        }
        if done {
            break;
        }
        if !range.is_empty() {
            continue;
        }
        let rel = range.from.saturating_sub(1).saturating_sub(region.from);
        if let Some(enc) = enclosing_brackets(eqn, rel) {
            out.push(BracketHighlight {
                from: enc.left + region.from,
                to: enc.left + region.from + 1,
            });
            out.push(BracketHighlight {
                from: enc.right + region.from,
                to: enc.right + region.from + 1,
            });
            break;
        }
    }
    out.sort_by_key(|m| (m.from, m.to));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::math_scan::scan_math;

    /// `括号几何`.
    #[test]
    fn find_matching_bracket_forward_supports_multi_char_brackets() {
        assert_eq!(find_matching_bracket("(a(b)c)", 0, "(", ")", false, 7), Some(6));
        assert_eq!(
            find_matching_bracket("\\langle \\sum \\rangle", 0, "\\langle", "\\rangle", false, 20),
            Some(13)
        );
        assert_eq!(find_matching_bracket("(abc", 0, "(", ")", false, 4), None);
    }

    #[test]
    fn find_matching_bracket_backwards() {
        assert_eq!(find_matching_bracket("(a(b)c)", 6, "(", ")", true, 7), Some(0));
        assert_eq!(find_matching_bracket("\\frac{a}{b}", 10, "{", "}", true, 11), Some(8));
    }

    #[test]
    fn within_env_finds_the_enclosing_layer_when_environments_nest() {
        let text = "\\pu{a \\pu{b} c}";
        let inner = text.find('b').unwrap();
        assert!(within_env(text, inner, "\\pu{", "}"));
        assert!(!within_env(text, text.len(), "\\pu{", "}"));
    }

    #[test]
    fn enclosing_brackets_picks_the_innermost_pair() {
        assert_eq!(enclosing_brackets("x (a [b] c) y", 7), Some(BracketPair { left: 5, right: 7 }));
        assert_eq!(enclosing_brackets("a b c", 3), None);
        // Cursor after the `)`: the group ends before the position, so it does
        // not enclose it (the closer's opener is skipped, then the scan runs out).
        assert_eq!(enclosing_brackets("(a)", 3), None);
    }

    /// `括号装饰的几何来源`.
    fn decos_colors(marks: &[BracketColor]) -> Vec<String> {
        marks.iter().map(|m| format!("cw-bracket-{}@{}-{}", m.depth, m.from, m.to)).collect()
    }

    fn decos_highlights(marks: &[BracketHighlight]) -> Vec<String> {
        marks.iter().map(|m| format!("cw-bracket-match@{}-{}", m.from, m.to)).collect()
    }

    #[test]
    fn bracket_colors_do_not_depend_on_the_selection() {
        let doc = "前置\n\n$$a+(b)\\cdot[c]$$\n\n后置\n";
        let math = scan_math(doc);
        let visible = [Range::new(0, doc.len())];
        let a = build_bracket_colors(doc, &visible, &math);
        // The same document at a different cursor yields the same decorations
        // (the function does not even take a cursor).
        let b = build_bracket_colors(doc, &visible, &math);
        assert_eq!(decos_colors(&b), decos_colors(&a));
        assert!(!a.is_empty());
    }

    #[test]
    fn bracket_colors_only_paint_formulas_inside_the_visible_range() {
        let doc = "$$a+(b)$$\n\n中间隔开的一些正文\n\n$$c+[d]$$\n";
        let math = scan_math(doc);
        let first = [Range::new(0, 10)];
        let marks = decos_colors(&build_bracket_colors(doc, &first, &math));
        let open = doc.find('(').unwrap();
        let close = doc.find(')').unwrap();
        assert_eq!(
            marks,
            vec![
                format!("cw-bracket-0@{}-{}", open, open + 1),
                format!("cw-bracket-0@{}-{}", close, close + 1),
            ]
        );
        // The second formula (c+[d]) is outside the visible range: nothing painted.
        assert!(marks.iter().all(|m| {
            let from: usize = m.split('@').nth(1).unwrap().split('-').next().unwrap().parse().unwrap();
            from <= 10
        }));
    }

    #[test]
    fn bracket_colors_rotate_by_depth() {
        // ((x)): the inner pair gets color 1, the outer color 0 — a closer
        // takes the depth after the pop.
        let doc = "$$((x))$$\n";
        let math = scan_math(doc);
        let marks = build_bracket_colors(doc, &[Range::new(0, doc.len())], &math);
        let depths: Vec<u8> = marks.iter().map(|m| m.depth).collect();
        assert_eq!(depths, vec![0, 1, 1, 0]);
    }

    #[test]
    fn cursor_highlight_marks_the_adjacent_bracket_pair() {
        let doc = "$$a+(b+c)+d$$\n";
        let math = scan_math(doc);
        let open = doc.find('(').unwrap();
        let close = doc.find(')').unwrap();
        // The cursor sits right after `(` (vim's insert-mode position).
        let marks = build_cursor_brackets(doc, &[Range::caret(open + 1)], &math);
        assert_eq!(
            decos_highlights(&marks),
            vec![
                format!("cw-bracket-match@{}-{}", open, open + 1),
                format!("cw-bracket-match@{}-{}", close, close + 1),
            ]
        );
    }

    #[test]
    fn cursor_highlight_outside_math_is_empty() {
        let doc = "普通文本 (含括号) 但不长在公式里\n";
        let math = scan_math(doc);
        let open = doc.find('(').unwrap();
        assert!(build_cursor_brackets(doc, &[Range::caret(open + 1)], &math).is_empty());
    }

    #[test]
    fn cursor_highlight_reads_positions_not_the_whole_document() {
        let filler = "x_{1}+".repeat(400); // ~2000 chars
        let doc = format!("$${filler}\\left(a+(b)\\right)$$\n");
        let math = scan_math(&doc);
        let open = doc.find("(b)").unwrap();
        let marks = build_cursor_brackets(&doc, &[Range::caret(open + 1)], &math);
        assert_eq!(
            decos_highlights(&marks),
            vec![
                format!("cw-bracket-match@{}-{}", open, open + 1),
                format!("cw-bracket-match@{}-{}", open + 2, open + 3),
            ]
        );
    }

    #[test]
    fn cursor_highlight_falls_back_to_the_enclosing_pair() {
        // Cursor inside the group but not next to a bracket: the innermost
        // enclosing pair lights up.
        let doc = "$$a+(b+c)+d$$\n";
        let math = scan_math(doc);
        let inside = doc.find('b').unwrap();
        let marks = build_cursor_brackets(doc, &[Range::caret(inside)], &math);
        let open = doc.find('(').unwrap();
        let close = doc.find(')').unwrap();
        assert_eq!(
            decos_highlights(&marks),
            vec![
                format!("cw-bracket-match@{}-{}", open, open + 1),
                format!("cw-bracket-match@{}-{}", close, close + 1),
            ]
        );
    }
}
