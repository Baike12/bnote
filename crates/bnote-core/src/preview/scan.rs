//! The rule engine: `(text, selections, visible window) → PreviewSnapshot`.
//!
//! Ported from the Tauri shell's `src/editor/livePreview.ts` (+ `widgets.ts`,
//! `callout.ts`, `mathScan.ts`, `numbering.ts`). See [`super`] for the data
//! model, the activity rule and the invariants this upholds.
//!
//! Rule → function map (TS line numbers refer to `livePreview.ts`):
//!
//! | rule | here | TS |
//! |---|---|---|
//! | activity rule | [`geom::Activity`] | `active` 242/415, `selectionAffectsDecos` 115 |
//! | block statics | [`blocks::Statics::collect`] | `collectBlockStatics` 170 |
//! | fence lines / `CodeLang` | [`scan`] (fence loop) | 255-267 |
//! | callout edges | [`scan`] (callout loop) | 268-290 |
//! | horizontal rule | [`scan`] (HR loop) | 291-301 |
//! | display math blocks | [`scan`] (math loop) | 302-337 |
//! | ATX headings | [`scan`] per-line + [`blocks::atx_heading`] | `decorateHeading` 807 (open prefix only) |
//! | setext underline | [`scan`] per-line + `decorateSetextDash` | 739-769 |
//! | list marks / indent | [`scan`] per-line | `decorateListMark` 780, 530-556 |
//! | task markers | [`scan`] per-line | 557-578 |
//! | inline code | [`inline::Inline::scan`] | `decorateInlineCode` 865 |
//! | emphasis/strong/strike | [`inline::emphasis`] | `decorateEmphasis` 840 |
//! | links / autolinks | [`inline::Inline::scan`] (exclusion only) | `decorateLink` 1075: marks, no span |
//! | images | [`inline::Inline::scan`] | `decorateImage` 1027 |
//! | wikilinks | [`inline::scan_wikilinks`] | `decorateWikiLinks` 1093 |
//! | blockquote `>` | context only, no span | `decorateBlockquote` 913: line class, no replace |
//! | math widgets | [`inline::Inline::scan`] | 608-638 |
//! | visible window | [`geom::Window`] | `buildInlineDecorations` 406 |

mod blocks;
mod geom;
mod inline;

use crate::preview::{BlockKind, PreviewSnapshot, ScanInput, Widget};

use blocks::{ListKind, Statics};
use geom::{line_of, Activity, Sink, Window};

/// Compute the preview for `input`.
pub fn scan(input: ScanInput<'_>) -> PreviewSnapshot {
    let statics = Statics::collect(input.text);
    let lines = &statics.lines;
    let win = Window::new(lines, &input.visible);
    let act = Activity::new(input.selections);
    let mut sink = Sink::new(lines, win, act, 64);

    // Block-level replacements, in the TS order (`buildBlockDecos`): fence
    // lines, callout edges, rules, display maths.
    emit_fence_lines(&statics, &act, &mut sink);
    emit_callout_edges(&statics, &act, &mut sink);
    emit_rules(&statics, &act, &mut sink);
    emit_math_blocks(&statics, &act, &mut sink);

    let inline = inline::Inline {
        text: input.text,
        math: &statics.math,
        math_inline: &statics.math_inline,
        code_ranges: &statics.code_ranges,
    };
    for n in win.lines() {
        scan_line(input.text, &statics, n, &inline, &act, &mut sink);
    }

    sink.finish()
}

/// Fence lines of fenced-code blocks: hidden (or replaced by the language
/// chip) only while the caret is outside the whole block (TS 255-267).
fn emit_fence_lines(statics: &Statics, act: &Activity, sink: &mut Sink) {
    for fence in &statics.fences {
        if act.touches(fence.from, fence.to) {
            continue;
        }
        let (open_from, open_to) = statics.lines[fence.open_line];
        match &fence.lang {
            Some(lang) => {
                sink.widget(open_from, open_to, Widget::CodeLang { lang: lang.clone() });
            }
            None => {
                sink.hide(open_from, open_to);
            }
        }
        if let Some(close) = fence.close_line {
            let (close_from, close_to) = statics.lines[close];
            sink.hide(close_from, close_to);
        }
    }
}

/// Callout edge lines: one single-line block per edge while the caret is
/// outside the whole region (TS 268-290). The opening block carries the
/// title and the body range; the closing block is the untitled edge.
fn emit_callout_edges(statics: &Statics, act: &Activity, sink: &mut Sink) {
    for region in &statics.callouts {
        if act.touches(region.from, region.to) {
            continue;
        }
        let body_first_line = region.open_line; // 0-based line after the opening edge
        let body_last_line = if region.closed {
            region.close_line.saturating_sub(2)
        } else {
            region.close_line.saturating_sub(1)
        };
        sink.block(
            region.open_line.saturating_sub(1),
            region.open_line.saturating_sub(1),
            BlockKind::Callout {
                kind: String::new(),
                title: region.title.clone(),
                body_first_line,
                body_last_line,
            },
        );
        if region.closed {
            sink.block(
                region.close_line.saturating_sub(1),
                region.close_line.saturating_sub(1),
                BlockKind::Callout {
                    kind: String::new(),
                    title: String::new(),
                    body_first_line,
                    body_last_line,
                },
            );
        }
    }
}

/// Horizontal rules: the line's text becomes `Widget::Rule` (TS 291-301).
/// The TS uses a block replace; the model has no `BlockKind::Rule`, so the
/// rule is a span covering the whole node range (see the port report).
fn emit_rules(statics: &Statics, act: &Activity, sink: &mut Sink) {
    for info in &statics.info {
        if let Some((from, to)) = info.hr {
            if act.inactive(from, to) {
                sink.widget(from, to, Widget::Rule);
            }
        }
    }
}

/// Multi-line display maths: one `PreviewBlock` per region while the caret is
/// outside it (TS 302-337; the caret-inside live preview widget is not
/// ported — source stays visible).
fn emit_math_blocks(statics: &Statics, act: &Activity, sink: &mut Sink) {
    for &i in &statics.math_blocks {
        let region = &statics.math[i];
        let first = line_of(&statics.lines, region.from);
        let last = line_of(&statics.lines, region.to.saturating_sub(1));
        if act.touches(region.from, region.to) {
            continue;
        }
        sink.block(
            first,
            last,
            BlockKind::Math {
                tex: region.content.clone(),
                display: true,
            },
        );
    }
}

/// One line's line-level rules, in the TS emission order: list indentation
/// and marks, heading prefix, setext dash, inline content, wikilinks.
/// Blockquote prefixes are parsed only as container context — the TS
/// `decorateBlockquote` (913-928) adds a line class and never hides `>`, so
/// this port emits no span for them.
fn scan_line(
    text: &str,
    statics: &Statics,
    n: usize,
    inline: &inline::Inline<'_>,
    act: &Activity,
    sink: &mut Sink,
) {
    let info = &statics.info[n];
    if info.skip.is_some() {
        return;
    }
    let (from, to) = statics.lines[n];
    if from >= to {
        return;
    }

    // Blockquote prefixes are context only: `decorateBlockquote`
    // (livePreview.ts:913-928) pushes a `md-quote` line decoration on inactive
    // lines and never hides the `>` — the class is not expressible here, and
    // hiding the marker would change bnote's rendering, so no span is emitted.

    if let Some(list) = &info.list {
        // Leading indentation is hidden on every line, active or not — the
        // layout must not shift when the caret enters or leaves (TS 530-544).
        let spaces = list.mark.0.saturating_sub(info.base);
        if spaces > 0 {
            sink.hide(info.base, list.mark.0);
        }
        match &list.kind {
            ListKind::Ordered => {
                // Ordered markers stay visible (the TS adds a dimming class).
            }
            ListKind::Bullet => {
                if act.inactive(list.mark.0, list.mark.1) {
                    let ws_to = blocks::whitespace_end(text, list.mark.1, to);
                    let end = if act.keep_marker_trailing_space(from, to, ws_to) {
                        list.mark.1
                    } else {
                        ws_to
                    };
                    sink.widget(list.mark.0, end, Widget::Bullet);
                }
            }
            ListKind::Task {
                checked,
                task,
                trailing,
            } => {
                // The marker plus the gap before the checkbox is swallowed
                // whole (TS `decorateListMark`, `li-t`).
                if act.inactive(list.mark.0, list.mark.1) {
                    let ws_to = blocks::whitespace_end(text, list.mark.1, to);
                    sink.hide(list.mark.0, ws_to);
                }
                if act.inactive(task.0, task.1) {
                    let end = if act.keep_marker_trailing_space(from, to, *trailing) {
                        task.1
                    } else {
                        *trailing
                    };
                    sink.widget(task.0, end, Widget::Checkbox { checked: *checked });
                }
            }
        }
    }

    if let Some(heading) = &info.heading {
        // Line-level activity: the caret line shows the raw `#`s.
        // `decorateHeading` (livePreview.ts:807-838) hides the *first*
        // `HeaderMark` plus the spaces after it (`mark.from..contentFrom`)
        // and nothing else — a trailing closing `#` run stays visible (it is
        // covered by the `md-heading` mark, not by a replace).
        if act.inactive(from, to) {
            sink.hide(heading.prefix.0, heading.prefix.1);
        }
    }

    if let Some(setext) = &info.setext_dash {
        // Only a dash-only underline whose whitespace reaches the line end
        // (TS `decorateSetextDash`); the mark's own range is the activity
        // range, the trailing space stays as the caret anchor.
        if setext.ws_to == to && act.inactive(setext.mark.0, setext.mark.1) {
            let end = if act.keep_marker_trailing_space(from, to, setext.ws_to) {
                setext.mark.1
            } else {
                setext.ws_to
            };
            sink.widget(setext.mark.0, end, Widget::Bullet);
        }
    }

    if info.hr.is_none() && info.setext_dash.is_none() {
        inline.scan(info.content_from, to, act, sink);
    }
    inline::scan_wikilinks(text, from, to, act, sink);
}

#[cfg(test)]
mod tests;
