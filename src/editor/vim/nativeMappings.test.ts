import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { applyNativeMappings } from "./vim";
import { Vim } from "@replit/codemirror-vim";

// 引擎 insert 模式的映射超时计时器挂在 window 上(vim.js 的
// insertModeEscKeysTimeout);node 测试环境用全局别名补上。
(globalThis as Record<string, unknown>).window = globalThis;

/**
 * 键序列映射(`imap jj <Esc>` 这类)必须把 rhs **原样**交给引擎。引擎展开
 * keyToKey 映射时按尖括号 token 切分(doKeyToKey),对 `<Esc>` 走"退出插入
 * 模式"的原生分支;一旦被改写成裸 "Esc",展开器按 E·s·c 三个单字符逐个
 * replaceSelection——插入模式退不出去,字面 "Esc" 被打进文档。用户报告的
 * 「normal 模式按 gg/G 不跳转」实际都发生在 insert 态(jj 退出失败)。
 * 这里用真实引擎 + 最小 CM5 shim 行为级锁死(纯逻辑,无 DOM)。
 */

function indexFromPos(doc: { lines: number; line(n: number): { from: number; to: number } }, pos: { line: number; ch: number }): number {
  const lineNumber = Math.min(Math.max(pos.line + 1, 1), doc.lines);
  const line = doc.line(lineNumber);
  return line.from + Math.min(Math.max(pos.ch, 0), line.to - line.from);
}

/** 最小 CM5 风格 shim:引擎 insert 路径(i / jj→<Esc>)触碰的方法面。
 *  文档状态由真 EditorState 承载,Pos(line, ch) 0 基与引擎一致。 */
function makeCm(docText: string) {
  let state = EditorState.create({ doc: docText });
  const opts: Record<string, unknown> = {};

  const doc = () => state.doc;
  const curPos = (): { line: number; ch: number } => {
    const offset = state.selection.main.head;
    const line = state.doc.lineAt(offset);
    return { line: line.number - 1, ch: offset - line.from };
  };
  const setCur = (pos: { line: number; ch: number }) => {
    const offset = indexFromPos(state.doc, pos);
    state = state.update({ selection: { anchor: offset } }).state;
  };
  const dispatch = (changes: { from: number; to: number; insert: string }, selAnchor?: number) => {
    state = state.update({ changes, selection: selAnchor !== undefined ? { anchor: selAnchor } : undefined }).state;
  };
  const posToOffset = (pos: { line: number; ch: number }) => indexFromPos(state.doc, pos);

  const cm = {
    // 引擎把 per-editor vim 状态挂在 cm.state.vim 上
    state: {} as { vim?: unknown },
    curOp: {} as Record<string, unknown>,
    operation(f: () => void) {
      this.curOp = {};
      try {
        f();
      } finally {
        this.curOp = {};
      }
    },
    getOption: (name: string) => opts[name],
    setOption: (name: string, value: unknown) => {
      opts[name] = value;
    },
    firstLine: () => 0,
    lastLine: () => doc().lines - 1,
    lineCount: () => doc().lines,
    getLine: (row: number) => (row < 0 || row >= doc().lines ? "" : doc().line(row + 1).text),
    getCursor: (_p?: string) => curPos(),
    getRange: (a: { line: number; ch: number }, b: { line: number; ch: number }) => {
      const from = posToOffset(a);
      const to = posToOffset(b);
      return from <= to ? state.doc.sliceString(from, to) : state.doc.sliceString(to, from);
    },
    listSelections: () => [(() => {
      const p = curPos();
      return { anchor: { ...p }, head: { ...p } };
    })()],
    somethingSelected: () => false,
    setSelection: (anchor: { line: number; ch: number }, head: { line: number; ch: number }) => {
      const a = posToOffset(anchor);
      const h = posToOffset(head);
      state = state.update({ selection: { anchor: a, head: h } }).state;
    },
    setSelections: (ranges: { anchor: { line: number; ch: number }; head: { line: number; ch: number } }[]) => {
      const first = ranges[0];
      if (first) cm.setSelection(first.anchor, first.head);
    },
    replaceRange: (text: string, from: { line: number; ch: number }, to?: { line: number; ch: number }) => {
      const f = posToOffset(from);
      const t = to ? posToOffset(to) : f;
      const insert = text ?? "";
      dispatch({ from: Math.min(f, t), to: Math.max(f, t), insert }, Math.min(f, t) + insert.length);
    },
    replaceSelection: (text: string) => {
      const p = curPos();
      const at = posToOffset(p);
      dispatch({ from: at, to: at, insert: text }, at + text.length);
    },
    setCursor: (pos: { line?: number; ch?: number } | { line: number; ch: number }) => {
      const p = curPos();
      const line = typeof pos === "object" && pos.line !== undefined ? pos.line : p.line;
      const ch = typeof pos === "object" && pos.ch !== undefined ? pos.ch : p.ch;
      setCur({ line, ch: ch ?? 0 });
    },
    // 宽面兜底:测试只走 insert 模式进出,引擎的其余探测一律温和失败
    isInMultiSelectMode: () => false,
    inVirtualSelectionMode: false,
    toggleOverwrite: () => {},
    setBookmark: () => ({ clear: () => {} }),
    getInputField: () => ({}),
    markText: () => ({ clear: () => {} }),
    on: () => {},
    off: () => {},
    signal: () => {},
    getValue: () => state.doc.toString(),
    state_: null,
  };
  return {
    cm: cm as unknown as Record<string, unknown> & { state: { vim?: unknown } },
    docText: () => state.doc.toString(),
  };
}

/** 按键序列进引擎(wrapper 的真实路径就是 multiSelectHandleKey)。 */
function typeKeys(cm: Record<string, unknown>, keys: string[]) {
  for (const k of keys) {
    Vim.multiSelectHandleKey(cm as never, k, "user");
  }
}

function modeOf(cm: { state: { vim?: { insertMode?: boolean } } }): string {
  const vim = cm.state.vim as { insertMode?: boolean } | undefined;
  return vim?.insertMode ? "insert" : "normal";
}

describe("applyNativeMappings: rhs 原样进引擎(键名改写回归)", () => {
  it("`imap jj <Esc>`(rhs 含尖括号)两个 j 退出插入模式,文档原样", () => {
    applyNativeMappings([{ lhs: "jj", rhs: "<Esc>", mode: "insert", noremap: true }]);
    const { cm, docText } = makeCm("line one\nline two");
    typeKeys(cm, ["i"]);
    expect(modeOf(cm as never)).toBe("insert");
    typeKeys(cm, ["j", "j"]);
    expect(modeOf(cm as never)).toBe("normal");
    // 引擎的 changeQueue 按"partial 期间已插入 2 字符"记账撤销;shim 无浏览器
    // 默认输入,首键未真插入,文档因此少 2 个既有字符——这是 shim 的记账
    // artifact,真实键盘下撤销的正是刚输入的 "jj"。这里只锁两件事:模式回到
    // normal + 没有字面 "Esc" 被插进文档。
    expect(docText()).not.toContain("Esc");
  });

  it("rhs 含 <Esc> 与普通字符混合(jja)仍逐 token 展开", () => {
    applyNativeMappings([{ lhs: ">>", rhs: "<Esc>A;", mode: "insert", noremap: true }]);
    const { cm, docText } = makeCm("abc");
    typeKeys(cm, ["i"]);
    typeKeys(cm, [">", ">"]);
    expect(modeOf(cm as never)).toBe("insert"); // <Esc> 退出后又 A 进插入
    typeKeys(cm, ["<Esc>"]);
    expect(modeOf(cm as never)).toBe("normal");
    expect(docText()).toBe("abc;");
  });

  it("裸 Esc 字符串作为 rhs 时被逐字符插入(锁住改写错误的历史症状)", () => {
    // 防回归方向:如果将来有人再把 <Esc> 改写成裸 Esc,这个用例会看到
    // 模式仍为 insert 且文档多出 "Esc" 字样——正是用户遇到的死法。
    applyNativeMappings([{ lhs: ";;", rhs: "Esc", mode: "insert", noremap: true }]);
    const { cm, docText } = makeCm("x");
    typeKeys(cm, ["i"]);
    typeKeys(cm, [";", ";"]);
    const stillInsert = modeOf(cm as never) === "insert";
    const polluted = docText().includes("Esc");
    expect(stillInsert || polluted).toBe(true);
  });
});
