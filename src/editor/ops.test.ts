import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { calloutInsertAnchor, cycleHeading, insertCallout, insertMathBlock, jumpHeaderTodos, planCalloutShortcut, planHeaderTodoJump, resetCalloutReturnForTest, resetHeaderTodoReturnForTest, toggleTodo, todayStamp } from "./ops";
import { matrixEnter } from "./snippets/matrix";
import { calloutRegions } from "./callout";
import { useAppStore } from "@/state/appStore";

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
    scrollDOM: { scrollTop: 0, scrollHeight: 0 },
    focus: () => {},
  };
  return view as unknown as EditorView;
}

const pos = (view: EditorView) => view.state.selection.main.head;
const text = (view: EditorView) => view.state.doc.toString();

/** 单选区假视图（需要真实选区而非光标的用例，如选中插入 callout）。 */
function makeRangeView(doc: string, from: number, to: number): EditorView {
  let state = EditorState.create({ doc, selection: EditorSelection.range(from, to) });
  return {
    get state() {
      return state;
    },
    dispatch: (spec: TransactionSpec) => {
      state = state.update(spec).state;
    },
    scrollDOM: { scrollTop: 0, scrollHeight: 0 },
    focus: () => {},
  } as unknown as EditorView;
}

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
  // 日记分支的插入串无尾换行,光标 = at + insert.length;
  // 普通笔记分支插入串带尾换行,光标要显式给(仍落在 `- [ ] ` 行尾)。
  const create = (at: number, insert: string, cursor = at + insert.length) => ({
    action: "create",
    at,
    insert,
    cursor,
  });

  it("头部有待办块:正文光标跳到块尾行行尾", () => {
    const doc = "- [ ] 甲\n- [x] 乙\n\n正文第一行\n";
    const p = planHeaderTodoJump(state(doc), 4, false, false);
    expect(p).toEqual({ action: "jump", anchor: doc.indexOf("乙") + 1 });
  });

  it("日记形状:H1 之后的待办区就是头部块(跳到块尾行行尾)", () => {
    const doc = "# 1 2026-10-05\n- [ ] 甲\n- [x] 乙\n\n正文\n";
    const p = planHeaderTodoJump(state(doc), 6, false, true);
    expect(p).toEqual({ action: "jump", anchor: doc.indexOf("乙") + 1 });
  });

  it("日记:第一行就是待办(H1 之前的待办区同样认)", () => {
    const doc = "- [ ] 甲\n# 1 2026-10-05\n\n正文\n";
    const p = planHeaderTodoJump(state(doc), 4, false, true);
    expect(p).toEqual({ action: "jump", anchor: doc.indexOf("甲") + 1 });
  });

  it("块内光标 + 有来处记忆 → 回跳;无记忆 → 静默", () => {
    const doc = "- [ ] 甲\n\n正文\n";
    expect(planHeaderTodoJump(state(doc), 1, true, false)).toEqual({ action: "back" });
    expect(planHeaderTodoJump(state(doc), 1, false, false)).toEqual({ action: "stay" });
  });

  it("无块 + 正文光标:创建在文档顶,光标在待办符号后", () => {
    const doc = "段落\n\n正文\n";
    expect(planHeaderTodoJump(state(doc), 3, false, false)).toEqual(create(0, "- [ ] \n", 6));
  });

  it("无块 + 文档以空行开头:创建仍在文档顶", () => {
    const doc = "\n\n正文\n";
    expect(planHeaderTodoJump(state(doc), 3, false, false)).toEqual(create(0, "- [ ] \n", 6));
  });

  it("普通笔记第一行是 H1 标题、无待办:创建在文件最顶,标题被顶到第二行", () => {
    const doc = "# 论 transformer\n\n正文\n";
    expect(planHeaderTodoJump(state(doc), 3, false, false)).toEqual(create(0, "- [ ] \n", 6));
  });

  it("普通笔记:头部待办区就是文件最顶,H1 之后的待办不算(照旧创建在最顶)", () => {
    const doc = "# 论 transformer\n- [ ] 正文中的待办\n";
    expect(planHeaderTodoJump(state(doc), 2, false, false)).toEqual(create(0, "- [ ] \n", 6));
  });

  it("无块 + 日记正文光标:创建在 H1 之后(日记待办区的位置)", () => {
    const doc = "# 1 2026-10-05\n\n正文\n";
    expect(planHeaderTodoJump(state(doc), 3, false, true)).toEqual(create(14, "\n- [ ] "));
  });

  it("无块 + 光标在标题行:日记有记忆回跳,无记忆就地创建", () => {
    const doc = "# 1 2026-10-05\n";
    expect(planHeaderTodoJump(state(doc), 1, true, true)).toEqual({ action: "back" });
    expect(planHeaderTodoJump(state(doc), 1, false, true)).toEqual(create(14, "\n- [ ] "));
  });

  it("无块 + 光标在文档首行:有记忆回跳,无记忆创建", () => {
    const doc = "正文\n- [ ] 块外的待办不算头部\n";
    expect(planHeaderTodoJump(state(doc), 1, true, false)).toEqual({ action: "back" });
    expect(planHeaderTodoJump(state(doc), 1, false, false)).toEqual(create(0, "- [ ] \n", 6));
  });

  it("头部扫描在首个非空非待办行截断:正文的待办不构成头部块(光标在正文→创建)", () => {
    const doc = "段落\n- [ ] 不是头部\n";
    expect(planHeaderTodoJump(state(doc), 2, false, false)).toEqual(create(0, "- [ ] \n", 6));
  });

  it("空文档:创建,不加尾换行", () => {
    expect(planHeaderTodoJump(state(""), 1, false, false)).toEqual(create(0, "- [ ] "));
  });
});

describe("jumpHeaderTodos:⌘T 创建空待办端到端", () => {
  const setFile = (path: string) => useAppStore.setState({ currentFile: path });

  it("日记无待办:创建空待办光标落符号后;输入后再按 ⌘T 回到正文原位", () => {
    resetHeaderTodoReturnForTest(); // 模块级往返记忆会跨用例泄漏
    setFile("/v/Daily/2026-10-05.md");
    // 正文行(行 3)列 2 处按 ⌘T
    const view = makeView("# 1 2026-10-05\n\n正文在这里\n", [18]);
    jumpHeaderTodos(view);
    expect(text(view)).toBe("# 1 2026-10-05\n- [ ] \n\n正文在这里\n");
    expect(pos(view)).toBe(21); // `- [ ] ` 行尾,待办符号后
    // 用户直接输入待办内容(同行打字不影响来处的行列锚)
    view.dispatch({ changes: [{ from: 21, insert: "第一件事" }] });
    expect(text(view)).toBe("# 1 2026-10-05\n- [ ] 第一件事\n\n正文在这里\n");
    // 新待办行已是头部块,且有来处记忆 → 精确回到创建前的正文行列
    jumpHeaderTodos(view);
    const cur = view.state.doc.lineAt(pos(view));
    expect(cur.number).toBe(4); // 「正文在这里」行(创建把它顶到了行 4)
    expect(pos(view) - cur.from).toBe(2); // 列 2,与创建前一致
  });

  it("普通笔记无待办:创建在文档顶,原内容被顶到下一行", () => {
    resetHeaderTodoReturnForTest();
    setFile("/v/笔记.md");
    const view = makeView("笔记正文\n", [2]);
    jumpHeaderTodos(view);
    expect(text(view)).toBe("- [ ] \n笔记正文\n");
    expect(pos(view)).toBe("- [ ] ".length);
  });

  it("普通笔记(H1 标题开头)无待办:待办成为第一行;再按 ⌘T 回到正文原位", () => {
    resetHeaderTodoReturnForTest();
    setFile("/v/笔记.md");
    const view = makeView("# 论 transformer\n\n正文\n", [17]); // 「正文」行行首
    jumpHeaderTodos(view);
    expect(text(view)).toBe("- [ ] \n# 论 transformer\n\n正文\n");
    expect(pos(view)).toBe("- [ ] ".length);
    // 待办行就是头部块 → 再按回到创建前的正文行列(创建把它顶到了行 4)
    jumpHeaderTodos(view);
    const cur = view.state.doc.lineAt(pos(view));
    expect(cur.text).toBe("正文");
    expect(pos(view) - cur.from).toBe(0);
  });
});

describe("insertCallout:插入形状与光标落点", () => {
  it("空行插入:开栏带标题槽、闭栏紧跟其后(两栏之间不预置空行)", () => {
    const view = makeView("", [0]);
    insertCallout(view);
    expect(text(view)).toBe("::: \n:::");
    expect(pos(view)).toBe(4); // 标题槽之后:直接开写标题
  });

  it("非空行插入:插到本行尾之后,光标同在标题槽之后", () => {
    const view = makeView("hello", [3]);
    insertCallout(view);
    expect(text(view)).toBe("hello\n::: \n:::");
    expect(pos(view)).toBe(10);
  });

  it("列表项内插入:两栏都落栏 0(缩进的闭栏永远关不上块)", () => {
    const view = makeView("  - 项", [5]);
    insertCallout(view);
    expect(text(view)).toBe("  - 项\n::: \n:::");
    expect(pos(view)).toBe(10);
  });

  it("落点即标题槽:直接输入的文字成为 callout 标题,回车即正文行", () => {
    const view = makeView("", [0]);
    insertCallout(view);
    const slot = pos(view);
    // 打字:文本落在槽内,光标跟在文字之后(输入管线的形状——光标随输入右移)
    view.dispatch({
      changes: { from: slot, insert: "正则化" },
      selection: { anchor: slot + "正则化".length },
    });
    expect(text(view)).toBe("::: 正则化\n:::");
    expect(calloutRegions(view.state)[0].title).toBe("正则化");
    // 回车:光标所在的新行成为块内正文行,标题归属不变(两栏之间无空行)
    const at = pos(view);
    view.dispatch({ changes: { from: at, insert: "\n" }, selection: { anchor: at + 1 } });
    expect(text(view)).toBe("::: 正则化\n\n:::");
    expect(view.state.doc.lineAt(pos(view)).number).toBe(2);
    expect(calloutRegions(view.state)[0].title).toBe("正则化");
  });

  it("插入的块一定被扫描器闭合(空行/正文行/列表行三种来处)", () => {
    for (const doc of ["", "hello", "  - 项"]) {
      const view = makeView(doc, [doc.length]);
      insertCallout(view);
      const regions = calloutRegions(view.state);
      expect(regions, `doc=${JSON.stringify(doc)}`).toHaveLength(1);
      expect(regions[0].closed, `doc=${JSON.stringify(doc)}`).toBe(true);
    }
  });

  it("选中插入:块建在选区行之后(空一行),原文留原处,光标落块内空行", () => {
    const view = makeRangeView("开头\n斜率矩阵\n结尾", 3, 7); // 选中「斜率矩阵」
    insertCallout(view);
    expect(text(view)).toBe("开头\n斜率矩阵\n\n::: 斜率矩阵\n\n:::\n结尾");
    const cur = view.state.doc.lineAt(pos(view));
    expect(cur.text).toBe(""); // 块内空行:直接输入就是解释内容
    expect(cur.number).toBe(5);
    expect(view.state.sliceDoc(3, 7)).toBe("斜率矩阵"); // 原文一个字节没动
    const regions = calloutRegions(view.state);
    expect(regions).toHaveLength(1);
    expect(regions[0].title).toBe("斜率矩阵");
    expect(regions[0].closed).toBe(true);
  });

  it("选区行与开栏之间恰好空一行,块后的内容保留", () => {
    const cases: [string, number, number, string][] = [
      // doc, 选区, 期望
      ["甲", 0, 1, "甲\n\n::: 甲\n\n:::"],
      ["甲\n乙", 0, 1, "甲\n\n::: 甲\n\n:::\n乙"],
      ["甲\n\n乙", 0, 1, "甲\n\n::: 甲\n\n:::\n\n乙"],
    ];
    for (const [doc, from, to, want] of cases) {
      const view = makeRangeView(doc, from, to);
      insertCallout(view);
      expect(text(view), JSON.stringify(doc)).toBe(want);
    }
  });

  it("跨行选区:标题压成单行(换行→空格),块建在选区末行之后", () => {
    const view = makeRangeView("甲\n乙丙", 0, 3); // 选中「甲\n乙」
    insertCallout(view);
    expect(text(view)).toBe("甲\n乙丙\n\n::: 甲 乙\n\n:::");
    expect(calloutRegions(view.state)[0].title).toBe("甲 乙");
  });

  it("选中插入不吞公式/图片链接源码:标题原样保留", () => {
    const doc = "前\n$$E=mc^2$$\n后";
    const view = makeRangeView(doc, 2, 12); // 选中 $$E=mc^2$$
    insertCallout(view);
    expect(text(view)).toBe("前\n$$E=mc^2$$\n\n::: $$E=mc^2$$\n\n:::\n后");
    expect(calloutRegions(view.state)[0].title).toBe("$$E=mc^2$$");
  });

  it("锚点往返:光标在原文上按 ⌘⇧B 跳到块,再按回到原文", () => {
    resetCalloutReturnForTest();
    useAppStore.setState({ currentFile: "/v/笔记.md" });
    const doc = "开头\n斜率矩阵\n结尾\n\n::: 斜率矩阵\n\n:::\n";
    const view = makeView(doc, [3]); // 光标落在原文「斜率矩阵」里
    insertCallout(view);
    // 落点 = 开栏行行尾(标题槽后),与创建选中块时的落点同一位置
    const cur = view.state.doc.lineAt(pos(view));
    expect(cur.text).toBe("::: 斜率矩阵");
    expect(pos(view)).toBe(cur.to);
    // 再按:已在块内且有来处记忆 → 回到原文
    insertCallout(view);
    expect(pos(view)).toBe(3);
  });

  it("callout 内无来处记忆:照旧就地开新块(不跳转)", () => {
    resetCalloutReturnForTest();
    useAppStore.setState({ currentFile: "/v/笔记.md" });
    const view = makeView("::: 甲\n内容\n:::\n", [8]);
    insertCallout(view);
    expect(text(view)).toBe("::: 甲\n内容\n::: \n:::\n:::\n");
  });

  it("选区是纯空白:不建空标题块,按无选区处理(就地开空块)", () => {
    const view = makeRangeView("甲 乙", 1, 2); // 选中一个空格
    insertCallout(view);
    expect(text(view)).toBe("甲 乙\n::: \n:::");
    expect(calloutRegions(view.state)[0].title).toBe("");
  });
});

describe("calloutInsertAnchor:选中插入的落点", () => {
  const anchorOf = (doc: string, from: number, to: number) => {
    const state = EditorState.create({ doc });
    return calloutInsertAnchor(state, from, to);
  };

  it("普通文本:选区末行的行尾(块之后原有的内容被推到块后)", () => {
    const doc = "第一行\n第二行\n第三行";
    expect(anchorOf(doc, 0, 3)).toBe(3); // 选区在行 1
    expect(anchorOf(doc, 4, 8)).toBe(7); // 选区带行尾换行,仍算行 2
  });

  it("围栏代码块内:延伸到闭栏行行尾(不切开代码块)", () => {
    expect(anchorOf("```py\ncode line\n```\n后文", 6, 15)).toBe(19);
  });

  it("未闭合围栏内:延伸到文档末行行尾", () => {
    expect(anchorOf("```py\ncode", 6, 10)).toBe(10);
  });

  it("display 公式块内:延伸到闭 $$ 行行尾", () => {
    expect(anchorOf("前\n$$\nE=mc^2\n$$\n后", 5, 11)).toBe(14);
  });

  it("单行 display 公式:落点就是本行行尾", () => {
    expect(anchorOf("前\n$$E=mc^2$$\n后", 2, 12)).toBe(12);
  });
});

describe("planCalloutShortcut:无选区 ⌘⇧B 的决策", () => {
  const mk = (doc: string) => {
    const state = EditorState.create({ doc });
    return { doc: state.doc, callouts: calloutRegions(state) };
  };

  it("光标在锚点文本内:跳到关联 callout", () => {
    const { doc, callouts } = mk("斜率矩阵\n\n::: 斜率矩阵\n\n:::\n");
    const p = planCalloutShortcut(doc, callouts, 1, false);
    expect(p.action).toBe("anchor-jump");
    if (p.action === "anchor-jump") expect(p.region.title).toBe("斜率矩阵");
  });

  it("光标恰在锚点末尾之外(区间右开):不跳,就地插入", () => {
    const { doc, callouts } = mk("斜率矩阵\n\n::: 斜率矩阵\n\n:::\n");
    expect(planCalloutShortcut(doc, callouts, 4, false)).toEqual({ action: "insert" });
  });

  it("光标在 callout 内(含边界行):有来处记忆回跳,无记忆就地插入", () => {
    const { doc, callouts } = mk("正文\n\n::: 甲\n\n:::\n");
    const inside = doc.line(3).from + 1; // 「::: 甲」行内
    expect(planCalloutShortcut(doc, callouts, inside, true)).toEqual({ action: "back" });
    expect(planCalloutShortcut(doc, callouts, inside, false)).toEqual({ action: "insert" });
  });

  it("光标在普通文本上:就地插入", () => {
    const { doc, callouts } = mk("正文\n\n::: 甲\n\n:::\n");
    expect(planCalloutShortcut(doc, callouts, 1, false)).toEqual({ action: "insert" });
  });

  it("无标题裸块:块外文本不产生锚点", () => {
    const { doc, callouts } = mk("内容\n\n:::\n甲\n:::\n");
    expect(planCalloutShortcut(doc, callouts, 1, false)).toEqual({ action: "insert" });
  });
});

/**
 * 公式块骨架(⌘M)的模型:插入的块级公式**原生就是对齐环境**,不是先给
 * `$$…$$` 再靠片段 `dm`/`#@` 转换。等号对齐与续行是 align 环境的回车语义
 * (matrix.ts 的 alignEnter),所以这里同时锁"骨架形状"与两个模块的接缝:
 * 骨架给出的环境名必须是 matrixEnvAt 认得的那个。
 */
describe("insertMathBlock:公式块骨架(⌘M)", () => {
  const SKELETON = "$$\n\\begin{align}\n\n\\end{align}\n$$";

  it("空行:原位替换成 align 骨架,光标落环境内空行", () => {
    const view = makeView("前\n\n后", [2]);
    insertMathBlock(view);
    expect(text(view)).toBe(`前\n${SKELETON}\n后`);
    const line = view.state.doc.lineAt(pos(view));
    expect(line.text).toBe("");
    expect(line.number).toBe(4); // $$ / \begin / ← / \end / $$
    expect(view.state.doc.line(3).text).toBe("\\begin{align}");
  });

  it("非空行:骨架插到本行之后,定界行自己占行", () => {
    const view = makeView("正文", [1]);
    insertMathBlock(view);
    expect(text(view)).toBe(`正文\n${SKELETON}`);
    expect(view.state.doc.lineAt(pos(view)).number).toBe(4);
  });

  it("插入后回车的接缝:走 align 续行——补对齐点 & 与行尾 \\,光标落新行", () => {
    const view = makeView("", [0]);
    insertMathBlock(view);
    const line = view.state.doc.lineAt(pos(view));
    view.dispatch({
      changes: { from: line.from, insert: "a=b=c" },
      selection: { anchor: line.from + "a=b=c".length },
    });
    expect(matrixEnter(view)).toBe(true);
    expect(text(view)).toBe("$$\n\\begin{align}\na&=b=c \\\\\n\n\\end{align}\n$$");
    const newLine = view.state.doc.lineAt(pos(view));
    expect(newLine.text).toBe("");
    expect(view.state.doc.line(newLine.number + 1).text).toBe("\\end{align}");
  });
});
