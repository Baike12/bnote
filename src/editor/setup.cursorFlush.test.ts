import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { GFM } from "@lezer/markdown";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { vimCursorNeedsFlush, scheduleVimCursorFlush } from "./setup";
import { currentVimMode, vimDrawsBlockCursor } from "./vim/vim";

/**
 * Gate: the vim cursor flush (setup.ts's updateListener) only pays for that one
 * synchronous coordsAtPos when a layer will really move. This predicate is the
 * root of the mode-switch jank — the regression looks like "flushing on every
 * transaction again", which pushes a full measure round (block cursor + selection
 * layer + typewriter) and one forced style recalc back into the keystroke frame
 * (measured in the browser: plain 2.0ms / formula block 4.3ms).
 *
 * What this locks is the model itself (pure functions); the DOM-side gain is
 * measured separately in the browser.
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
  return vimCursorNeedsFlush(
    start,
    start.update({ selection: EditorSelection.cursor(to) }).state,
    false,
    false,
  );
}

describe("vim cursor flush criterion", () => {
  it("a no-op switch like normal→insert (the selection did not move) does not flush", () => {
    // `i` goes through selectForInsert: the transaction carries a selection, but
    // the position did not change.
    const start = state(PLAIN, 3);
    const next = start.update({ selection: EditorSelection.cursor(3) }).state;
    expect(vimCursorNeedsFlush(start, next, false, false)).toBe(false);
  });

  it("horizontal movement in the body while in insert mode does not flush (no DOM is rebuilt)", () => {
    expect(moved(PLAIN, 2, 6)).toBe(false);
    // Horizontal movement inside the third line (16..22 are the same line:
    // crossing a line boundary would hit the upper bound of selectionAffectsDecos)
    expect(moved(PLAIN, 16, 21)).toBe(false);
  });

  it("a document change must flush (lines and decorations may be rebuilt)", () => {
    const start = state(PLAIN, 3);
    const next = start.update({ changes: { from: 3, insert: "x" } }).state;
    expect(vimCursorNeedsFlush(start, next, false, true)).toBe(true);
  });

  it("flush while the engine draws a block cursor (j/k/h/l and Esc in normal/visual)", () => {
    expect(vimCursorNeedsFlush(state(PLAIN, 3), state(PLAIN, 3), true, false)).toBe(true);
  });

  it("movement on the same line across a marker slot must flush (a bare `-` / task bracket renders differently)", () => {
    // In "- 列表项": the slot ends at col 2, so moving the caret from 2 to 3
    // crosses the slot boundary.
    const start = state(LIST, 2);
    const next = start.update({ selection: EditorSelection.cursor(3) }).state;
    expect(vimCursorNeedsFlush(start, next, false, false)).toBe(true);
  });

  it("any selection change on a line that hits an inline trigger flushes (an upper bound, over-paying is fine)", () => {
    const start = state(INLINE_TRIGGER, 1);
    const next = start.update({ selection: EditorSelection.cursor(5) }).state;
    expect(vimCursorNeedsFlush(start, next, false, false)).toBe(true);
    // Same for a formula line ($ is part of the trigger set)
    const ms = state(MATH, 1);
    const mn = ms.update({ selection: EditorSelection.cursor(4) }).state;
    expect(vimCursorNeedsFlush(ms, mn, false, false)).toBe(true);
  });
});

/**
 * The block cursor predicate must match the engine's own measureCursor
 * (`vim && (!vim.insertMode || overwrite)`) — being wrong in either direction
 * breaks: saying true pays for a full measure round for nothing, saying false
 * lands the block cursor one frame late. The engine instance is the view's `cm`
 * (getCM reads it).
 */
describe("the block cursor criterion matches the engine", () => {
  const fakeView = (vim: unknown, overwrite = false) =>
    ({ cm: { state: { vim, overwrite } } }) as unknown as Parameters<typeof vimDrawsBlockCursor>[0];

  it("insert (not replace) draws no block cursor", () => {
    expect(vimDrawsBlockCursor(fakeView({ insertMode: true, visualMode: false }))).toBe(false);
  });

  it("normal / visual / replace all draw", () => {
    expect(vimDrawsBlockCursor(fakeView({ insertMode: false, visualMode: false }))).toBe(true);
    expect(vimDrawsBlockCursor(fakeView({ insertMode: false, visualMode: true }))).toBe(true);
    expect(vimDrawsBlockCursor(fakeView({ insertMode: true }, true))).toBe(true);
  });

  it("without a vim engine it draws no block cursor and the mode cannot be read either", () => {
    const noEngine = { cm: null } as unknown as Parameters<typeof vimDrawsBlockCursor>[0];
    expect(vimDrawsBlockCursor(noEngine)).toBe(false);
    expect(currentVimMode(noEngine)).toBe(null);
  });
});

/**
 * Timing contract of the flush (the comment above setup.ts's updateListener): the
 * flush is queued as a microtask — it still runs inside the keystroke task and
 * before rendering (the block cursor still lands in the same frame), but after
 * every synchronous change of that task (including the engine's .cm-vimMode
 * class flip), so one measure round sees the final styles and Esc's "layout
 * before the flip + invalidated flip + rAF recompute" two rounds collapse into
 * one. The regression looks like going back to reading coordinates synchronously
 * in updateListener: every Esc would then compute a layout for the stale styles.
 */
describe("flush microtask timing contract", () => {
  const fakeView = (connected: boolean) => {
    const calls: number[] = [];
    const view = {
      dom: { isConnected: connected },
      state: { selection: { main: { head: 7 } } },
      coordsAtPos: (pos: number) => {
        calls.push(pos);
      },
    };
    return { view, calls };
  };

  it("no layout is read in the synchronous phase, the flush happens in the microtask", async () => {
    const { view, calls } = fakeView(true);
    scheduleVimCursorFlush(view);
    expect(calls).toEqual([]);
    await Promise.resolve();
    expect(calls).toEqual([7]);
  });

  it("the flush is dropped when the view is destroyed before the microtask runs (the async callback proves it is still current)", async () => {
    const { view, calls } = fakeView(false);
    scheduleVimCursorFlush(view);
    await Promise.resolve();
    expect(calls).toEqual([]);
  });
});
