//! Geometry and emission for the preview scan: the line table, the visible
//! window, the activity rule and the span/block sink with its disjointness
//! guard. The data model and the invariants live in [`super::super`].

use std::ops::{Range, RangeInclusive};

use crate::preview::{
    BlockKind, PreviewBlock, PreviewSnapshot, PreviewSpan, PreviewSpanKind, Widget,
};

/// Line table: `[(start, end)]` with `end` pointing at the `\n` (identical to
/// `markdown::line_ranges`, which guarantees at least one line even for an
/// empty document).
pub(super) type LineTable = Vec<(usize, usize)>;

/// 0-based index of the line containing `pos`. A position at a line break
/// belongs to the line that break ends; positions past the end of the text
/// (and `usize::MAX`-style probes) resolve to the last line.
pub(super) fn line_of(lines: &[(usize, usize)], pos: usize) -> usize {
    let n = lines.len().saturating_sub(1);
    lines
        .partition_point(|(start, _)| *start <= pos)
        .saturating_sub(1)
        .min(n)
}

/// The requested byte window expanded to whole lines. Block classification
/// still reads the whole document; only emission is limited to this window
/// (TS: `buildInlineDecorations` iterates `view.visibleRanges`).
#[derive(Clone, Copy, Debug)]
pub(super) struct Window {
    pub(super) first: usize,
    pub(super) last: usize,
    from: usize,
    to: usize,
}

impl Window {
    pub(super) fn new(lines: &[(usize, usize)], visible: &Range<usize>) -> Window {
        let last_line = lines.len().saturating_sub(1);
        let first = line_of(lines, visible.start).min(last_line);
        // The byte before `visible.end` names the last visible line; an empty
        // window is the single line holding `visible.start`.
        let probe = if visible.end > visible.start {
            visible.end - 1
        } else {
            visible.start
        };
        let last = line_of(lines, probe).min(last_line).max(first);
        Window {
            first,
            last,
            from: lines[first].0,
            to: lines[last].1,
        }
    }

    /// True when `[from, to)` shares at least one byte with the window.
    pub(super) fn intersects(&self, from: usize, to: usize) -> bool {
        from < self.to && to > self.from
    }

    pub(super) fn lines(&self) -> RangeInclusive<usize> {
        self.first..=self.last
    }
}

/// The activity rule (TS `active(from, to)`): true when any selection touches
/// the closed range `[from, to]`. `to` is the construct's *exclusive* end, so
/// a caret resting on the byte right after a construct counts as touching it
/// (bnote: "触点算活动") — that is what keeps a caret at the end of `- x`
/// from flipping the line back to a different rendering.
#[derive(Clone, Copy)]
pub(super) struct Activity<'a> {
    selections: &'a [Range<usize>],
}

impl<'a> Activity<'a> {
    pub(super) fn new(selections: &'a [Range<usize>]) -> Activity<'a> {
        Activity { selections }
    }

    /// Any selection touching `[from, to]` (TS `active`).
    pub(super) fn touches(&self, from: usize, to: usize) -> bool {
        self.selections
            .iter()
            .any(|r| r.start <= to && r.end >= from)
    }

    /// No selection touches `[from, to]` — the construct renders.
    pub(super) fn inactive(&self, from: usize, to: usize) -> bool {
        !self.touches(from, to)
    }

    /// Any selection touching the line `[from, to]` (the line-level marker
    /// rule; TS `activeLine`).
    pub(super) fn line_active(&self, from: usize, to: usize) -> bool {
        self.touches(from, to)
    }

    /// Any selection touching any of the lines `first..=last`. Blocks must
    /// never cover a caret/selection line (invariant), so the sink refuses
    /// such blocks outright.
    pub(super) fn lines_active(&self, lines: &[(usize, usize)], first: usize, last: usize) -> bool {
        if last < first {
            return false;
        }
        (first..=last.min(lines.len().saturating_sub(1)))
            .any(|n| self.line_active(lines[n].0, lines[n].1))
    }

    /// TS `keepMarkerTrailingSpace`: the whitespace run after a marker ends at
    /// the line end AND a selection resting at/after that run keeps the last
    /// space visible as the caret's text anchor (an empty item whose whole
    /// line would otherwise have no text node).
    pub(super) fn keep_marker_trailing_space(
        &self,
        line_from: usize,
        line_to: usize,
        ws_to: usize,
    ) -> bool {
        ws_to == line_to
            && self
                .selections
                .iter()
                .any(|r| r.start <= line_to && r.end >= line_from && r.start >= ws_to)
    }
}

/// Collector for the snapshot. Every emitted span hides bytes, so the sink
/// keeps a sorted claim list and drops a span that would overlap an earlier
/// one — the model's "pairwise disjoint" invariant is enforced here, and the
/// TS `claim()` call sites map onto the same guard.
pub(super) struct Sink<'a> {
    lines: &'a [(usize, usize)],
    win: Window,
    act: Activity<'a>,
    spans: Vec<PreviewSpan>,
    claimed: Vec<Range<usize>>,
    blocks: Vec<PreviewBlock>,
}

impl<'a> Sink<'a> {
    pub(super) fn new(
        lines: &'a [(usize, usize)],
        win: Window,
        act: Activity<'a>,
        capacity: usize,
    ) -> Sink<'a> {
        Sink {
            lines,
            win,
            act,
            spans: Vec::with_capacity(capacity),
            claimed: Vec::new(),
            blocks: Vec::new(),
        }
    }

    /// Hides `[from, to)` (`PreviewSpanKind::Hidden`). Returns false when the
    /// range is empty, outside the window, or already claimed.
    pub(super) fn hide(&mut self, from: usize, to: usize) -> bool {
        self.push(from, to, PreviewSpanKind::Hidden)
    }

    /// Replaces `[from, to)` with an inline element. Returns false like
    /// [`Sink::hide`].
    pub(super) fn widget(&mut self, from: usize, to: usize, widget: Widget) -> bool {
        self.push(from, to, PreviewSpanKind::Widget(widget))
    }

    fn push(&mut self, from: usize, to: usize, kind: PreviewSpanKind) -> bool {
        if from >= to || !self.win.intersects(from, to) || !self.claim(from, to) {
            return false;
        }
        self.spans.push(PreviewSpan {
            range: from..to,
            kind,
        });
        true
    }

    /// Claims `[from, to)` without emitting a span (used to reserve bytes
    /// that a later rule must not touch).
    fn claim(&mut self, from: usize, to: usize) -> bool {
        let i = self.claimed.partition_point(|r| r.start < from);
        if i > 0 && self.claimed[i - 1].end > from {
            return false;
        }
        if self.claimed.get(i).is_some_and(|r| r.start < to) {
            return false;
        }
        self.claimed.insert(i, from..to);
        true
    }

    /// True when `[from, to)` shares a byte with an already claimed span.
    pub(super) fn overlaps_claimed(&self, from: usize, to: usize) -> bool {
        let i = self.claimed.partition_point(|r| r.start < from);
        if i > 0 && self.claimed[i - 1].end > from {
            return true;
        }
        self.claimed.get(i).is_some_and(|r| r.start < to)
    }

    /// Emits a whole-line-range block replacement. Refused when the range is
    /// empty/inverted, outside the window, overlapping an earlier block, or
    /// touched by a selection — the invariant that a block never covers a
    /// caret line is enforced here, not by the callers.
    pub(super) fn block(&mut self, first_line: usize, last_line: usize, kind: BlockKind) -> bool {
        if last_line < first_line
            || last_line >= self.lines.len()
            || first_line > self.win.last
            || last_line < self.win.first
        {
            return false;
        }
        if self
            .blocks
            .iter()
            .any(|b| first_line <= b.last_line && last_line >= b.first_line)
        {
            return false;
        }
        if self.act.lines_active(self.lines, first_line, last_line) {
            return false;
        }
        self.blocks.push(PreviewBlock {
            first_line,
            last_line,
            kind,
        });
        true
    }

    pub(super) fn finish(mut self) -> PreviewSnapshot {
        self.spans.sort_by_key(|s| s.range.start);
        self.blocks.sort_by_key(|b| b.first_line);
        PreviewSnapshot {
            spans: self.spans,
            blocks: self.blocks,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> LineTable {
        crate::markdown::line_ranges(text)
    }

    #[test]
    fn line_of_resolves_positions_and_overruns() {
        let l = lines("ab\ncd\n");
        assert_eq!(line_of(&l, 0), 0);
        assert_eq!(line_of(&l, 2), 0); // the `\n` belongs to line 0
        assert_eq!(line_of(&l, 3), 1);
        assert_eq!(line_of(&l, 6), 2); // past the end → last line
        assert_eq!(line_of(&l, usize::MAX), 2);
        let empty = lines("");
        assert_eq!(line_of(&empty, 0), 0);
        assert_eq!(line_of(&empty, usize::MAX), 0);
    }

    #[test]
    fn window_expands_to_whole_lines_and_clamps() {
        let l = lines("aa\nbb\ncc");
        assert_eq!(Window::new(&l, &(0..1)).first, 0);
        assert_eq!(Window::new(&l, &(0..1)).last, 0);
        assert_eq!(Window::new(&l, &(3..4)).first, 1); // `b` of line 1
        assert_eq!(Window::new(&l, &(3..4)).last, 1);
        // End exactly at a line start: the previous byte names the last line.
        let w = Window::new(&l, &(0..3));
        assert_eq!((w.first, w.last), (0, 0));
        // Empty window: the line holding `start`.
        let w = Window::new(&l, &(4..4));
        assert_eq!((w.first, w.last), (1, 1));
        // Overrun clamps to the last line.
        let w = Window::new(&l, &(0..usize::MAX));
        assert_eq!((w.first, w.last), (0, 2));
        assert!(w.intersects(0, 1));
        assert!(w.intersects(7, 8));
        assert!(!w.intersects(8, 9));
    }

    #[test]
    fn activity_touches_closed_range_with_exclusive_end() {
        let caret = [3..3];
        let act = Activity::new(&caret);
        // A caret on the byte right after the range (its exclusive end)
        // still touches it.
        assert!(act.touches(0, 3));
        assert!(!act.inactive(0, 3));
        assert!(act.touches(3, 5));
        assert!(act.inactive(4, 5));
        // A selection range touching a construct's start/end counts too.
        let sel = [1..9];
        let act = Activity::new(&sel);
        assert!(act.touches(8, 10));
        assert!(act.touches(0, 1));
        assert!(act.touches(9, 12)); // starts exactly where the selection ends
        assert!(act.inactive(10, 12));
    }

    #[test]
    fn sink_keeps_spans_sorted_disjoint_and_windowed() {
        let l = lines("abcdef\nghij");
        let w = Window::new(&l, &(0..usize::MAX));
        let sels: [Range<usize>; 0] = [];
        let act = Activity::new(&sels);
        let mut sink = Sink::new(&l, w, act, 4);
        assert!(sink.hide(0, 2));
        assert!(!sink.hide(1, 3)); // overlaps [0, 2)
        assert!(sink.hide(2, 4)); // touching but disjoint
        assert!(!sink.hide(3, 3)); // empty
        assert!(sink.hide(6, 7));
        let windowed = Window::new(&l, &(0..2));
        let mut narrow = Sink::new(&l, windowed, act, 1);
        assert!(!narrow.hide(6, 7));
        let snap = sink.finish();
        assert_eq!(
            snap.spans
                .iter()
                .map(|s| s.range.clone())
                .collect::<Vec<_>>(),
            vec![0..2, 2..4, 6..7]
        );
    }

    #[test]
    fn sink_refuses_blocks_on_selection_lines_and_overlaps() {
        let l = lines("aa\nbb\ncc");
        let w = Window::new(&l, &(0..usize::MAX));
        let sels = [4..4]; // caret on line 1
        let act = Activity::new(&sels);
        let mut sink = Sink::new(&l, w, act, 0);
        let math = || BlockKind::Math {
            tex: String::new(),
            display: true,
        };
        assert!(!sink.block(0, 1, math())); // covers the caret line
        assert!(!sink.block(1, 1, math()));
        assert!(sink.block(0, 0, math())); // line 0: free
        assert!(sink.block(2, 2, math())); // line 2: free
        assert!(!sink.block(0, 2, math())); // overlaps line 0 and the caret
        assert!(!sink.block(2, 1, math())); // inverted
        assert!(!sink.block(2, 9, math())); // past the last line
        let snap = sink.finish();
        assert_eq!(snap.blocks.len(), 2);
        assert_eq!(snap.blocks[0].first_line, 0);
        assert_eq!(snap.blocks[1].first_line, 2);
    }
}
