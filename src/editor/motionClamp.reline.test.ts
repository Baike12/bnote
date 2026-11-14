import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import type { EditorView } from "@codemirror/view";
import { blockDecorationsField } from "./livePreview";
import { columnOnLine, installMathMotionClamp, pixelGoalOf } from "./motionClamp";

/**
 * The motion clamp wraps `view.moveVertically`: CM6 resolves vertical motion
 * from pixels and skips non-text blocks, so one plain j/arrow press leaps
 * clean over a collapsed display-math widget. The wrapper re-derives a
 * single-step, empty-range motion that spanned two or more document lines,
 * walking the intermediate lines as visible steps. Page-style jumps (an
 * explicit distance), non-empty ranges (visual mode) and horizontal motions
 * are explicitly left alone.
 *
 * The geometry here is deterministic (8px per character, 24px rows, content
 * left at 100px); what is locked is the decision flow, not browser pixels.
 *
 * Line numbers (1-based):
 *  1 above
 *  2 $$          ← opening marker
 *  3 x = 1
 *  4 $$          ← closing marker
 *  5 mid
 *  6 (blank)
 *  7 ---         ← horizontal rule
 *  8 (blank)
 *  9 after
 */
const DOC = ["above", "$$", "x = 1", "$$", "mid", "", "---", "", "after"].join("\n");
const CHAR_W = 8;
const ROW_H = 24;
const CONTENT_LEFT = 100;

function makeState(doc: string): EditorState {
  const created = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM] }), blockDecorationsField],
  });
  ensureSyntaxTree(created, created.doc.length, 10_000);
  return created.update({}).state;
}

/**
 * A fake view whose `moveVertically` mimics the real CM6 scan: it jumps
 * `skipLines` document lines without knowing about collapsed blocks (that
 * blindness is exactly what the clamp exists for).
 */
function makeView(state: EditorState, skipLines: number) {
  const view = {
    state,
    defaultCharacterWidth: CHAR_W,
    contentDOM: { getBoundingClientRect: () => ({ left: CONTENT_LEFT }) },
    coordsAtPos: (pos: number) => {
      const line = state.doc.lineAt(pos);
      const top = (line.number - 1) * ROW_H;
      return {
        left: CONTENT_LEFT + (pos - line.from) * CHAR_W,
        top: top + 2,
        bottom: top + ROW_H - 2,
      };
    },
    posAtCoords: ({ x, y }: { x: number; y: number }) => {
      const n = Math.min(state.doc.lines, Math.max(1, Math.floor(y / ROW_H) + 1));
      const line = state.doc.line(n);
      const col = Math.round((x - CONTENT_LEFT) / CHAR_W);
      return Math.min(line.to, line.from + Math.max(0, col));
    },
    moveVertically: (start: { head: number }) => {
      const lineNo = state.doc.lineAt(start.head).number;
      const target = Math.min(state.doc.lines, Math.max(1, lineNo + skipLines));
      return EditorSelection.cursor(state.doc.line(target).from);
    },
  };
  return view as unknown as EditorView;
}

/** Installs the clamp on a view whose caret starts on `lineNo`. */
function moveFrom(lineNo: number, skipLines: number, distance?: number) {
  const base = makeState(DOC);
  const state = base.update({
    selection: EditorSelection.cursor(base.doc.line(lineNo).from),
  }).state;
  const view = makeView(state, skipLines);
  installMathMotionClamp(view);
  const start = view.state.selection.main;
  const result =
    distance === undefined
      ? view.moveVertically(start, skipLines > 0)
      : view.moveVertically(start, skipLines > 0, distance);
  return { state: view.state, line: view.state.doc.lineAt(result.head).number, result };
}

describe("installMathMotionClamp: one vertical step lands on the near visible edge", () => {
  it("a motion that jumped past the whole block is pulled back to the opening marker line", () => {
    // line 1 → line 6 would cross the collapsed block AND "mid".
    expect(moveFrom(1, 5).line).toBe(2);
  });

  it("walking upward across the block lands on the closing marker", () => {
    // line 5 → line 2: the walk meets the block's closing line first.
    expect(moveFrom(5, -3).line).toBe(4);
  });

  it("a hidden line inside the walk is skipped, but the first visible line is the step", () => {
    // line 5 → line 9 crosses the `---` rule; the walk stops at the blank line
    // before it, which is the one visible step upward from the rule.
    expect(moveFrom(5, 4).line).toBe(6);
  });

  it("a jump that would stop on the horizontal rule lands past it", () => {
    // line 5 → line 7 (the `---` line): its rendered form hides the line, so
    // the step ends on the blank line before it instead of on the rule.
    expect(moveFrom(5, 2).line).toBe(6);
  });

  it("a motion that does not cross a hidden line keeps the CM6 result", () => {
    // line 6 → line 7 is one line: the ordinary single-step case.
    expect(moveFrom(6, 1).line).toBe(7);
  });

  it("a one-line step is always returned untouched (the ordinary arrow case)", () => {
    expect(moveFrom(1, 1).line).toBe(2);
    expect(moveFrom(3, 1).line).toBe(4);
  });

  it("with the caret inside the block its source lines are plain steps, not hidden ones", () => {
    // The caret rests on the `x = 1` line: the region is being edited, so one
    // visible step is the closing marker line, not the whole block.
    const base = makeState(DOC);
    const state = base.update({
      selection: EditorSelection.cursor(base.doc.line(3).from),
    }).state;
    const view = makeView(state, 2);
    installMathMotionClamp(view);
    const result = view.moveVertically(view.state.selection.main, true);
    expect(view.state.doc.lineAt(result.head).number).toBe(4);
  });

  it("a page-style jump (an explicit pixel distance) is left alone", () => {
    expect(moveFrom(1, 5, 200).line).toBe(6);
  });

  it("a non-empty result range (visual mode) is left alone", () => {
    const base = makeState(DOC);
    const state = base.update({
      selection: EditorSelection.range(base.doc.line(1).from, base.doc.line(1).from + 2),
    }).state;
    const view = makeView(state, 5);
    installMathMotionClamp(view);
    const result = view.moveVertically(view.state.selection.main, true);
    expect(view.state.doc.lineAt(result.head).number).toBe(6);
  });

  it("a non-empty starting range is left alone (the clamp only re-derives a caret motion)", () => {
    const base = makeState(DOC);
    const state = base.update({
      selection: EditorSelection.range(base.doc.line(1).from, base.doc.line(1).from + 1),
    }).state;
    const view = makeView(state, 5);
    installMathMotionClamp(view);
    const result = view.moveVertically(view.state.selection.main, true);
    expect(view.state.doc.lineAt(result.head).number).toBe(6);
  });

  it("the result's goal column decides the landing column on the edge line", () => {
    // `$$` is 2 characters wide; a 24px goal resolves to column 3, clamped to
    // the line length.
    const base = makeState(DOC);
    const state = base.update({
      selection: EditorSelection.cursor(base.doc.line(1).from),
    }).state;
    const view = {
      ...makeView(state, 5),
      moveVertically: () => EditorSelection.cursor(state.doc.line(6).from, 1, undefined, 24),
    } as unknown as EditorView;
    installMathMotionClamp(view);
    const landed = view.moveVertically(view.state.selection.main, true);
    expect(view.state.doc.lineAt(landed.head).number).toBe(2);
    expect(landed.head).toBe(state.doc.line(2).to);
  });
});

describe("pixelGoalOf: the visual x the vertical motions anchor on", () => {
  it("returns the caret x relative to the content box", () => {
    const state = makeState("abc");
    const view = makeView(state, 1);
    // Two characters in: 2 * 8px from the content edge.
    expect(pixelGoalOf(view, 2)).toBe(16);
  });

  it("an explicit contentLeft is used instead of reading the DOM again", () => {
    const state = makeState("abc");
    const view = makeView(state, 1);
    // rect.left is 100 + 2*8 = 116; the caller's stale measurement wins.
    expect(pixelGoalOf(view, 2, 200)).toBe(116 - 200);
  });

  it("a position with no rectangle falls back to x = 0", () => {
    const state = makeState("abc");
    const view = { ...makeView(state, 1), coordsAtPos: () => null } as unknown as EditorView;
    expect(pixelGoalOf(view, 1)).toBe(0);
  });
});

describe("columnOnLine: precise when drawn, estimated when off-screen", () => {
  const state = makeState("abcdef\nxy");

  it("a drawn line resolves the column nearest the goal through posAtCoords", () => {
    const view = makeView(state, 1);
    expect(columnOnLine(view, state.doc.line(1), 24)).toBe(3);
  });

  it("an undrawable line estimates from the average character width", () => {
    const view = { ...makeView(state, 1), coordsAtPos: () => null } as unknown as EditorView;
    expect(columnOnLine(view, state.doc.line(1), 24)).toBe(3);
  });

  it("the estimate is clamped to the line length", () => {
    const view = { ...makeView(state, 1), coordsAtPos: () => null } as unknown as EditorView;
    expect(columnOnLine(view, state.doc.line(2), 10_000)).toBe(2);
  });

  it("a negative goal clamps to column 0", () => {
    const view = { ...makeView(state, 1), coordsAtPos: () => null } as unknown as EditorView;
    expect(columnOnLine(view, state.doc.line(1), -50)).toBe(0);
  });

  it("a posAtCoords hit on a different line is discarded and the estimate is used", () => {
    const view = {
      ...makeView(state, 1),
      coordsAtPos: (pos: number) => ({ left: pos, top: 0, bottom: 10 }),
      posAtCoords: () => state.doc.line(2).from,
    } as unknown as EditorView;
    expect(columnOnLine(view, state.doc.line(1), 16)).toBe(2);
  });
});
