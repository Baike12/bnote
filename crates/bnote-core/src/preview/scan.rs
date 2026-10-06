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
//! | fence lines (collapse to zero height) | [`scan`] (fence loop) | 255-267 |
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

use crate::markdown::callout::CalloutRegion;
use crate::preview::{BlockKind, PanelKind, PreviewSnapshot, ScanInput, SpanStyle, Widget};

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
    // lines, callout edges, rules, display maths. The callout *panels* are a
    // line-range look, not a replacement, and are emitted first: they are not
    // caret-gated and must not be lost to a block's refusal.
    emit_callout_panels(&statics, &mut sink);
    emit_style_panels(&statics, &act, &mut sink);
    emit_fence_lines(&statics, &act, &mut sink);
    emit_callout_edges(&statics, &act, &mut sink);
    emit_rules(&statics, &act, &mut sink);
    emit_math_blocks(&statics, &act, &mut sink, input.math_preview);
    emit_math_source_styles(input.text, &statics, &act, &mut sink);

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

/// Fenced-code body lines and blockquote lines get their container look from
/// panels (TS `md-code-line` / `md-quote`):
///
/// - a code body is styled only while the caret is **outside** the whole
///   block (TS calls `decorateFencedCodeLines` under `!active(node)`), so the
///   panel covers `open + 1 ..= close - 1` (or to the end when unclosed);
/// - a quote line is styled only while it is **inactive** (TS checks the line
///   against the selections), so a region is emitted as maximal runs of
///   consecutive styled lines at the same nesting depth.
fn emit_style_panels(statics: &Statics, act: &Activity, sink: &mut Sink) {
    let last_line = statics.lines.len().saturating_sub(1);
    for fence in &statics.fences {
        if act.touches(fence.from, fence.to) {
            continue;
        }
        let first = fence.open_line + 1;
        let last = fence
            .close_line
            .map(|close| close.saturating_sub(1))
            .unwrap_or(last_line);
        if first <= last {
            sink.panel(first, last, PanelKind::CodeBlock);
        }
    }

    // Quote runs: one panel per maximal run of quoted, inactive lines.
    let mut run: Option<(usize, usize)> = None; // (first, last)
    for n in 0..=last_line {
        let (line_from, line_to) = statics.lines[n];
        let styled = !statics.info[n].quotes.is_empty() && !act.line_active(line_from, line_to);
        match (styled, run) {
            (true, Some((first, _))) => run = Some((first, n)),
            (true, None) => run = Some((n, n)),
            (false, Some((first, last))) => {
                sink.panel(first, last, PanelKind::Blockquote);
                run = None;
            }
            (false, None) => {}
        }
    }
    if let Some((first, last)) = run {
        sink.panel(first, last, PanelKind::Blockquote);
    }
}

/// Fence lines of fenced-code blocks: the whole line is **removed** (not just
/// emptied) while the caret is outside the whole block, so it takes zero
/// height (TS 255-267: `HiddenLineWidget`, `block: true`; the TS shell's
/// `cw-hidden-line` is `height: 0`). The code body stays source and editable.
fn emit_fence_lines(statics: &Statics, act: &Activity, sink: &mut Sink) {
    for fence in &statics.fences {
        if act.touches(fence.from, fence.to) {
            continue;
        }
        sink.block(fence.open_line, fence.open_line, BlockKind::HiddenLine);
        if let Some(close) = fence.close_line {
            sink.block(close, close, BlockKind::HiddenLine);
        }
    }
}

/// Callout panels: every region's per-line container look — background, left
/// border, nesting depth — emitted for all lines edge-to-edge (TS 577-604).
/// The caret does **not** gate this: the TS emits the line classes
/// unconditionally so that pure cursor movement never rebuilds the region.
///
/// The panel and the edges are complementary: the panel styles the lines, the
/// edge blocks replace the `:::` lines themselves (a block replace removes the
/// line element, which is why the edge widget carries the panel face for its
/// own line — see [`super::BlockKind::Callout`]).
fn emit_callout_panels(statics: &Statics, sink: &mut Sink) {
    let last_line = statics.lines.len().saturating_sub(1);
    for region in &statics.callouts {
        let open = region.open_line.saturating_sub(1);
        let close = region.close_line.saturating_sub(1);
        sink.panel(
            open,
            close.min(last_line),
            PanelKind::Callout {
                depth: region.depth.min(u8::MAX as usize) as u8,
                open_line: open,
                close_line: region.closed.then_some(close),
            },
        );
    }
}

/// The raw maths source keeps syntax colouring while the caret edits the
/// region (TS `highlightMathSource`, livePreview.ts:663-681): `$$`
/// delimiters purple, `\cmd`s red, braces and structure chars orange. The TS
/// runs this in its inline pass for every region the caret touches — inline,
/// single-line display, and a multi-line block being edited — before the
/// block field takes over the inactive ones. Regions inside fenced code are
/// skipped, like every other maths rule.
fn emit_math_source_styles(text: &str, statics: &Statics, act: &Activity, sink: &mut Sink) {
    for region in &statics.math {
        if !act.touches(region.from, region.to) {
            continue;
        }
        if statics
            .code_ranges
            .iter()
            .any(|range| range.0 < region.to && range.1 > region.from)
        {
            continue;
        }
        let source = &text[region.from..region.to];
        // The TS bails out of a region longer than 20 000 chars.
        if source.len() > 20_000 {
            continue;
        }
        let bytes = source.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            let (style, len) = match bytes[i] {
                // `(\$\$)` — only a doubled delimiter is highlighted; a lone
                // `$` matches nothing in the TS regex.
                b'$' if bytes.get(i + 1) == Some(&b'$') => (SpanStyle::MathDelim, 2),
                // `(\\[a-zA-Z]+|\\.)` — a command name or an escaped char.
                b'\\' => {
                    let mut j = i + 1;
                    if bytes.get(j).is_some_and(u8::is_ascii_alphabetic) {
                        while bytes.get(j).is_some_and(u8::is_ascii_alphabetic) {
                            j += 1;
                        }
                    } else if j < bytes.len() {
                        j += 1;
                    } else {
                        // A trailing backslash matches neither alternative.
                        i += 1;
                        continue;
                    }
                    (SpanStyle::MathCmd, j - i)
                }
                // `([{}[\]^_&~])` — braces and structure characters.
                b'{' | b'}' | b'[' | b']' | b'^' | b'_' | b'&' | b'~' => {
                    (SpanStyle::MathBrace, 1)
                }
                _ => {
                    i += 1;
                    continue;
                }
            };
            sink.style(region.from + i, region.from + i + len, style);
            i += len;
        }
    }
}

/// Callout edge lines: one single-line block per edge while the caret is
/// outside the whole region (TS 268-290). The opening block carries the title
/// (empty for an untitled block); the closing block is the untitled edge.
fn emit_callout_edges(statics: &Statics, act: &Activity, sink: &mut Sink) {
    for region in &statics.callouts {
        if act.touches(region.from, region.to) {
            continue;
        }
        sink.block(
            region.open_line.saturating_sub(1),
            region.open_line.saturating_sub(1),
            BlockKind::Callout {
                title: region.title.clone(),
                depth: region.depth,
                open: true,
            },
        );
        if region.closed {
            sink.block(
                region.close_line.saturating_sub(1),
                region.close_line.saturating_sub(1),
                BlockKind::Callout {
                    title: String::new(),
                    depth: region.depth,
                    open: false,
                },
            );
        }
    }
}

/// The callout nesting depth for `pos`, `None` outside every region. Port of
/// the TS `calloutDepthAt` (`livePreview.ts:246-249`, -1 outside): it scans
/// the regions in `from` order and takes the **first** match, so a position
/// nested in two regions reports the **outermost** depth — a single-depth
/// block face cannot express nesting anyway; the inner face comes from the
/// panels, which are emitted per region.
fn callout_depth_at(callouts: &[CalloutRegion], pos: usize) -> Option<usize> {
    callouts
        .iter()
        .find(|c| pos >= c.from && pos <= c.to)
        .map(|c| c.depth)
}

/// Horizontal rules: the whole line is replaced by a rule element (TS 291-301,
/// `HrWidget` with `block: true`). The rule carries the callout face for its
/// own line, like the math blocks.
fn emit_rules(statics: &Statics, act: &Activity, sink: &mut Sink) {
    for info in &statics.info {
        if let Some((from, to)) = info.hr {
            if act.inactive(from, to) {
                let line = line_of(&statics.lines, from);
                let depth = callout_depth_at(&statics.callouts, from);
                sink.block(line, line, BlockKind::Rule { depth });
            }
        }
    }
}

/// Multi-line display maths (TS 302-337):
///
/// - caret outside → one replacement `PreviewBlock` for the whole region;
/// - caret inside → the source stays (nothing is hidden), and when the
///   `mathPreview` setting is on and the block has content, a **live-rendered
///   copy is inserted right below it** (the TS `MathPreviewWidget`). The
///   insertion is anchored at the start of the line after the region — or at
///   the very end of the document when the region is the last one, which is
///   the `at_line == line count` boundary case of [`Sink::insert`].
fn emit_math_blocks(statics: &Statics, act: &Activity, sink: &mut Sink, math_preview: bool) {
    for &i in &statics.math_blocks {
        let region = &statics.math[i];
        let first = line_of(&statics.lines, region.from);
        let last = line_of(&statics.lines, region.to.saturating_sub(1));
        let depth = callout_depth_at(&statics.callouts, region.from);
        if act.touches(region.from, region.to) {
            if math_preview && !region.content.trim().is_empty() {
                let anchor = if last + 1 < statics.lines.len() {
                    last + 1
                } else {
                    statics.lines.len()
                };
                sink.insert(
                    anchor,
                    BlockKind::MathPreview {
                        tex: region.content.clone(),
                        depth,
                    },
                );
            }
            continue;
        }
        sink.block(
            first,
            last,
            BlockKind::Math {
                tex: region.content.clone(),
                depth,
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
                // Ordered markers stay visible, dimmed (TS `md-listmark`,
                // livePreview.ts:794-796).
                sink.style(list.mark.0, list.mark.1, SpanStyle::ListMark);
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
        } else {
            // Raw `#` markers on the caret line, dimmed like Obsidian's
            // formatting (TS `md-hmark`).
            sink.style(heading.prefix.0, heading.prefix.1, SpanStyle::HeadingMark);
        }
        // The heading's content carries `md-heading md-h{level}` whatever the
        // activity — "Heading colors apply on the active line too; only the
        // hash hiding is lifted there". The TS range is
        // `contentFrom..node.to` (the ATXHeading node ends at the line's last
        // non-space byte; a closing `#` run is part of it).
        let content_to = text[..to].trim_end().len();
        sink.style(
            heading.content_from,
            content_to,
            SpanStyle::Heading {
                level: heading.level,
            },
        );
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
