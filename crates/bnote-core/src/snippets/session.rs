//! Port of the session-stack layer of `src/editor/snippets/extension.ts`:
//! tabstop tracking, the parent chain, tab navigation, exit rules and mirror
//! synchronisation.
//!
//! The TS model is a linked list of sessions (`parent` pointers) rebuilt
//! immutably inside the CodeMirror state field. Here the chain is a `Vec` whose
//! index 0 is the root and whose last element is the innermost session — the
//! exact same stack, with the TS `session.parent` = `sessions[level - 1]`.
//!
//! Positions are absolute byte offsets into the document the host holds; every
//! document edit must be pushed into the stack with [`SessionStack::apply_edit`]
//! (or through a `keys::*` entry point, which does it for you).

use std::collections::BTreeMap;

use crate::markdown::math_scan::MathRegion;

use super::replacement::ParsedReplacement;
use super::{Range, Replace};

/// Port of the TS `SnippetSession`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub base: usize,
    pub end: usize,
    /// Unique tabstop indices in navigation order ($0 first when present).
    pub order: Vec<u32>,
    /// Current ranges per tabstop index (may contain mirrors).
    pub stops: BTreeMap<u32, Vec<Range>>,
    /// Index into `order`.
    pub active: usize,
    /// End of the replacement text (absolute): the default landing point of a
    /// Tab on the last tabstop.
    pub final_pos: usize,
}

impl Session {
    /// Port of the TS `buildSession`. `None` when the replacement has no
    /// tabstops (nothing to track).
    pub fn build(start: usize, replacement: &ParsedReplacement) -> Option<Session> {
        if replacement.stops.is_empty() {
            return None;
        }
        let base = start;
        let end = start + replacement.text.len();

        let mut order: Vec<u32> = Vec::new();
        for s in &replacement.stops {
            if !order.contains(&s.index) {
                order.push(s.index);
            }
        }
        // $0 is the primary typing position; navigate to it first.
        if order.contains(&0) {
            let without_zero: Vec<u32> = order.iter().copied().filter(|i| *i != 0).collect();
            order.clear();
            order.push(0);
            order.extend(without_zero);
        }

        let mut stops: BTreeMap<u32, Vec<Range>> = BTreeMap::new();
        for s in &replacement.stops {
            stops
                .entry(s.index)
                .or_default()
                .push(Range::new(base + s.from, base + s.to));
        }

        Some(Session { base, end, order, stops, active: 0, final_pos: end })
    }

    /// The tabstop index the session is currently on.
    pub fn active_index(&self) -> Option<u32> {
        self.order.get(self.active).copied()
    }

    /// All ranges of the active tabstop (mirrors included).
    pub fn active_ranges(&self) -> Option<&[Range]> {
        self.active_index().and_then(|i| self.stops.get(&i)).map(|v| v.as_slice())
    }

    /// The first range of the active tabstop.
    pub fn active_range(&self) -> Option<Range> {
        self.active_ranges().and_then(|r| r.first().copied())
    }

    /// The cursor a fresh expansion selects (TS `startSessionAt`): the first
    /// stop of the first navigation index.
    pub fn initial_selection(&self) -> Option<Range> {
        self.order.first().and_then(|i| self.stops.get(i)).and_then(|v| v.first().copied())
    }

    /// Port of the TS `mapSession`: maps every position through one edit. The
    /// active stop grows around insertions at its position (-1/+1 mapping) so
    /// its range always contains what the user typed — mirror sync reads it.
    /// Each level of the chain does this (a child session lives inside the
    /// parent's active stop), so parents grow along with their children.
    pub fn mapped(&self, from: usize, to: usize, inserted_len: usize) -> Session {
        let active_idx = self.active_index();
        let stops: BTreeMap<u32, Vec<Range>> = self
            .stops
            .iter()
            .map(|(idx, ranges)| {
                let is_active = Some(*idx) == active_idx;
                let mapped: Vec<Range> = ranges
                    .iter()
                    .map(|r| Range {
                        from: map_pos(r.from, from, to, inserted_len, is_active),
                        to: map_pos(r.to, from, to, inserted_len, false),
                    })
                    .collect();
                (*idx, mapped)
            })
            .collect();
        Session {
            base: map_pos(self.base, from, to, inserted_len, false),
            end: map_pos(self.end, from, to, inserted_len, false),
            order: self.order.clone(),
            stops,
            active: self.active,
            final_pos: map_pos(self.final_pos, from, to, inserted_len, false),
        }
    }
}

/// CodeMirror `ChangeDesc.mapPos` for a single change: `assoc_left` is assoc
/// `-1` (positions at the change start stay before the insert), otherwise assoc
/// `+1` (they move past it).
pub(crate) fn map_pos(
    pos: usize,
    from: usize,
    to: usize,
    inserted_len: usize,
    assoc_left: bool,
) -> usize {
    if pos < from {
        pos
    } else if pos > to {
        pos + inserted_len - (to - from)
    } else if assoc_left {
        from
    } else {
        from + inserted_len
    }
}

/// Port of the TS `TabPlan`: the Tab decision inside the session stack.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TabPlan {
    /// Select the stop at `index` of the session at `level`.
    Select { level: usize, index: usize },
    /// The whole chain is exhausted: the session ends, the landing point comes
    /// from [`SessionStack::exit_cursor`].
    End,
}

/// Port of the TS `previousStop` outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviousAction {
    /// Move the cursor to the previous tabstop of the top session.
    Select(Range),
    /// Already at the first tabstop: popped one level (parent session stays on
    /// its own active stop), no cursor movement.
    Popped,
    /// No session at all.
    NoSession,
}

/// The snippet session stack (TS `snippetField` value + `setSession` effect).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionStack {
    /// Index 0 = root, last = innermost.
    sessions: Vec<Session>,
}

impl SessionStack {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    /// All levels, root first.
    pub fn sessions(&self) -> &[Session] {
        &self.sessions
    }

    /// The innermost session.
    pub fn top(&self) -> Option<&Session> {
        self.sessions.last()
    }

    /// The root session (its `finalPos` decides where a finished chain lands).
    pub fn root(&self) -> Option<&Session> {
        self.sessions.first()
    }

    /// TS `setSession.of(null)`.
    pub fn clear(&mut self) {
        self.sessions.clear();
    }

    /// TS: a new session replaces/extends the chain (its `parent` is the
    /// previous top). Positions must already be in the current document.
    pub fn push(&mut self, session: Session) {
        self.sessions.push(session);
    }

    /// Port of the TS `snippetField` update for a session-starting transaction:
    /// the existing chain is remapped through the edit, then the new session
    /// (built against the post-edit document) is pushed.
    pub fn push_child(&mut self, session: Session, edit: &Replace, old_len: usize) {
        self.apply_edit(edit, old_len);
        self.sessions.push(session);
    }

    /// Remaps the whole chain through one document edit. A single change that
    /// covers the entire old document means the file was switched / the note
    /// reloaded — the document the sessions were anchored to is gone, so the
    /// chain is dropped (TS `fullReplace`).
    pub fn apply_edit(&mut self, edit: &Replace, old_len: usize) {
        if self.sessions.is_empty() {
            return;
        }
        if edit.from == 0 && edit.to == old_len {
            self.sessions.clear();
            return;
        }
        for s in &mut self.sessions {
            *s = s.mapped(edit.from, edit.to, edit.insert.len());
        }
    }

    /// Port of the TS `planTab`: the top session's next tabstop, else the
    /// parent's (recursively), else the chain ends.
    pub fn plan_tab(&self) -> Option<TabPlan> {
        if self.sessions.is_empty() {
            return None;
        }
        for level in (0..self.sessions.len()).rev() {
            let s = &self.sessions[level];
            let next = s.active + 1;
            if next < s.order.len() {
                return Some(TabPlan::Select { level, index: next });
            }
        }
        Some(TabPlan::End)
    }

    /// Port of the TS `selectStop`: makes `index` active on `level` and returns
    /// the range to select.
    pub fn select(&mut self, level: usize, index: usize) -> Option<Range> {
        let s = self.sessions.get_mut(level)?;
        s.active = index;
        s.active_range()
    }

    /// Port of the TS `previousStop`. Only the same-level pop semantics are
    /// kept: at the first tabstop of the top session, one level is popped (the
    /// parent stays on whatever stop it was on).
    pub fn previous(&mut self) -> PreviousAction {
        let Some(top) = self.sessions.last_mut() else {
            return PreviousAction::NoSession;
        };
        if top.active > 0 {
            top.active -= 1;
            return match top.active_range() {
                Some(range) => PreviousAction::Select(range),
                None => PreviousAction::Popped,
            };
        }
        self.sessions.pop();
        PreviousAction::Popped
    }

    /// Port of the TS `exitChain`: the deepest level that still contains `head`
    /// (`None` = the cursor left the whole chain).
    pub fn exit_chain(&self, head: usize) -> Option<usize> {
        for level in (0..self.sessions.len()).rev() {
            let s = &self.sessions[level];
            if head >= s.base && head <= s.end {
                return Some(level);
            }
        }
        None
    }

    /// The `exitChain` write: drops the levels the cursor has left. Returns
    /// whether anything changed.
    pub fn prune(&mut self, head: usize) -> bool {
        match self.exit_chain(head) {
            Some(level) if level + 1 == self.sessions.len() => false,
            Some(level) => {
                self.sessions.truncate(level + 1);
                true
            }
            None => {
                if self.sessions.is_empty() {
                    false
                } else {
                    self.sessions.clear();
                    true
                }
            }
        }
    }

    /// Port of the TS `exitCursorPosition`: the landing point when the chain
    /// ends — the end of the replacement text, except when the cursor is inside
    /// a math region and that end already reached the region's closing
    /// delimiter (whole-block snippets like `dm`/`mk`/`ma`), where the cursor
    /// stays put instead of being thrown out of the formula. `None` = stay.
    pub fn exit_cursor(&self, cursor: usize, math: &[MathRegion]) -> Option<usize> {
        let root = self.root()?;
        if let Some(region) = math.iter().find(|r| cursor >= r.from && cursor <= r.to) {
            if root.final_pos >= region.to {
                return None;
            }
        }
        Some(root.final_pos)
    }

    /// Port of the TS `mirrorSyncListener`: keeps mirrored tabstops (the same
    /// index appearing in several places) in sync after an edit. Every level of
    /// the chain takes part — a child session lives inside the parent's active
    /// stop, so the parent's mirrors (e.g. `beg`'s `\begin`/`\end` env name)
    /// must follow while the child is being typed.
    pub fn mirror_edits(&self, doc: &str, head: usize) -> Vec<Replace> {
        let mut changes: Vec<Replace> = Vec::new();
        for node in self.sessions.iter().rev() {
            let Some(ranges) = node.active_ranges() else { continue };
            if ranges.len() < 2 {
                continue;
            }
            let valid: Vec<Range> = ranges
                .iter()
                .copied()
                .filter(|r| r.from <= r.to && r.to <= doc.len())
                .collect();
            if valid.len() < 2 {
                continue;
            }
            let source = valid
                .iter()
                .find(|r| head >= r.from && head <= r.to)
                .copied()
                .unwrap_or(valid[0]);
            let content = &doc[source.from..source.to];
            if valid.iter().all(|r| &doc[r.from..r.to] == content) {
                continue;
            }
            for r in &valid {
                if *r != source {
                    changes.push(Replace::new(r.from, r.to, content));
                }
            }
        }
        changes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::math_scan::scan_math;
    use crate::snippets::parse_replacement;

    fn build(start: usize, replacement: &str) -> Session {
        Session::build(start, &parse_replacement(replacement, &[], None, false))
            .expect("the fixture has tabstops")
    }

    fn paren() -> Session {
        build(0, "($0)$1")
    }

    fn dm() -> Session {
        build(0, "$$\n$0\n$$")
    }

    fn stack(levels: Vec<Session>) -> SessionStack {
        let mut s = SessionStack::new();
        for level in levels {
            s.push(level);
        }
        s
    }

    /// `planTab:Tab 在 tabstop 间的推进与弹出`.
    #[test]
    fn dm_tab_ends_the_session() {
        let s = dm();
        assert_eq!(s.order, vec![0]);
        assert_eq!(stack(vec![s]).plan_tab(), Some(TabPlan::End));
    }

    #[test]
    fn paren_tab_walks_zero_then_one_then_ends() {
        let s = paren();
        let mut st = stack(vec![s.clone()]);
        assert_eq!(st.plan_tab(), Some(TabPlan::Select { level: 0, index: 1 }));
        st.sessions[0].active = 1;
        assert_eq!(st.plan_tab(), Some(TabPlan::End));
    }

    #[test]
    fn nested_session_walks_inner_then_pops_to_the_outer_and_ends() {
        let outer = dm();
        let inner = build(3, "\\mathbf{$0}$1");
        let mut st = stack(vec![outer.clone(), inner]);
        assert_eq!(st.plan_tab(), Some(TabPlan::Select { level: 1, index: 1 }));
        st.sessions[1].active = 1;
        assert_eq!(st.plan_tab(), Some(TabPlan::End));
    }

    #[test]
    fn a_deep_chain_pops_level_by_level() {
        let root = paren();
        let mut root_active0 = root.clone();
        root_active0.active = 0;
        let mid = build(1, "[$0]$1");
        let leaf = build(2, "<$0>");
        let mut st = stack(vec![root_active0, mid, leaf]);
        assert_eq!(st.plan_tab(), Some(TabPlan::Select { level: 1, index: 1 }));
        st.sessions[1].active = 1;
        assert_eq!(st.plan_tab(), Some(TabPlan::Select { level: 0, index: 1 }));
        st.sessions[0].active = 1;
        assert_eq!(st.plan_tab(), Some(TabPlan::End));
    }

    /// `exitCursorPosition:会话结束落点(公式区域夹紧)`.
    #[test]
    fn exit_lands_after_the_closing_brace_inside_a_block() {
        let doc = "$$\n\\mathbf{}\n$$"; // 3 + 9 + 3
        let s = build(3, "\\mathbf{$0}");
        assert_eq!(s.final_pos, 12);
        assert_eq!(doc.len(), 15);
        let st = stack(vec![s]);
        // The cursor is inside the braces at 11; the closing `$$` is past
        // finalPos, so the cursor lands right after the `}`.
        assert_eq!(st.exit_cursor(11, &scan_math(doc)), Some(12));
    }

    #[test]
    fn whole_block_creation_stays_put() {
        let s = dm();
        let doc = "$$\n\n$$";
        let st = stack(vec![s.clone()]);
        assert_eq!(s.final_pos, 6);
        assert_eq!(st.exit_cursor(3, &scan_math(doc)), None);
    }

    #[test]
    fn inline_creation_lands_after_the_mapped_closing_dollar() {
        let s = build(0, "$$0$"); // text "$$", stop at 1, finalPos = 2
        let mut st = stack(vec![s]);
        st.apply_edit(&Replace::insert_at(1, "x"), 2);
        let field = st.top().unwrap();
        assert_eq!(field.final_pos, 3);
        assert_eq!(st.exit_cursor(1, &scan_math("$x$")), None);
    }

    #[test]
    fn outside_math_the_cursor_always_lands_at_the_replacement_end() {
        let s = build(0, "($0)");
        let st = stack(vec![s.clone()]);
        assert_eq!(st.exit_cursor(1, &scan_math("()")), Some(s.final_pos));
    }

    /// `exitChain:光标离开即弹出`.
    #[test]
    fn inside_the_inner_session_it_is_kept() {
        let outer = paren();
        let inner = build(1, "<$0>");
        let st = stack(vec![outer, inner]);
        assert_eq!(st.exit_chain(2), Some(1));
    }

    #[test]
    fn leaving_the_inner_session_falls_back_to_the_parent() {
        let outer = paren(); // [0, 2)
        let inner = build(1, "x$0");
        let st = stack(vec![outer, inner]);
        assert_eq!(st.exit_chain(0), Some(0));
    }

    #[test]
    fn leaving_the_whole_chain_keeps_nothing() {
        let outer = paren();
        let inner = build(1, "x$0");
        let st = stack(vec![outer, inner]);
        assert_eq!(st.exit_chain(10), None);
    }

    /// `snippetField:链式映射与全量替换`.
    #[test]
    fn a_plain_edit_maps_every_stop_of_the_chain() {
        let mut st = stack(vec![paren()]);
        st.apply_edit(&Replace::insert_at(1, "x"), 2);
        let mapped = st.top().unwrap();
        assert_eq!(mapped.stops[&0][0], Range::new(1, 2));
        assert_eq!(mapped.stops[&1][0], Range::new(3, 3));
        assert_eq!(mapped.end, 3);
    }

    #[test]
    fn the_parent_active_stop_grows_with_the_child_expansion() {
        let mut st = stack(vec![paren()]); // $0 = [1,1]
        let child = build(1, "Y$0");
        st.push_child(child, &Replace::insert_at(1, "Y"), 2);
        let field = st.top().unwrap();
        assert_eq!(field.base, 1);
        assert_eq!(field.stops[&0][0], Range::new(2, 2));
        // The parent's $0 is the active stop: the -1/+1 mapping must swallow
        // the text the child expanded over.
        assert_eq!(st.sessions()[0].stops[&0][0], Range::new(1, 2));
    }

    #[test]
    fn a_full_document_replace_clears_the_chain() {
        let outer = paren();
        let inner = build(1, "<$0>");
        let doc = "(x<<>>)";
        let mut st = stack(vec![outer, inner]);
        st.apply_edit(&Replace::new(0, doc.len(), "另一个文件的内容"), doc.len());
        assert!(st.is_empty());
    }

    #[test]
    fn ordinary_input_does_not_clear_the_session() {
        let mut st = stack(vec![dm()]);
        let doc = "$$\n\n$$";
        st.apply_edit(&Replace::insert_at(3, "E"), doc.len());
        assert!(!st.is_empty());
    }

    /// `buildSession:tabstop 顺序与镜像`.
    #[test]
    fn zero_is_the_first_navigation_position() {
        let s = build(0, "\\sum_{${0:i}=${1:1}}^{${2:N}} $3");
        assert_eq!(s.order, vec![0, 1, 2, 3]);
    }

    #[test]
    fn without_zero_the_navigation_follows_appearance_order() {
        let s = build(0, "ab$1cd$2");
        assert_eq!(s.order, vec![1, 2]);
    }

    #[test]
    fn mirrored_stops_share_one_range_group() {
        let s = build(0, "\\begin{$0}\n$1\n\\end{$0}");
        assert_eq!(s.order, vec![0, 1]);
        assert_eq!(s.stops[&0].len(), 2);
    }

    #[test]
    fn a_replacement_without_stops_builds_no_session() {
        assert!(Session::build(0, &parse_replacement("\\alpha", &[], None, false)).is_none());
    }

    /// latexSuite.test.ts — `deleteScriptBraces:sj/sk 会话存在时删掉整对`.
    #[test]
    fn deleting_the_active_braces_collapses_the_session_to_a_point() {
        let doc = "$x_{}$";
        // `sj` (`_{$0}`) expanded at 2: the active stop sits between the braces.
        let mut st = stack(vec![build(2, "_{$0}")]);
        assert_eq!(st.top().unwrap().active_range(), Some(Range::caret(4)));
        let delete = Replace::delete(2, 5);
        st.apply_edit(&delete, doc.len());
        let field = st.top().unwrap();
        assert_eq!(field.base, 2);
        assert_eq!(field.end, 2);
        assert_eq!(field.final_pos, 2);
        assert_eq!(field.stops[&0][0], Range::new(2, 2));
        // The cursor is still on that point: keep the level; one step further
        // and it pops by the normal rule, leaving no residue.
        assert_eq!(st.exit_chain(2), Some(0));
        assert_eq!(st.exit_chain(3), None);
    }

    #[test]
    fn deleting_the_inner_braces_keeps_only_the_inner_level() {
        let outer = Session {
            base: 1,
            end: 13,
            order: vec![0, 1],
            stops: BTreeMap::from([(0, vec![Range::caret(7)]), (1, vec![Range::new(9, 12)])]),
            active: 1,
            final_pos: 13,
        };
        let inner = build(9, "_{$0}");
        let doc = "$\\frac{}{_{}}$";
        let mut st = stack(vec![outer, inner]);
        st.apply_edit(&Replace::delete(9, 12), doc.len());
        let field = st.top().unwrap();
        assert_eq!(field.base, 9);
        assert_eq!(st.len(), 2);
        let parent = st.root().unwrap();
        assert_eq!(parent.base, 1);
        assert_eq!(parent.end, 10);
        assert_eq!(parent.stops[&1][0], Range::new(9, 9));
    }

    /// `mirror sync`: the same tabstop index in several places follows the
    /// typed text; the parent level participates too.
    #[test]
    fn mirror_sync_copies_the_source_range_into_the_mirrors() {
        let doc = "\\begin{}\n\n\\end{}";
        let mut st = stack(vec![build(0, "\\begin{$0}\n$1\n\\end{$0}")]);
        st.sessions[0].active = 1; // navigate to $1 (the body)
        // Type "X" in the body: the active stop grows.
        st.apply_edit(&Replace::insert_at(9, "X"), doc.len());
        let doc2 = "\\begin{}\nX\n\\end{}";
        // Now move to $0 (the env name) and type "align" there.
        st.sessions[0].active = 0;
        st.apply_edit(&Replace::insert_at(7, "align"), doc2.len());
        let doc3 = "\\begin{align}\nX\n\\end{}";
        let head = 12; // inside the first (source) range
        let changes = st.mirror_edits(doc3, head);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].from, doc3.rfind('{').unwrap() + 1);
        assert_eq!(changes[0].insert, "align");
        let out = crate::snippets::apply_replaces(doc3, &changes);
        assert_eq!(out, "\\begin{align}\nX\n\\end{align}");
        // The sync is a transaction of its own: it remaps the stack too, after
        // which both mirrors agree and no further edits are produced.
        st.apply_edit(&changes[0], doc3.len());
        assert!(st.mirror_edits(&out, head).is_empty());
    }

    /// `exitChain` interop: tabout carries the cursor out of the session.
    #[test]
    fn a_cursor_carried_out_of_the_range_ends_the_session() {
        let st = stack(vec![paren()]);
        // `$(x)$`: parenthesised group at 1..4, out = after the `)`.
        let doc = "$(x)$";
        let out = doc.find(')').unwrap() + 1;
        assert_eq!(st.exit_chain(out), None);
    }

    /// `previousStop` (Shift+Tab) semantics.
    #[test]
    fn previous_walks_back_then_pops() {
        let mut st = stack(vec![paren()]);
        st.sessions[0].active = 1;
        // Shift+Tab at $1 walks back to $0 (`($0)$1` puts $0 at 1).
        assert_eq!(st.previous(), PreviousAction::Select(Range::caret(1)));
        assert_eq!(st.previous(), PreviousAction::Popped);
        assert!(st.is_empty());
        assert_eq!(st.previous(), PreviousAction::NoSession);
    }

    /// `mapPos` follows CodeMirror's assoc rules.
    #[test]
    fn map_pos_matches_codemirror_assoc() {
        // Insertion at 1: left assoc stays, right assoc moves.
        assert_eq!(map_pos(1, 1, 1, 1, true), 1);
        assert_eq!(map_pos(1, 1, 1, 1, false), 2);
        // Replacement [1,2) with "xy".
        assert_eq!(map_pos(1, 1, 2, 2, true), 1);
        assert_eq!(map_pos(2, 1, 2, 2, false), 3);
        assert_eq!(map_pos(3, 1, 2, 2, false), 4);
        assert_eq!(map_pos(0, 1, 2, 2, false), 0);
        // Deletion [1,2).
        assert_eq!(map_pos(3, 1, 2, 0, false), 2);
        assert_eq!(map_pos(1, 1, 2, 0, true), 1);
        assert_eq!(map_pos(2, 1, 2, 0, false), 1);
    }
}
