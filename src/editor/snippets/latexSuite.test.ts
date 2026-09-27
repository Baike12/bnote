import { beforeEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { autoEnlargeBrackets, enlargeBracketEdits } from "./enlarge";
import { MATRIX_ROW_BREAK, matrixEnter, matrixEnvAt, matrixSeparator } from "./matrix";
import {
  buildSession,
  deleteDollarPair,
  deleteScriptBraces,
  exitChain,
  setSession,
  snippetField,
} from "./extension";
import type { SnippetSession } from "./extension";
import { parseReplacement } from "./engine";
import { buildBracketColors, buildCursorBrackets, enclosingBrackets, findMatchingBracket, withinEnv } from "./brackets";
import { configureLatexSuite, resetLatexConfig } from "./config";

beforeEach(() => {
  resetLatexConfig();
});

/** 只依赖 view 的 {state, dispatch} 面(与 ops.test.ts 同款假视图)。 */
function makeView(doc: string, cursors: number[] = [doc.length]): EditorView {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.create(cursors.map((c) => EditorSelection.cursor(c))),
  });
  const view = {
    get state() {
      return state;
    },
    dispatch: (spec: TransactionSpec) => {
      state = state.update(spec).state;
    },
  };
  return view as unknown as EditorView;
}

const text = (view: EditorView) => view.state.doc.toString();
const head = (view: EditorView) => view.state.selection.main.head;

describe("enlargeBracketEdits:括号里有大个子就升级成 \\left…\\right", () => {
  const run = (doc: string, triggers = ["sum", "int", "frac", "prod", "bigcup", "bigcap"]) =>
    enlargeBracketEdits(doc, 0, doc.length, triggers);

  it("圆括号内有 \\sum:两侧各插入放大命令,并留一个空格", () => {
    expect(run("(\\sum_{i} x)")).toEqual([
      { from: 0, to: 1, insert: "\\left( " },
      { from: 11, to: 12, insert: " \\right)" },
    ]);
  });

  it("内容里没有触发词:不动", () => {
    expect(run("(x + y)")).toEqual([]);
  });

  it("已经放大过的跳过,不重复加", () => {
    expect(run("\\left(\\sum x\\right)")).toEqual([]);
  });

  it("嵌套:内外两对各自放大(有触发词时不跳过整对)", () => {
    expect(run("((\\sum x))").map((e) => e.insert)).toEqual([
      "\\left( ",
      " \\right)",
      "\\left( ",
      " \\right)",
    ]);
  });

  it("方括号与转义花括号同样是放大对象", () => {
    expect(run("[\\int x]").map((e) => e.insert)).toEqual(["\\left[ ", " \\right]"]);
    expect(run("\\{\\sum\\}").map((e) => e.insert)).toEqual(["\\left\\{ ", " \\right\\}"]);
  });

  it("\\langle…\\rangle 等多字符括号也认(插件的八种括号表)", () => {
    expect(run("\\langle \\sum \\rangle").map((e) => e.insert)).toEqual([
      "\\left\\langle ",
      " \\right\\rangle",
    ]);
  });

  it("没有配对闭括号:不动", () => {
    expect(run("(\\sum x")).toEqual([]);
  });

  it("触发词是子串匹配(与插件一致:\\internal 里含 \\int 也会放大)", () => {
    expect(run("(\\internal)").map((e) => e.insert)).toEqual(["\\left( ", " \\right)"]);
  });
});

describe("autoEnlargeBrackets:展开之后才跑,且只认本次插入的文本", () => {
  it("插入 \\frac 后把外层括号升级(自动分数后的路径)", () => {
    const view = makeView("$(\\frac{a}{b})$", [2]);
    expect(autoEnlargeBrackets(view, "\\frac{a}{b}")).toBe(true);
    expect(text(view)).toBe("$\\left( \\frac{a}{b} \\right)$");
  });

  it("插入的文本里没有触发词:整段方程一个字都不动", () => {
    const view = makeView("$(\\sum x)$", [2]);
    expect(autoEnlargeBrackets(view, "\\alpha")).toBe(false);
    expect(text(view)).toBe("$(\\sum x)$");
  });

  it("开关关掉后完全不跑", () => {
    configureLatexSuite({ autoEnlargeBrackets: false });
    const view = makeView("$(\\frac{a}{b})$", [2]);
    expect(autoEnlargeBrackets(view, "\\frac{a}{b}")).toBe(false);
    expect(text(view)).toBe("$(\\frac{a}{b})$");
  });

  it("光标不在公式里:不动(放大只在方程范围内进行)", () => {
    const view = makeView("正文\n\n$(\\frac{a}{b})$", [0]);
    expect(autoEnlargeBrackets(view, "\\frac")).toBe(false);
  });
});

describe("矩阵环境判定与快捷", () => {
  const BLOCK = "$$\n\\begin{pmatrix}\nQ & b\n\\end{pmatrix}\n$$";

  it("块级公式里认出矩阵环境", () => {
    const pos = BLOCK.indexOf("Q & b") + 1;
    expect(matrixEnvAt(EditorState.create({ doc: BLOCK }), pos)).toBe("pmatrix");
  });

  it("cases / align 等环境名都在设置表里", () => {
    for (const env of ["cases", "align", "bmatrix", "array"]) {
      // 正文用 Q:环境名里可能含 x/a(bmatrix、matrix),拿它们当光标标记会插进环境名里
      const doc = `$$\n\\begin{${env}}\nQ\n\\end{${env}}\n$$`;
      const state = EditorState.create({ doc });
      expect(matrixEnvAt(state, doc.indexOf("Q") + 1)).toBe(env);
    }
  });

  it("环境之外(公式里但不在矩阵里)返回 null", () => {
    const doc = "$$\na & b\n$$";
    const state = EditorState.create({ doc });
    expect(matrixEnvAt(state, doc.indexOf("&"))).toBeNull();
  });

  it("行内公式里不生效(插件只在 block math 触发)", () => {
    const doc = "$\\begin{pmatrix}a\\end{pmatrix}$";
    const state = EditorState.create({ doc });
    expect(matrixEnvAt(state, doc.indexOf("a"))).toBeNull();
  });

  it("矩阵列分隔挂在 Shift+Tab 上,环境外交回后续处理(false)", () => {
    const inside = makeView(BLOCK, [BLOCK.indexOf("Q")]);
    expect(matrixSeparator(inside)).toBe(true);
    expect(text(inside)).toBe(BLOCK.replace("Q", " & Q"));

    const outside = makeView("$$x$$", [2]);
    expect(matrixSeparator(outside)).toBe(false);
    expect(text(outside)).toBe("$$x$$");
  });

  it("Enter 在矩阵里补 ` \\\\` 换行:行分隔符就是两个反斜杠 + 换行", () => {
    expect([...MATRIX_ROW_BREAK]).toEqual([" ", "\\", "\\", "\n"]);
    const view = makeView(BLOCK, [BLOCK.indexOf("Q")]);
    expect(matrixEnter(view)).toBe(true);
    expect(text(view)).toBe(
      "$$\n\\begin{pmatrix}\n \\\\\nQ & b\n\\end{pmatrix}\n$$",
    );
  });

  it("Shift+Enter 只把光标送到下一行行尾,不动文档", () => {
    const view = makeView(BLOCK, [BLOCK.indexOf("Q")]);
    const before = text(view);
    expect(matrixEnter(view, true)).toBe(true);
    expect(text(view)).toBe(before);
    // 光标原本在第 3 行(Q & b),shift+Enter 送到第 4 行(= \end{pmatrix} 那行)的行尾
    expect(view.state.doc.lineAt(head(view)).number).toBe(4);
    expect(head(view)).toBe(view.state.doc.line(4).to);
  });

  it("开关关掉后 Shift+Tab/Enter 都不认", () => {
    configureLatexSuite({ matrixShortcuts: false });
    const view = makeView(BLOCK, [BLOCK.indexOf("Q")]);
    expect(matrixSeparator(view)).toBe(false);
    expect(matrixEnter(view)).toBe(false);
  });
});

describe("autoDelete$:光标夹在两个 $ 之间时一次删两个", () => {
  it("`$|$` 空行内公式:一次删干净,不留落单的 $", () => {
    const view = makeView("$$", [1]);
    expect(deleteDollarPair(view)).toBe(true);
    expect(text(view)).toBe("");
  });

  it("`$$|$$` 空块级公式:同样一次删两个", () => {
    const view = makeView("$$$$", [2]);
    expect(deleteDollarPair(view)).toBe(true);
    expect(text(view)).toBe("$$");
  });

  it("光标旁边只有一个 $:交回默认删除", () => {
    const view = makeView("$x$", [2]);
    expect(deleteDollarPair(view)).toBe(false);
    expect(text(view)).toBe("$x$");
  });

  it("公式之外的两个 $ 不删(正文里的美元符号)", () => {
    const view = makeView("价格$5 和 $10 不同", [5]);
    expect(deleteDollarPair(view)).toBe(false);
  });

  it("开关关掉后不接管 Backspace", () => {
    configureLatexSuite({ autoDeleteDollar: false });
    const view = makeView("$$", [1]);
    expect(deleteDollarPair(view)).toBe(false);
  });
});

describe("deleteScriptBraces:上下标空花括号连标记一起删", () => {
  const atBrace = (doc: string) => doc.indexOf("}");

  it("`_{|}` 一次删干净,不留 `_}` 再按两下", () => {
    const doc = "$x_{}$";
    const view = makeView(doc, [atBrace(doc)]);
    expect(deleteScriptBraces(view)).toBe(true);
    expect(text(view)).toBe("$x$");
  });

  it("`^{|}` 同样一次删干净", () => {
    const doc = "$a^{}$";
    const view = makeView(doc, [atBrace(doc)]);
    expect(deleteScriptBraces(view)).toBe(true);
    expect(text(view)).toBe("$a$");
  });

  it("块级公式里同样生效", () => {
    const doc = "$$\nx_{}\n$$";
    const view = makeView(doc, [atBrace(doc)]);
    expect(deleteScriptBraces(view)).toBe(true);
    expect(text(view)).toBe("$$\nx\n$$");
  });

  it("嵌套时只删最内层那一对", () => {
    const doc = "$x_{a_{}}$";
    const view = makeView(doc, [atBrace(doc)]);
    expect(deleteScriptBraces(view)).toBe(true);
    expect(text(view)).toBe("$x_{a}$");
  });

  it("花括号里有内容:是普通删除,不接管", () => {
    const doc = "$x_{a}$";
    const view = makeView(doc, [doc.indexOf("}")]);
    expect(deleteScriptBraces(view)).toBe(false);
    expect(text(view)).toBe("$x_{a}$");
  });

  it("公式之外的 `_{}` 不碰(正文里 `_` 是强调标记)", () => {
    const doc = "x_{}";
    const view = makeView(doc, [atBrace(doc)]);
    expect(deleteScriptBraces(view)).toBe(false);
    expect(text(view)).toBe("x_{}");
  });

  it("有选区时不接管,交回默认删除", () => {
    const doc = "$x_{}$";
    const view = makeView(doc, [atBrace(doc)]);
    view.dispatch({ selection: EditorSelection.range(2, 5) });
    expect(deleteScriptBraces(view)).toBe(false);
  });
});

/** 假视图包一层带 snippetField 的 state:删的正是 sj 展开出的活动区,验证会话映射。 */
function viewWithState(initial: EditorState) {
  let state = initial;
  const view = {
    get state() {
      return state;
    },
    dispatch: (spec: TransactionSpec) => {
      state = state.update(spec).state;
    },
  };
  return { view: view as unknown as EditorView, state: () => state };
}

describe("deleteScriptBraces:sj/sk 会话存在时删掉整对", () => {
  it("会话被映射成删除点上的一个点,没有指向文档外的坐标", () => {
    const doc = "$x_{}$";
    // sj 的替换文本 `_{$0}` 展开在位置 2:base=2、活动区就是 `{}` 之间(位置 4)
    const session = buildSession(2, parseReplacement("_{$0}", [], null))!;
    const initial = EditorState.create({
      doc,
      extensions: [snippetField],
      selection: EditorSelection.cursor(4),
    }).update({ effects: setSession.of(session) }).state;
    const { view, state } = viewWithState(initial);

    expect(deleteScriptBraces(view)).toBe(true);
    expect(state().doc.toString()).toBe("$x$");
    expect(state().selection.main.head).toBe(2);

    const field = state().field(snippetField)!;
    expect(field.base).toBe(2);
    expect(field.end).toBe(2);
    expect(field.finalPos).toBe(2);
    expect(field.stops.get(0)![0]).toEqual({ from: 2, to: 2 });
    // 光标仍在这一层的点上:保留;再动一格就按既有规则正常弹掉,不留残层。
    expect(exitChain(field, 2)).toBe(field);
    expect(exitChain(field, 3)).toBeNull();
  });

  it("有外层会话时,删掉的只是内层那一层", () => {
    // 外层 \frac 占 [1,13)(分母 $1 是 active stop,内层 sj 就长在它里面)
    const outer: SnippetSession = {
      base: 1,
      end: 13,
      order: [0, 1],
      stops: new Map([
        [0, [{ from: 7, to: 7 }]],
        [1, [{ from: 9, to: 12 }]],
      ]),
      active: 1,
      finalPos: 13,
      parent: null,
    };
    const inner = buildSession(9, parseReplacement("_{$0}", [], null), outer)!;
    const initial = EditorState.create({
      doc: "$\\frac{}{_{}}$",
      extensions: [snippetField],
      selection: EditorSelection.cursor(11),
    }).update({ effects: setSession.of(inner) }).state;
    const { view, state } = viewWithState(initial);

    expect(deleteScriptBraces(view)).toBe(true);
    expect(state().doc.toString()).toBe("$\\frac{}{}$");

    const field = state().field(snippetField)!;
    expect(field.base).toBe(9);
    expect(field.parent).not.toBeNull();
    // 父链仍在,且整条随事务映射到新文档坐标(分母的 { } 收在删除点上)
    expect(field.parent!.base).toBe(1);
    expect(field.parent!.end).toBe(10);
    expect(field.parent!.stops.get(1)![0]).toEqual({ from: 9, to: 9 });
  });
});

describe("括号几何", () => {
  it("findMatchingBracket 前向配对(支持多字符括号)", () => {
    expect(findMatchingBracket("(a(b)c)", 0, "(", ")")).toBe(6);
    expect(findMatchingBracket("\\langle \\sum \\rangle", 0, "\\langle", "\\rangle")).toBe(13);
    expect(findMatchingBracket("(abc", 0, "(", ")")).toBe(-1);
  });

  it("反向配对:从闭括号找开括号", () => {
    expect(findMatchingBracket("(a(b)c)", 6, "(", ")", true)).toBe(0);
    expect(findMatchingBracket("\\frac{a}{b}", 10, "{", "}", true)).toBe(8);
  });

  it("withinEnv:同名环境嵌套时找真正包住光标的那一层", () => {
    const text2 = "\\pu{a \\pu{b} c}";
    const inner = text2.indexOf("b");
    expect(withinEnv(text2, inner, "\\pu{", "}")).toBe(true);
    const after = text2.length; // 环境之外
    expect(withinEnv(text2, after, "\\pu{", "}")).toBe(false);
  });

  it("enclosingBrackets:取最内层包围括号,光标在括号外返回 null", () => {
    expect(enclosingBrackets("x (a [b] c) y", 7)).toEqual({ left: 5, right: 7 });
    expect(enclosingBrackets("a b c", 3)).toBeNull();
  });
});

/**
 * 门禁：两个括号装饰构建器的**几何来源**。它们每次选区变化都会跑（光标高亮）
 * 或曾经每次都跑（彩色配对），所以谁读全文、谁跟选区无关，必须锁住：
 *   - 彩色配对只依赖文档 + 视口——插件因此不在 selectionSet 上重建；
 *   - 光标高亮只看光标处两个字符 + 它所在的那一个公式区域，不许把整篇文档
 *     字符串化（曾经的 `state.doc.toString()` 就是每次选区变化一次全文拷贝）。
 */
describe("括号装饰的几何来源", () => {
  /** 只用到 {state, visibleRanges} 的假视图。 */
  function decoView(doc: string, cursor: number, visible?: { from: number; to: number }) {
    const state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) });
    return { state, visibleRanges: [visible ?? { from: 0, to: doc.length }] };
  }
  const decos = (set: DecorationSet) => {
    const out: string[] = [];
    set.between(0, 1e9, (from, to, deco) => {
      out.push(`${(deco.spec as { class?: string }).class ?? "?"}@${from}-${to}`);
    });
    return out;
  };

  it("彩色配对与选区无关（同一文档两个不同光标 → 同一份装饰）", () => {
    const doc = "前置\n\n$$a+(b)\\cdot[c]$$\n\n后置\n";
    const a = decoView(doc, 0);
    const b = { state: a.state.update({ selection: EditorSelection.cursor(8) }).state, visibleRanges: a.visibleRanges };
    expect(decos(buildBracketColors(b))).toEqual(decos(buildBracketColors(a)));
    expect(decos(buildBracketColors(a)).length).toBeGreaterThan(0);
  });

  it("彩色配对只画视口范围内的公式", () => {
    const doc = "$$a+(b)$$\n\n中间隔开的一些正文\n\n$$c+[d]$$\n";
    const first = { from: 0, to: 10 };
    const marks = decos(buildBracketColors(decoView(doc, 0, first)));
    const open = doc.indexOf("(");
    const close = doc.indexOf(")");
    // 第一段公式的一对括号（最外层 → 0 号色）
    expect(marks).toEqual([
      `cw-bracket-0@${open}-${open + 1}`,
      `cw-bracket-0@${close}-${close + 1}`,
    ]);
    // 视口外的第二段公式（c+[d]）一个都不画
    expect(marks.every((m) => Number(m.split("@")[1].split("-")[0]) <= first.to)).toBe(true);
  });

  it("光标高亮:光标紧邻括号时给出配对的两个字符", () => {
    const doc = "$$a+(b+c)+d$$\n";
    const open = doc.indexOf("(");
    // 光标停在 `(` 之后（vim 的 i 态就是这种紧邻位置）
    const marks = decos(buildCursorBrackets(decoView(doc, open + 1)));
    expect(marks).toEqual([
      `cw-bracket-match@${open}-${open + 1}`,
      `cw-bracket-match@${doc.indexOf(")")}-${doc.indexOf(")") + 1}`,
    ]);
  });

  it("光标高亮:不在公式里就没有装饰（不做全库扫描）", () => {
    const doc = "普通文本 (含括号) 但不长在公式里\n";
    const open = doc.indexOf("(");
    expect(decos(buildCursorBrackets(decoView(doc, open + 1)))).toEqual([]);
  });

  it("光标高亮:长公式里也只按位置取字符（几何不依赖全文文本）", () => {
    const filler = "x_{1}+".repeat(400); // ~2000 字符
    const doc = `$$${filler}\\left(a+(b)\\right)$$\n`;
    const open = doc.indexOf("(b)");
    const marks = decos(buildCursorBrackets(decoView(doc, open + 1)));
    expect(marks).toEqual([
      `cw-bracket-match@${open}-${open + 1}`,
      `cw-bracket-match@${open + 2}-${open + 3}`,
    ]);
  });
});
