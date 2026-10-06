//! Behavioral test suite for the vim core.
//!
//! The harness drives the pure engine exactly the way the adapter will:
//! feed keys, apply the returned `Execution` plan to a plain `String`, set
//! the cursor. Docs carry a `|` cursor marker (`"foo |bar"` = text
//! `foo bar`, cursor on `b`).

#![cfg(test)]
// Test names mirror the vim keys they cover (`J_joins_with_space`, `iW_big_words`):
// the capitalised segment is the key, not a word.
#![allow(non_snake_case)]

use crate::editor::vim::core::exec::feed;
use crate::editor::vim::core::key::Key;
use crate::editor::vim::core::ops::{CursorPlan, HostContext, HostIntent, Outcome};
use crate::editor::vim::core::state::Mode;
use crate::editor::vim::core::Viewport;
use crate::editor::vim::core::{VimState, VimText};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

struct Env {
    text: String,
    cursor: usize,
    /// (anchor, head) while a visual selection is active.
    selection: Option<(usize, usize)>,
    viewport: Viewport,
    clipboard: Option<String>,
    state: VimState,
    undos: usize,
    redos: usize,
}

impl Env {
    fn new(spec: &str) -> Env {
        let (text, cursor) = split_marker(spec);
        Env {
            text,
            cursor,
            selection: None,
            viewport: Viewport {
                first_line: 0,
                last_line: 100,
            },
            clipboard: None,
            state: VimState::new(),
            undos: 0,
            redos: 0,
        }
    }

    fn ctx(&self) -> HostContext {
        let selection = match self.selection {
            Some((a, h)) => a.min(h)..a.max(h),
            None => self.cursor..self.cursor,
        };
        HostContext {
            cursor: self.cursor,
            selection,
            viewport: self.viewport,
            shiftwidth: 4,
            clipboard: self.clipboard.clone(),
        }
    }

    /// Simulate native insert-mode typing (the host applies it directly and
    /// reports it via `record_insert`).
    fn type_text(&mut self, text: &str) {
        self.text.insert_str(self.cursor, text);
        self.state.record_insert(text);
        self.cursor += text.len();
    }

    fn step(&mut self, keys: &str) -> &mut Self {
        for key in parse_keys(keys) {
            let ctx = self.ctx();
            let outcome = feed(&mut self.state, &self.text, key, &ctx);
            self.apply(outcome);
        }
        self
    }

    fn apply(&mut self, outcome: Outcome) {
        let Outcome::Executed(exec) = outcome else {
            return;
        };
        let mut edits = exec.edits.clone();
        // Contract: apply in descending start order.
        edits.sort_by(|a, b| b.range.start.cmp(&a.range.start));
        for edit in edits {
            let start = edit.range.start.min(self.text.len());
            let end = edit.range.end.clamp(start, self.text.len());
            self.text.replace_range(start..end, &edit.text);
        }
        match exec.cursor {
            Some(CursorPlan::Collapse(pos)) => {
                self.cursor = pos.min(self.text.len());
                let visual_now = exec.mode_after.map_or(false, |m| m.is_visual())
                    || exec.mode_after.is_none() && self.state.mode.is_visual();
                if !visual_now {
                    self.selection = None;
                }
            }
            Some(CursorPlan::Select { anchor, head }) => {
                self.cursor = head.min(self.text.len());
                self.selection = Some((anchor.min(self.text.len()), self.cursor));
            }
            None => {}
        }
        if let Some(mode) = exec.mode_after {
            self.state.mode = mode;
        }
        for intent in exec.host_intents {
            match intent {
                HostIntent::Undo => self.undos += 1,
                HostIntent::Redo => self.redos += 1,
                HostIntent::OpenSearch => {}
            }
        }
    }
}

/// `"foo |bar"` → `("foo bar", 4)`.
fn split_marker(spec: &str) -> (String, usize) {
    match spec.find('|') {
        Some(i) => (format!("{}{}", &spec[..i], &spec[i + 1..]), i),
        None => (spec.to_string(), 0),
    }
}

fn parse_keys(s: &str) -> Vec<Key> {
    let mut keys = Vec::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '<' {
            let mut token = String::new();
            for t in chars.by_ref() {
                if t == '>' {
                    break;
                }
                token.push(t);
            }
            keys.push(match token.as_str() {
                "Esc" => Key::Escape,
                "Enter" | "CR" => Key::Enter,
                "BS" => Key::Backspace,
                "Space" => Key::Char(' '),
                "C-r" => Key::CtrlR,
                "C-a" => Key::CtrlA,
                "C-x" => Key::CtrlX,
                "C-o" => Key::CtrlO,
                "Tab" => Key::Tab,
                "lt" => Key::Char('<'),
                "gt" => Key::Char('>'),
                other => panic!("unknown key token <{other}>"),
            });
        } else {
            keys.push(Key::Char(c));
        }
    }
    keys
}

fn check_keys(initial: &str, keys: &str, expected: &str) {
    let mut env = Env::new(initial);
    env.step(keys);
    let (want_text, want_cursor) = split_marker(expected);
    assert_eq!(env.text, want_text, "text after `{keys}`");
    assert_eq!(env.cursor, want_cursor, "cursor after `{keys}`");
}

fn check_text(initial: &str, keys: &str, expected: &str) {
    let mut env = Env::new(initial);
    env.step(keys);
    assert_eq!(env.text, expected, "text after `{keys}`");
}

fn check_cursor(initial: &str, keys: &str, expected: &str) {
    let mut env = Env::new(initial);
    env.step(keys);
    let (_, want_cursor) = split_marker(expected);
    assert_eq!(env.cursor, want_cursor, "cursor after `{keys}`");
}

fn check_mode(initial: &str, keys: &str, mode: Mode) {
    let mut env = Env::new(initial);
    env.step(keys);
    assert_eq!(env.state.mode, mode, "mode after `{keys}`");
}

// ---------------------------------------------------------------------------
// doc helpers
// ---------------------------------------------------------------------------

mod doc_tests {
    use super::*;
    use crate::editor::vim::core::doc::{
        first_non_blank, line_count, line_end, line_index, line_range, line_start,
    };

    #[test]
    fn line_count_counts_trailing_empty_line() {
        assert_eq!(line_count(&"a\nb".to_string()), 2);
        assert_eq!(line_count(&"a\nb\n".to_string()), 3);
        assert_eq!(line_count(&String::new()), 1);
    }

    #[test]
    fn line_range_at_newlines() {
        let doc = "ab\ncd".to_string();
        assert_eq!(line_range(&doc, 0), 0..2);
        assert_eq!(line_range(&doc, 2), 0..2); // the newline belongs to line 0
        assert_eq!(line_range(&doc, 3), 3..5);
        assert_eq!(line_start(&doc, 1), 3);
        assert_eq!(line_end(&doc, 0), 2);
    }

    #[test]
    fn first_non_blank_and_line_index() {
        let doc = "  hi\n\nx".to_string();
        assert_eq!(first_non_blank(&doc, 0), 2);
        assert_eq!(first_non_blank(&doc, 1), 5); // empty line: its end
        assert_eq!(line_index(&doc, 4), 0);
        assert_eq!(line_index(&doc, 5), 1);
        assert_eq!(line_index(&doc, 6), 2);
    }

    #[test]
    fn cjk_slices_on_char_boundaries() {
        let doc = "中文abc".to_string();
        // 中 = 3 bytes.
        assert_eq!(doc.char_at(1), Some('中'));
        assert_eq!(doc.char_at(3), Some('文'));
        assert_eq!(doc.slice(0..4), "中");
        assert_eq!(doc.slice(3..7), "文a");
    }
}

// ---------------------------------------------------------------------------
// Motions
// ---------------------------------------------------------------------------

mod motion_tests {
    use super::*;

    #[test]
    fn h_left_stays_on_line() {
        check_cursor("ab\nc|d", "h", "ab\n|cd");
        // h never wraps: at the line start it stays put.
        check_cursor("ab\nc|d", "hh", "ab\n|cd");
        // From the end-of-line slot it lands on the last char.
        check_cursor("abc|", "h", "ab|c");
    }

    #[test]
    fn l_right_stops_after_last_char() {
        // The end-of-line slot (after the last char) is a legal stop; it
        // never wraps and further presses do not move.
        check_cursor("|ab", "ll", "ab|");
        check_cursor("|ab", "lll", "ab|");
    }

    #[test]
    fn j_k_move_with_curswant() {
        check_cursor("|foo\n  bar", "j", "foo\n|  bar");
        check_cursor("|foo\n  bar", "jj", "foo\n|  bar"); // second j: no line 2
        // Short line clamps to its last char.
        check_cursor("|foo\nx\nbar", "j", "foo\n|x");
        // Back up.
        check_cursor("foo\n  b|ar", "k", "foo|\n  bar");
        // k at top: no move.
        check_cursor("|foo", "k", "|foo");
    }

    #[test]
    fn j_k_keep_goal_column_through_short_line() {
        // From column 5, down to a 1-char line, then down again: goal kept.
        check_cursor("hello|\n    x\n    world", "j", "hello\n    x|");
        check_cursor("hello|\n    x\n    world", "jj", "hello\n    x\n    w|orld");
    }

    #[test]
    fn dollar_moves_to_line_end_and_sets_far_goal() {
        check_cursor("f|oo\nbar", "$", "fo|o\nbar");
        // After `$`, j lands at the end of the (shorter) next line.
        check_cursor("foo|\nxy\nz", "j", "foo\nxy|");
    }

    #[test]
    fn zero_caret_g_underscore() {
        check_cursor("  foo b|ar", "0", "|  foo bar");
        check_cursor("  foo b|ar", "^", "  |foo bar");
        check_cursor("  foo   b|ar", "g_", "  foo   ba|r");
    }

    #[test]
    fn word_motions_basic() {
        check_cursor("|foo bar", "w", "foo |bar");
        check_cursor("foo |bar", "w", "foo ba|r");
        check_cursor("|foo bar", "e", "fo|o bar");
        check_cursor("|foo bar", "E", "fo|o bar");
        check_cursor("foo |bar", "b", "|foo bar");
        check_cursor("foo |bar", "ge", "fo|o bar");
    }

    #[test]
    fn word_motions_cross_lines_and_stop_on_empty_lines() {
        // w stops on the empty line.
        check_cursor("a|b\n\ncd", "w", "ab\n|\ncd");
        // w crosses to the next word.
        check_cursor("a|b\n  cd", "w", "ab\n  |cd");
        // b from 'd' lands on 'c'; a further b stops on the empty line.
        check_cursor("ab\n\nc|d", "b", "ab\n\n|cd");
        check_cursor("ab\n\ncd|", "bb", "ab\n|\ncd");
        // e skips empty lines.
        check_cursor("a|b\n\ncd", "e", "ab\n\nc|d");
        // w from the last word stops at the last char (doc end).
        check_cursor("abc\nxy|z", "w", "abc\nxy|z");
    }

    #[test]
    fn word_motions_punct_runs() {
        check_cursor("|foo.bar", "w", "foo|.bar");
        check_cursor("foo|.bar", "w", "foo.|bar");
        check_cursor("|foo.bar", "e", "fo|o.bar");
        check_cursor("foo|.bar", "e", "foo.ba|r");
    }

    #[test]
    fn big_word_motions() {
        check_cursor("|foo.bar", "W", "foo.ba|r");
        check_cursor("foo.bar |baz", "B", "|foo.bar baz");
    }

    #[test]
    fn cjk_word_motions() {
        // CJK ideographs are word chars; 中文 is one word.
        check_cursor("|中文 english", "w", "中文 |english");
        check_cursor("中|文 english", "w", "中文 |english");
        check_cursor("中文 |english", "e", "中文 englis|h");
        check_cursor("中文 |english", "b", "|中文 english");
    }

    #[test]
    fn f_find_on_line() {
        check_cursor("|foo bar baz", "fb", "foo |bar baz");
        check_cursor("|foo bar baz", "2fb", "foo bar |baz");
        check_cursor("|foo bar", "Fb", "|foo bar");
        check_cursor("foo b|ar", "Fb", "foo |bar");
        check_cursor("|foo bar", "tb", "foo| bar");
        check_cursor("|abcabc", "tc", "a|bcabc");
    }

    #[test]
    fn find_till_semantics() {
        // t = up to (one before the target); fails when there is no room.
        check_cursor("|aXbXc", "tX", "|aXbXc");
        // f lands on the target.
        check_cursor("|aXbXc", "fX", "a|XbXc");
    }

    #[test]
    fn semicolon_and_comma_repeat_find() {
        check_cursor("|aXbXc", "fX;", "aXb|Xc");
        check_cursor("|aXbXc", "fX;,", "a|XbXc");
        // Comma does not change the recorded direction.
        check_cursor("|aXbXcX", "fX;;", "aXbXc|X");
        check_cursor("aXbXc|", "FX;,", "aXb|Xc");
        // ; without a find: no move.
        check_cursor("|abc", ";", "|abc");
    }

    #[test]
    fn percent_bracket_matching() {
        check_cursor("|(a(b)c)", "%", "(a(b)c|)");
        check_cursor("(a(b)c|)", "%", "|(a(b)c)");
        check_cursor("|(a(b)c)", "]", "|(a(b)c)"); // not a command: no move
        check_cursor("a (b)c |d (e)f", "%", "a (b)c d (e|)f");
    }

    #[test]
    fn paragraph_motions() {
        check_cursor("|a\nb\n\n\nc", "}", "a\nb\n|\n\nc");
        check_cursor("|a\nb\n\n\nc", "}}", "a\nb\n\n|c");
        check_cursor("a\nb\n\n|c", "{", "a\nb\n|\n\nc");
        check_cursor("a\nb\n\n|c", "{{", "|a\nb\n\nc");
    }

    #[test]
    fn gg_G_and_countG() {
        check_cursor("a\nb\nc|", "gg", "|a\nb\nc");
        check_cursor("|a\nb\nc", "G", "a\nb\n|c");
        check_cursor("|a\nb\nc", "2G", "a\n|b\nc");
        check_cursor("|a\nb\nc", "10G", "a\nb\n|c");
        check_cursor("|a\nb\nc", "gg", "|a\nb\nc");
    }

    #[test]
    fn viewport_motions() {
        let mut env = Env::new("|a\nb\nc\nd\ne");
        env.viewport = Viewport {
            first_line: 1,
            last_line: 3,
        };
        env.step("H");
        assert_eq!(env.cursor, 2); // line 1 start
        let mut env = Env::new("|a\nb\nc\nd\ne");
        env.viewport = Viewport {
            first_line: 0,
            last_line: 4,
        };
        env.step("M");
        assert_eq!(env.cursor, 4); // line 2
    }

    #[test]
    fn marks_and_backtick_quote_jump() {
        let mut env = Env::new("|foo\nbar\nbaz");
        env.step("ma"); // mark a at 0
        env.step("G"); // to last line
        assert_eq!(env.cursor, 8);
        env.step("`a"); // exact jump back
        assert_eq!(env.cursor, 0);
        env.step("G");
        env.step("'a"); // line jump: first non-blank of mark's line
        assert_eq!(env.cursor, 0);
    }

    #[test]
    fn search_n_N_wrap() {
        let mut env = Env::new("|a b a b a");
        env.state.last_search = Some("b".into());
        env.step("n");
        assert_eq!(env.cursor, 2);
        env.step("n");
        assert_eq!(env.cursor, 6);
        env.step("N");
        assert_eq!(env.cursor, 2);
    }

    #[test]
    fn star_sets_search_and_jumps() {
        let mut env = Env::new("foo |bar baz bar");
        env.step("*");
        assert_eq!(env.state.last_search.as_deref(), Some("bar"));
        assert_eq!(env.cursor, 12);
    }

    #[test]
    fn enter_moves_to_next_line_first_non_blank() {
        check_cursor("a\n  b|c", "<Enter>", "a\n  |bc");
        check_cursor("|abc", "<Enter>", "|abc"); // last line: stays
    }

    #[test]
    fn space_is_l_no_wrap() {
        check_cursor("|ab", "<Space><Space>", "ab|");
        // At the last char of the line, space stops at the end-of-line slot.
        check_cursor("a|b\ncd", "<Space>", "ab|\ncd");
        // On an empty line, space cannot move.
        check_cursor("ab\n|\ncd", "<Space>", "ab\n|\ncd");
    }
}

// ---------------------------------------------------------------------------
// Operator ranges (motion composition)
// ---------------------------------------------------------------------------

mod motion_range_tests {
    use super::*;

    #[test]
    fn dw_at_last_word_stops_at_eol() {
        check_keys("foo |bar\nbaz", "dw", "foo| \nbaz");
    }

    #[test]
    fn dw_mid_line() {
        check_keys("|foo bar baz", "dw", "|bar baz");
    }

    #[test]
    fn d2w_and_2dw() {
        check_keys("|foo bar baz", "d2w", "|baz");
        check_keys("|foo bar baz", "2dw", "|baz");
        check_keys("|foo bar baz", "2d3w", "|");
    }

    #[test]
    fn cw_like_ce() {
        check_keys("foo |bar baz", "cw", "foo | baz");
        // Cursor on whitespace: cw behaves like dw.
        check_keys("foo | bar", "cw", "foo |bar");
    }

    #[test]
    fn de_deletes_including_last_char() {
        check_keys("|foo bar", "de", "| bar");
    }

    #[test]
    fn db_deletes_to_word_start() {
        check_keys("foo |bar", "db", "|bar");
    }

    #[test]
    fn d_dollar_deletes_to_line_end() {
        check_keys("foo b|ar", "d$", "foo |b");
        check_keys("foo b|ar\nbaz", "d$", "foo |b\nbaz");
    }

    #[test]
    fn d0_and_d_caret() {
        check_keys("foo b|ar", "d0", "|ar");
        check_keys("  foo b|ar", "d^", "  |ar");
    }

    #[test]
    fn dj_is_linewise_two_lines() {
        check_keys("|a\nb\nc", "dj", "|c");
    }

    #[test]
    fn dG_dgg() {
        check_keys("|a\nb\nc", "dG", "|");
        check_keys("a\nb\nc|", "dgg", "|");
    }

    #[test]
    fn d_brace_linewise_adjustment() {
        // Exclusive motion ending at col 0 of a later line with the start at
        // first-non-blank becomes linewise: deletes whole lines.
        check_keys("|a b\n\nc d", "d}", "|\nc d");
    }

    #[test]
    fn d_percent_deletes_both_brackets() {
        check_keys("x|(a)b", "d%", "x|b");
    }

    #[test]
    fn gu_motion_lowercase() {
        check_keys("|ABC DEF", "guw", "|abc DEF");
        check_keys("|ABC DEF", "gU$", "|ABC DEF");
        check_keys("|aBc", "g~~", "|AbC");
    }

    #[test]
    fn yank_with_motion_moves_cursor_to_range_start() {
        check_cursor("foo |bar", "yw", "foo |bar");
        check_cursor("|foo bar", "y$", "|foo bar");
    }

    #[test]
    fn change_motion_enters_insert() {
        check_mode("|foo bar", "cw", Mode::Insert);
        check_keys("|foo bar", "cw", "| bar");
    }
}

// ---------------------------------------------------------------------------
// Text objects
// ---------------------------------------------------------------------------

mod object_tests {
    use super::*;

    #[test]
    fn diw_inner_word() {
        check_keys("foo b|ar baz", "diw", "foo | baz");
        check_keys("|foo bar", "diw", "| bar");
    }

    #[test]
    fn daw_around_word() {
        check_keys("foo b|ar baz", "daw", "foo |baz");
        // No trailing whitespace: leading whitespace goes.
        check_keys("foo   |bar", "daw", "fo|o");
    }

    #[test]
    fn diw_on_whitespace_takes_whitespace_run() {
        check_keys("foo |  bar", "diw", "foo|bar");
    }

    #[test]
    fn diw_count_two_words() {
        check_keys("foo b|ar baz qux", "d2iw", "foo |baz qux");
    }

    #[test]
    fn iW_big_words() {
        check_keys("a.b c|d e", "diW", "a.b | e");
        check_keys("a.b |c.d e", "daW", "a.b |e");
    }

    #[test]
    fn quote_objects() {
        check_keys(r#"say "he|llo" now"#, "di\"", r#"say "|" now"#);
        check_keys(r#"say "he|llo" now"#, "da\"", r#"say |now"#);
        check_keys("'a|b' 'c'", "di'", "'|' 'c'");
        // Cursor on the opening quote.
        check_keys(r#"say |"hello""#, "di\"", r#"say "|""#);
    }

    #[test]
    fn bracket_objects_with_nesting() {
        check_keys("f(a, (b|c), d)", "di(", "f(a, (|), d)");
        check_keys("f(a, (b|c), d)", "da(", "f(a, |, d)");
        check_keys("f(|a, b)", "di(", "f(|)");
        check_keys("f(|a, b)", "da(", "|f");
        check_keys("x{a{b|}c}y", "di{", "x{a{|}c}y");
        check_keys("x[a|b]y", "da[", "x|y");
    }

    #[test]
    fn paragraph_objects() {
        check_keys("a\nb|\nc\n\nd", "dip", "|\nd");
        check_keys("a\nb|\nc\n\nd", "dap", "|d");
    }
}

// ---------------------------------------------------------------------------
// Direct ops
// ---------------------------------------------------------------------------

mod op_tests {
    use super::*;

    #[test]
    fn x_deletes_at_cursor_clamped_to_eol() {
        check_keys("|abc", "x", "|bc");
        check_keys("ab|", "x", "ab|");
        check_keys("|ab", "3x", "|");
        // x never crosses the newline.
        check_keys("|ab\ncd", "3x", "|\ncd");
    }

    #[test]
    fn big_x_deletes_before() {
        check_keys("ab|", "X", "a|");
        check_keys("abc|", "2X", "a|");
        check_keys("|ab", "X", "|ab");
    }

    #[test]
    fn s_deletes_char_and_enters_insert() {
        check_mode("|abc", "s", Mode::Insert);
        check_keys("|abc", "s", "|bc");
    }

    #[test]
    fn S_and_cc_clear_line_keeping_indent() {
        check_keys("  foo| bar", "S", "  |");
        check_mode("foo|", "S", Mode::Insert);
        check_keys("  fo|o", "cc", "  |");
    }

    #[test]
    fn dd_deletes_line() {
        check_keys("|a\nb\nc", "dd", "|b\nc");
        check_keys("a\n|b\nc", "dd", "a\n|c");
        // Last line.
        check_keys("a\nb|", "dd", "a\n|");
    }

    #[test]
    fn dd_on_single_line_empties_doc() {
        check_keys("|only", "dd", "|");
        check_cursor("|", "dd", "|");
    }

    #[test]
    fn dd_paste_linewise_roundtrip() {
        let mut env = Env::new("|a\nb");
        env.step("dd");
        assert_eq!(env.text, "b");
        env.step("p");
        assert_eq!(env.text, "b\na");
    }

    #[test]
    fn yy_yanks_linewise() {
        let mut env = Env::new("|foo\nbar");
        env.step("yy");
        // Cursor stayed put for yy.
        assert_eq!(env.cursor, 0);
        env.step("p");
        assert_eq!(env.text, "foo\nfoo\nbar");
        assert_eq!(env.cursor, 4);
    }

    #[test]
    fn yyp_roundtrip() {
        check_keys("|foo bar", "yyp", "foo bar\n|foo bar");
    }

    #[test]
    fn p_charwise_after_cursor() {
        let mut env = Env::new("|hello");
        env.step("yl"); // yank "h"
        env.step("ll");
        env.step("p");
        assert_eq!(env.text, "helhlo");
        assert_eq!(env.cursor, 3);
    }

    #[test]
    fn p_before_cursor() {
        let mut env = Env::new("|hello");
        env.step("yl");
        env.step("P");
        assert_eq!(env.text, "hhello");
    }

    #[test]
    fn p_with_count() {
        let mut env = Env::new("h|i");
        env.step("yh"); // yank "h"
        env.step("3p");
        assert_eq!(env.text, "hhhhi");
    }

    #[test]
    fn paste_from_plus_register_reads_clipboard() {
        let mut env = Env::new("|ab");
        env.clipboard = Some("CLIP".into());
        env.step("\"+p");
        assert_eq!(env.text, "aCLIPb");
    }

    #[test]
    fn named_registers_set_append_and_paste() {
        let mut env = Env::new("|aa bb cc");
        env.step("\"ayiw");
        assert_eq!(env.state.registers.read(Some('a')).unwrap().text, "aa");
        env.step("w");
        env.step("\"Ayiw");
        assert_eq!(env.state.registers.read(Some('a')).unwrap().text, "aabb");
        env.step("dd"); // empty the doc
        env.step("\"ap");
        assert_eq!(env.text, "aabb");
    }

    #[test]
    fn blackhole_register() {
        let mut env = Env::new("|foo bar");
        env.step("\"_diw");
        assert_eq!(env.text, " bar");
        assert!(env.state.registers.read(None).is_none());
        // p with an empty register is a no-op.
        env.step("p");
        assert_eq!(env.text, " bar");
    }

    #[test]
    fn J_joins_with_space() {
        check_keys("foo|\nbar", "J", "foo| bar");
    }

    #[test]
    fn J_no_space_before_paren() {
        check_keys("f(|\n)x", "J", "f(|)x");
    }

    #[test]
    fn J_count() {
        check_keys("a|\nb\nc", "3J", "a| b c");
    }

    #[test]
    fn J_keeps_existing_trailing_space() {
        // The line already ends in a space: no second space is inserted.
        check_keys("foo | \nbar", "J", "foo  |bar");
    }

    #[test]
    fn o_O_open_lines_with_indent() {
        check_mode("  fo|o", "o", Mode::Insert);
        let mut env = Env::new("  fo|o");
        env.step("o");
        assert_eq!(env.text, "  foo\n  ");
        assert_eq!(env.cursor, 8);
        let mut env = Env::new("  fo|o");
        env.step("O");
        assert_eq!(env.text, "  \n  foo");
        assert_eq!(env.cursor, 2);
    }

    #[test]
    fn i_a_I_A_placement() {
        check_cursor("|foo", "i", "|foo");
        check_cursor("|foo", "a", "f|oo");
        check_cursor("|foo", "A", "foo|");
        check_cursor("  f|oo", "I", "  |foo");
        // `a` on an empty line stays there.
        check_cursor("|\nfoo", "a", "|\nfoo");
        // `A` on an empty line: col 0.
        check_cursor("|\nfoo", "A", "|\nfoo");
    }

    #[test]
    fn tilde_toggles_case_and_advances() {
        check_keys("|aBc", "~", "A|Bc");
        check_keys("|aBc", "3~", "Ab|C");
    }

    #[test]
    fn r_replace_chars() {
        check_keys("|abc", "rx", "|xbc");
        check_keys("|abc", "3rz", "zz|z");
        // Not enough chars on the line: fails.
        check_keys("a|b", "3rz", "a|b");
        // CJK char replaced by one char.
        check_keys("|中文", "rx", "|x文");
    }

    #[test]
    fn ctrl_a_and_ctrl_x() {
        check_keys("v=|1", "<C-a>", "v=|2");
        check_keys("v=|1", "<C-x>", "v=|0");
        check_keys("|n10", "<C-a>", "n1|1");
        check_keys("|n10", "3<C-a>", "n1|3");
    }

    #[test]
    fn ctrl_a_negative_and_leading_zeros() {
        check_keys("|-5", "<C-a>", "-|4");
        check_keys("|-5", "3<C-a>", "-|2");
        check_keys("|-1", "<C-a>", "|0");
        check_keys("|08", "<C-a>", "|9");
        check_keys("|0", "<C-a>", "|1");
        // Crosses zero into negative.
        check_keys("|0", "<C-x>", "-|1");
    }

    #[test]
    fn ctrl_a_no_number_fails() {
        check_keys("|abc", "<C-a>", "|abc");
    }

    #[test]
    fn undo_redo_intents() {
        let mut env = Env::new("|abc");
        env.step("u");
        assert_eq!(env.undos, 1);
        env.step("<C-r>");
        assert_eq!(env.redos, 1);
    }

    #[test]
    fn ctrl_o_jump_list_back() {
        let mut env = Env::new("|l1\nl2\nl3");
        env.step("G"); // jump to line 2
        assert_eq!(env.cursor, 6);
        env.step("gg");
        assert_eq!(env.cursor, 0);
        env.step("<C-o>"); // back to the pre-gg position
        assert_eq!(env.cursor, 6);
    }
}

// ---------------------------------------------------------------------------
// `.` repeat
// ---------------------------------------------------------------------------

mod repeat_tests {
    use super::*;

    #[test]
    fn dot_repeats_operator_command() {
        let mut env = Env::new("|foo bar baz");
        env.step("dw");
        env.step(".");
        assert_eq!(env.text, "baz");
        env.step(".");
        assert_eq!(env.text, "");
    }

    #[test]
    fn dot_with_count_recorded() {
        // The replay deletes two words again — here the whole remainder.
        check_text("|a b c d", "2dw.", "");
    }

    #[test]
    fn dot_repeats_insert_session() {
        let mut env = Env::new("|x");
        env.step("i");
        env.type_text("ab");
        env.step("<Esc>");
        assert_eq!(env.text, "abx");
        assert_eq!(env.cursor, 1); // on the last typed char
        env.step(".");
        assert_eq!(env.text, "aabbx");
    }

    #[test]
    fn dot_noop_without_history() {
        check_keys("|abc", ".", "|abc");
    }

    #[test]
    fn escape_after_pending_aborts_and_dot_empty() {
        let mut env = Env::new("|foo bar");
        env.step("d<Esc>");
        assert_eq!(env.text, "foo bar");
        env.step(".");
        assert_eq!(env.text, "foo bar");
    }

    #[test]
    fn dot_survives_replay() {
        let mut env = Env::new("|a b c");
        env.step("dw");
        env.step(".");
        env.step(".");
        // The final dw hits the last word: deletes it whole.
        assert_eq!(env.text, "");
    }
}

// ---------------------------------------------------------------------------
// Modes and pending sequences
// ---------------------------------------------------------------------------

mod mode_tests {
    use super::*;

    #[test]
    fn enter_and_exit_insert() {
        let mut env = Env::new("|foo");
        env.step("i");
        assert_eq!(env.state.mode, Mode::Insert);
        env.step("<Esc>");
        assert_eq!(env.state.mode, Mode::Normal);
        assert_eq!(env.cursor, 0);
    }

    #[test]
    fn insert_exit_moves_cursor_left() {
        let mut env = Env::new("|ab");
        env.step("A");
        env.type_text("!");
        assert_eq!(env.cursor, 3);
        env.step("<Esc>");
        assert_eq!(env.cursor, 2);
    }

    #[test]
    fn count_insert_replay_on_escape() {
        let mut env = Env::new("|.");
        env.step("3i");
        env.type_text("ab");
        env.step("<Esc>");
        assert_eq!(env.text, "ababab.");
        assert_eq!(env.state.mode, Mode::Normal);
    }

    #[test]
    fn count_o_replay_on_escape() {
        let mut env = Env::new("  |x");
        env.step("2o");
        env.type_text("hi");
        env.step("<Esc>");
        assert_eq!(env.text, "  x\n  hi\n  hi");
    }

    #[test]
    fn replace_mode_overwrites() {
        let mut env = Env::new("|abc");
        env.step("R");
        assert_eq!(env.state.mode, Mode::Replace);
        env.step("X");
        assert_eq!(env.text, "Xbc");
        env.step("Y");
        assert_eq!(env.text, "XYc");
        env.step("<Esc>");
        assert_eq!(env.state.mode, Mode::Normal);
    }

    #[test]
    fn replace_mode_past_eol_inserts() {
        let mut env = Env::new("ab|");
        env.step("R");
        env.step("Z");
        assert_eq!(env.text, "abZ");
    }

    #[test]
    fn gi_returns_to_last_insert_exit() {
        let mut env = Env::new("|ab");
        env.step("A");
        env.type_text("c");
        env.step("<Esc>");
        env.step("gg");
        assert_eq!(env.cursor, 0);
        env.step("gi");
        assert_eq!(env.state.mode, Mode::Insert);
        assert_eq!(env.cursor, 3);
    }

    #[test]
    fn escape_clears_pending_operator() {
        let mut env = Env::new("|foo");
        env.step("d");
        env.step("<Esc>");
        assert!(env.state.pending.is_none());
        assert_eq!(env.text, "foo");
    }

    #[test]
    fn operator_then_register_prefix() {
        let mut env = Env::new("|foo bar");
        env.step("\"a");
        assert!(env.state.registers.requested.is_some());
        env.step("diw");
        assert_eq!(env.state.registers.read(Some('a')).unwrap().text, "foo");
    }
}

// ---------------------------------------------------------------------------
// Visual mode
// ---------------------------------------------------------------------------

mod visual_tests {
    use super::*;

    #[test]
    fn v_enter_escape() {
        let mut env = Env::new("|abc");
        env.step("v");
        assert_eq!(env.state.mode, Mode::Visual);
        env.step("<Esc>");
        assert_eq!(env.state.mode, Mode::Normal);
        assert_eq!(env.cursor, 0);
    }

    #[test]
    fn v_motion_extends_selection() {
        let mut env = Env::new("|abc def");
        env.step("v");
        env.step("e");
        assert_eq!(env.state.mode, Mode::Visual);
        let (anchor, head) = env.selection.unwrap();
        assert_eq!(anchor, 0);
        assert_eq!(head, 2);
    }

    #[test]
    fn viw_selects_inner_word() {
        let mut env = Env::new("foo |bar baz");
        env.step("viw");
        let (anchor, head) = env.selection.unwrap();
        assert_eq!(anchor, 4);
        assert_eq!(head, 6);
    }

    #[test]
    fn visual_d_deletes_selection() {
        check_keys("foo |bar baz", "viwd", "foo | baz");
        // Reversed selection made with motions.
        check_keys("foo bar| baz", "vhd", "foo ba|baz");
    }

    #[test]
    fn visual_yank_moves_cursor_to_start() {
        let mut env = Env::new("foo |bar baz");
        env.step("viwy");
        assert_eq!(env.state.registers.read(None).unwrap().text, "bar");
        assert_eq!(env.state.mode, Mode::Normal);
        assert_eq!(env.cursor, 4);
    }

    #[test]
    fn visual_line_d_is_linewise() {
        check_keys("a\nb|c\nd", "Vd", "a\n|d");
    }

    #[test]
    fn visual_line_yank_paste() {
        let mut env = Env::new("a\nb|c\nd");
        env.step("Vy");
        env.step("p");
        assert_eq!(env.text, "a\nbc\nbc\nd");
    }

    #[test]
    fn visual_o_swaps_ends() {
        let mut env = Env::new("|abc def");
        env.step("v");
        env.step("e");
        env.step("o");
        let (anchor, head) = env.selection.unwrap();
        assert_eq!(anchor, 2);
        assert_eq!(head, 0);
    }

    #[test]
    fn visual_u_U_case() {
        check_text("foo |bar", "viwU", "foo BAR");
        check_text("FOO |BAR", "viwu", "FOO bar");
        check_text("foo |bar", "viw~", "foo BAR");
    }

    #[test]
    fn visual_J_joins_lines() {
        let mut env = Env::new("a\n|b\nc");
        env.step("v");
        env.step("j");
        env.step("J");
        assert_eq!(env.text, "a\nb c");
    }

    #[test]
    fn visual_indent() {
        let mut env = Env::new("a\n|b\nc\nd");
        env.step("V");
        env.step("j");
        env.step("<gt>");
        assert_eq!(env.text, "a\n    b\n    c\nd");
        env.step("V");
        env.step("j");
        env.step("<lt>");
        assert_eq!(env.text, "a\nb\nc\nd");
    }

    #[test]
    fn visual_r_replaces() {
        check_text("f(o|ob)r", "vwrX", "f(oXXXr");
    }

    #[test]
    fn visual_p_replaces_with_register() {
        let mut env = Env::new("|abc def");
        env.step("yiw");
        env.step("w");
        env.step("viwp");
        assert_eq!(env.text, "abc abc");
    }

    #[test]
    fn visual_I_A_single_cursor_v1() {
        let mut env = Env::new("foo b|ar");
        env.step("viwI");
        assert_eq!(env.state.mode, Mode::Insert);
        assert_eq!(env.cursor, 4);
        let mut env = Env::new("foo b|ar");
        env.step("viwA");
        assert_eq!(env.cursor, 7);
    }

    #[test]
    fn visual_motion_w_word() {
        let mut env = Env::new("|foo bar");
        env.step("vw");
        let (_, head) = env.selection.unwrap();
        assert_eq!(head, 4);
    }

    #[test]
    fn visual_counts() {
        let mut env = Env::new("|abc def ghi");
        env.step("v3w");
        let (_, head) = env.selection.unwrap();
        assert_eq!(head, 10);
    }

    #[test]
    fn visual_V_toggles_linewise() {
        let mut env = Env::new("|abc");
        env.step("V");
        assert_eq!(env.state.mode, Mode::VisualLine);
        env.step("V");
        assert_eq!(env.state.mode, Mode::Normal);
        env.step("V");
        env.step("v");
        assert_eq!(env.state.mode, Mode::Normal);
    }
}

// ---------------------------------------------------------------------------
// Registers / marks / jumplist integration
// ---------------------------------------------------------------------------

mod integration_tests {
    use super::*;

    #[test]
    fn yank_delete_paste_full_cycle() {
        let mut env = Env::new("|the quick brown fox");
        env.step("yiw");
        env.step("w");
        env.step("dw");
        env.step("P");
        assert_eq!(env.text, "the quick brown fox");
    }

    #[test]
    fn numbered_registers_after_multiline_deletes() {
        let mut env = Env::new("|l1\nl2\nl3");
        env.step("dd");
        env.step("dd");
        assert_eq!(env.text, "l3");
        env.step("\"1p");
        assert_eq!(env.text, "l3\nl2");
        env.step("\"2p");
        assert_eq!(env.text, "l3\nl2\nl1");
    }

    #[test]
    fn small_delete_register() {
        let mut env = Env::new("|abc def");
        env.step("dw");
        assert_eq!(env.state.registers.read(Some('-')).unwrap().text, "abc ");
        env.step("P");
        assert_eq!(env.text, "abc def");
    }

    #[test]
    fn document_switch_resets_marks_but_keeps_registers() {
        let mut env = Env::new("|abc");
        env.step("ma");
        assert!(env.state.marks.get('a').is_some());
        env.state.reset_for_document();
        assert!(env.state.marks.get('a').is_none());
        env.step("yiw");
        env.state.reset_for_document();
        assert_eq!(env.state.registers.read(None).unwrap().text, "abc");
    }

    #[test]
    fn dd_on_last_line_of_short_doc() {
        // bnote jumplist semantics: short docs never panic on G/gg.
        check_keys("|a", "G", "|a");
        check_keys("|a", "gg", "|a");
        check_keys("|a\nb", "G", "a\n|b");
        check_keys("a\nb|", "gg", "|a\nb");
    }

    #[test]
    fn edit_then_jump_list_stale_entry_skipped() {
        // Entries past the (shrunken) doc end behave as null per bnote's
        // jumplist patch.
        let mut env = Env::new("|aaa\nbbb\nccc\nddd\neee");
        env.step("G"); // jump: push 0
        env.step("2G"); // jump: push 12
        // Shrink the doc below the 2G entry.
        env.text.truncate(8); // "aaa\nbbb\n"
        env.step("<C-o>");
        // Newest back-jump target (12) is stale → skipped → lands on 0.
        assert_eq!(env.cursor, 0);
    }
}


#[cfg(test)]
mod debug_probe3 {
    use super::*;

    #[test]
    fn debug_yank_cycle() {
        let mut env = Env::new("|the quick brown fox");
        env.step("yiw");
        eprintln!("yiw: unnamed={:?} yank={:?}", env.state.registers.unnamed.as_ref().map(|r| &r.text), env.state.registers.yank.as_ref().map(|r| &r.text));
        env.step("w");
        eprintln!("w: cursor={}", env.cursor);
        env.step("dw");
        eprintln!("dw: text={:?} unnamed={:?}", env.text, env.state.registers.unnamed.as_ref().map(|r| &r.text));
        env.step("P");
        eprintln!("P: text={:?}", env.text);
    }
}

