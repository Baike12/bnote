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
    expect(r!.start).toBe(10); // After "="
    expect(r!.end).toBe(12); // The freshly typed `/` is replaced too.
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

/** tryAutoExpand is where the two input paths (inputHandler / vim listener)
 *  meet: the fake view locks the end-to-end expansion of "/" and the caret
 *  landing point ($0 = the denominator). */
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
    expect(view.state.selection.main.head).toBe(19); // Between "{" and "}"
  });

  it("非数学态的 / 原样插入,不吞不扩", () => {
    const view = makeView("x/", 2);
    expect(tryAutoExpand(view, "/", null)).toBe(false);
    expect(view.state.doc.toString()).toBe("x/");
  });

  /** A fake view with the full snippet extension: the session field really
   *  exists, so this locks "while a session is active, `/` still expands". */
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
    // The "(" auto snippet opens a session with the caret inside the bracket.
    expect(tryAutoExpand(view, "(", null)).toBe(true);
    expect(view.state.doc.toString()).toBe("$$f()");
    expect(getSession(view)).not.toBeNull();
    // Keep typing key by key (on the real typing path the session stays alive
    // across the whole line).
    for (const c of ["x", ")", "=", "1"]) {
      const at = view.state.selection.main.head;
      view.dispatch({ changes: { from: at, insert: c }, selection: { anchor: at + 1 } });
    }
    expect(getSession(view)).not.toBeNull();
    // The input path has already inserted the "/"; before the fix the session
    // suppressed it, here it must expand as usual.
    const at = view.state.selection.main.head;
    view.dispatch({ changes: { from: at, insert: "/" }, selection: { anchor: at + 1 } });
    expect(tryAutoExpand(view, "/", null)).toBe(true);
    expect(view.state.doc.toString()).toBe("$$f(x)=\\frac{1}{})");
  });

  // A multi-character commit (the IME pushes the whole string ending in "/")
  // and the deferred expansion after composition go through the
  // autoExpandVimListener / polling path, which needs a real EditorView
  // update listener; vitest without DOM cannot fake that — the browser
  // harness protocol covers it (docC/docD scenarios).
});
