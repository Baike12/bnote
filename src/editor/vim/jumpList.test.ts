import { describe, expect, it } from "vitest";
import { EditorState, type Text } from "@codemirror/state";
import { CodeMirror, Vim } from "@replit/codemirror-vim";
import { patchVimMarkerFind } from "./vim";

// 引擎的 insert 模式超时计时器挂在 window 上；node 测试环境用全局别名补上。
(globalThis as Record<string, unknown>).window = globalThis;

/**
 * 「换文件后 gg/G 失效」的根因回归：
 *
 * 引擎的 jumpList 挂在模块级单例 vimGlobalState 上，跨文档、跨
 * view.setState 存活；bnote 切文件走 loadDocument/reloadDocument 的
 * setState 整体替换——不是事务，标记不会被 mapPos。引擎 Marker.find() 用
 * posFromIndex 把旧文档的裸偏移投影到当前文档，越界直接抛 RangeError；
 * gg/G(toJumplist) 在 recordJumpPosition → jumpList.add → curMark.find()
 * 处必抛，且异常发生在 setSelection 之前——光标永远落不下去，引擎 catch
 * 重置 vim 态（状态条仍是 NORMAL），j/k 照常。patch 恢复 CM5 语义：越界
 * find() 返回 null（报告"标记不存在"），add() 走下一槽位续写。
 *
 * 这里用真实引擎 + 真 shim CodeMirror（真 Marker、真 Text，无 DOM）走完
 * 整条链：不 patch 时第一个 gg 就抛 RangeError；patch 后 gg/G 照常跳。
 */

/** 2000 行文档，末尾偏移 ≈20.9k——毒标记的来源（长文档里按过 G）。 */
const LONG_DOC = Array.from({ length: 2000 }, (_, i) => `第 ${i + 1} 行内容`).join("\n");
const SHORT_DOC = "# 2026-10-02\n短日记\n";

interface FakeCm {
  state: { vim?: unknown };
  // 引擎实际触碰的方法面（normal 模式 motion + jumpList 路径）
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

/** 真 shim + 真 Text 的最小宿主：shim 经 cm6.state.doc 读到 fake cm 的
 *  同一份文档；swapDoc 整份替换 EditorState（setState 语义，非事务）。 */
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
    // 真书签：真 Marker（裸偏移 + find()），由 patched 原型背书
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
    // 整份换短文档（setState 语义）后：同一书签的偏移越界
    (view.state as { doc: Text }).doc = EditorState.create({ doc: SHORT_DOC }).doc as Text;
    expect(() => (marker as { find(): unknown }).find()).not.toThrow();
    expect((marker as { find(): unknown }).find()).toBeNull();
    // 当前文档内的书签不受影响
    const live = shim.setBookmark({ line: 1, ch: 2 } as never);
    expect((live as { find(): unknown }).find()).toEqual({ line: 1, ch: 2 });
  });

  it("长文档 G → 整份换短文档 → gg/G 照常跳（此前 gg 处必抛 RangeError）", () => {
    patchVimMarkerFind();
    const { cm, cursor, swapDoc } = makeCm(LONG_DOC);
    typeKeys(cm, ["G"]);
    expect(cursor().line).toBe(1999);
    // setState 换文件：全局 jumpList 里留下偏移 ≈20.9k 的死标记
    swapDoc(SHORT_DOC);
    // 此前在这里抛 RangeError: Invalid position … in document of length 15
    expect(() => typeKeys(cm, ["g", "g"])).not.toThrow();
    expect(cursor().line).toBe(0);
    // SHORT_DOC 以 \n 结尾：末尾空行也算一行，G 落在末行（index 2）
    expect(() => typeKeys(cm, ["G"])).not.toThrow();
    expect(cursor().line).toBe(2);
    // 非 jumplist 键不受影响（对照组）
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
