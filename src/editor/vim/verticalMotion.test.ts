import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { blockDecorationsField } from "../livePreview";
import { moveByLinesVisual, type VimCoreState } from "./verticalMotion";

/**
 * 行号（1 起）：
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

/** 确定性几何：字符等宽 8px、行高 24px、content 左缘 100px。
 *  真实浏览器里的像素解析行为（隐藏前缀零宽、widget 命中偏向）由浏览器
 *  测量锁定；这里锁的是运动模型的控制流与记账。 */
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

function makeState(): EditorState {
  const created = EditorState.create({
    doc: DOC,
    extensions: [blockDecorationsField],
  });
  return created.update({ selection: { anchor: 0 } }).state;
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

/** `this`（引擎 motions 表）用最小替身：家族判定需要的成员按需注入，
 *  run/motions 返回给测试，用于模拟引擎的 lastMotion 记账。 */
function makeHarness(familyKeys: string[] = []): Harness {
  const state = makeState();
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
    // 锚 = line 1 col 5 的 x = 40px；目标行落 col 5。
    expect(out).toEqual({ line: 1, ch: 5 });
    expect(vim.lastHSPos).toBe(5 * CHAR_W);
    expect(vim.lastHPos).toBe(5);
  });

  it("连续 j 沿用同一视觉锚，不吸收落点量化误差", () => {
    const { run, vim, motions } = makeHarness(["moveByLines"]);
    // 模拟引擎：lastMotion 已指向本 motion，锚在上一步更新为 40。
    vim.lastMotion = motions.moveByLines;
    vim.lastHSPos = 5 * CHAR_W;
    const out = run({ line: 1, ch: 5 }, { forward: true, repeat: 1 }, vim);
    // 目标行 3 是折叠公式的开行（边缘），落点列按锚估算并被行尾钳制。
    expect(out.line).toBe(2);
    expect(out.ch).toBe(2); // "$$".length
    expect(vim.lastHSPos).toBe(5 * CHAR_W); // 锚不变：量化误差不反馈
  });

  it("隐藏行不是步：跨过公式块按可见步计数", () => {
    const { run, vim, motions } = makeHarness(["moveByLines"]);
    vim.lastMotion = motions.moveByLines;
    vim.lastHSPos = 5 * CHAR_W;
    // 4j：task(2) → $$开(3) → 源(4) → $$闭(5) → bullet(6)。
    const out = run({ line: 1, ch: 5 }, { forward: true, repeat: 4 }, vim);
    expect(out.line).toBe(5);
  });

  it("$ 之后 j 保持行尾意图（lastHPos=Infinity 贯穿，锚保持行尾 x）", () => {
    const { run, vim, motions } = makeHarness(["moveByLines", "moveToEol"]);
    vim.lastMotion = motions.moveToEol;
    vim.lastHPos = Infinity;
    const eolX = 40;
    vim.lastHSPos = eolX;
    // 光标在待办行（1）行尾（$ 之后），j 到 `$$` 开行：行尾意图落在该行行尾。
    const out = run({ line: 1, ch: 15 }, { forward: true, repeat: 1 }, vim);
    expect(out).toEqual({ line: 2, ch: "$$".length });
    expect(vim.lastHPos).toBe(Infinity);
    // eolIntent 分支不回写锚：moveToEol 设的行尾 x 保持原样。
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
