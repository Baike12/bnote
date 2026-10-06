//! Inline scanning for one line's content: inline code, math widgets, images,
//! wikilinks and the emphasis/strong/strikethrough delimiter algorithm.
//!
//! The TS source walks a lezer tree (`buildInlineDecorations` in
//! `livePreview.ts`); this port scans the line's bytes directly. Every rule
//! keeps the TS activity rule: a span is emitted only while no selection
//! touches the construct's node range, and a construct's `to` is exclusive
//! with a caret resting on it counting as touching (TS `active`).
//!
//! Nothing is ever emitted inside inline code, fenced code, a math region or
//! a markdown link — those ranges are collected up front and every later
//! scanner skips them (the TS `exclude` lists + `return false` at those
//! nodes). Links and autolinks hide nothing at all: `decorateLink`
//! (1075-1091) and the URL/Autolink branch (524-529) only add class marks,
//! which the snapshot model cannot express, so those ranges merely shield
//! their content.

use crate::markdown::math_scan::MathRegion;
use crate::preview::Widget;

use super::geom::{Activity, Sink};

/// One line's inline scan, with the document-wide exclusions it must respect.
pub(super) struct Inline<'a> {
    pub(super) text: &'a str,
    /// Every math region of the document (TS `mathRegions`).
    pub(super) math: &'a [MathRegion],
    /// Which regions are rendered as an inline `Widget::Math` (single-line,
    /// outside fenced code), indexed like `math`.
    pub(super) math_inline: &'a [bool],
    /// Fenced-code byte ranges (already excluded by line skipping inside a
    /// block, but a display region starting mid-line still overlaps them).
    pub(super) code_ranges: &'a [(usize, usize)],
}

impl Inline<'_> {
    /// Scans the content `[from, to)` of one line.
    pub(super) fn scan(&self, from: usize, to: usize, act: &Activity, sink: &mut Sink) {
        if from >= to {
            return;
        }

        // Inline code: it hides its own backticks and shields its content from
        // every other rule (TS `return false` at `InlineCode`). The backtick
        // hides are emitted last, once the link/image scan has decided which
        // code spans live inside a shielded node.
        let code = inline_code(self.text, from, to);
        let mut code_excl = Excluded::default();
        for span in &code {
            code_excl.push(span.node);
        }

        // Math regions on this line: single-line ones become widgets; all of
        // them are shielded from links/emphasis (the TS math loop is
        // independent of the tree walk, so a formula inside a link label still
        // renders).
        //
        // Regions are sorted by position and lines are scanned in order, so a
        // partition point finds this line's slice in `log n` — walking every
        // region per line is quadratic in the document length.
        let first = self.math.partition_point(|region| region.to <= from);
        for (offset, region) in self.math[first..].iter().enumerate() {
            let i = first + offset;
            if region.from >= to {
                break;
            }
            if self.overlaps_code(region.from, region.to) {
                continue;
            }
            if self.math_inline[i]
                && act.inactive(region.from, region.to)
                && !code_excl.overlaps(region.from, region.to)
            {
                let end = region.to.min(to);
                sink.widget(
                    region.from,
                    end,
                    Widget::Math {
                        tex: region.content.clone(),
                        display: region.display,
                    },
                );
            }
        }

        // Links, images and autolinks: images emit their widget, every node is
        // recorded as shielded so nothing else decorates inside it (TS returns
        // false at `Link`/`Image`/`Autolink`; `decorateLink` itself adds only
        // class marks, never a replace).
        let mut shielded = Excluded::default();
        let mut i = from;
        let bytes = self.text.as_bytes();
        while i < to {
            if let Some(end) = code_excl.end_of(i) {
                i = end;
                continue;
            }
            match bytes[i] {
                b'\\' => i = (i + 2).min(to),
                b'!' if bytes.get(i + 1) == Some(&b'[') && bytes.get(i + 2) != Some(&b'[') => {
                    if let Some(node) = bracketed(self.text, i + 1, to) {
                        let end = node.node.1;
                        if act.inactive(i, end) {
                            let src = self.text[node.dest.0..node.dest.1].to_string();
                            let alt = self.text[node.label.0..node.label.1].to_string();
                            sink.widget(i, end, Widget::Image { src, alt });
                        }
                        shielded.push((i, end));
                        i = end;
                    } else {
                        i += 1;
                    }
                }
                b'[' if bytes.get(i + 1) == Some(&b'[') => i = (i + 2).min(to),
                b'[' => {
                    if let Some(node) = bracketed(self.text, i, to) {
                        let end = node.node.1;
                        // `decorateLink` (livePreview.ts:1075-1091) emits only
                        // marks (`md-link` on the label, `md-url` on the URL)
                        // and no replace — the source stays visible, so the
                        // link contributes only this shield (the TS returns
                        // false at the node, shielding the label from every
                        // other rule).
                        shielded.push((i, end));
                        i = end;
                    } else {
                        i += 1;
                    }
                }
                b'<' => match autolink(self.text, i, to) {
                    Some(end) => {
                        shielded.push((i, end));
                        i = end;
                    }
                    None => i += 1,
                },
                _ => i += 1,
            }
        }

        // Code spans that a link/image/autolink swallowed stay raw: the TS
        // never reaches an `InlineCode` inside a node it returned false at.
        for span in &code {
            if shielded.overlaps(span.node.0, span.node.1) {
                continue;
            }
            if act.inactive(span.node.0, span.node.1) {
                sink.hide(span.open.0, span.open.1);
                sink.hide(span.close.0, span.close.1);
            }
        }

        code_excl.extend(&shielded);
        // Markdown escapes run before emphasis: an escaped delimiter (`\*`)
        // must win the bytes over the emphasis scan, exactly like the TS tree
        // walk, which never descends into an `Escape` node.
        self.scan_escapes(from, to, act, &code_excl, sink);
        emphasis(self.text, from, to, &code_excl, act, sink);
    }

    /// Markdown escapes: `\X`, where X is an ASCII punctuator, renders as `X`
    /// alone while the pair is inactive (TS `Escape` node → `EscapeCharWidget`,
    /// `.cw-escape` at normal text color). Anything inside inline code, a
    /// fenced block, a link/image (both shielded, see `excl`) or a math region
    /// is not a markdown escape — `\,`/`\;`/`\{` inside a formula are LaTeX.
    fn scan_escapes(
        &self,
        from: usize,
        to: usize,
        act: &Activity,
        excl: &Excluded,
        sink: &mut Sink,
    ) {
        let bytes = self.text.as_bytes();
        let mut i = from;
        // `to` is exclusive and an escape is two bytes: the last byte of the
        // line can never start one (the TS `start == cx.end - 1` guard).
        while i + 1 < to {
            if bytes[i] != b'\\' {
                i += 1;
                continue;
            }
            let escaped = bytes[i + 1];
            if !is_escapable(escaped) {
                i += 1;
                continue;
            }
            let end = i + 2;
            if !excl.overlaps(i, end) && !self.in_math(i, end) && act.inactive(i, end) {
                sink.widget(
                    i,
                    end,
                    Widget::Escape {
                        char: (escaped as char).to_string(),
                    },
                );
            }
            i = end;
        }
    }

    /// Whether `[from, to)` sits inside a math region (TS `inAnyMath`): the
    /// TS tree walk skips every node inside a formula.
    fn in_math(&self, from: usize, to: usize) -> bool {
        let first = self.math.partition_point(|region| region.to <= from);
        self.math[first..]
            .iter()
            .take_while(|region| region.from < to)
            .any(|region| from >= region.from && to <= region.to)
    }

    fn overlaps_code(&self, from: usize, to: usize) -> bool {
        self.code_ranges.iter().any(|(a, b)| from < *b && to > *a)
    }
}

/// The CM6 `Escapable` set (`@lezer/markdown`): a backslash escapes exactly
/// these characters (and nothing else — `\x` stays a literal backslash).
fn is_escapable(byte: u8) -> bool {
    matches!(
        byte,
        b'!' | b'"'
            | b'#'
            | b'$'
            | b'%'
            | b'&'
            | b'\''
            | b'('
            | b')'
            | b'*'
            | b'+'
            | b','
            | b'-'
            | b'.'
            | b'/'
            | b':'
            | b';'
            | b'<'
            | b'='
            | b'>'
            | b'?'
            | b'@'
            | b'['
            | b'\\'
            | b']'
            | b'^'
            | b'_'
            | b'`'
            | b'{'
            | b'|'
            | b'}'
            | b'~'
    )
}

/// Wikilink pass (`[[target]]` / `[[target|alias]]` / `![[embed]]`), run over
/// the whole raw line exactly like the TS regex pass: it is line-level, so it
/// renders only while the caret is not on the line, and it is skipped inside
/// code (already emitted spans) rather than clamped.
pub(super) fn scan_wikilinks(
    text: &str,
    line_from: usize,
    line_to: usize,
    act: &Activity,
    sink: &mut Sink,
) {
    if line_from >= line_to || act.line_active(line_from, line_to) {
        return;
    }
    let line = &text[line_from..line_to];
    if !line.contains("[[") {
        return;
    }
    let bytes = line.as_bytes();
    let mut i = 0usize;
    while i + 1 < bytes.len() {
        if bytes[i] != b'[' || bytes[i + 1] != b'[' {
            i += 1;
            continue;
        }
        // `\[\[([^\[\]\n]+?)\]\]` — content holds no bracket and is non-empty.
        let mut j = i + 2;
        let mut close = None;
        while j < bytes.len() {
            match bytes[j] {
                b'[' => break,
                b']' => {
                    if j > i + 2 && bytes.get(j + 1) == Some(&b']') {
                        close = Some(j);
                    }
                    break;
                }
                _ => j += 1,
            }
        }
        let Some(close) = close else {
            i += 1;
            continue;
        };
        let from = line_from + i;
        let to = line_from + close + 2;
        let raw = &line[i + 2..close];
        let pipe = raw.find('|');
        let before_pipe = pipe.map_or(raw, |p| &raw[..p]);
        let target = before_pipe.split('#').next().unwrap_or("").trim();
        if target.is_empty() {
            i = close + 2;
            continue;
        }
        let embed_from = if i > 0 && bytes[i - 1] == b'!' {
            Some(from - 1)
        } else {
            None
        };

        // `![[x.png]]` / `![[x.excalidraw]]`: the whole embed renders as an
        // image when the target is one (otherwise the plain wikilink path
        // below keeps the source, matching the TS fallback).
        if let Some(start) = embed_from {
            if is_image_name(target) || is_drawing_name(target) {
                let widget = Widget::Image {
                    src: target.to_string(),
                    alt: target.to_string(),
                };
                if sink.widget(start, to, widget) {
                    i = close + 2;
                    continue;
                }
            }
        }

        if sink.overlaps_claimed(from, to) {
            i = close + 2;
            continue;
        }
        if let Some(pipe) = pipe {
            let alias_start = from + 2 + pipe + 1;
            if alias_start > from + 2 {
                sink.hide(from + 2, alias_start);
            }
        }
        sink.hide(from, from + 2);
        sink.hide(to - 2, to);
        i = close + 2;
    }
}

/// `IMAGE_EXT_RE` from `livePreview.ts`.
fn is_image_name(name: &str) -> bool {
    const EXTS: [&str; 12] = [
        "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico", "tif", "tiff", "heic",
    ];
    let lower = name.to_ascii_lowercase();
    EXTS.iter().any(|e| lower.ends_with(&format!(".{e}")))
}

/// `isDrawingFileName` from `src/lib/excalidrawFile.ts`.
fn is_drawing_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".excalidraw") || lower.ends_with(".excalidraw.md")
}

/// One inline-code span: the node range plus its two backtick runs.
struct CodeSpan {
    node: (usize, usize),
    open: (usize, usize),
    close: (usize, usize),
}

/// CommonMark code spans: a backtick run opens and is closed by a run of the
/// same length; shorter runs inside are literal.
fn inline_code(text: &str, from: usize, to: usize) -> Vec<CodeSpan> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = from;
    while i < to {
        if bytes[i] != b'`' {
            i += 1;
            continue;
        }
        let start = i;
        while i < to && bytes[i] == b'`' {
            i += 1;
        }
        let len = i - start;
        let mut j = i;
        let mut close = None;
        while j < to {
            if bytes[j] != b'`' {
                j += 1;
                continue;
            }
            let run = j;
            while j < to && bytes[j] == b'`' {
                j += 1;
            }
            if j - run == len {
                close = Some((run, j));
                break;
            }
        }
        if let Some((cf, ct)) = close {
            out.push(CodeSpan {
                node: (start, ct),
                open: (start, i),
                close: (cf, ct),
            });
            i = ct;
        }
    }
    out
}

/// A bracketed construct `[...](...)`: node range, label range and
/// destination (title stripped).
struct Bracket {
    node: (usize, usize),
    label: (usize, usize),
    dest: (usize, usize),
}

/// Parses `[label](dest "title")` at `pos` (the `[`).
fn bracketed(text: &str, pos: usize, to: usize) -> Option<Bracket> {
    let bytes = text.as_bytes();
    if bytes.get(pos) != Some(&b'[') {
        return None;
    }
    let mut depth = 0usize;
    let mut i = pos + 1;
    let mut close = None;
    while i < to {
        match bytes[i] {
            b'\\' => i += 2,
            b'[' => {
                depth += 1;
                i += 1;
            }
            b']' => {
                if depth == 0 {
                    close = Some(i);
                    break;
                }
                depth -= 1;
                i += 1;
            }
            _ => i += 1,
        }
    }
    let close_bracket = close?;
    if bytes.get(close_bracket + 1) != Some(&b'(') {
        return None;
    }
    let open_paren = close_bracket + 1;
    let mut depth = 0usize;
    let mut i = open_paren + 1;
    let mut close_paren = None;
    while i < to {
        match bytes[i] {
            b'\\' => i += 2,
            b'(' => {
                depth += 1;
                i += 1;
            }
            b')' => {
                if depth == 0 {
                    close_paren = Some(i);
                    break;
                }
                depth -= 1;
                i += 1;
            }
            _ => i += 1,
        }
    }
    let close_paren = close_paren?;
    let dest = destination(text, open_paren + 1, close_paren)?;
    Some(Bracket {
        node: (pos, close_paren + 1),
        label: (pos + 1, close_bracket),
        dest,
    })
}

/// Destination range inside `(...)`: the first whitespace-delimited token at
/// paren depth zero, with a `<...>` wrapper unwrapped. A trailing
/// `"title"` (TS strips `\s+"[^"]*"$`) is never part of it.
fn destination(text: &str, from: usize, to: usize) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut start = from;
    while start < to && (bytes[start] == b' ' || bytes[start] == b'\t') {
        start += 1;
    }
    if start >= to {
        return None;
    }
    if bytes[start] == b'<' {
        let mut i = start + 1;
        while i < to && bytes[i] != b'>' {
            i += 1;
        }
        if i >= to {
            return None;
        }
        return Some((start + 1, i));
    }
    let mut depth = 0usize;
    let mut i = start;
    while i < to {
        match bytes[i] {
            b'\\' => i += 2,
            b'(' => {
                depth += 1;
                i += 1;
            }
            b')' => {
                if depth == 0 {
                    break;
                }
                depth -= 1;
                i += 1;
            }
            b' ' | b'\t' if depth == 0 => break,
            _ => i += 1,
        }
    }
    (i > start).then_some((start, i.min(to)))
}

/// Autolink `<scheme:...>` / `<email@host>` (`<notalink>` is not one).
fn autolink(text: &str, pos: usize, to: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut i = pos + 1;
    while i < to && bytes[i] != b'>' {
        match bytes[i] {
            b'<' | b' ' | b'\t' => return None,
            _ => i += 1,
        }
    }
    if i >= to {
        return None;
    }
    let inner = &text[pos + 1..i];
    let has_scheme = match inner.split_once(':') {
        Some((scheme, rest)) => {
            !rest.is_empty()
                && (2..=32).contains(&scheme.len())
                && scheme
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphabetic())
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-')
        }
        None => false,
    };
    let email = inner.contains('@') && inner.contains('.') && !inner.contains(char::is_whitespace);
    (has_scheme || email).then_some(i + 1)
}

/// Sorted, merged exclusion ranges for the delimiter scan.
#[derive(Default)]
struct Excluded {
    ranges: Vec<(usize, usize)>,
}

impl Excluded {
    fn push(&mut self, range: (usize, usize)) {
        if range.0 < range.1 {
            self.ranges.push(range);
            self.ranges.sort_unstable();
        }
    }

    /// End of the excluded range containing `pos`, if any (the scanner jumps
    /// past it, so overlapping pushes are harmless).
    fn end_of(&self, pos: usize) -> Option<usize> {
        let i = self.ranges.partition_point(|(s, _)| *s <= pos);
        let (s, e) = *self.ranges.get(i.checked_sub(1)?)?;
        (pos < e && pos >= s).then_some(e)
    }

    fn overlaps(&self, from: usize, to: usize) -> bool {
        self.ranges.iter().any(|(a, b)| from < *b && to > *a)
    }

    /// Adds every range of `other` to this list.
    fn extend(&mut self, other: &Excluded) {
        for range in &other.ranges {
            self.push(*range);
        }
    }
}

/// One delimiter run of `*`, `_` or `~`.
struct Run {
    from: usize,
    to: usize,
    ch: u8,
    len: usize,
    can_open: bool,
    can_close: bool,
    open_used: usize,
    close_used: usize,
}

impl Run {
    fn remaining(&self) -> usize {
        self.len.saturating_sub(self.open_used + self.close_used)
    }
}

/// Emphasis / strong / strikethrough: the CommonMark delimiter-stack
/// algorithm over one line (inline constructs never cross a line break), with
/// GFM's `~~` strikethrough. Each match hides its two delimiter chunks with
/// the whole pair as the activity range; nested pairs are handled at every
/// level (the TS stops at the outermost node, leaving nested marks visible —
/// this port decorates each nesting level).
fn emphasis(
    text: &str,
    from: usize,
    to: usize,
    excluded: &Excluded,
    act: &Activity,
    sink: &mut Sink,
) {
    let bytes = text.as_bytes();
    let mut runs: Vec<Run> = Vec::new();
    let mut i = from;
    while i < to {
        if let Some(end) = excluded.end_of(i) {
            i = end;
            continue;
        }
        let b = bytes[i];
        if b == b'\\' {
            i = (i + 2).min(to);
            continue;
        }
        if b != b'*' && b != b'_' && b != b'~' {
            i += 1;
            continue;
        }
        let start = i;
        while i < to && bytes[i] == b {
            i += 1;
        }
        let (left, right) = flanking(text, start, i);
        let (can_open, can_close) = if b == b'_' {
            let before_punct = text[..start].chars().next_back().is_some_and(is_punct);
            let after_punct = text[i..].chars().next().is_some_and(is_punct);
            (
                left && (!right || before_punct),
                right && (!left || after_punct),
            )
        } else {
            (left, right)
        };
        runs.push(Run {
            from: start,
            to: i,
            ch: b,
            len: i - start,
            can_open,
            can_close,
            open_used: 0,
            close_used: 0,
        });
    }

    let mut stack: Vec<usize> = Vec::new();
    for ci in 0..runs.len() {
        if runs[ci].can_close {
            loop {
                let Some(oi) = stack
                    .iter()
                    .rev()
                    .copied()
                    .find(|&oi| runs[oi].ch == runs[ci].ch && runs[oi].remaining() > 0)
                else {
                    break;
                };
                // Rule of three (CommonMark): a closer that could also open
                // (or vice versa) with a total length divisible by three does
                // not match unless both runs are.
                if runs[ci].ch != b'~'
                    && (runs[ci].can_open || runs[oi].can_close)
                    && (runs[oi].len + runs[ci].len) % 3 == 0
                    && (runs[oi].len % 3 != 0 || runs[ci].len % 3 != 0)
                {
                    break;
                }
                let two = runs[oi].remaining() >= 2 && runs[ci].remaining() >= 2;
                if runs[ci].ch == b'~' && !two {
                    break; // GFM strikethrough needs exactly two tildes
                }
                let use_len = if two { 2 } else { 1 };
                let open_chunk = (
                    runs[oi].to - runs[oi].open_used - use_len,
                    runs[oi].to - runs[oi].open_used,
                );
                let close_chunk = (
                    runs[ci].from + runs[ci].close_used,
                    runs[ci].from + runs[ci].close_used + use_len,
                );
                runs[oi].open_used += use_len;
                runs[ci].close_used += use_len;
                if act.inactive(open_chunk.0, close_chunk.1) {
                    sink.hide(open_chunk.0, open_chunk.1);
                    sink.hide(close_chunk.0, close_chunk.1);
                }
                if runs[oi].remaining() == 0 {
                    stack.retain(|&x| x != oi);
                }
                if runs[ci].remaining() == 0 {
                    break;
                }
            }
        }
        if runs[ci].can_open && runs[ci].remaining() > 0 {
            stack.push(ci);
        }
    }
}

/// CommonMark left/right-flanking classification for a delimiter run.
fn flanking(text: &str, from: usize, to: usize) -> (bool, bool) {
    let before = text[..from].chars().next_back();
    let after = text[to..].chars().next();
    let before_ws = before.is_none_or(char::is_whitespace);
    let after_ws = after.is_none_or(char::is_whitespace);
    let before_punct = before.is_some_and(is_punct);
    let after_punct = after.is_some_and(is_punct);
    let left = !after_ws && (!after_punct || before_ws || before_punct);
    let right = !before_ws && (!before_punct || after_ws || after_punct);
    (left, right)
}

/// CommonMark punctuation: ASCII punctuation or a Unicode P/S character. The
/// approximation covers every non-alphanumeric, non-whitespace, non-control
/// `char` (CJK punctuation and symbols included).
fn is_punct(c: char) -> bool {
    c.is_ascii_punctuation() || (!c.is_alphanumeric() && !c.is_whitespace() && !c.is_control())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spans(text: &str) -> Vec<(usize, usize)> {
        inline_code(text, 0, text.len())
            .iter()
            .map(|s| (s.node.0, s.node.1))
            .collect()
    }

    fn bracket(text: &str) -> Option<(usize, usize, usize, usize, usize, usize)> {
        bracketed(text, text.find('[')?, text.len())
            .map(|b| (b.node.0, b.node.1, b.label.0, b.label.1, b.dest.0, b.dest.1))
    }

    #[test]
    fn inline_code_runs_match_lezer() {
        assert_eq!(spans("``a`b``"), vec![(0, 7)]);
        assert_eq!(spans("` a `"), vec![(0, 5)]);
        assert_eq!(spans("`` ` ``"), vec![(0, 7)]);
        assert_eq!(spans("`a"), Vec::<(usize, usize)>::new());
        assert_eq!(spans("a `x` b `y`"), vec![(2, 5), (8, 11)]);
    }

    #[test]
    fn bracketed_links_and_images_match_lezer() {
        assert_eq!(bracket("[a](b)"), Some((0, 6, 1, 2, 4, 5)));
        assert_eq!(bracket("[a [b] c](u)"), Some((0, 12, 1, 8, 10, 11)));
        assert_eq!(bracket("[a](b(c))"), Some((0, 9, 1, 2, 4, 8)));
        assert_eq!(bracket("[a](b \"t\")"), Some((0, 10, 1, 2, 4, 5)));
        // `bracketed` parses the `[...](...)` part; the image caller extends
        // the node over the leading `!`.
        assert_eq!(bracket("![alt](src)"), Some((1, 11, 2, 5, 7, 10)));
        // Destination in angle brackets, and no link without `(`.
        assert_eq!(bracket("[a](<a b>)"), Some((0, 10, 1, 2, 5, 8)));
        assert_eq!(bracket("[a] (b)"), None);
        assert_eq!(bracket("[a]( )"), None);
    }

    #[test]
    fn autolink_detection() {
        assert_eq!(autolink("<http://x>", 0, 10), Some(10));
        assert_eq!(autolink("<a@b.com>", 0, 9), Some(9));
        assert_eq!(autolink("<notalink>", 0, 10), None);
        assert_eq!(autolink("<1abc:x>", 0, 8), None);
        assert_eq!(autolink("<a", 0, 2), None);
    }

    /// Runs (pos, len, can_open, can_close) via the same classification the
    /// matcher uses.
    fn runs(text: &str) -> Vec<(usize, usize, bool, bool)> {
        let bytes = text.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < text.len() {
            let b = bytes[i];
            if b != b'*' && b != b'_' && b != b'~' {
                i += 1;
                continue;
            }
            let start = i;
            while i < text.len() && bytes[i] == b {
                i += 1;
            }
            let (left, right) = flanking(text, start, i);
            let (open, close) = if b == b'_' {
                let before_punct = text[..start].chars().next_back().is_some_and(is_punct);
                let after_punct = text[i..].chars().next().is_some_and(is_punct);
                (
                    left && (!right || before_punct),
                    right && (!left || after_punct),
                )
            } else {
                (left, right)
            };
            out.push((start, i - start, open, close));
        }
        out
    }

    #[test]
    fn flanking_matches_commonmark_examples() {
        assert_eq!(runs("*a*"), vec![(0, 1, true, false), (2, 1, false, true)]);
        assert_eq!(runs("a*b*c")[0], (1, 1, true, true));
        // Intraword `_` neither opens nor closes.
        assert_eq!(
            runs("a_b_c"),
            vec![(1, 1, false, false), (3, 1, false, false)]
        );
        // `_` at word boundaries works.
        assert_eq!(runs("_x_"), vec![(0, 1, true, false), (2, 1, false, true)]);
        // CJK neighbours are not whitespace/punctuation → `*` still works.
        assert_eq!(runs("中*文*中")[0], (3, 1, true, true));
        // A whitespace-only neighbour is not a delimiter opener.
        assert_eq!(runs("* a *")[0], (0, 1, false, false));
    }

    #[test]
    fn emphasis_matcher_node_ranges() {
        // The matcher emits through the sink; use a full-window sink and read
        // the hidden chunks back as the delimiter pairs.
        fn pairs(text: &str) -> Vec<(usize, usize)> {
            let lines = crate::markdown::line_ranges(text);
            let win = super::super::geom::Window::new(&lines, &(0..usize::MAX));
            let sels: [std::ops::Range<usize>; 0] = [];
            let act = super::super::geom::Activity::new(&sels);
            let mut sink = super::super::geom::Sink::new(&lines, win, act, 8);
            emphasis(text, 0, text.len(), &Excluded::default(), &act, &mut sink);
            sink.finish()
                .spans
                .iter()
                .map(|s| (s.range.start, s.range.end))
                .collect()
        }
        assert_eq!(pairs("a*b*c"), vec![(1, 2), (3, 4)]);
        assert_eq!(pairs("**a**"), vec![(0, 2), (3, 5)]);
        // `***a***` nests: strong consumes the middle two, emphasis the rest.
        assert_eq!(pairs("***a***"), vec![(0, 1), (1, 3), (4, 6), (6, 7)]);
        // Strikethrough needs two tildes; a triple run leaves one literal.
        assert_eq!(pairs("a ~~~x~~~ b"), vec![(3, 5), (6, 8)]);
        assert!(pairs("a ~x~ b").is_empty());
        // Unmatched runs emit nothing.
        assert!(pairs("*a").is_empty());
        assert!(pairs("****").is_empty());
    }

    #[test]
    fn wikilink_helpers() {
        assert!(is_image_name("a.PNG") && is_image_name("a.jpeg") && is_image_name("a.svg"));
        assert!(!is_image_name("a.excalidraw") && !is_image_name("notes.md"));
        assert!(is_drawing_name("画图.excalidraw") && is_drawing_name("x.EXCALIDRAW.MD"));
        assert!(!is_drawing_name("x.png"));
    }

    #[test]
    fn excluded_ranges_are_searched_efficiently_and_correctly() {
        let mut ex = Excluded::default();
        ex.push((10, 20));
        ex.push((0, 5));
        assert_eq!(ex.end_of(0), Some(5));
        assert_eq!(ex.end_of(4), Some(5));
        assert_eq!(ex.end_of(5), None);
        assert_eq!(ex.end_of(11), Some(20));
        assert_eq!(ex.end_of(21), None);
        assert!(ex.overlaps(4, 12));
        assert!(!ex.overlaps(5, 10));
    }
}
