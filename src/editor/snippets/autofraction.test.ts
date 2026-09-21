import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { autoFraction } from "./autofraction";
import { getSession, snippetsExtension, tryAutoExpand } from "./extension";

function frac(doc: string, cursor: number, visualText: string | null = null) {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) });
  return autoFraction(state, cursor, visualText);
}

describe("auto-fraction(latex-suite 语义移植)", () => {
  it("断字符截断:silu(x)=1/ → \\frac{1}{}", () => {
    const r = frac("$$silu(x)=1/", 12);
    expect(r).not.toBeNull();
    expect(r!.replacement.text).toBe("\\frac{1}{}");
    expect(r!.start).toBe(10); // "=" 之后
    expect(r!.end).toBe(12); // 连同刚键入的 / 一起替换
  });

  it("a+b/ → a+\\frac{b}{}(+ 是断字符)", () => {
    const r = frac("$$a+b/", 6);
    expect(r!.replacement.text).toBe("\\frac{b}{}");
    expect(r!.start).toBe(4);
  });

  it("无断字符:ab/ → \\frac{ab}{}", () => {
    expect(frac("$$ab/", 5)!.replacement.text).toBe("\\frac{ab}{}");
  });

  it("}/ 跳组:整个 \\frac{a}{b} 成为分子", () => {
    const r = frac("$$\\frac{a}{b}/", 14);
    expect(r!.replacement.text).toBe("\\frac{\\frac{a}{b}}{}");
    expect(r!.start).toBe(2);
  });

  it("(a+b)/ 剥掉外层括号 → \\frac{a+b}{}", () => {
    expect(frac("$$(a+b)/", 8)!.replacement.text).toBe("\\frac{a+b}{}");
  });

  it("希腊字母命令后的空格不是边界:\\alpha x/ → \\frac{\\alpha x}{}", () => {
    expect(frac("$$\\alpha x/", 11)!.replacement.text).toBe("\\frac{\\alpha x}{}");
  });

  it("指数闭合后照常展开:e^{xy}/ → \\frac{e^{xy}}{}", () => {
    expect(frac("$$e^{xy}/", 9)!.replacement.text).toBe("\\frac{e^{xy}}{}");
  });

  it("^{…} 内不展开(e^{x/} 保持字面)", () => {
    expect(frac("$$e^{x/}", 7)).toBeNull();
  });

  it("\\pu{…} 内不展开", () => {
    expect(frac("$$\\pu{x/}", 8)).toBeNull();
  });

  it("空分子不展开($$x + / 保持字面)", () => {
    expect(frac("$$x + /", 7)).toBeNull();
  });

  it("\\text{…} 内不展开", () => {
    expect(frac("$$\\text{a/b}$$", 10)).toBeNull();
  });

  it("非数学态不展开", () => {
    expect(frac("x/", 2)).toBeNull();
  });

  it("行内公式同样生效(闭合 $):$a+b/$ → \\frac{b}{}", () => {
    const r = frac("$a+b/$", 5);
    expect(r!.replacement.text).toBe("\\frac{b}{}");
  });

  it("分子不跨行(换行是停止字符)", () => {
    expect(frac("$$x\ny/", 6)!.replacement.text).toBe("\\frac{y}{}");
  });

  it("Tab 是断字符:x<Tab>/ 不展开", () => {
    expect(frac("$$x\t/", 5)).toBeNull();
  });

  it("选中文本即分子(visualText 路径)", () => {
    const r = frac("$$/", 3, "a+b");
    expect(r!.replacement.text).toBe("\\frac{a+b}{}");
    expect(r!.start).toBe(2);
    expect(r!.end).toBe(3);
  });
});

/** tryAutoExpand 是两条输入路径(inputHandler / vim listener)的汇合点:
 *  用假视图锁住 "/" 的端到端展开与光标落点($0 = 分母)。 */
function makeView(doc: string, cursor: number): EditorView {
  let state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) });
  const view = {
    get state() {
      return state;
    },
    dispatch: (spec: Parameters<typeof state.update>[0]) => {
      state = state.update(spec).state;
    },
    focus: () => {},
  };
  return view as unknown as EditorView;
}

describe("tryAutoExpand 汇合 auto-fraction", () => {
  it("/ 在数学块内展开,光标落入分母", () => {
    const view = makeView("$$silu(x)=1/", 12);
    expect(tryAutoExpand(view, "/", null)).toBe(true);
    expect(view.state.doc.toString()).toBe("$$silu(x)=\\frac{1}{}");
    expect(view.state.selection.main.head).toBe(19); // "{" 与 "}" 之间
  });

  it("非数学态的 / 原样插入,不吞不扩", () => {
    const view = makeView("x/", 2);
    expect(tryAutoExpand(view, "/", null)).toBe(false);
    expect(view.state.doc.toString()).toBe("x/");
  });

  /** 带完整片段扩展的假视图:会话字段真实存在,用于锁"会话期间 / 仍展开"。 */
  function makeSessionView(doc: string, cursor: number): EditorView {
    let state = EditorState.create({
      doc,
      extensions: [snippetsExtension()],
      selection: EditorSelection.cursor(cursor),
    });
    const view = {
      get state() {
        return state;
      },
      dispatch: (spec: Parameters<typeof state.update>[0]) => {
        state = state.update(spec).state;
      },
      focus: () => {},
    };
    return view as unknown as EditorView;
  }

  it("括号片段会话活跃时键入 / 仍展开(latex-suite 击键级语义)", () => {
    const view = makeSessionView("$$f(", 4);
    // "(" 自动片段 → 会话开启,光标在括号内
    expect(tryAutoExpand(view, "(", null)).toBe(true);
    expect(view.state.doc.toString()).toBe("$$f()");
    expect(getSession(view)).not.toBeNull();
    // 继续逐键键入(真实键入路径中会话横跨整行持续存活)
    for (const c of ["x", ")", "=", "1"]) {
      const at = view.state.selection.main.head;
      view.dispatch({ changes: { from: at, insert: c }, selection: { anchor: at + 1 } });
    }
    expect(getSession(view)).not.toBeNull();
    // / 已由输入路径插入;修复前被会话压制,这里必须照常展开
    const at = view.state.selection.main.head;
    view.dispatch({ changes: { from: at, insert: "/" }, selection: { anchor: at + 1 } });
    expect(tryAutoExpand(view, "/", null)).toBe(true);
    expect(view.state.doc.toString()).toBe("$$f(x)=\\frac{1}{})");
  });

  // 多字符提交(IME 整串上屏以 / 结尾)与 composition 延迟展开走的是
  // autoExpandVimListener / 轮询路径,需要真实 EditorView 的更新监听器,
  // 无 DOM 的 vitest 模拟不了——由浏览器 harness 协议验证(docC/docD 场景)。
});
