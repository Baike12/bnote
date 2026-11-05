import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { blockDecorationsField } from "../livePreview";
import { moveByLinesVisual, type VimCoreState } from "./verticalMotion";

/**
 * Line numbers (1-based):
 *  1 plain one
 *  2 - [ ] task item
 *  3 $$
 *  4 x = 1
 *  5 $$
 *  6 - bullet item
 *  7 plain two
 */
const DOC = [
  "plain one",
  "- [ ] task item",
  "$$",
  "x = 1",
  "$$",
  "- bullet item",
  "plain two",
].join("\n");

const CHAR_W = 8;
const ROW_H = 24;
const CONTENT_LEFT = 100;

/** Deterministic geometry: 8px per character, 24px line height, content left
 *  edge at 100px. The pixel resolution of a real browser (zero-width hidden
 *  prefixes, widget hit bias) is locked by browser measurements; what is locked
 *  here is the control flow and bookkeeping of the motion model. */
function makeFakeView(state: EditorState): EditorView {
  const view = {
    state,
    defaultCharacterWidth: CHAR_W,
    contentDOM: {
      getBoundingClientRect: () => ({ left: CONTENT_LEFT, top: 0, right: 900, bottom: 600 }),
    },
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
  };
  return view as unknown as EditorView;
}

function makeState(doc = DOC, anchor = 0): EditorState {
  const created = EditorState.create({
    doc,
    extensions: [blockDecorationsField],
  });
  return created.update({ selection: { anchor } }).state;
}

interface Harness {
  run: (
    head: { line: number; ch: number },
    motionArgs: { forward: boolean; repeat: number; repeatOffset?: number; toFirstChar?: boolean },
    vim: VimCoreState,
  ) => { line: number; ch: number };
  vim: VimCoreState;
  motions: Record<string, unknown>;
}

/** `this` (the engine's motions table) uses a minimal stand-in: the members the
 *  family check needs are injected on demand; run/motions are handed back to
 *  the test to simulate the engine's lastMotion bookkeeping. */
function makeHarness(familyKeys: string[] = [], doc = DOC, anchor = 0): Harness {
  const state = makeState(doc, anchor);
  const view = makeFakeView(state);
  const cm = { cm6: view, firstLine: () => 0, lastLine: () => state.doc.lines - 1 };
  const vim: VimCoreState = { lastMotion: null, lastHPos: 0, lastHSPos: Number.NaN };
  const motions: Record<string, unknown> = {
    moveToStartOfLine: (_cm: unknown, head: { line: number; ch: number }) => ({
      line: head.line,
      ch: 0,
    }),
  };
  for (const k of familyKeys) motions[k] = k === "moveByLines" ? moveByLinesVisual : Symbol(k);
  const fn = moveByLinesVisual as (...a: unknown[]) => { line: number; ch: number };
  const run = (
    head: { line: number; ch: number },
    motionArgs: Record<string, unknown>,
    v: VimCoreState,
  ) => fn.call(motions, cm, head, motionArgs, v);
  return { run, vim, motions };
}

describe("moveByLinesVisual (the pixel-anchored j/k landing point)", () => {
  it("the first step takes the visual anchor from the current caret, lands on the retained x and records it in lastHSPos", () => {
    const { run, vim } = makeHarness();
    const out = run({ line: 0, ch: 5 }, { forward: true, repeat: 1 }, vim);
    // The anchor is the x of line 1 col 5 = 40px; the target line lands on col 5.
    expect(out).toEqual({ line: 1, ch: 5 });
    expect(vim.lastHSPos).toBe(5 * CHAR_W);
    expect(vim.lastHPos).toBe(5);
  });

  it("repeated j keeps the same visual anchor and does not absorb the quantization error of the landing point", () => {
    const { run, vim, motions } = makeHarness(["moveByLines"]);
    // Simulate the engine: lastMotion already points at this motion, and the
    // anchor was updated to 40 in the previous step.
    vim.lastMotion = motions.moveByLines;
    vim.lastHSPos = 5 * CHAR_W;
    const out = run({ line: 1, ch: 5 }, { forward: true, repeat: 1 }, vim);
    // Target line 3 is the opening line of the folded formula (the edge); the
    // landing column is estimated from the anchor and clamped to the line end.
    expect(out.line).toBe(2);
    expect(out.ch).toBe(2); // "$$".length
    expect(vim.lastHSPos).toBe(5 * CHAR_W); // the anchor is unchanged: quantization error does not feed back
  });

  it("a hidden line is not a step: crossing a formula block counts visible steps", () => {
    const { run, vim, motions } = makeHarness(["moveByLines"]);
    vim.lastMotion = motions.moveByLines;
    vim.lastHSPos = 5 * CHAR_W;
    // 4j: task(2) → $$open(3) → source(4) → $$close(5) → bullet(6).
    const out = run({ line: 1, ch: 5 }, { forward: true, repeat: 4 }, vim);
    expect(out.line).toBe(5);
  });

  it("j after $ keeps the end-of-line intent (lastHPos=Infinity carries through and the anchor stays at the end-of-line x)", () => {
    const { run, vim, motions } = makeHarness(["moveByLines", "moveToEol"]);
    vim.lastMotion = motions.moveToEol;
    vim.lastHPos = Infinity;
    const eolX = 40;
    vim.lastHSPos = eolX;
    // The caret sits at the end of the todo line (1) (after `$`); j to the
    // `$$` opening line: the end-of-line intent lands at that line's end.
    const out = run({ line: 1, ch: 15 }, { forward: true, repeat: 1 }, vim);
    expect(out).toEqual({ line: 2, ch: "$$".length });
    expect(vim.lastHPos).toBe(Infinity);
    // The eolIntent branch does not write the anchor back: the end-of-line x
    // set by moveToEol stays as it is.
    expect(vim.lastHSPos).toBe(eolX);
  });

  it("toFirstChar resolves to the first visible character and resets the anchor", () => {
    const { run, vim } = makeHarness();
    const out = run({ line: 0, ch: 0 }, { forward: true, repeat: 1, toFirstChar: true }, vim);
    expect(out).toEqual({ line: 1, ch: 0 });
    expect(vim.lastHSPos).toBe(0);
  });

  it("when k hits the first line boundary it follows the engine's moveToStartOfLine", () => {
    const { run, vim, motions } = makeHarness(["moveByLines"]);
    vim.lastMotion = motions.moveByLines;
    vim.lastHSPos = 5 * CHAR_W;
    const out = run({ line: 0, ch: 3 }, { forward: false, repeat: 1 }, vim);
    expect(out).toEqual({ line: 0, ch: 0 });
  });

  it("when j hits the last line boundary it replicates the engine's private moveToEol(keepHPos=true): the caret stays at the line end and the bookkeeping is untouched", () => {
    const { run, vim, motions } = makeHarness(["moveByLines"]);
    vim.lastMotion = motions.moveByLines;
    vim.lastHSPos = 5 * CHAR_W;
    vim.lastHPos = 3;
    const out = run({ line: 6, ch: 3 }, { forward: true, repeat: 1 }, vim);
    expect(out).toEqual({ line: 6, ch: Infinity });
    expect(vim.lastHPos).toBe(3);
    expect(vim.lastHSPos).toBe(5 * CHAR_W);
  });

  it("after the repeatOffset cancels out count=0: toFirstChar in place", () => {
    const { run, vim } = makeHarness();
    const out = run(
      { line: 1, ch: 4 },
      { forward: true, repeat: 1, repeatOffset: -1, toFirstChar: true },
      vim,
    );
    expect(out).toEqual({ line: 1, ch: 0 });
  });
});

/** Line numbers (1-based):
 *  1 plain above
 *  2 ::: title only
 *  3 :::
 *  4 plain below
 *
 * The title-only callout has no visible body line inside its block; both `:::`
 * boundaries are block replaces. Without treating the boundaries as landing
 * points, j would skip the whole callout (that is the defect). The hidden
 * detection of an HR depends on the markdown syntax tree, which this unit test
 * does not set up, so no `---` is placed here; the real structure with an HR
 * is verified in the browser harness.
 */
const CALLOUT_ONLY_TITLE = ["plain above", "::: 只有标题", ":::", "plain below"].join("\n");

/** Line numbers (1-based):
 *  1 plain above
 *  2 ::: title
 *  3 body
 *  4 :::
 *  5 plain below
 */
const CALLOUT_WITH_BODY = ["plain above", "::: 标题", "body", ":::", "plain below"].join("\n");

describe("moveByLinesVisual: a callout boundary is a landing point", () => {
  it("a title-only callout: j lands on the opening marker line (entering the block) instead of skipping it as a whole", () => {
    const { run, vim } = makeHarness([], CALLOUT_ONLY_TITLE);
    const out = run({ line: 0, ch: 0 }, { forward: true, repeat: 1 }, vim);
    expect(out.line).toBe(1); // 0-based → the `::: title only` line
  });

  it("a title-only callout: k from below lands on the closing marker line (entering the block)", () => {
    const { run, vim } = makeHarness(
      [],
      CALLOUT_ONLY_TITLE,
      CALLOUT_ONLY_TITLE.indexOf("plain below"),
    );
    const out = run({ line: 3, ch: 0 }, { forward: false, repeat: 1 }, vim);
    expect(out.line).toBe(2); // 0-based → the closing `:::` marker
  });

  it("once inside the block the boundary line becomes an ordinary step: j can continue through the whole block", () => {
    const { run, vim } = makeHarness(
      [],
      CALLOUT_ONLY_TITLE,
      CALLOUT_ONLY_TITLE.indexOf("::: 只有标题"),
    );
    expect(run({ line: 1, ch: 0 }, { forward: true, repeat: 1 }, vim).line).toBe(2);
    expect(run({ line: 2, ch: 0 }, { forward: true, repeat: 1 }, vim).line).toBe(3);
  });

  it("a counted j: 2j passes both the opening and the closing marker lines from outside the block (the steps share one frame of decorations)", () => {
    const { run, vim } = makeHarness([], CALLOUT_ONLY_TITLE);
    const out = run({ line: 0, ch: 0 }, { forward: true, repeat: 2 }, vim);
    expect(out.line).toBe(2); // 0-based → the closing `:::` marker
  });

  it("a callout with a body: j from above first lands on the opening marker line and then enters the body", () => {
    const outside = makeHarness([], CALLOUT_WITH_BODY, 0);
    expect(outside.run({ line: 0, ch: 0 }, { forward: true, repeat: 1 }, outside.vim).line).toBe(1);
    const inside = makeHarness([], CALLOUT_WITH_BODY, CALLOUT_WITH_BODY.indexOf("::: 标题"));
    expect(inside.run({ line: 1, ch: 0 }, { forward: true, repeat: 1 }, inside.vim).line).toBe(2);
  });
});
