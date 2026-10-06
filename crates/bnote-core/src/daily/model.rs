//! Pure-text model for the cross-file todo sync. Port of
//! `bnote/src/daily/model.ts` (plus `fenceStateScan` from
//! `src/editor/context.ts`, which the rollover extraction needs).
//!
//! Everything here is pure string/line math: no IO, no system clock, no
//! editor. Line numbers are 1-based as in the TS source; where the TS uses
//! CodeMirror character offsets this port uses byte offsets — internally
//! consistent because every spec producer and consumer in this module (and
//! in `super::engine`) shares the same unit.

// ---------------------------------------------------------------- 文档

/// Line-addressed view over a document. Port of the CM `Text` surface the TS
/// model uses: 1-based `line(n)`, per-line from/to offsets, `doc.length`.
#[derive(Clone, Debug)]
pub struct Doc {
    lines: Vec<String>,
    starts: Vec<usize>,
    len: usize,
}

impl Doc {
    /// Splits on `\n` exactly like CM: `""` is one empty line, `"a\n"` is
    /// two lines (the second empty).
    pub fn new(text: &str) -> Doc {
        let lines: Vec<String> = text.split('\n').map(str::to_string).collect();
        let mut starts = Vec::with_capacity(lines.len());
        let mut off = 0usize;
        for l in &lines {
            starts.push(off);
            off += l.len() + 1; // +1 for the '\n' (also after the last line; len is fixed below)
        }
        Doc { len: text.len(), lines, starts }
    }

    /// Number of lines (CM `doc.lines`).
    pub fn line_count(&self) -> usize {
        self.lines.len()
    }

    /// Text of line `n` (1-based). Out-of-range returns `""` (the TS reads
    /// only in-range lines; this keeps the ports total).
    pub fn line(&self, n: usize) -> &str {
        if n == 0 || n > self.lines.len() {
            return "";
        }
        &self.lines[n - 1]
    }

    /// Start offset of line `n` (1-based).
    pub fn line_start(&self, n: usize) -> usize {
        if n == 0 || n > self.starts.len() {
            return self.len;
        }
        self.starts[n - 1]
    }

    /// End offset of line `n` (position of its `\n`, or of doc end).
    pub fn line_end(&self, n: usize) -> usize {
        if n == 0 || n > self.lines.len() {
            return self.len;
        }
        self.starts[n - 1] + self.lines[n - 1].len()
    }

    /// Total length in bytes (CM `doc.length`).
    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// 1-based line number containing byte offset `pos` (CM `lineAt`).
    pub fn line_at(&self, pos: usize) -> usize {
        let pos = pos.min(self.len);
        let i = self.starts.partition_point(|&s| s <= pos) - 1;
        i + 1
    }

    /// Reassembled document text.
    pub fn text(&self) -> String {
        self.lines.join("\n")
    }
}

// ---------------------------------------------------------------- 行模型

/// Port of `LIST_LINE_RE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(.*)$/`.
fn parse_list_line_raw(text: &str) -> Option<(usize, usize, usize)> {
    // Returns (indent_end, marker_end, gap_end) byte offsets.
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
        i += 1;
    }
    let indent_end = i;
    // marker: one of `-` `*` `+`, or digits followed by `.` or `)`
    if i < b.len() && (b[i] == b'-' || b[i] == b'*' || b[i] == b'+') {
        i += 1;
    } else {
        let dstart = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == dstart || i >= b.len() || (b[i] != b'.' && b[i] != b')') {
            return None;
        }
        i += 1;
    }
    let marker_end = i;
    let gstart = i;
    while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
        i += 1;
    }
    if i == gstart {
        return None; // `[ \t]+` requires at least one
    }
    Some((indent_end, marker_end, i))
}

/// Port of `BOX_RE = /^\[([ xX])\][ \t]?/`.
/// Returns (box char, content offset after the checkbox + one optional space).
fn parse_box(content: &str) -> Option<(char, usize)> {
    let b = content.as_bytes();
    if b.len() < 3 || b[0] != b'[' || b[2] != b']' {
        return None;
    }
    let box_char = b[1];
    if box_char != b' ' && box_char != b'x' && box_char != b'X' {
        return None;
    }
    let mut end = 3;
    if content.len() > 3 && (content.as_bytes()[3] == b' ' || content.as_bytes()[3] == b'\t') {
        end = 4;
    }
    Some((box_char as char, end))
}

/// Parsed list line. Port of `daily/model.ts::ListLine`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListLine<'a> {
    /// Leading whitespace verbatim (tab/space fidelity).
    pub indent: &'a str,
    /// `"-"` / `"*"` / `"+"` / `"1."` / `"2)"`.
    pub marker: &'a str,
    /// Whitespace between marker and content.
    pub gap: &'a str,
    /// Checkbox state; `None` = plain list item (no checkbox).
    pub box_: Option<char>,
    /// Line content after the checkbox (or after the marker when unchecked).
    pub text: &'a str,
}

/// Port of `daily/model.ts::parseListLine`.
pub fn parse_list_line(text: &str) -> Option<ListLine<'_>> {
    let (indent_end, marker_end, gap_end) = parse_list_line_raw(text)?;
    let mut content = &text[gap_end..];
    let mut box_ = None;
    if let Some((c, end)) = parse_box(content) {
        box_ = Some(c);
        content = &content[end..];
    }
    Some(ListLine {
        indent: &text[..indent_end],
        marker: &text[indent_end..marker_end],
        gap: &text[marker_end..gap_end],
        box_,
        text: content,
    },
    )
}

/// Whether the line is a todo (list item with a checkbox).
/// Port of `daily/model.ts::isTodo`.
pub fn is_todo(l: &Option<ListLine<'_>>) -> bool {
    matches!(l, Some(p) if p.box_.is_some())
}

/// Start offset of the trailing `✅ YYYY-MM-DD` completion stamp within
/// `text`, mirroring `editor/ops.ts::DONE_STAMP_RE =
/// /(\s*✅\s*\d{4}-\d{2}-\d{2})\s*$/` (leftmost match, anchored at end).
/// `None` when the text does not end with a stamp.
pub(crate) fn done_stamp_start(text: &str) -> Option<usize> {
    let b = text.as_bytes();
    for (i, c) in text.char_indices() {
        if c != '\u{2705}' {
            continue;
        }
        let mut j = i + '\u{2705}'.len_utf8();
        while j < b.len() && is_inline_ws(b[j]) {
            j += 1; // \s* between ✅ and the date
        }
        if !stamp_tail_is_date(b, j) {
            continue;
        }
        // The match begins at the start of the whitespace run before ✅
        // (`\s*✅` is inside group 1).
        let mut start = i;
        while start > 0 && is_inline_ws(b[start - 1]) {
            start -= 1;
        }
        return Some(start);
    }
    None
}

fn is_inline_ws(c: u8) -> bool {
    c == b' ' || c == b'\t' || c == b'\r' || c == b'\n'
}

/// After byte `j` the string must be exactly `YYYY-MM-DD` plus optional
/// trailing whitespace (`\d{4}-\d{2}-\d{2}\s*$`).
fn stamp_tail_is_date(b: &[u8], j: usize) -> bool {
    if j + 10 > b.len() {
        return false;
    }
    let d = &b[j..j + 10];
    let digit = |c: u8| c.is_ascii_digit();
    let ok = digit(d[0])
        && digit(d[1])
        && digit(d[2])
        && digit(d[3])
        && d[4] == b'-'
        && digit(d[5])
        && digit(d[6])
        && d[7] == b'-'
        && digit(d[8])
        && digit(d[9]);
    ok && b[j + 10..].iter().all(|&c| is_inline_ws(c))
}

/// Todo identity text: strip the ✅ completion stamp and trim both ends.
/// Link anchors and entry matching both use this.
/// Port of `daily/model.ts::todoText`.
pub fn todo_text<'a>(l: &ListLine<'a>) -> &'a str {
    let stripped = match done_stamp_start(l.text) {
        Some(s) => &l.text[..s],
        None => l.text,
    };
    stripped.trim()
}

/// Identity text of the todo on line `n` (1-based); `None` when that line is
/// not a todo. Port of `daily/model.ts::todoTextAt`.
pub fn todo_text_at(doc: &Doc, line_no: usize) -> Option<&str> {
    let p = parse_list_line(doc.line(line_no))?;
    if p.box_.is_none() {
        return None;
    }
    Some(todo_text(&p))
}

// ---------------------------------------------------------------- 块提取

/// Root of the todo block containing `line_no`: walk up the chain of
/// continuous shallower-indent ancestors. Blank/non-list lines break the
/// chain; same-depth or deeper lines are siblings/children and are skipped.
/// Port of `daily/model.ts::blockRootLine` (500-step guard included).
pub fn block_root_line(doc: &Doc, line_no: usize) -> usize {
    let cur = parse_list_line(doc.line(line_no));
    let Some(cur) = cur else { return line_no };
    let mut depth = cur.indent.len();
    if depth == 0 {
        return line_no;
    }
    let mut root = line_no;
    let mut n = line_no - 1;
    while n >= 1 && line_no - n <= 500 {
        let Some(p) = parse_list_line(doc.line(n)) else { break };
        if p.indent.len() < depth {
            root = n;
            depth = p.indent.len();
            if depth == 0 {
                break;
            }
        }
        n -= 1;
    }
    root
}

/// Last line of the block rooted at `root_no`: consecutive deeper list lines
/// after the root (blank / non-list / same-depth stops). Port of
/// `daily/model.ts::blockEnd`.
pub fn block_end(doc: &Doc, root_no: usize) -> usize {
    let Some(root) = parse_list_line(doc.line(root_no)) else {
        return root_no;
    };
    let mut end = root_no;
    for n in root_no + 1..=doc.line_count() {
        let Some(p) = parse_list_line(doc.line(n)) else { break };
        if p.indent.len() <= root.indent.len() {
            break;
        }
        end = n;
    }
    end
}

/// Line texts of the block (root + deeper lines below it).
/// Port of `daily/model.ts::blockLines`.
pub fn block_lines(doc: &Doc, root_no: usize) -> Vec<String> {
    let mut out = Vec::new();
    for n in root_no..=block_end(doc, root_no) {
        out.push(doc.line(n).to_string());
    }
    out
}

/// Re-indent a block: strip up to `strip_len` leading whitespace chars per
/// line (only whitespace, never into the marker), then prepend `to_indent` —
/// children keep their relative indent. Port of
/// `daily/model.ts::reindentBlock`.
pub fn reindent_block<S: AsRef<str>>(lines: &[S], strip_len: usize, to_indent: &str) -> Vec<String> {
    lines
        .iter()
        .map(|l| {
            let s = l.as_ref();
            let mut cut = 0;
            let b = s.as_bytes();
            while cut < strip_len && cut < b.len() && (b[cut] == b' ' || b[cut] == b'\t') {
                cut += 1;
            }
            let mut out = String::with_capacity(to_indent.len() + s.len());
            out.push_str(to_indent);
            out.push_str(&s[cut..]);
            out
        })
        .collect()
}

// ---------------------------------------------------------------- 日记待办区

fn is_blank_line(text: &str) -> bool {
    text.trim().is_empty()
}

fn is_header_line(text: &str) -> bool {
    text.starts_with("# ")
}

/// One top-level entry in the daily file's header todo region (1-based,
/// inclusive line range). Port of `daily/model.ts::DailyEntry`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DailyEntry {
    pub start: usize,
    pub end: usize,
}

/// Parsed header todo region. Port of `daily/model.ts::DailyRegion`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DailyRegion {
    /// Header H1 line number (1-based); 0 when there is no header.
    pub header_end: usize,
    /// Top-level entries, in document order.
    pub entries: Vec<DailyEntry>,
    /// Last list line inside the region; equals header_end when empty.
    pub last_list_line: usize,
}

/// Structure of a daily file: an optional `# title` line, then (skipping
/// blank lines) the todo region — consecutive list lines where indent-0
/// lines open a top-level entry and deeper lines belong to it; single blank
/// lines between list lines are separators. The first non-blank non-list
/// line ends the region. Port of `daily/model.ts::parseDailyRegion`.
pub fn parse_daily_region(doc: &Doc) -> DailyRegion {
    let header_end = if doc.line_count() >= 1 && is_header_line(doc.line(1)) { 1 } else { 0 };
    let mut i = header_end + 1;
    while i <= doc.line_count() && is_blank_line(doc.line(i)) {
        i += 1;
    }
    let mut entries: Vec<DailyEntry> = Vec::new();
    let mut cur: Option<usize> = None; // index into entries
    let mut last_list_line = header_end;
    while i <= doc.line_count() {
        let text = doc.line(i);
        if is_blank_line(text) {
            if i + 1 <= doc.line_count() && parse_list_line(doc.line(i + 1)).is_some() {
                i += 1;
                continue;
            }
            break;
        }
        let Some(p) = parse_list_line(text) else { break };
        if p.indent.is_empty() {
            entries.push(DailyEntry { start: i, end: i });
            cur = Some(entries.len() - 1);
        } else if let Some(idx) = cur {
            entries[idx].end = i;
        } else {
            break; // deep line before any top-level entry: not a todo region
        }
        last_list_line = i;
        i += 1;
    }
    DailyRegion { header_end, entries, last_list_line }
}

/// Find the entry whose identity text is `normalized`; ties go to the entry
/// nearest `near_line`. Port of `daily/model.ts::findEntryByText`.
pub fn find_entry_by_text(
    doc: &Doc,
    region: &DailyRegion,
    normalized: &str,
    near_line: usize,
) -> Option<DailyEntry> {
    let mut best: Option<DailyEntry> = None;
    let mut best_dist = usize::MAX;
    for e in &region.entries {
        let Some(p) = parse_list_line(doc.line(e.start)) else { continue };
        if p.box_.is_none() || todo_text(&p) != normalized {
            continue;
        }
        let d = e.start.abs_diff(near_line);
        if d < best_dist {
            best_dist = d;
            best = Some(*e);
        }
    }
    best
}

// ---------------------------------------------------------------- 改动 spec

/// A change spec: byte offsets into the document. Port of
/// `daily/model.ts::DocChange` (`to`/`insert` optional there).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocChange {
    pub from: usize,
    pub to: Option<usize>,
    pub insert: Option<String>,
}

impl DocChange {
    pub fn insert_at(from: usize, insert: impl Into<String>) -> DocChange {
        DocChange { from, to: None, insert: Some(insert.into()) }
    }
}

/// Append one top-level entry (chronological: right after the last entry;
/// after the header when the region is empty; at the top of a non-empty
/// headerless document). The returned entry points into the NEW document.
/// Port of `daily/model.ts::appendEntrySpec`.
pub fn append_entry_spec(
    doc: &Doc,
    region: &DailyRegion,
    block: &[impl AsRef<str>],
) -> (DocChange, DailyEntry) {
    let text = block
        .iter()
        .map(|l| l.as_ref())
        .collect::<Vec<_>>()
        .join("\n");
    let at: usize;
    let start: usize;
    let insert: String;
    if !region.entries.is_empty() {
        at = doc.line_end(region.last_list_line);
        start = region.last_list_line + 1;
        insert = format!("\n{}", text);
    } else if region.header_end >= 1 {
        at = doc.line_end(region.header_end);
        start = region.header_end + 2; // header + one blank line
        insert = format!("\n\n{}", text);
    } else if doc.is_empty() {
        at = 0;
        start = 1;
        insert = text.clone();
    } else {
        at = 0;
        start = 1;
        insert = format!("{}\n\n", text);
    }
    let line_count = if text.is_empty() { 0 } else { text.split('\n').count() };
    let entry = DailyEntry { start, end: start + line_count.saturating_sub(1) };
    (DocChange { from: at, to: None, insert: Some(insert) }, entry)
}

/// Replace a whole entry with a new block. Port of
/// `daily/model.ts::replaceEntrySpec`.
pub fn replace_entry_spec(
    doc: &Doc,
    entry: DailyEntry,
    block: &[impl AsRef<str>],
) -> DocChange {
    DocChange {
        from: doc.line_start(entry.start),
        to: Some(doc.line_end(entry.end)),
        insert: Some(
            block
                .iter()
                .map(|l| l.as_ref())
                .collect::<Vec<_>>()
                .join("\n"),
        ),
    }
}

/// Remove an entry (whole-line semantics, newline included), plus the single
/// blank separator right after it so repeated add/remove cannot pile up blank
/// lines; when the removal empties the region at file end the separator blank
/// after the header is retracted too. Port of
/// `daily/model.ts::removeEntrySpec`.
pub fn remove_entry_spec(doc: &Doc, entry: DailyEntry) -> DocChange {
    let after_end = entry.end + 1;
    let mut from = doc.line_start(entry.start);
    let to;
    if after_end <= doc.line_count() && is_blank_line(doc.line(after_end)) {
        to = if after_end + 1 <= doc.line_count() {
            doc.line_start(after_end + 1)
        } else {
            doc.len()
        };
    } else {
        to = if after_end <= doc.line_count() {
            doc.line_start(after_end)
        } else {
            doc.len()
        };
    }
    if to >= doc.len() && entry.start > 1 && is_blank_line(doc.line(entry.start - 1)) {
        from = doc.line_start(entry.start - 1);
    }
    DocChange { from, to: Some(to), insert: None }
}

/// Apply change specs to document text (pure string math, for off-screen
/// file read-modify-write). Port of `daily/model.ts::textAfterChanges`.
pub fn text_after_changes(doc_text: &str, specs: &[DocChange]) -> String {
    // CM applies a sorted, disjoint change set; applying right-to-left is
    // equivalent for the disjoint specs this module produces.
    let mut sorted: Vec<&DocChange> = specs.iter().collect();
    sorted.sort_by(|a, b| b.from.cmp(&a.from));
    let mut out = doc_text.to_string();
    for spec in sorted {
        let to = spec.to.unwrap_or(spec.from).min(out.len());
        let from = spec.from.min(to);
        let insert = spec.insert.as_deref().unwrap_or("");
        out.replace_range(from..to, insert);
    }
    out
}

// ---------------------------------------------------------------- 路径与定位

/// Whether the path is a daily file (`<vault>/Daily/YYYY-MM-DD.md`, any day).
/// Port of `daily/model.ts::isDailyPath`.
pub fn is_daily_path(path: &str) -> bool {
    daily_day_of(path).is_some()
}

/// Date (YYYY-MM-DD) encoded in a daily file path; `None` for other paths.
/// Port of `daily/model.ts::dailyDayOf` (regex `/\/Daily\/(\d{4}-\d{2}-\d{2})\.md$/`).
pub fn daily_day_of(path: &str) -> Option<&str> {
    let rest = path.strip_suffix(".md")?;
    let idx = rest.rfind("/Daily/")?;
    let day = &rest[idx + "/Daily/".len()..];
    if !is_date_shape(day) {
        return None;
    }
    Some(day)
}

/// Exactly `YYYY-MM-DD` (digit shape; no calendar validation, same as the TS regex).
fn is_date_shape(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && (0..10).all(|i| matches!(i, 4 | 7) || b[i].is_ascii_digit())
}

/// Absolute path of the daily file for `day`. Port of
/// `daily/model.ts::dailyPathFor`.
pub fn daily_path_for(vault_root: &str, day: &str) -> String {
    format!("{}/Daily/{}.md", vault_root.trim_end_matches('/'), day)
}

/// Initial content of a new daily file. Both the send/record paths and
/// "open today's daily" share this shape, so every entry point produces
/// byte-identical files. Port of `daily/model.ts::dailyScaffold`.
pub fn daily_scaffold(day: &str) -> String {
    format!("# {}\n", day)
}

/// Link metadata file path (inside the vault, travels with the repo).
/// Port of `daily/model.ts::linksFilePath`.
pub fn links_file_path(vault_root: &str) -> String {
    format!("{}/.bnote/daily-links.json", vault_root.trim_end_matches('/'))
}

/// Find the todo block root whose identity text is one of `texts`: try the
/// hint line, then a ±30-line window around it, then the whole document
/// (debounced low-frequency path; a full scan is acceptable).
/// Port of `daily/model.ts::resolveRootLine`.
pub fn resolve_root_line(doc: &Doc, texts: &[&str], hint: Option<usize>) -> Option<usize> {
    let want: std::collections::HashSet<&str> = texts.iter().copied().collect();
    let match_at = |n: usize| -> bool { todo_text_at(doc, n).is_some_and(|t| want.contains(&t)) };
    if let Some(h) = hint {
        if h >= 1 && h <= doc.line_count() && match_at(h) {
            return Some(h);
        }
    }
    if let Some(h) = hint {
        let from = h.saturating_sub(30).max(1);
        let to = (h + 30).min(doc.line_count());
        for n in from..=to {
            if match_at(n) {
                return Some(n);
            }
        }
    }
    for n in 1..=doc.line_count() {
        if match_at(n) {
            return Some(n);
        }
    }
    None
}

// ---------------------------------------------------------------- 围栏扫描

/// CommonMark fence marker: up to 3 leading spaces + 3+ backticks or tildes.
/// Returns (marker char, marker length, rest of the line).
/// Port of `src/editor/context.ts::FENCE_RE`.
fn fence_marker(line: &str) -> Option<(u8, usize, &str)> {
    let b = line.as_bytes();
    let mut i = 0;
    while i < 3 && i < b.len() && b[i] == b' ' {
        i += 1;
    }
    if i >= b.len() {
        return None;
    }
    let c = b[i];
    if c != b'`' && c != b'~' {
        return None;
    }
    let start = i;
    while i < b.len() && b[i] == c {
        i += 1;
    }
    let len = i - start;
    if len < 3 {
        return None;
    }
    Some((c, len, &line[i..]))
}

/// Single pass over the document: for each line, whether it sits inside a
/// ``` / ~~~ fenced code block (index = line-1; the fence line itself does
/// not count as inside). Port of `src/editor/context.ts::fenceStateScan`.
pub fn fence_state_scan(doc: &Doc) -> Vec<bool> {
    let mut inside = vec![false; doc.line_count()];
    let mut open: Option<u8> = None;
    let mut open_len = 0usize;
    for n in 1..=doc.line_count() {
        inside[n - 1] = open.is_some();
        let Some((c, len, rest)) = fence_marker(doc.line(n)) else { continue };
        if open.is_none() {
            open = Some(c);
            open_len = len;
        } else if open == Some(c) && len >= open_len && rest.trim().is_empty() {
            open = None;
        }
    }
    inside
}

// ---------------------------------------------------------------- 待办跟随(rollover)

/// Lines of the block that carry over: unfinished todos plus the ancestor
/// anchor chain required to keep them nested; `None` when nothing is kept.
/// Port of `daily/model.ts::carriedLines`.
fn carried_lines(doc: &Doc, root_no: usize, end_no: usize) -> Option<Vec<String>> {
    let mut indent: Vec<usize> = Vec::new();
    let mut kept: Vec<bool> = Vec::new();
    for n in root_no..=end_no {
        let Some(p) = parse_list_line(doc.line(n)) else { break }; // blockEnd guarantees list lines
        indent.push(p.indent.len());
        kept.push(p.box_ == Some(' '));
    }
    // Bottom-up anchor fill: a line with any kept descendant in its deeper
    // contiguous subtree window must stay, or the hierarchy would break.
    // The window closes at the first line with indent <= this line's, so it
    // never crosses into a sibling subtree.
    for i in (0..kept.len().saturating_sub(1)).rev() {
        if kept[i] {
            continue;
        }
        for j in i + 1..kept.len() {
            if indent[j] <= indent[i] {
                break;
            }
            if kept[j] {
                kept[i] = true;
                break;
            }
        }
    }
    if !kept.iter().any(|&k| k) {
        return None;
    }
    let lines = kept
        .iter()
        .enumerate()
        .filter(|(_, &k)| k)
        .map(|(i, _)| doc.line(root_no + i).to_string())
        .collect();
    Some(lines)
}

/// Top-level list blocks (excluding fenced code): root line and block end.
/// Roots are indent-0 list lines (todo or plain bullet — filtering is the
/// caller's semantic decision). Port of `daily/model.ts::topBlocks`.
fn top_blocks(doc: &Doc, fenced: &[bool]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut n = 1;
    while n <= doc.line_count() {
        if fenced[n - 1] {
            n += 1;
            continue;
        }
        let p = parse_list_line(doc.line(n));
        let deeper = p.as_ref().is_none_or(|p| !p.indent.is_empty());
        if p.is_none() || deeper {
            n += 1;
            continue;
        }
        let end = block_end(doc, n);
        out.push((n, end));
        n = end + 1;
    }
    out
}

/// Rollover block extraction: every block of the daily file that contains an
/// unfinished todo (plain-bullet roots and empty-text todos included —
/// hand-written daily shapes get no special casing). Port of
/// `daily/model.ts::rolloverBlocks`.
pub fn rollover_blocks(prev_text: &str) -> Vec<Vec<String>> {
    let doc = Doc::new(prev_text);
    let fenced = fence_state_scan(&doc);
    let mut out = Vec::new();
    for (root_no, end_no) in top_blocks(&doc, &fenced) {
        if let Some(carried) = carried_lines(&doc, root_no, end_no) {
            out.push(carried);
        }
    }
    out
}

/// Most recent daily-file date strictly earlier than `today` among `names`;
/// `None` when there is none ("a few days ago" beats none — not literally
/// yesterday). Port of `daily/model.ts::previousDailyFile`.
pub fn previous_daily_file<S: AsRef<str>>(names: &[S], today: &str) -> Option<String> {
    let mut best: Option<&str> = None;
    for name in names {
        let Some(day) = name.as_ref().strip_suffix(".md") else { continue };
        if !is_date_shape(day) || day >= today {
            continue;
        }
        if best.is_none_or(|b| day > b) {
            best = Some(day);
        }
    }
    best.map(str::to_string)
}

/// Initial content of a new day's daily file: bare scaffold + each block
/// appended via `append_entry_spec`, same shape the engine writes (H1 +
/// blank line + entries separated by single newlines, single trailing
/// newline). Port of `daily/model.ts::composeDailyScaffold`.
pub fn compose_daily_scaffold(day: &str, blocks: &[Vec<String>]) -> String {
    let mut text = daily_scaffold(day);
    for block in blocks {
        let doc = Doc::new(&text);
        let region = parse_daily_region(&doc);
        let (change, _) = append_entry_spec(&doc, &region, block);
        text = text_after_changes(&text, &[change]);
    }
    text
}

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(text: &str) -> Doc {
        Doc::new(text)
    }

    // ---- parseListLine / todoText (model.test.ts "parseListLine / todoText")

    #[test]
    fn parse_list_line_recognizes_bullet_ordered_checkbox_with_indent_fidelity() {
        assert_eq!(
            parse_list_line("- [ ] 任务").unwrap(),
            ListLine { indent: "", marker: "-", gap: " ", box_: Some(' '), text: "任务" }
        );
        assert_eq!(
            parse_list_line("  * [x] 完成 ✅ 2026-09-23").unwrap(),
            ListLine {
                indent: "  ",
                marker: "*",
                gap: " ",
                box_: Some('x'),
                text: "完成 ✅ 2026-09-23",
            }
        );
        assert_eq!(
            parse_list_line("\t1. [X] 大写").unwrap(),
            ListLine { indent: "\t", marker: "1.", gap: " ", box_: Some('X'), text: "大写" }
        );
        assert_eq!(
            parse_list_line("- 普通列表项").unwrap(),
            ListLine { indent: "", marker: "-", gap: " ", box_: None, text: "普通列表项" }
        );
        assert_eq!(
            parse_list_line("2) 有序圆括号").unwrap(),
            ListLine { indent: "", marker: "2)", gap: " ", box_: None, text: "有序圆括号" }
        );
        assert_eq!(parse_list_line("正文行"), None);
        assert_eq!(parse_list_line(""), None);
    }

    #[test]
    fn todo_text_strips_done_stamp_and_trims() {
        let p = parse_list_line("- [ ] 任务").unwrap();
        assert_eq!(todo_text(&p), "任务");
        let p = parse_list_line("- [x] 任务 ✅ 2026-09-23").unwrap();
        assert_eq!(todo_text(&p), "任务");
        let p = parse_list_line("- [ ]  空格包围 ").unwrap();
        assert_eq!(todo_text(&p), "空格包围");
    }

    #[test]
    fn todo_text_leaves_mid_line_stamp_like_text_alone() {
        // The TS regex is end-anchored; a ✅ not followed by a trailing date
        // must not be stripped.
        let p = parse_list_line("- [ ] a ✅ 2026-09-23 b").unwrap();
        assert_eq!(todo_text(&p), "a ✅ 2026-09-23 b");
        let p = parse_list_line("- [ ] 第一 ✅ 2026-09-23 第二 ✅ 2026-09-24").unwrap();
        assert_eq!(todo_text(&p), "第一 ✅ 2026-09-23 第二");
    }

    // ---- blockRootLine / blockEnd / blockLines

    #[test]
    fn block_root_walks_to_shallowest_ancestor_skipping_siblings() {
        let d = &doc("- [ ] 根\n  - [ ] 子\n    - [ ] 孙\n- [ ] 兄弟\n");
        assert_eq!(block_root_line(d, 1), 1);
        assert_eq!(block_root_line(d, 2), 1);
        assert_eq!(block_root_line(d, 3), 1);
        assert_eq!(block_root_line(d, 4), 4);
    }

    #[test]
    fn block_root_breaks_at_blank_line() {
        let d = doc("- a\n\n  - b\n");
        assert_eq!(block_root_line(&d, 3), 3);
    }

    #[test]
    fn plain_bullet_can_be_block_root() {
        let d = doc("- 项目\n  - [ ] 待办\n");
        assert_eq!(block_root_line(&d, 2), 1);
    }

    #[test]
    fn block_end_takes_all_deeper_lines_stops_at_blank_or_same_depth() {
        let d = &doc("- [ ] 根\n  - [ ] 子\n    - [ ] 孙\n- [ ] 兄弟\n");
        assert_eq!(block_end(d, 1), 3);
        assert_eq!(block_end(d, 4), 4);
        let with_blank = doc("- [ ] 根\n  - [ ] 子\n\n  - [ ] 不算\n");
        assert_eq!(block_end(&with_blank, 1), 2);
        assert_eq!(
            block_lines(d, 1),
            vec!["- [ ] 根".to_string(), "  - [ ] 子".to_string(), "    - [ ] 孙".to_string()]
        );
    }

    // ---- reindentBlock

    #[test]
    fn reindent_strips_source_root_indent_and_rebases_children() {
        assert_eq!(
            reindent_block(&["  - [ ] 子", "    - [ ] 孙"], 2, ""),
            vec!["- [ ] 子".to_string(), "  - [ ] 孙".to_string()]
        );
    }

    #[test]
    fn reindent_adds_target_indent_shifting_whole_block() {
        assert_eq!(
            reindent_block(&["- [ ] 子", "  - [ ] 孙"], 0, "\t"),
            vec!["\t- [ ] 子".to_string(), "\t  - [ ] 孙".to_string()]
        );
    }

    #[test]
    fn reindent_strips_only_whitespace_never_into_marker() {
        assert_eq!(reindent_block(&["  \t- 混合"], 2, ""), vec!["\t- 混合".to_string()]);
        assert_eq!(reindent_block(&["\t- 混合"], 2, ""), vec!["- 混合".to_string()]);
    }

    // ---- parseDailyRegion

    #[test]
    fn parse_daily_region_header_entries_blank_separators_prose_end() {
        let d = doc("# 2026-09-23\n\n- [ ] 甲\n  - [ ] 甲1\n\n- [ ] 乙\n\n今天写了日记。\n");
        let r = parse_daily_region(&d);
        assert_eq!(r.header_end, 1);
        assert_eq!(
            r.entries,
            vec![DailyEntry { start: 3, end: 4 }, DailyEntry { start: 6, end: 6 }]
        );
        assert_eq!(r.last_list_line, 6);
    }

    #[test]
    fn parse_daily_region_no_header_empty_doc_prose_only() {
        assert_eq!(parse_daily_region(&doc("- [ ] 甲\n- [ ] 乙\n")).header_end, 0);
        assert_eq!(parse_daily_region(&doc("")).entries, Vec::<DailyEntry>::new());
        let prose = doc("今天的事\n- 不是待办区开头\n");
        assert_eq!(parse_daily_region(&prose).entries, Vec::<DailyEntry>::new());
    }

    #[test]
    fn parse_daily_region_deep_lines_before_top_level_do_not_open_region() {
        let d = doc("  - 深层开头\n- [ ] 甲\n");
        assert_eq!(parse_daily_region(&d).entries, Vec::<DailyEntry>::new());
    }

    // ---- appendEntrySpec / replaceEntrySpec / removeEntrySpec

    #[test]
    fn append_into_empty_region_after_header_inserts_one_blank_line() {
        let d = doc("# 2026-09-23\n");
        let r = parse_daily_region(&d);
        let (change, entry) = append_entry_spec(&d, &r, &["- [ ] 甲"]);
        assert_eq!(text_after_changes("# 2026-09-23\n", &[change]), "# 2026-09-23\n\n- [ ] 甲\n");
        assert_eq!(entry, DailyEntry { start: 3, end: 3 });
    }

    #[test]
    fn append_after_existing_entries_is_chronological() {
        let text = "# d\n\n- [ ] 甲\n- [ ] 乙\n";
        let d = doc(text);
        let (change, _) = append_entry_spec(&d, &parse_daily_region(&d), &["- [ ] 丙"]);
        assert_eq!(text_after_changes(text, &[change]), "# d\n\n- [ ] 甲\n- [ ] 乙\n- [ ] 丙\n");
    }

    #[test]
    fn append_into_empty_doc_and_headerless_prose_doc() {
        let empty = doc("");
        let r0 = parse_daily_region(&empty);
        let (change, _) = append_entry_spec(&empty, &r0, &["- [ ] 甲"]);
        assert_eq!(text_after_changes("", &[change]), "- [ ] 甲");
        let prose = doc("旧内容\n");
        let (change, _) = append_entry_spec(&prose, &parse_daily_region(&prose), &["- [ ] 甲"]);
        assert_eq!(text_after_changes("旧内容\n", &[change]), "- [ ] 甲\n\n旧内容\n");
    }

    #[test]
    fn replace_entry_wholesale_and_remove_eats_separator_blank() {
        let text = "# d\n\n- [ ] 甲\n  - [ ] 甲1\n\n- [ ] 乙\n\n正文\n";
        let d = doc(text);
        let region = parse_daily_region(&d);
        let replaced = text_after_changes(
            text,
            &[replace_entry_spec(&d, region.entries[0], &["- [ ] 甲改", "  - [ ] 新子项"])],
        );
        assert_eq!(replaced, "# d\n\n- [ ] 甲改\n  - [ ] 新子项\n\n- [ ] 乙\n\n正文\n");
        let removed = text_after_changes(text, &[remove_entry_spec(&d, region.entries[0])]);
        assert_eq!(removed, "# d\n\n- [ ] 乙\n\n正文\n");
    }

    #[test]
    fn removing_tail_entry_keeps_blank_before_prose() {
        let text = "# d\n\n- [ ] 甲\n\n正文\n";
        let d = doc(text);
        let removed = text_after_changes(text, &[remove_entry_spec(&d, parse_daily_region(&d).entries[0])]);
        assert_eq!(removed, "# d\n\n正文\n");
    }

    // ---- findEntryByText

    #[test]
    fn find_entry_by_text_prefers_nearest_to_near_line() {
        let text = "# d\n\n- [ ] 同名\n- [ ] 其他\n- [ ] 同名\n";
        let d = doc(text);
        let region = parse_daily_region(&d);
        assert_eq!(find_entry_by_text(&d, &region, "同名", 1).unwrap().start, 3);
        assert_eq!(find_entry_by_text(&d, &region, "同名", 100).unwrap().start, 5);
        assert_eq!(find_entry_by_text(&d, &region, "不存在", 1), None);
    }

    // ---- resolveRootLine

    #[test]
    fn resolve_root_line_hint_window_full_scan_and_miss() {
        let d = doc("前言\n- [ ] 甲\n- [ ] 乙\n- [ ] 丙\n");
        assert_eq!(resolve_root_line(&d, &["乙"], Some(3)), Some(3));
        assert_eq!(resolve_root_line(&d, &["乙"], Some(8)), Some(3)); // window ±30
        assert_eq!(resolve_root_line(&d, &["丙"], Some(2)), Some(4)); // hint line is not it: nearest
        assert_eq!(resolve_root_line(&d, &["丁"], Some(2)), None);
    }

    #[test]
    fn resolve_root_line_never_matches_non_todo_lines() {
        let d = doc("甲\n- [ ] 乙\n");
        assert_eq!(resolve_root_line(&d, &["甲"], Some(1)), None);
    }

    // ---- 路径约定

    #[test]
    fn daily_and_links_path_conventions() {
        assert_eq!(daily_path_for("/vault", "2026-09-23"), "/vault/Daily/2026-09-23.md");
        assert_eq!(daily_path_for("/vault/", "2026-09-23"), "/vault/Daily/2026-09-23.md");
        assert!(is_daily_path("/vault/Daily/2026-09-23.md"));
        assert!(!is_daily_path("/vault/Daily/2026-9-3.md"));
        assert!(is_daily_path("/vault/notes/Daily/2026-09-23.md"));
        assert!(!is_daily_path("/vault/notes/todo.md"));
        assert_eq!(links_file_path("/vault"), "/vault/.bnote/daily-links.json");
    }

    #[test]
    fn daily_day_of_extracts_date() {
        assert_eq!(daily_day_of("/vault/Daily/2026-09-23.md"), Some("2026-09-23"));
        assert_eq!(daily_day_of("/vault/notes/Daily/2026-09-23.md"), Some("2026-09-23"));
        assert_eq!(daily_day_of("/vault/Daily/2026-9-3.md"), None);
        assert_eq!(daily_day_of("/vault/notes/todo.md"), None);
    }

    // ---- rolloverBlocks

    #[test]
    fn rollover_real_diary_shape_fenced_and_prose_do_not_truncate() {
        let prev = [
            "# 1 2026-10-02",
            "**没有规划的不做，专注**",
            "- [ ] cs336第一次作业",
            "  - [ ] 注意力机制",
            "    - [x] rope ✅ 2026-10-02",
            "    - [ ] 带rope的多头注意力",
            "  - [ ] transformer",
            "- [ ] 了解一下aihot",
        ]
        .join("\n");
        assert_eq!(
            rollover_blocks(&prev),
            vec![
                vec![
                    "- [ ] cs336第一次作业".to_string(),
                    "  - [ ] 注意力机制".to_string(),
                    "    - [ ] 带rope的多头注意力".to_string(),
                    "  - [ ] transformer".to_string(),
                ],
                vec!["- [ ] 了解一下aihot".to_string()],
            ]
        );
    }

    #[test]
    fn rollover_done_middle_node_is_anchor_for_its_descendants() {
        let prev = ["- [ ] 父", "  - [x] 中间 ✅ 2026-09-22", "    - [ ] 剩下的"].join("\n");
        assert_eq!(
            rollover_blocks(&prev),
            vec![vec![
                "- [ ] 父".to_string(),
                "  - [x] 中间 ✅ 2026-09-22".to_string(),
                "    - [ ] 剩下的".to_string(),
            ]]
        );
    }

    #[test]
    fn rollover_done_sibling_subtree_is_skipped_without_crossing_indent_window() {
        let prev = [
            "- [ ] 父",
            "  - [x] 完成的中间 ✅ 2026-09-22",
            "  - [ ] 活着的子项",
            "  - [x] 另一个完成 ✅ 2026-09-22",
        ]
        .join("\n");
        assert_eq!(
            rollover_blocks(&prev),
            vec![vec!["- [ ] 父".to_string(), "  - [ ] 活着的子项".to_string()]]
        );
    }

    #[test]
    fn rollover_top_level_done_block_follows_only_with_unfinished_descendants() {
        let prev = [
            "- [x] 收尾完成 ✅ 2026-09-22",
            "- [x] 大盘还未完",
            "  - [ ] 还没做的子项",
            "- [x] 纯完成 ✅ 2026-09-22",
            "  - [x] 完成的子项 ✅ 2026-09-22",
        ]
        .join("\n");
        assert_eq!(
            rollover_blocks(&prev),
            vec![vec!["- [x] 大盘还未完".to_string(), "  - [ ] 还没做的子项".to_string()]]
        );
    }

    #[test]
    fn rollover_plain_bullet_blocks_anchor_only_when_they_have_live_descendants() {
        let prev = [
            "- 普通分组",
            "  - 普通子项",
            "- 有活的分组",
            "  - 普通备注",
            "  - [ ] 真正的待办",
        ]
        .join("\n");
        assert_eq!(
            rollover_blocks(&prev),
            vec![vec!["- 有活的分组".to_string(), "  - [ ] 真正的待办".to_string()]]
        );
    }

    #[test]
    fn rollover_ignores_todo_like_lines_inside_fenced_code() {
        let prev = ["```", "- [ ] 代码里的假待办", "```", "", "- [ ] 真待办"].join("\n");
        assert_eq!(rollover_blocks(&prev), vec![vec!["- [ ] 真待办".to_string()]]);
    }

    #[test]
    fn rollover_all_done_or_empty_doc_yields_nothing() {
        assert_eq!(rollover_blocks("# d\n\n- [x] 甲 ✅ 2026-09-22\n"), Vec::<Vec<String>>::new());
        assert_eq!(rollover_blocks(""), Vec::<Vec<String>>::new());
    }

    #[test]
    fn rollover_empty_text_unfinished_todo_is_carried() {
        assert_eq!(rollover_blocks("- [ ] "), vec![vec!["- [ ] ".to_string()]]);
    }

    // ---- previousDailyFile

    #[test]
    fn previous_daily_file_takes_latest_before_today_ignoring_non_dates() {
        let names = ["2026-09-30.md", "notes.md", "2026-10-02.md", "2026-10-03.md", "2026-10-01.md"];
        assert_eq!(previous_daily_file(&names, "2026-10-02"), Some("2026-10-01".to_string()));
        assert_eq!(previous_daily_file(&["2026-10-02.md"], "2026-10-02"), None);
        assert_eq!(previous_daily_file(&[] as &[&str], "2026-10-02"), None);
    }

    // ---- composeDailyScaffold

    #[test]
    fn compose_scaffold_without_blocks_is_bare_scaffold() {
        assert_eq!(compose_daily_scaffold("2026-10-03", &[]), "# 2026-10-03\n");
    }

    #[test]
    fn compose_scaffold_matches_engine_append_shape() {
        let blocks = vec![
            vec!["- [ ] 甲".to_string(), "  - [ ] 乙".to_string()],
            vec!["- [ ] 丙".to_string()],
        ];
        assert_eq!(compose_daily_scaffold("2026-10-03", &blocks), "# 2026-10-03\n\n- [ ] 甲\n  - [ ] 乙\n- [ ] 丙\n");
    }

    // ---- Doc basics (offset bookkeeping the specs rely on)

    #[test]
    fn doc_line_offsets_and_line_at() {
        let d = doc("ab\n\ncd");
        assert_eq!(d.line_count(), 3);
        assert_eq!(d.line(1), "ab");
        assert_eq!(d.line(2), "");
        assert_eq!(d.line(3), "cd");
        assert_eq!(d.line_start(3), 4);
        assert_eq!(d.line_end(3), 6);
        assert_eq!(d.len(), 6);
        assert_eq!(d.line_at(0), 1);
        assert_eq!(d.line_at(2), 1);
        assert_eq!(d.line_at(3), 2);
        assert_eq!(d.line_at(6), 3);
        let empty = doc("");
        assert_eq!(empty.line_count(), 1);
        assert!(empty.is_empty());
        assert_eq!(doc("a\n").line_count(), 2);
    }

    #[test]
    fn fence_state_scan_marks_only_lines_between_markers() {
        // The closing fence line itself still counts as "inside" (the scan
        // reads the open state from before the line, exactly like the TS).
        let d = doc("a\n```\ncode\n```\nafter\n~~~\nx\n~~~\n");
        assert_eq!(
            fence_state_scan(&d),
            vec![false, false, true, true, false, false, true, true, false]
        );
    }
}
