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
const DOC = ["plain one", "- [ ] task item", "$$", "x = 1", "$$", "- bullet item", "plain two"].join(
  "\n",
);

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
  const run = (head: { line: number; ch: number }, motionArgs: Record<string, unknown>, v: VimCoreState) =>
    fn.call(motions, cm, head, motionArgs, v);
  return { run, vim, motions };
}

describe("moveByLinesVisual（像素锚定的 j/k 落点）", () => {
  it("第一步从当前光标取视觉锚，落在保留 x 上并记入 lastHSPos", () => {
    const { run, vim } = makeHarness();
    const out = run({ line: 0, ch: 5 }, { forward: true, repeat: 1 }, vim);
    // The anchor is the x of line 1 col 5 = 40px; the target line lands on col 5.
    expect(out).toEqual({ line: 1, ch: 5 });
    expect(vim.lastHSPos).toBe(5 * CHAR_W);
    expect(vim.lastHPos).toBe(5);
  });

  it("连续 j 沿用同一视觉锚，不吸收落点量化误差", () => {
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

  it("隐藏行不是步：跨过公式块按可见步计数", () => {
    const { run, vim, motions } = makeHarness(["moveByLines"]);
    vim.lastMotion = motions.moveByLines;
    vim.lastHSPos = 5 * CHAR_W;
    // 4j: task(2) → $$open(3) → source(4) → $$close(5) → bullet(6).
    const out = run({ line: 1, ch: 5 }, { forward: true, repeat: 4 }, vim);
    expect(out.line).toBe(5);
  });

  it("$ 之后 j 保持行尾意图（lastHPos=Infinity 贯穿，锚保持行尾 x）", () => {
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

  it("toFirstChar 解析到第一个可见字符并重置锚", () => {
    const { run, vim } = makeHarness();
    const out = run({ line: 0, ch: 0 }, { forward: true, repeat: 1, toFirstChar: true }, vim);
    expect(out).toEqual({ line: 1, ch: 0 });
    expect(vim.lastHSPos).toBe(0);
  });

  it("k 到首行边界时沿用引擎的 moveToStartOfLine", () => {
    const { run, vim, motions } = makeHarness(["moveByLines"]);
    vim.lastMotion = motions.moveByLines;
    vim.lastHSPos = 5 * CHAR_W;
    const out = run({ line: 0, ch: 3 }, { forward: false, repeat: 1 }, vim);
    expect(out).toEqual({ line: 0, ch: 0 });
  });

  it("j 到末行边界时复刻引擎私有 moveToEol(keepHPos=true)：原力行尾且不动记账", () => {
    const { run, vim, motions } = makeHarness(["moveByLines"]);
    vim.lastMotion = motions.moveByLines;
    vim.lastHSPos = 5 * CHAR_W;
    vim.lastHPos = 3;
    const out = run({ line: 6, ch: 3 }, { forward: true, repeat: 1 }, vim);
    expect(out).toEqual({ line: 6, ch: Infinity });
    expect(vim.lastHPos).toBe(3);
    expect(vim.lastHSPos).toBe(5 * CHAR_W);
  });

  it("repeatOffset 抵消后 count=0：原地 toFirstChar", () => {
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

describe("moveByLinesVisual：callout 边界是落点", () => {
  it("标题-only callout：j 落在开标记行（进入块），不再整体跳过", () => {
    const { run, vim } = makeHarness([], CALLOUT_ONLY_TITLE);
    const out = run({ line: 0, ch: 0 }, { forward: true, repeat: 1 }, vim);
    expect(out.line).toBe(1); // 0-based → the `::: title only` line
  });

  it("标题-only callout：k 从下方落在合标记行（进入块）", () => {
    const { run, vim } = makeHarness(
      [],
      CALLOUT_ONLY_TITLE,
      CALLOUT_ONLY_TITLE.indexOf("plain below"),
    );
    const out = run({ line: 3, ch: 0 }, { forward: false, repeat: 1 }, vim);
    expect(out.line).toBe(2); // 0-based → the closing `:::` marker
  });

  it("进入块后边界行变成普通步：可继续 j 穿过整个块", () => {
    const { run, vim } = makeHarness(
      [],
      CALLOUT_ONLY_TITLE,
      CALLOUT_ONLY_TITLE.indexOf("::: 只有标题"),
    );
    expect(run({ line: 1, ch: 0 }, { forward: true, repeat: 1 }, vim).line).toBe(2);
    expect(run({ line: 2, ch: 0 }, { forward: true, repeat: 1 }, vim).line).toBe(3);
  });

  it("计数 j：2j 从块外穿过开、合两条标记行（多步共享同一帧装饰）", () => {
    const { run, vim } = makeHarness([], CALLOUT_ONLY_TITLE);
    const out = run({ line: 0, ch: 0 }, { forward: true, repeat: 2 }, vim);
    expect(out.line).toBe(2); // 0-based → the closing `:::` marker
  });

  it("有正文的 callout：j 从上方先落在开标记行，再进正文", () => {
    const outside = makeHarness([], CALLOUT_WITH_BODY, 0);
    expect(outside.run({ line: 0, ch: 0 }, { forward: true, repeat: 1 }, outside.vim).line).toBe(1);
    const inside = makeHarness(
      [],
      CALLOUT_WITH_BODY,
      CALLOUT_WITH_BODY.indexOf("::: 标题"),
    );
    expect(inside.run({ line: 1, ch: 0 }, { forward: true, repeat: 1 }, inside.vim).line).toBe(2);
  });
});
