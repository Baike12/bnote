import { beforeEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { planTabout, tabout } from "./tabout";
import {
  buildSession,
  closeBracketSkip,
  exitChain,
  runShiftTab,
  runTab,
  setSession,
  snippetField,
  type SnippetSession,
} from "./extension";
import { parseReplacement } from "./engine";
import { matrixSeparator } from "./matrix";
import { configureLatexSuite, resetLatexConfig } from "./config";

beforeEach(() => {
  resetLatexConfig();
});

/** 只依赖 view 的 {state, dispatch} 面(与 session.test.ts / ops.test.ts 同款)。 */
function makeView(
  doc: string,
  cursors: number[] = [doc.length],
  session: SnippetSession | null = null,
): EditorView {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.create(cursors.map((c) => EditorSelection.cursor(c))),
    extensions: [snippetField],
  });
  if (session) state = state.update({ effects: setSession.of(session) }).state;
  const view = {
    get state() {
      return state;
    },
    dispatch: (spec: TransactionSpec) => {
      state = state.update(spec).state;
    },
    focus: () => {},
    composing: false,
  };
  return view as unknown as EditorView;
}

const text = (view: EditorView) => view.state.doc.toString();
const head = (view: EditorView) => view.state.selection.main.head;
const at = (doc: string, cursor: number) => planTabout(EditorState.create({ doc }), cursor);

describe("planTabout:向后扫到一个闭合符就跨过去(一次一层)", () => {
  it("光标对着 \\right) 的 `)`:跨到它后面,一个字都不改", () => {
    const doc = "$\\left( x \\right)$";
    const closers = doc.indexOf(")");
    expect(at(doc, doc.indexOf("\\right)")!)).toEqual({ pos: closers + 1, changes: [] });
  });

  it("多个括号叠在一起:一次 Tab 只出一层,逐层走完", () => {
    // 光标在 \frac{a}{x} 的 x 之后:`}` → `)` → 闭合 `$`,三次 Tab 才彻底出去
    const doc = "$\\frac{a}{x}(y)$";
    const step1 = at(doc, doc.indexOf("x") + 1)!;
    expect(step1.pos).toBe(doc.indexOf("}(y)") + 1); // 分母的右花括号
    const step2 = at(doc, step1.pos)!;
    expect(step2.pos).toBe(doc.indexOf(")") + 1); // (y) 的右圆括号
    const step3 = at(doc, step2.pos)!;
    expect(step3.pos).toBe(doc.length); // 越过闭合 $,落到公式外
    expect(at(doc, step3.pos)).toBeNull(); // 已经在公式外:不再接管 Tab
  });

  it("\\rangle 整体跨过去(它不以可扫单字符收尾)", () => {
    const doc = "$\\langle x \\rangle$";
    const pos = doc.indexOf("\\rangle");
    expect(at(doc, pos)).toEqual({ pos: pos + "\\rangle".length, changes: [] });
  });

  it("`|` 与 `>` 也在扫描表里(插件原表)", () => {
    expect(at("$a|b$", 1)).toEqual({ pos: 3, changes: [] }); // 跳过 a,落在 | 之后
    expect(at("$a>b$", 1)).toEqual({ pos: 3, changes: [] });
  });

  it("光标后面还有普通字符:不接管(只跳闭合符,不跳内容)", () => {
    const doc = "$a)b$";
    expect(at(doc, 3)).toBeNull(); // `)` 在光标**之前**,扫描只向后看
  });

  it("正文里的 Tab 不动(只在公式里生效)", () => {
    expect(at("普通文本(说明)", 2)).toBeNull();
    const doc = "正文\n\n$(x)$";
    expect(at(doc, doc.indexOf("正文"))).toBeNull();
  });

  it("光标压在定界符上(公式首尾那两三个 $):不是跳出场景", () => {
    const inline = "$(x)$";
    expect(at(inline, 0)).toBeNull(); // 压在开 $ 上
    expect(at(inline, inline.length)).toBeNull(); // 压在闭 $ 上
    const block = "$$\n(x)\n$$";
    expect(at(block, 1)).toBeNull(); // 压在开 $$ 的第二个 $ 上
    expect(at(block, block.length - 1)).toBeNull(); // 压在闭 $$ 的第一个 $ 上
  });
});

describe("planTabout:公式尾巴上的整块跳出", () => {
  it("行内公式:光标已在内容末尾 → 落到闭合 $ 之后(一次跳出公式)", () => {
    const doc = "$x$";
    expect(at(doc, 2)).toEqual({ pos: doc.length, changes: [] });
  });

  it("内容以空白收尾的 `$x $` 压根不是公式(行内区域不允许这样收尾)", () => {
    expect(at("$x $", 2)).toBeNull();
  });

  it("块级公式:落到底部 $$ 的下一行行首,并清掉光标行的行尾空白", () => {
    const doc = "$$\nE[q]   \n$$\n下一段";
    const plan = at(doc, doc.indexOf("E[q]") + 4)!;
    // 行尾三个空格被吃掉,落点跟着左移:下一段的首字符从 14 变到 11
    expect(plan.changes).toEqual([
      { from: doc.indexOf("E[q]"), to: doc.indexOf("E[q]") + 7, insert: "E[q]" },
    ]);
    expect(plan.pos).toBe(11);
    const preview = doc.slice(0, doc.indexOf("E[q]") + 4).trimEnd() + doc.slice(doc.indexOf("E[q]") + 7);
    expect(preview.slice(plan.pos)).toBe("下一段");
  });

  it("块级公式:行首缩进保留(列表项里是 markdown 结构,不做 trim)", () => {
    const doc = "$$\n  E[q]  \n$$\n下一段";
    const plan = at(doc, doc.indexOf("E[q]") + 4)!;
    expect(plan.changes).toEqual([
      { from: doc.indexOf("E[q]") - 2, to: doc.indexOf("E[q]") + 6, insert: "  E[q]" },
    ]);
    expect(plan.pos).toBe(doc.indexOf("下一段") - 2);
  });

  it("底部 $$ 已经是末行:先补一个换行才有下一行可落", () => {
    const doc = "$$\nx\n$$";
    const plan = at(doc, doc.indexOf("x") + 1)!;
    expect(plan.changes).toEqual([{ from: doc.length, to: doc.length, insert: "\n" }]);
    expect(plan.pos).toBe(doc.length + 1);
  });

  it("光标停在内容中间(后面还有字符):不整块跳出", () => {
    expect(at("$$\nx\ny\n$$", 4)).toBeNull();
  });
});

describe("tabout:派发与开关", () => {
  it("按计划落光标,块级收尾改动一起派发", () => {
    const doc = "$$\nx   \n$$\n下一段";
    const view = makeView(doc, [doc.indexOf("x") + 1]);
    expect(tabout(view)).toBe(true);
    expect(text(view)).toBe("$$\nx\n$$\n下一段");
    expect(text(view).slice(head(view))).toBe("下一段");
  });

  it("没有可跳的位置:交回后续处理(false,不吞掉 Tab)", () => {
    const view = makeView("正文段落", [0]);
    expect(tabout(view)).toBe(false);
    expect(text(view)).toBe("正文段落");
  });

  it("开关关掉后完全不接管(插件 taboutEnabled)", () => {
    configureLatexSuite({ tabout: false });
    const view = makeView("$(x)$", [2]);
    expect(tabout(view)).toBe(false);
  });
});

describe("Tab 链路次序:会话 → 展开 → tabout(插件 handleKeydown 的顺序)", () => {
  const DM = "$$\n\\begin{pmatrix}\nQ & b\n\\end{pmatrix}\n$$";

  it("有会话:Tab 走制表位,不做 tabout", () => {
    const doc = "$\\mathbf{}$";
    const session = buildSession(1, parseReplacement("\\mathbf{$0}$1", [], null))!;
    const view = makeView(doc, [doc.indexOf("}")], session);
    expect(runTab(view)).toBe(true);
    expect(head(view)).toBe(doc.indexOf("}$") + 1); // 走到 $1(右括号之后)
    expect(text(view)).toBe(doc); // 只移光标,不改文档
    expect(view.state.field(snippetField)).not.toBeNull(); // 会话还在
  });

  it("会话走完后的那次 Tab 才轮到 tabout:光标从括号里出来", () => {
    // sum 片段展开 + autoEnlarge 之后的真实形状:光标停在 \sum… 之后,外面还有 \right)
    const doc = "$\\left( \\sum_{i=1}^{N} \\right)$";
    const pos = doc.indexOf("\\sum");
    const session = buildSession(
      pos,
      parseReplacement("\\sum_{${0:i}=${1:1}}^{${2:N}} $3", [], null),
    )!;
    const view = makeView(doc, [doc.indexOf("\\right)")], session);
    // 会话还没走完:Tab 只推进制表位
    runTab(view);
    expect(view.state.field(snippetField, false)).not.toBeNull();
    // 会话结束后再按 Tab:这一下才是"跳出括号"——一次一层,直到出了右括号
    for (let i = 0; i < 6; i++) runTab(view);
    expect(head(view)).toBeGreaterThan(doc.indexOf(")"));
  });

  it("无会话无片段可展开:Tab 落到 tabout(不再掉进 indentMore)", () => {
    const doc = "$$\n\\left( x \\right)\n$$";
    const view = makeView(doc, [doc.indexOf("\\right)")]);
    expect(runTab(view)).toBe(true);
    expect(head(view)).toBe(doc.indexOf(")") + 1);
    expect(text(view)).toBe(doc); // 只是移光标,不改文档
  });

  it("矩阵里普通 Tab 不再插 ` & `(留给 tabout),Shift+Tab 才是列分隔", () => {
    const separator = makeView(DM, [DM.indexOf("Q")]);
    expect(matrixSeparator(separator)).toBe(true);
    expect(text(separator)).toBe(DM.replace("Q", " & Q"));

    const tabbed = makeView(DM, [DM.indexOf("Q")]);
    expect(runTab(tabbed)).toBe(true);
    expect(text(tabbed)).toBe(DM); // 没往公式里插 ` & `

    const shifted = makeView(DM, [DM.indexOf("Q")]);
    expect(runShiftTab(shifted)).toBe(true);
    expect(text(shifted)).toBe(DM.replace("Q", " & Q"));
  });

  it("矩阵里连按 Tab:一次一层地把光标送到 \\end{pmatrix} 之后", () => {
    const view = makeView(DM, [DM.indexOf("Q")]);
    expect(runTab(view)).toBe(true);
    // 行尾之后只剩 `}`(环境收尾)与空白:第一下就跨过 \end{pmatrix}
    expect(head(view)).toBe(DM.indexOf("\\end{pmatrix}") + "\\end{pmatrix}".length);
    // 再一下:光标后面只剩空白 → 落到底部 $$ 的下一行(文档末行之后)
    expect(runTab(view)).toBe(true);
    expect(text(view).slice(head(view)).trim()).toBe("");
  });

  it("Shift+Tab 在非矩阵处退回上一个制表位(不吞键、不乱插 &)", () => {
    const doc = "$\\mathbf{}$";
    const session = buildSession(1, parseReplacement("\\mathbf{$0}$1", [], null))!;
    const view = makeView(doc, [doc.indexOf("}$")], { ...session, active: 1 });
    expect(runShiftTab(view)).toBe(true);
    expect(text(view)).toBe(doc);
    expect(head(view)).toBe(doc.indexOf("}")); // 回到 $0
  });
});

describe("闭括号跳越:敲下光标前那个右括号 = 一次 Tab", () => {
  const session = () => buildSession(0, parseReplacement("($0)$1", [], null))!;

  it("括号片段展开后敲 `)`:不重复插入,直接跳出这一层", () => {
    const view = makeView("()", [1], session());
    expect(view.state.field(snippetField)!.order).toEqual([0, 1]);
    const before = view.state;
    // 默认插入事务(vim 与非 vim 的打字路径在这里汇合)
    view.dispatch({
      changes: { from: 1, insert: ")" },
      selection: { anchor: 2 },
      userEvent: "input.type",
    });
    expect(text(view)).toBe("())"); // 多出来的那一个(事后判定要处理的中间态)
    expect(closeBracketSkip(view, before, { from: 1, to: 1, insert: ")" }, 2)).toBe(true);
    expect(text(view)).toBe("()"); // 撤掉刚插进去的那个,原位那个留着
    expect(head(view)).toBe(2); // 光标跳出到 $1
  });

  it("最后一个制表位:按插件原样放行(字符照插)", () => {
    const view = makeView("()", [1], { ...session(), active: 1 });
    const before = view.state;
    view.dispatch({
      changes: { from: 2, insert: ")" },
      selection: { anchor: 3 },
      userEvent: "input.type",
    });
    expect(closeBracketSkip(view, before, { from: 2, to: 2, insert: ")" }, 3)).toBe(false);
    expect(text(view)).toBe("())");
  });

  it("光标前不是同一个右括号:不接管(正常输入)", () => {
    const view = makeView("(x", [2], session());
    const before = view.state;
    view.dispatch({
      changes: { from: 2, insert: ")" },
      selection: { anchor: 3 },
      userEvent: "input.type",
    });
    expect(closeBracketSkip(view, before, { from: 2, to: 2, insert: ")" }, 3)).toBe(false);
  });

  it("没有会话:不接管(插件在没有 tabstop 时也是照插)", () => {
    const view = makeView("()", [1]);
    const before = view.state;
    view.dispatch({
      changes: { from: 1, insert: ")" },
      selection: { anchor: 2 },
      userEvent: "input.type",
    });
    expect(closeBracketSkip(view, before, { from: 1, to: 1, insert: ")" }, 2)).toBe(false);
  });

  it("`]` 同样跳越(插件表里只有三种右括号)", () => {
    const view = makeView("[]", [1], session());
    const before = view.state;
    view.dispatch({
      changes: { from: 1, insert: "]" },
      selection: { anchor: 2 },
      userEvent: "input.type",
    });
    expect(closeBracketSkip(view, before, { from: 1, to: 1, insert: "]" }, 2)).toBe(true);
    expect(text(view)).toBe("[]");
  });
});

describe("会话与 tabout 的接缝", () => {
  it("tabout 把光标带出会话范围后,exitChain 收掉会话", () => {
    const session = buildSession(0, parseReplacement("($0)$1", [], null))!;
    const doc = "$(x)$";
    const out = doc.indexOf(")") + 1;
    expect(exitChain(session, out)).toBeNull();
  });
});
