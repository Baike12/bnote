//! Pure vim state: modes, registers, marks, jump list, pending keys, counts.
//! No gpui imports — this file is the model the whole engine rotates around.
// Engine surface reserved for the host adapter and future motions.
#![allow(dead_code)]

use std::collections::HashMap;
use std::ops::Range;

/// Editor modes. `VisualBlock` is reserved: ctrl-v does not enter it in v1
/// (see the module header of `editor::vim`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Normal,
    Insert,
    Replace,
    Visual,
    VisualLine,
    VisualBlock,
}

impl Mode {
    pub fn is_visual(self) -> bool {
        matches!(self, Mode::Visual | Mode::VisualLine | Mode::VisualBlock)
    }
    pub fn is_insert_like(self) -> bool {
        matches!(self, Mode::Insert | Mode::Replace)
    }
}

/// Operators that can combine with motions and text objects.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Operator {
    Change,
    Delete,
    Yank,
    Indent,
    Outdent,
    Lowercase,
    Uppercase,
    ToggleCase,
    /// `g?` rot13 is not implemented; kept out of the enum on purpose.
    ReplaceWith(char),
    Join,
    /// `>`/`<` applied to a linewise selection (visual mode).
    Filter,
}

impl Operator {
    /// Does this operator force linewise behavior (`dd`, `cc`, `yy`, `>>`)?
    pub fn doubled_is_linewise(self) -> bool {
        matches!(
            self,
            Operator::Change
                | Operator::Delete
                | Operator::Yank
                | Operator::Indent
                | Operator::Outdent
                | Operator::Lowercase
                | Operator::Uppercase
                | Operator::ToggleCase
        )
    }
}

/// Content of one register plus its linewise flag.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RegisterContent {
    pub text: String,
    pub linewise: bool,
}

impl RegisterContent {
    pub fn charwise(text: impl Into<String>) -> Self {
        RegisterContent {
            text: text.into(),
            linewise: false,
        }
    }
    pub fn linewise(text: impl Into<String>) -> Self {
        RegisterContent {
            text: text.into(),
            linewise: true,
        }
    }
}

/// Register file: unnamed `"`, yank `0`, small delete `-`, numbered `1..9`
/// (shifting on multiline deletes), named `a-z`/`A-Z` (append), blackhole
/// `_`, plus `+` mirrored to the host clipboard by the adapter.
#[derive(Clone, Debug, Default)]
pub struct Registers {
    pub unnamed: Option<RegisterContent>,
    pub yank: Option<RegisterContent>,
    pub small_delete: Option<RegisterContent>,
    /// `numbered[0]` is register `1`.
    pub numbered: [Option<RegisterContent>; 9],
    pub named: HashMap<char, RegisterContent>,
    /// Set when the last write went into `+` so the host mirrors it out.
    pub clipboard_dirty: Option<RegisterContent>,
    /// Bumped on every write. The host compares it across one key to learn
    /// whether the unnamed register moved without cloning the text
    /// (`set clipboard=unnamed` mirrors it to the system clipboard).
    pub write_seq: u64,
    /// The register prefix read before the last write/read command (`"a`).
    pub requested: Option<char>,
}

impl Registers {
    /// Write a register with vim's routing rules:
    /// - `_`: blackhole, nothing recorded;
    /// - `+`: host clipboard (mirrored by the adapter), also unnamed;
    /// - `a-z`: named set, `A-Z`: append to the named register (charwise
    ///   append joins with `\n` when linewise flags differ — v1 keeps the
    ///   linewise flag if either part is linewise);
    /// - every write also lands in `"` (unnamed);
    /// - yanks additionally land in `0`; multiline deletes shift `1..9`.
    pub fn write(&mut self, name: Option<char>, content: RegisterContent, is_delete: bool, is_multiline: bool) {
        self.write_seq = self.write_seq.wrapping_add(1);
        match name {
            Some('_') => return,
            Some('+') => {
                self.clipboard_dirty = Some(content.clone());
                self.unnamed = Some(content);
            }
            Some(c) if c.is_ascii_lowercase() => {
                self.named.insert(c, content.clone());
                self.unnamed = Some(content);
            }
            Some(c) if c.is_ascii_uppercase() => {
                let lower = c.to_ascii_lowercase();
                let joined = match self.named.remove(&lower) {
                    Some(prev) => RegisterContent {
                        text: if content.linewise || prev.linewise {
                            format!("{}\n{}", prev.text, content.text)
                        } else {
                            format!("{}{}", prev.text, content.text)
                        },
                        linewise: prev.linewise || content.linewise,
                    },
                    None => content.clone(),
                };
                self.named.insert(lower, joined);
                self.unnamed = Some(content);
            }
            other => {
                self.unnamed = Some(content.clone());
                if !is_delete {
                    self.yank = Some(content.clone());
                }
                if is_delete && is_multiline {
                    // Shift 8→9, …, 1→2, then store into 1.
                    for i in (1..self.numbered.len()).rev() {
                        self.numbered[i] = self.numbered[i - 1].take();
                    }
                    self.numbered[0] = Some(content);
                } else if is_delete {
                    self.small_delete = Some(content);
                }
                let _ = other;
            }
        }
    }

    /// Read a register, falling back to unnamed.
    pub fn read(&self, name: Option<char>) -> Option<&RegisterContent> {
        match name {
            Some('"') | None => self.unnamed.as_ref(),
            Some('_') => None,
            Some('+') => self.unnamed.as_ref(),
            Some('0') => self.yank.as_ref(),
            Some('-') => self.small_delete.as_ref(),
            Some(c) if c.is_ascii_lowercase() || c.is_ascii_uppercase() => {
                self.named.get(&c.to_ascii_lowercase())
            }
            // Numbered registers `1..9`.
            Some(c) if ('1'..='9').contains(&c) => {
                self.numbered[(c as u8 - b'1') as usize].as_ref()
            }
            Some(_) => self.unnamed.as_ref(),
        }
    }
}

/// Marks: per-buffer char → byte. Auto-marks: `^` last insert exit, `.` last
/// change, `<`/`>` visual range ends.
#[derive(Clone, Debug, Default)]
pub struct Marks {
    map: HashMap<char, usize>,
}

impl Marks {
    pub fn set(&mut self, name: char, byte: usize) {
        self.map.insert(name, byte);
    }
    pub fn get(&self, name: char) -> Option<usize> {
        self.map.get(&name).copied()
    }
    pub fn remove(&mut self, name: char) {
        self.map.remove(&name);
    }
}

/// Jump list with Zed/bnote semantics: cap 100 entries, navigating trims the
/// tail, and an entry that points past the end of the (shrunk or switched)
/// document is treated as null and skipped — bnote's
/// `patchVimMarkerFind`/`jumpList.test.ts` semantics.
#[derive(Clone, Debug, Default)]
pub struct JumpList {
    entries: Vec<usize>,
    index: Option<usize>,
}

impl JumpList {
    const CAP: usize = 100;

    pub fn push(&mut self, byte: usize) {
        // Drop everything after the current position, then append.
        if let Some(i) = self.index {
            self.entries.truncate(i + 1);
        }
        if self.entries.last() == Some(&byte) {
            self.index = Some(self.entries.len() - 1);
            return;
        }
        self.entries.push(byte);
        if self.entries.len() > Self::CAP {
            self.entries.remove(0);
        }
        self.index = Some(self.entries.len() - 1);
    }

    /// Jump backwards `count` times; `doc_len` implements the out-of-range →
    /// null rule (stale entries are skipped, not clamped).
    pub fn back(&mut self, count: usize, doc_len: usize) -> Option<usize> {
        let mut idx = self.index? as isize;
        let mut jumps = 0;
        while jumps < count {
            idx -= 1;
            if idx < 0 {
                self.index = Some(0);
                return None;
            }
            if self.entries[idx as usize] > doc_len {
                continue; // stale entry: skip like a null mark
            }
            jumps += 1;
        }
        self.index = Some(idx as usize);
        self.entries.get(idx as usize).copied()
    }

    /// Jump forwards `count` times with the same stale-entry rule.
    pub fn forward(&mut self, count: usize, doc_len: usize) -> Option<usize> {
        let mut idx = self.index? as isize;
        let mut jumps = 0;
        while jumps < count {
            idx += 1;
            if idx as usize >= self.entries.len() {
                self.index = Some(self.entries.len().saturating_sub(1));
                return None;
            }
            if self.entries[idx as usize] > doc_len {
                continue;
            }
            jumps += 1;
        }
        self.index = Some(idx as usize);
        self.entries.get(idx as usize).copied()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// State of the last `f`/`F`/`t`/`T`, driven by `;` and `,`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct LastFind {
    pub ch: char,
    pub forward: bool,
    pub till: bool,
}

/// What the repeat recorder captured for `.`.
#[derive(Clone, Debug)]
pub enum RecordedOp {
    /// A normal-mode command replayed by re-feeding these keys.
    Keys(Vec<crate::editor::vim::core::key::Key>),
    /// Text inserted during an insert session (recorded passively by the
    /// host — see `record_insert`), with the entry count (`3i`).
    Insert { text: String, count: u32 },
    /// An insert session that opened a line with `o`/`O`; the replay unit is
    /// `"\n{indent}{text}"` appended below the cursor line.
    InsertOpenLine { text: String, indent: String, count: u32 },
}

/// How the current insert session was entered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InsertEntry {
    Plain,
    OpenLine { below: bool, indent: String },
}

/// Bookkeeping for the active insert session (for count replay and `.`).
#[derive(Clone, Debug)]
pub struct InsertSession {
    pub text: String,
    pub count: u32,
    pub entry: InsertEntry,
}

/// An operator waiting for its target (motion/object/double).
#[derive(Clone, Debug)]
pub struct OpPending {
    pub op: Operator,
    pub register: Option<char>,
    pub pre_count: Option<u32>,
}

/// Pending key sequence under construction.
#[derive(Clone, Debug)]
pub enum Pending {
    None,
    /// A digit count being typed (`1` then `2` …). Zero on its own is not a
    /// count (it is the `0` motion). Carries the operator it belongs to.
    Count { digits: String, op: Option<Box<OpPending>> },
    /// Operator awaiting a motion/object/double (`d` `w`, `d` `d`).
    Operator(Box<OpPending>),
    /// Operator + `i`/`a` awaiting the object letter.
    Object { inner: bool, op: Box<OpPending> },
    /// `f`/`F`/`t`/`T` awaiting its target char.
    Find {
        forward: bool,
        till: bool,
        count: Option<u32>,
        op: Option<Box<OpPending>>,
    },
    /// `r` awaiting the replacement char (count already parsed).
    ReplaceChar { count: u32, visual: bool },
    /// `m` awaiting the mark name.
    SetMark,
    /// `` ` ``/`'` awaiting the mark name (backtick = exact, quote = line).
    GotoMark { exact: bool, op: Option<Box<OpPending>> },
    /// `"` awaiting the register name.
    RegisterPrefix,
    /// `g`/`z` prefix awaited (`gg`, `g_`, `gu`, …).
    GPrefix { count: Option<u32>, op: Option<Box<OpPending>> },
    ZPrefix,
}

impl Pending {
    pub fn reset(&mut self) {
        *self = Pending::None;
    }
    pub fn is_none(&self) -> bool {
        matches!(self, Pending::None)
    }
}

/// The full vim state, owned by the host (one per buffer). Pure functions in
/// `exec`/`motion`/`ops` take `&mut VimState`.
#[derive(Clone, Debug)]
pub struct VimState {
    pub mode: Mode,
    pub pending: Pending,
    /// Column goal for `j`/`k` (char column). `None` = re-anchor at the
    /// cursor (vim resets curswant on horizontal moves).
    pub curswant: Option<usize>,
    /// Visual-mode anchor (the fixed end). The head is the host cursor.
    pub visual_anchor: usize,
    pub registers: Registers,
    pub marks: Marks,
    pub jumplist: JumpList,
    pub last_find: Option<LastFind>,
    /// Last search pattern (substring, v1). Host feeds it via
    /// `set_last_search`; `n`/`N`/`*` consume it.
    pub last_search: Option<String>,
    /// Position before the last jump (for ``` `` ``` / `''`).
    pub jump_from: Option<usize>,
    pub repeat: Option<RecordedOp>,
    /// Active insert session (typed-text recording + count replay).
    pub insert_session: Option<InsertSession>,
    /// Keys consumed by the command currently under construction; recorded
    /// for `.` when the command executes.
    pub keylog: Vec<crate::editor::vim::core::key::Key>,
    /// True while `.` is replaying — recording is suppressed so the same
    /// repeat stays repeatable.
    pub replaying: bool,
    /// Byte where the last insert session ended (auto-mark `^`).
    pub last_insert_exit: Option<usize>,
    /// `gv`'s memory: the selection the last visual session ended with —
    /// (kind, anchor, head). Kinds are only char/line (v1 has no block).
    pub last_visual: Option<(Mode, usize, usize)>,
}

impl Default for VimState {
    fn default() -> Self {
        Self::new()
    }
}

impl VimState {
    pub fn new() -> Self {
        VimState {
            mode: Mode::Normal,
            pending: Pending::None,
            curswant: None,
            visual_anchor: 0,
            registers: Registers::default(),
            marks: Marks::default(),
            jumplist: JumpList::default(),
            last_find: None,
            last_search: None,
            jump_from: None,
            repeat: None,
            insert_session: None,
            keylog: Vec::new(),
            replaying: false,
            last_insert_exit: None,
            last_visual: None,
        }
    }

    /// Reset per-buffer state when the host switches documents: marks and
    /// jump-list entries are byte offsets into a different doc. Registers,
    /// last-find and last-search carry over (they are session state).
    pub fn reset_for_document(&mut self) {
        self.marks = Marks::default();
        self.jumplist = JumpList::default();
        self.pending.reset();
        self.curswant = None;
        self.visual_anchor = 0;
        self.keylog.clear();
        self.insert_session = None;
    }

    /// Passive insert recording hook: the host calls this on
    /// `InputEvent::Change` while the mode is Insert. Never consumes keys,
    /// so IME typing is untouched.
    pub fn record_insert(&mut self, text: &str) {
        if self.mode.is_insert_like() {
            if let Some(session) = self.insert_session.as_mut() {
                session.text.push_str(text);
            }
        }
    }

    /// Start an insert session (called by `exec` on entering insert).
    pub fn begin_insert_session(&mut self, count: u32, entry: InsertEntry) {
        self.insert_session = Some(InsertSession {
            text: String::new(),
            count: count.max(1),
            entry,
        });
    }

    /// Finish an insert session, returning what should be recorded for `.`.
    pub fn end_insert_session(&mut self) -> Option<RecordedOp> {
        let session = self.insert_session.take()?;
        if session.text.is_empty() {
            return None;
        }
        match session.entry {
            InsertEntry::Plain => Some(RecordedOp::Insert {
                text: session.text,
                count: session.count,
            }),
            InsertEntry::OpenLine { indent, .. } => Some(RecordedOp::InsertOpenLine {
                text: session.text,
                indent,
                count: session.count,
            }),
        }
    }

    /// Resolve the effective count: pre-operator × post-operator,
    /// multiplicative like vim (`2d3w` = 6 words). Vim caps at 1e7; the core
    /// caps at 10000 to keep motion loops bounded.
    pub fn combine_counts(pre: Option<u32>, post: Option<u32>) -> u32 {
        let c = match (pre, post) {
            (None, None) => 1,
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (Some(a), Some(b)) => a.saturating_mul(b),
        };
        c.clamp(1, 10_000)
    }

    /// Parse a digit into the pending count. Returns `false` for the `0`
    /// key when no count is being built yet — it is the `0` motion instead
    /// (also behind operators: `d0` deletes to line start).
    pub fn push_count_digit(digits: &mut String, digit: char) -> bool {
        if digit == '0' && digits.is_empty() {
            return false;
        }
        if digits.len() < 5 {
            digits.push(digit);
        }
        true
    }

    /// Record a resolved normal-mode command for `.`.
    pub fn record(&mut self, keys: Vec<crate::editor::vim::core::key::Key>) {
        if !keys.is_empty() {
            self.repeat = Some(RecordedOp::Keys(keys));
        }
    }

    /// Snapshot of the visual selection range (anchor, head) for the host.
    pub fn visual_range(&self, head: usize) -> Range<usize> {
        self.visual_anchor.min(head)..self.visual_anchor.max(head)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_yank_routes_to_zero_and_unnamed() {
        let mut r = Registers::default();
        r.write(None, RegisterContent::charwise("abc"), false, false);
        assert_eq!(r.read(None).unwrap().text, "abc");
        assert_eq!(r.read(Some('0')).unwrap().text, "abc");
        assert!(r.read(Some('-')).is_none());
    }

    #[test]
    fn registers_single_line_delete_goes_small() {
        let mut r = Registers::default();
        r.write(None, RegisterContent::charwise("x"), true, false);
        assert_eq!(r.read(Some('-')).unwrap().text, "x");
        assert!(r.read(Some('0')).is_none());
        assert!(r.read(Some('1')).is_none());
    }

    #[test]
    fn registers_multiline_delete_shifts_numbered() {
        let mut r = Registers::default();
        r.write(None, RegisterContent::linewise("first"), true, true);
        r.write(None, RegisterContent::linewise("second"), true, true);
        assert_eq!(r.read(Some('1')).unwrap().text, "second");
        assert_eq!(r.read(Some('2')).unwrap().text, "first");
    }

    #[test]
    fn registers_named_set_and_append() {
        let mut r = Registers::default();
        r.write(Some('a'), RegisterContent::charwise("x"), false, false);
        r.write(Some('A'), RegisterContent::charwise("y"), false, false);
        assert_eq!(r.read(Some('a')).unwrap().text, "xy");
        // Named writes also mirror unnamed.
        assert_eq!(r.read(None).unwrap().text, "y");
    }

    #[test]
    fn registers_blackhole_writes_nothing() {
        let mut r = Registers::default();
        r.write(Some('_'), RegisterContent::charwise("x"), true, false);
        assert!(r.read(None).is_none());
        // Reading `_` yields nothing.
        r.write(None, RegisterContent::charwise("keep"), true, false);
        assert!(r.read(Some('_')).is_none());
        assert_eq!(r.read(None).unwrap().text, "keep");
    }

    #[test]
    fn registers_plus_marks_clipboard() {
        let mut r = Registers::default();
        r.write(Some('+'), RegisterContent::charwise("clip"), true, false);
        assert_eq!(r.clipboard_dirty.as_ref().unwrap().text, "clip");
        assert_eq!(r.read(Some('+')).unwrap().text, "clip");
    }

    #[test]
    fn counts_multiply_and_cap() {
        assert_eq!(VimState::combine_counts(None, None), 1);
        assert_eq!(VimState::combine_counts(Some(2), Some(3)), 6);
        assert_eq!(VimState::combine_counts(Some(999_999), Some(999_999)), 10_000);
    }

    #[test]
    fn count_digit_zero_handling() {
        let mut digits = String::new();
        // Plain `0` is not a count.
        assert!(!VimState::push_count_digit(&mut digits, '0'));
        assert!(digits.is_empty());
        // After `1`, `0` extends the count (also behind operators: `d10w`).
        assert!(VimState::push_count_digit(&mut digits, '1'));
        assert!(VimState::push_count_digit(&mut digits, '0'));
        assert_eq!(digits, "10");
    }

    #[test]
    fn jumplist_cap_and_trimming() {
        let mut jl = JumpList::default();
        for i in 0..150 {
            jl.push(i);
        }
        assert_eq!(jl.len(), 100);
        // Navigating back then pushing trims the tail: entries 50..=146 remain
        // (97), then 999 is appended.
        assert_eq!(jl.back(3, 1000), Some(146));
        jl.push(999);
        assert_eq!(jl.len(), 98);
        assert_eq!(jl.back(1, 1000), Some(146));
    }

    #[test]
    fn jumplist_back_stops_before_stale_entries() {
        let mut jl = JumpList::default();
        jl.push(10);
        jl.push(20);
        jl.push(30);
        // Doc len 25: entry 30 is stale, 20 is fine.
        assert_eq!(jl.back(1, 25), Some(20));
        // Doc len 15: both 20 and 30 are stale.
        assert_eq!(jl.back(1, 15), Some(10));
    }

    #[test]
    fn jumplist_forward_skips_stale_and_runs_out() {
        let mut jl = JumpList::default();
        jl.push(10);
        jl.push(100); // will be stale
        jl.push(200);
        // One valid back-jump (10), forward finds only stale entries.
        assert_eq!(jl.back(1, 50), Some(10));
        assert_eq!(jl.forward(1, 50), None);
        // Running out parks the index on the newest entry; further forwards fail.
        assert_eq!(jl.forward(1, 50), None);
        // With the full doc, the same walk reaches the newest entry.
        let mut jl2 = JumpList::default();
        jl2.push(10);
        jl2.push(100);
        jl2.push(200);
        assert_eq!(jl2.back(1, 1000), Some(100));
        assert_eq!(jl2.forward(1, 1000), Some(200));
    }

    #[test]
    fn insert_recording_roundtrip() {
        use super::InsertEntry;
        let mut s = VimState::new();
        s.mode = Mode::Insert;
        s.begin_insert_session(3, InsertEntry::Plain);
        s.record_insert("ab");
        s.record_insert("c");
        s.mode = Mode::Normal;
        match s.end_insert_session() {
            Some(super::RecordedOp::Insert { text, count }) => {
                assert_eq!(text, "abc");
                assert_eq!(count, 3);
            }
            other => panic!("unexpected {:?}", other),
        }
        assert!(s.end_insert_session().is_none());
    }
}
