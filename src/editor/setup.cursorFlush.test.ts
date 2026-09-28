import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { GFM } from "@lezer/markdown";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { vimCursorNeedsFlush } from "./setup";
import { currentVimMode, vimDrawsBlockCursor } from "./vim/vim";

/**
 * 门禁：vim 光标冲刷（setup.ts 的 updateListener）只在「真有层会动」时付那一次
 * 同步 coordsAtPos。这条判据是模式切换卡顿的根因所在——回归的样子是「又开始
 * 每次事务都冲刷」，那会把整轮 measure（块光标 + 选区层 + 打字机）和一次强制
 * 样式重算塞回按键那一帧（实测 plain 2.0ms / 公式块 4.3ms，浏览器里量过）。
 *
 * 这里锁的是模型本身（纯函数），DOM 侧的收益另有浏览器测量。
 */

function state(doc: string, cursor: number): EditorState {
  const created = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
    selection: EditorSelection.cursor(cursor),
  });
  ensureSyntaxTree(created, created.doc.length);
  return created;
}

const PLAIN = "第一行普通正文\n第二行普通正文\n第三行普通正文\n";
const LIST = "- 列表项\n- 第二项\n";
const MATH = "$$a + b = c$$\n";
const INLINE_TRIGGER = "带 *强调* 的一行\n";

function moved(doc: string, from: number, to: number): boolean {
  const start = state(doc, from);
  return vimCursorNeedsFlush(start, start.update({ selection: EditorSelection.cursor(to) }).state, false, false);
}

describe("vim 光标冲刷判据", () => {
  it("normal→insert 那种空转（选区没动）不冲刷", () => {
    // `i` 走的是 selectForInsert：事务里带了 selection，但位置没变。
    const start = state(PLAIN, 3);
    const next = start.update({ selection: EditorSelection.cursor(3) }).state;
    expect(vimCursorNeedsFlush(start, next, false, false)).toBe(false);
  });

  it("插入态在正文里横向移动不冲刷（没有任何 DOM 会重构）", () => {
    expect(moved(PLAIN, 2, 6)).toBe(false);
    // 第三行内部横向移动（16..22 是同一行：跨行移动会命中 selectionAffectsDecos 的上界）
    expect(moved(PLAIN, 16, 21)).toBe(false);
  });

  it("文档变了必须冲刷（行/装饰可能重构）", () => {
    const start = state(PLAIN, 3);
    const next = start.update({ changes: { from: 3, insert: "x" } }).state;
    expect(vimCursorNeedsFlush(start, next, false, true)).toBe(true);
  });

  it("引擎在画块光标时冲刷（normal/visual 的 j/k/h/l 与 Esc）", () => {
    expect(vimCursorNeedsFlush(state(PLAIN, 3), state(PLAIN, 3), true, false)).toBe(true);
  });

  it("跨标记槽的同行移动要冲刷（裸 `-`/任务括号的渲染会翻）", () => {
    // "- 列表项"：槽结束在 col 2，光标从 2 走到 3 跨过槽边界。
    const start = state(LIST, 2);
    const next = start.update({ selection: EditorSelection.cursor(3) }).state;
    expect(vimCursorNeedsFlush(start, next, false, false)).toBe(true);
  });

  it("命中行内触发符的行上任何选区变化都冲刷（上界，宁可多付）", () => {
    const start = state(INLINE_TRIGGER, 1);
    const next = start.update({ selection: EditorSelection.cursor(5) }).state;
    expect(vimCursorNeedsFlush(start, next, false, false)).toBe(true);
    // 公式行同理（$ 在触发符集合里）
    const ms = state(MATH, 1);
    const mn = ms.update({ selection: EditorSelection.cursor(4) }).state;
    expect(vimCursorNeedsFlush(ms, mn, false, false)).toBe(true);
  });
});

/**
 * 块光标判据必须与引擎自己的 measureCursor 对齐（`vim && (!vim.insertMode ||
 * overwrite)`）——判错的两个方向都出问题：说 true 是白付一次整轮 measure，
 * 说 false 是块光标慢一帧落位。引擎实例就是视图上的 `cm`（getCM 读它）。
 */
describe("块光标判据与引擎一致", () => {
  const fakeView = (vim: unknown, overwrite = false) =>
    ({ cm: { state: { vim, overwrite } } }) as unknown as Parameters<typeof vimDrawsBlockCursor>[0];

  it("insert（非 replace）不画块光标", () => {
    expect(vimDrawsBlockCursor(fakeView({ insertMode: true, visualMode: false }))).toBe(false);
  });

  it("normal / visual / replace 都画", () => {
    expect(vimDrawsBlockCursor(fakeView({ insertMode: false, visualMode: false }))).toBe(true);
    expect(vimDrawsBlockCursor(fakeView({ insertMode: false, visualMode: true }))).toBe(true);
    expect(vimDrawsBlockCursor(fakeView({ insertMode: true }, true))).toBe(true);
  });

  it("没有 vim 引擎时既不画块光标，模式也读不出来", () => {
    const noEngine = { cm: null } as unknown as Parameters<typeof vimDrawsBlockCursor>[0];
    expect(vimDrawsBlockCursor(noEngine)).toBe(false);
    expect(currentVimMode(noEngine)).toBe(null);
  });
});
