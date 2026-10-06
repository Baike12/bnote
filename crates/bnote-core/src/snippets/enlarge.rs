//! Port of `src/editor/snippets/enlarge.ts` — latex-suite's
//! `autoEnlargeBrackets`: a `\sum`/`\frac`-class "big" command inside brackets
//! upgrades `( … )` to `\left( … \right)`.
//!
//! The trigger is **not** "a bracket was typed" but "a snippet expansion or an
//! auto-fraction just happened": when the inserted text contains one of the
//! trigger words (substring match on `\` + word) the whole equation is scanned.
//!
//! * `\left(` + space and space + `\right)` are written into the equation.
//! * A pair whose contents carry no trigger word is skipped as a whole (its
//!   interior is not inspected); a pair that does advance only one character,
//!   so nested brackets each get enlarged.
//! * Pairs already wrapped in `\left…\right` are skipped.

use crate::markdown::math_scan::MathRegion;

use super::brackets::find_matching_bracket;
use super::config::LatexConfig;
use super::{Replace, next_char_start};

const LEFT: &str = "\\left";
const RIGHT: &str = "\\right";

/// The plugin's eight opening brackets (in match order: first one wins).
pub const BRACKET_PAIRS: &[(&str, &str)] = &[
    ("(", ")"),
    ("[", "]"),
    ("\\{", "\\}"),
    ("\\langle", "\\rangle"),
    ("\\lvert", "\\rvert"),
    ("\\lVert", "\\rVert"),
    ("\\lceil", "\\rceil"),
    ("\\lfloor", "\\rfloor"),
];

/// Pure function: the pairs to enlarge inside the equation text `[start, end)`,
/// as insertion edits (absolute coordinates, in scan order). Empty when there
/// is nothing to do.
pub fn enlarge_bracket_edits(
    text: &str,
    start: usize,
    end: usize,
    triggers: &[String],
) -> Vec<Replace> {
    let mut out: Vec<Replace> = Vec::new();
    let mut i = start;
    while i < end {
        let Some((open, close)) = BRACKET_PAIRS.iter().find(|(o, _)| text[i..].starts_with(o)) else {
            i = next_char_start(text, i).unwrap_or(text.len());
            continue;
        };
        let Some(j) = find_matching_bracket(text, i, open, close, false, end) else {
            i = next_char_start(text, i).unwrap_or(text.len());
            continue;
        };
        let already_enlarged = i >= LEFT.len()
            && &text[i - LEFT.len()..i] == LEFT
            && j >= RIGHT.len()
            && &text[j - RIGHT.len()..j] == RIGHT;
        if already_enlarged {
            i = next_char_start(text, i).unwrap_or(text.len());
            continue;
        }
        let contents = &text[i + 1..j];
        if !triggers.iter().any(|word| contents.contains(&format!("\\{}", word))) {
            i = next_char_start(text, j).unwrap_or(text.len()); // skip the whole pair
            continue;
        }
        out.push(Replace::new(i, i + open.len(), format!("{}{} ", LEFT, open)));
        out.push(Replace::new(j, j + open.len(), format!(" {}{}", RIGHT, close)));
        i = next_char_start(text, i).unwrap_or(text.len());
    }
    out
}

/// Port of `src/editor/snippets/enlarge.ts::autoEnlargeBrackets`: runs after an
/// expansion with the freshly inserted text; `None` = the document is untouched.
pub fn auto_enlarge_edits(
    doc: &str,
    head: usize,
    inserted: &str,
    config: &LatexConfig,
    math: &[MathRegion],
) -> Option<Vec<Replace>> {
    if !config.auto_enlarge_brackets {
        return None;
    }
    if !config
        .auto_enlarge_triggers
        .iter()
        .any(|word| inserted.contains(&format!("\\{}", word)))
    {
        return None;
    }
    let region = math.iter().find(|r| head >= r.from && head <= r.to)?;
    let edits = enlarge_bracket_edits(doc, region.from, region.to, &config.auto_enlarge_triggers);
    if edits.is_empty() {
        return None;
    }
    Some(edits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::math_scan::scan_math;
    use crate::snippets::apply_replaces;
    use crate::snippets::config::LatexConfig;

    fn triggers() -> Vec<String> {
        LatexConfig::default().auto_enlarge_triggers
    }

    fn run(doc: &str) -> Vec<Replace> {
        enlarge_bracket_edits(doc, 0, doc.len(), &triggers())
    }

    fn inserts(doc: &str) -> Vec<String> {
        run(doc).into_iter().map(|r| r.insert).collect()
    }

    /// `enlargeBracketEdits:括号里有大个子就升级成 \left…\right`.
    #[test]
    fn paren_with_sum_gets_left_right_and_spaces() {
        assert_eq!(
            run("(\\sum_{i} x)"),
            vec![
                Replace::new(0, 1, "\\left( "),
                Replace::new(11, 12, " \\right)"),
            ]
        );
    }

    #[test]
    fn contents_without_a_trigger_word_are_untouched() {
        assert!(run("(x + y)").is_empty());
    }

    #[test]
    fn already_enlarged_pairs_are_skipped() {
        assert!(run("\\left(\\sum x\\right)").is_empty());
    }

    #[test]
    fn nested_pairs_are_each_enlarged() {
        assert_eq!(
            inserts("((\\sum x))"),
            vec!["\\left( ", " \\right)", "\\left( ", " \\right)"]
        );
    }

    #[test]
    fn square_and_escaped_curly_brackets_are_enlarged_too() {
        assert_eq!(inserts("[\\int x]"), vec!["\\left[ ", " \\right]"]);
        assert_eq!(inserts("\\{\\sum\\}"), vec!["\\left\\{ ", " \\right\\}"]);
    }

    #[test]
    fn multi_character_brackets_are_recognized() {
        assert_eq!(
            inserts("\\langle \\sum \\rangle"),
            vec!["\\left\\langle ", " \\right\\rangle"]
        );
    }

    #[test]
    fn an_unpaired_opener_is_left_alone() {
        assert!(run("(\\sum x").is_empty());
    }

    #[test]
    fn the_trigger_word_is_a_substring_match() {
        // `\internal` contains `\int` — the plugin enlarges too.
        assert_eq!(inserts("(\\internal)"), vec!["\\left( ", " \\right)"]);
    }

    /// `autoEnlargeBrackets:展开之后才跑,且只认本次插入的文本`.
    #[test]
    fn inserting_frac_upgrades_the_enclosing_paren() {
        let doc = "$(\\frac{a}{b})$";
        let math = scan_math(doc);
        let edits = auto_enlarge_edits(doc, 2, "\\frac{a}{b}", &LatexConfig::default(), &math).unwrap();
        assert_eq!(apply_replaces(doc, &edits), "$\\left( \\frac{a}{b} \\right)$");
    }

    #[test]
    fn inserted_text_without_a_trigger_word_changes_nothing() {
        let doc = "$(\\sum x)$";
        let math = scan_math(doc);
        assert!(auto_enlarge_edits(doc, 2, "\\alpha", &LatexConfig::default(), &math).is_none());
    }

    #[test]
    fn switched_off_means_nothing_runs() {
        let mut config = LatexConfig::default();
        config.auto_enlarge_brackets = false;
        let doc = "$(\\frac{a}{b})$";
        let math = scan_math(doc);
        assert!(auto_enlarge_edits(doc, 2, "\\frac{a}{b}", &config, &math).is_none());
    }

    #[test]
    fn a_cursor_outside_math_changes_nothing() {
        let doc = "正文\n\n$(\\frac{a}{b})$";
        let math = scan_math(doc);
        assert!(auto_enlarge_edits(doc, 0, "\\frac", &LatexConfig::default(), &math).is_none());
    }
}
