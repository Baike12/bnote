import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { cycleHeading, toggleTodo, todayStamp } from "./ops";

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
