import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { cycleHeading, insertCallout, planHeaderTodoJump, toggleTodo, todayStamp } from "./ops";

/**
 * toggleTodo 只依赖 view 的 {state, dispatch} 面，用假视图即可在 node 里
 * 锁住「光标落在标记后」的选区模型（与 toggleList 同一模型）。
 */
function makeView(doc: string, cursors: number[]): EditorView {
  let state = EditorState.create({
    doc,
    // 多光标需要显式启用该 facet，否则 EditorState.create 折叠成单光标。
    extensions: [EditorState.allowMultipleSelections.of(true)],
    selection: EditorSelection.create(cursors.map((c) => EditorSelection.cursor(c))),
  });
  const view = {
    get state() {
      return state;
    },
    dispatch: (spec: TransactionSpec) => {
      state = state.update(spec).state;
    },
    focus: () => {},
  };
  return view as unknown as EditorView;
}

const pos = (view: EditorView) => view.state.selection.main.head;
const text = (view: EditorView) => view.state.doc.toString();

describe("toggleTodo 的光标落点（前缀区 → 新标记之后）", () => {
  it("空行切换待办：光标落在 `- [ ] ` 之后，可直接输入", () => {
    const view = makeView("", [0]);
    toggleTodo(view);
    expect(text(view)).toBe("- [ ] ");
    expect(pos(view)).toBe(6);
  });

  it("行首的普通文本行：光标落到标记与正文之间", () => {
    const view = makeView("hello", [0]);
    toggleTodo(view);
    expect(text(view)).toBe("- [ ] hello");
    expect(pos(view)).toBe(6);
  });

  it("正文中间的光标：经映射留在原字符上，不吸附到标记后", () => {
    const view = makeView("hello", [3]);
    toggleTodo(view);
    expect(text(view)).toBe("- [ ] hello");
    expect(pos(view)).toBe(9); // 原 col 3 的 "l"
  });

  it("行首的无序列表项：换成待办后光标同样落在标记后", () => {
    const view = makeView("- item", [0]);
    toggleTodo(view);
    expect(text(view)).toBe("- [ ] item");
    expect(pos(view)).toBe(6);
  });

  it("缩进行：光标在缩进内时落到缩进+标记之后", () => {
    const view = makeView("  text", [1]);
    toggleTodo(view);
    expect(text(view)).toBe("  - [ ] text");
    expect(pos(view)).toBe(8);
  });

  it("完成待办（→ [x] + 戳记）：选区不动，文本正确", () => {
    const view = makeView("- [ ] foo", [4]);
    toggleTodo(view);
    expect(text(view)).toBe(`- [x] foo ✅ ${todayStamp()}`);
    expect(pos(view)).toBe(4);
  });

  it("多光标跨行：后一行的落点计入前一行的前缀增量", () => {
    const view = makeView("\nabc", [0, 1]);
    toggleTodo(view);
    expect(text(view)).toBe("- [ ] \n- [ ] abc");
    const [first, second] = view.state.selection.ranges;
    expect(first.head).toBe(6); // 第一行（原空行）标记后
    expect(second.head).toBe(13); // 第二行标记后（7 + 6）
  });
});

describe("cycleHeading：重复按键在 正文→H1→H2→H3→H4→正文 间循环", () => {
  it("正文行第一次按：加一级标题前缀", () => {
    const view = makeView("标题文字", [2]);
    cycleHeading(view);
    expect(text(view)).toBe("# 标题文字");
  });

  it("逐级深入到 H4 后摘掉前缀，循环回正文再从 H1 重新开始", () => {
    const view = makeView("# 一", [0]);
    cycleHeading(view);
    expect(text(view)).toBe("## 一");
    cycleHeading(view);
    expect(text(view)).toBe("### 一");
    cycleHeading(view);
    expect(text(view)).toBe("#### 一");
    cycleHeading(view);
    expect(text(view)).toBe("一");
    cycleHeading(view);
    expect(text(view)).toBe("# 一");
  });

  it("H5/H6 不在循环里：下一档直接取消标题", () => {
    const view = makeView("##### 五", [3]);
    cycleHeading(view);
    expect(text(view)).toBe("五");
    const view6 = makeView("###### 六", [0]);
    cycleHeading(view6);
    expect(text(view6)).toBe("六");
  });

  it("多光标跨行：每行各前进一步，正文行从 H1 起", () => {
    const view = makeView("# a\nb\n## c", [0, 4, 9]);
    cycleHeading(view);
    expect(text(view)).toBe("## a\n# b\n### c");
  });

  it("空行也参与循环：加一级标题前缀", () => {
    const view = makeView("", [0]);
    cycleHeading(view);
    expect(text(view)).toBe("# ");
  });
});

describe("planHeaderTodoJump:⌘T 的往返决策", () => {
  const state = (doc: string) => EditorState.create({ doc }).doc;

  it("头部有待办块:正文光标跳到块尾行行尾", () => {
    const doc = "- [ ] 甲\n- [x] 乙\n\n正文第一行\n";
    const p = planHeaderTodoJump(state(doc), 4, false);
    expect(p).toEqual({ action: "jump", anchor: doc.indexOf("乙") + 1 });
  });

  it("块内光标 + 有来处记忆 → 回跳;无记忆 → 静默", () => {
    const doc = "- [ ] 甲\n\n正文\n";
    expect(planHeaderTodoJump(state(doc), 1, true)).toEqual({ action: "back" });
    expect(planHeaderTodoJump(state(doc), 1, false)).toEqual({ action: "stay" });
  });

  it("头部没有待办块:跳到第一行(新待办块长出来的位置)", () => {
    const doc = "# 标题\n\n正文\n";
    expect(planHeaderTodoJump(state(doc), 3, false)).toEqual({ action: "jump", anchor: 0 });
  });

  it("头部是空行也算无块:目标仍是第一行", () => {
    const doc = "\n\n正文\n";
    expect(planHeaderTodoJump(state(doc), 3, false)).toEqual({ action: "jump", anchor: 0 });
  });

  it("已在第一行且无块:有记忆则回跳,无记忆静默", () => {
    const doc = "正文\n- [ ] 块外的待办不算头部\n";
    expect(planHeaderTodoJump(state(doc), 1, true)).toEqual({ action: "back" });
    expect(planHeaderTodoJump(state(doc), 1, false)).toEqual({ action: "stay" });
  });

  it("头部扫描在首个非空非待办行截断:正文的待办不构成头部块", () => {
    const doc = "段落\n- [ ] 不是头部\n";
    expect(planHeaderTodoJump(state(doc), 2, false)).toEqual({ action: "jump", anchor: 0 });
  });

  it("空文档:光标本就在第一行,静默", () => {
    expect(planHeaderTodoJump(state(""), 1, false)).toEqual({ action: "stay" });
  });
});

describe("insertCallout:插入形状与光标落点", () => {
  it("空行插入:裸 ::: 开合,光标在块内内容空行行首", () => {
    const view = makeView("", [0]);
    insertCallout(view);
    expect(text(view)).toBe(":::\n\n:::");
    expect(pos(view)).toBe(4);
  });

  it("非空行插入:插到本行尾之后,光标同在内容空行行首", () => {
    const view = makeView("hello", [3]);
    insertCallout(view);
    expect(text(view)).toBe("hello\n:::\n\n:::");
    expect(pos(view)).toBe(10);
  });

  it("列表项内插入:内部空行与合栏继承缩进,光标在缩进之后", () => {
    const view = makeView("  - 项", [5]);
    insertCallout(view);
    expect(text(view)).toBe("  - 项\n:::\n  \n  :::");
    expect(pos(view)).toBe(12);
  });

  it("选区包裹:覆盖行整段收进块内,选区两端平移进块", () => {
    let state = EditorState.create({
      doc: "# 一\n正文行\n尾行",
      selection: EditorSelection.range(4, 10),
    });
    const view = {
      get state() {
        return state;
      },
      dispatch: (spec: TransactionSpec) => {
        state = state.update(spec).state;
      },
      focus: () => {},
    } as unknown as EditorView;
    insertCallout(view);
    expect(text(view)).toBe("# 一\n:::\n正文行\n尾行\n:::");
    const sel = view.state.selection.main;
    // 与 insertCodeBlock 同一条映射规则:选区起点恰在覆盖首行行首时保持原
    // doc 位置(= 新开栏行首),行尾端平移进块内。
    expect(sel.anchor).toBe(4); // 新开栏 ::: 行首
    expect(sel.head).toBe(14); // 尾行行尾
  });
});
