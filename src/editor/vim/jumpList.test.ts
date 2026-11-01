import { describe, expect, it } from "vitest";
import { EditorState, type Text } from "@codemirror/state";
import { CodeMirror, Vim } from "@replit/codemirror-vim";
import { patchVimMarkerFind } from "./vim";

// The engine's insert-mode timeout timer hangs off `window`; the node test
// environment supplies it through a global alias.
(globalThis as Record<string, unknown>).window = globalThis;

/**
 * Root-cause regression for "gg/G stop working after switching files":
 *
 * The engine's jumpList lives on the module-level singleton vimGlobalState,
 * so it survives across documents and across view.setState; bnote switches
 * files through the setState wholesale replacement in loadDocument/
 * reloadDocument — not a transaction, so markers are never mapPos-ed. The
 * engine's Marker.find() projects the old document's bare offset onto the
 * current one with posFromIndex and throws RangeError when it is out of
 * range; gg/G (toJumplist) always throws at recordJumpPosition → jumpList.add
 * → curMark.find(), and the throw happens before setSelection — the caret
 * never lands, the engine's catch resets the vim state (the status line
 * still reads NORMAL), and j/k keep working. The patch restores CM5
 * semantics: an out-of-range find() returns null (reporting "marker does
 * not exist"), and add() continues in the next slot.
 *
 * Here the real engine plus a real shim CodeMirror (real Marker, real Text,
 * no DOM) walks the whole chain: without the patch the first gg throws
 * RangeError; with the patch gg/G still jump.
 */

/** 2000-line document, last offset ≈20.9k — the source of the poison marker
 *  (G was pressed in a long document). */
const LONG_DOC = Array.from({ length: 2000 }, (_, i) => `第 ${i + 1} 行内容`).join("\n");
const SHORT_DOC = "# 2026-10-02\n短日记\n";

interface FakeCm {
  state: { vim?: unknown };
  // The method surface the engine actually touches (normal-mode motion +
  // jumpList path)
  curOp: Record<string, unknown>;
  operation(f: () => void): void;
  getOption(name: string): unknown;
  setOption(name: string, value: unknown): void;
  firstLine(): number;
  lastLine(): number;
  lineCount(): number;
  getLine(row: number): string;
  getCursor(p?: string): { line: number; ch: number };
  listSelections(): { anchor: { line: number; ch: number }; head: { line: number; ch: number } }[];
  somethingSelected(): boolean;
  setSelection(anchor: { line: number; ch: number }, head?: { line: number; ch: number }): void;
  setCursor(lineOrPos: number | { line?: number; ch?: number }, chArg?: number): void;
  setBookmark(cursor: { line: number; ch: number }, options?: { insertLeft?: boolean }): unknown;
  on(type: string, f: unknown): void;
  off(type: string, f: unknown): void;
  signal(type: string, e: unknown): void;
  isInMultiSelectMode(): boolean;
  inVirtualSelectionMode: boolean;
}

/** Minimal host with a real shim and real Text: the shim reads the fake cm's
 *  document through cm6.state.doc; swapDoc replaces the whole EditorState
 *  (setState semantics, not a transaction). */
function makeCm(docText: string) {
  let state = EditorState.create({ doc: docText });
  const view = {
    get state() {
      return { doc: state.doc as Text };
    },
  };
  const shim = new CodeMirror(view as never);

  const indexFromPos = (pos: { line: number; ch: number }) => {
    const line = state.doc.line(Math.min(Math.max(pos.line + 1, 1), state.doc.lines));
    return line.from + Math.min(Math.max(pos.ch, 0), line.to - line.from);
  };
  const cur = () => {
    const offset = state.selection.main.head;
    const line = state.doc.lineAt(offset);
    return { line: line.number - 1, ch: offset - line.from };
  };

  const cm: FakeCm = {
    state: {},
    curOp: {},
    operation(f) {
      this.curOp = {};
      try {
        f();
      } finally {
        this.curOp = {};
      }
    },
    getOption: () => undefined,
    setOption: () => {},
    firstLine: () => 0,
    lastLine: () => state.doc.lines - 1,
    lineCount: () => state.doc.lines,
    getLine: (row) => (row < 0 || row >= state.doc.lines ? "" : state.doc.line(row + 1).text),
    getCursor: () => cur(),
    listSelections: () => [{ anchor: cur(), head: cur() }],
    somethingSelected: () => !state.selection.main.empty,
    setSelection: (anchor, head) => {
      const a = indexFromPos(anchor);
      const h = indexFromPos(head ?? anchor);
      state = state.update({ selection: { anchor: a, head: h } }).state;
    },
    setCursor: (lineOrPos: number | { line?: number; ch?: number }, chArg?: number) => {
      const p = cur();
      const line = typeof lineOrPos === "number" ? lineOrPos : (lineOrPos?.line ?? p.line);
      const ch = typeof lineOrPos === "number" ? (chArg ?? 0) : (lineOrPos?.ch ?? p.ch);
      state = state.update({ selection: { anchor: indexFromPos({ line, ch }) } }).state;
    },
    // A real bookmark: a real Marker (bare offset + find()), backed by the
    // patched prototype
    setBookmark: (cursor, options) => shim.setBookmark(cursor as never, options as never),
    on: () => {},
    off: () => {},
    signal: () => {},
    isInMultiSelectMode: () => false,
    inVirtualSelectionMode: false,
  };
  return {
    cm: cm as unknown as Record<string, unknown>,
    cursor: (): { line: number; ch: number } => cur(),
    swapDoc: (text: string) => {
      state = EditorState.create({ doc: text });
    },
  };
}

function typeKeys(cm: Record<string, unknown>, keys: string[]) {
  for (const k of keys) Vim.multiSelectHandleKey(cm as never, k, "user");
}

describe("跨文档 jump marker（换文件后 gg/G 失效回归）", () => {
  it("长文档末尾的书签，换短文档后 find() 报告不存在而不是抛 RangeError", () => {
    patchVimMarkerFind();
    const long = EditorState.create({ doc: LONG_DOC }).doc;
    const view = { state: { doc: long as Text } };
    const shim = new CodeMirror(view as never);
    const marker = shim.setBookmark({ line: long.lines - 1, ch: 0 } as never);
    expect(marker).not.toBeNull();
    expect((marker as { find(): unknown }).find()).toEqual({ line: 1999, ch: 0 });
    // After the wholesale switch to a short document (setState semantics):
    // the same bookmark's offset is out of range
    (view.state as { doc: Text }).doc = EditorState.create({ doc: SHORT_DOC }).doc as Text;
    expect(() => (marker as { find(): unknown }).find()).not.toThrow();
    expect((marker as { find(): unknown }).find()).toBeNull();
    // Bookmarks inside the current document are unaffected
    const live = shim.setBookmark({ line: 1, ch: 2 } as never);
    expect((live as { find(): unknown }).find()).toEqual({ line: 1, ch: 2 });
  });

  it("长文档 G → 整份换短文档 → gg/G 照常跳（此前 gg 处必抛 RangeError）", () => {
    patchVimMarkerFind();
    const { cm, cursor, swapDoc } = makeCm(LONG_DOC);
    typeKeys(cm, ["G"]);
    expect(cursor().line).toBe(1999);
    // setState file switch: the global jumpList keeps a dead marker with an
    // offset ≈20.9k
    swapDoc(SHORT_DOC);
    // This used to throw RangeError: Invalid position … in document of length 15
    expect(() => typeKeys(cm, ["g", "g"])).not.toThrow();
    expect(cursor().line).toBe(0);
    // SHORT_DOC ends with \n: the trailing empty line counts as a line, so G
    // lands on the last line (index 2)
    expect(() => typeKeys(cm, ["G"])).not.toThrow();
    expect(cursor().line).toBe(2);
    // Keys outside the jump list are unaffected (control group)
    typeKeys(cm, ["g", "g"]);
    expect(cursor().line).toBe(0);
  });

  it("换短文档后 <C-o>/<C-i> 走过死标记不抛（jumpList.move 的跳过路径）", () => {
    patchVimMarkerFind();
    const { cm, cursor, swapDoc } = makeCm(LONG_DOC);
    typeKeys(cm, ["G"]);
    swapDoc(SHORT_DOC);
    expect(() => typeKeys(cm, ["<C-o>", "<C-i>"])).not.toThrow();
    const pos = cursor();
    expect(pos.line).toBeGreaterThanOrEqual(0);
    expect(pos.line).toBeLessThan(3);
  });
});
