import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { calloutInsertAnchor, cycleHeading, insertCallout, insertMathBlock, jumpHeaderTodos, planCalloutShortcut, planHeaderTodoJump, resetCalloutReturnForTest, resetHeaderTodoReturnForTest, toggleTodo, todayStamp } from "./ops";
import { matrixEnter } from "./snippets/matrix";
import { calloutRegions } from "./callout";
import { useAppStore } from "@/state/appStore";

/**
 * toggleTodo only depends on the {state, dispatch} surface of the view, so a
 * fake view is enough to lock the "the caret lands after the marker" selection
 * model in node (the same model as toggleList).
 */
function makeView(doc: string, cursors: number[]): EditorView {
  let state = EditorState.create({
    doc,
    // Multiple cursors need that facet explicitly enabled, otherwise EditorState.create collapses to a single cursor.
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

/** A fake view with a single selection (for the cases that need a real selection instead of a caret, such as inserting a callout with a selection). */
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

describe("toggleTodo caret landing (prefix area → after the new marker)", () => {
  it("empty line toggled to a todo: the caret lands after `- [ ] ` so typing can start right away", () => {
    const view = makeView("", [0]);
    toggleTodo(view);
    expect(text(view)).toBe("- [ ] ");
    expect(pos(view)).toBe(6);
  });

  it("plain text line at the line start: the caret lands between the marker and the body", () => {
    const view = makeView("hello", [0]);
    toggleTodo(view);
    expect(text(view)).toBe("- [ ] hello");
    expect(pos(view)).toBe(6);
  });

  it("caret inside the body: the mapping keeps it on the original character instead of snapping after the marker", () => {
    const view = makeView("hello", [3]);
    toggleTodo(view);
    expect(text(view)).toBe("- [ ] hello");
    expect(pos(view)).toBe(9); // the "l" that was at col 3
  });

  it("bullet list item at the line start: after it becomes a todo the caret still lands after the marker", () => {
    const view = makeView("- item", [0]);
    toggleTodo(view);
    expect(text(view)).toBe("- [ ] item");
    expect(pos(view)).toBe(6);
  });

  it("indented line: with the caret inside the indent it lands after the indent plus the marker", () => {
    const view = makeView("  text", [1]);
    toggleTodo(view);
    expect(text(view)).toBe("  - [ ] text");
    expect(pos(view)).toBe(8);
  });

  it("completing a todo (→ [x] + stamp): the selection stays put and the text is correct", () => {
    const view = makeView("- [ ] foo", [4]);
    toggleTodo(view);
    expect(text(view)).toBe(`- [x] foo ✅ ${todayStamp()}`);
    expect(pos(view)).toBe(4);
  });

  it("multiple cursors across lines: the later line's landing point counts the earlier line's prefix delta", () => {
    const view = makeView("\nabc", [0, 1]);
    toggleTodo(view);
    expect(text(view)).toBe("- [ ] \n- [ ] abc");
    const [first, second] = view.state.selection.ranges;
    expect(first.head).toBe(6); // after the marker on the first line (originally empty)
    expect(second.head).toBe(13); // after the marker on the second line (7 + 6)
  });
});

describe("cycleHeading: repeated presses cycle body→H1→H2→H3→H4→body", () => {
  it("body line pressed the first time: a one-level heading prefix is added", () => {
    const view = makeView("标题文字", [2]);
    cycleHeading(view);
    expect(text(view)).toBe("# 标题文字");
  });

  it("after descending to H4 the prefix is stripped, cycling back to body and starting again at H1", () => {
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

  it("H5/H6 are not in the cycle: the next step drops the heading entirely", () => {
    const view = makeView("##### 五", [3]);
    cycleHeading(view);
    expect(text(view)).toBe("五");
    const view6 = makeView("###### 六", [0]);
    cycleHeading(view6);
    expect(text(view6)).toBe("六");
  });

  it("multiple cursors across lines: each line advances one step, body lines start at H1", () => {
    const view = makeView("# a\nb\n## c", [0, 4, 9]);
    cycleHeading(view);
    expect(text(view)).toBe("## a\n# b\n### c");
  });

  it("empty lines take part in the cycle: a one-level heading prefix is added", () => {
    const view = makeView("", [0]);
    cycleHeading(view);
    expect(text(view)).toBe("# ");
  });
});

describe("planHeaderTodoJump: the round-trip decision of ⌘T", () => {
  const state = (doc: string) => EditorState.create({ doc }).doc;
  // The daily branch's insert string has no trailing newline, so the caret =
  // at + insert.length; the plain note branch's insert string carries a
  // trailing newline, so the caret has to be given explicitly (it still lands
  // at the end of the `- [ ] ` line).
  const create = (at: number, insert: string, cursor = at + insert.length) => ({
    action: "create",
    at,
    insert,
    cursor,
  });

  it("header has a todo block: a body caret jumps to the end of the block's last line", () => {
    const doc = "- [ ] 甲\n- [x] 乙\n\n正文第一行\n";
    const p = planHeaderTodoJump(state(doc), 4, false, false);
    expect(p).toEqual({ action: "jump", anchor: doc.indexOf("乙") + 1 });
  });

  it("daily-note shape: the todo area after H1 is the header block (jumps to the end of the block's last line)", () => {
    const doc = "# 1 2026-10-05\n- [ ] 甲\n- [x] 乙\n\n正文\n";
    const p = planHeaderTodoJump(state(doc), 6, false, true);
    expect(p).toEqual({ action: "jump", anchor: doc.indexOf("乙") + 1 });
  });

  it("daily note: the first line is a todo (a todo area before H1 counts too)", () => {
    const doc = "- [ ] 甲\n# 1 2026-10-05\n\n正文\n";
    const p = planHeaderTodoJump(state(doc), 4, false, true);
    expect(p).toEqual({ action: "jump", anchor: doc.indexOf("甲") + 1 });
  });

  it("caret inside the block + a return memory → go back; without memory → stay", () => {
    const doc = "- [ ] 甲\n\n正文\n";
    expect(planHeaderTodoJump(state(doc), 1, true, false)).toEqual({ action: "back" });
    expect(planHeaderTodoJump(state(doc), 1, false, false)).toEqual({ action: "stay" });
  });

  it("no block + body caret: the todo is created at the top of the document with the caret after the marker", () => {
    const doc = "段落\n\n正文\n";
    expect(planHeaderTodoJump(state(doc), 3, false, false)).toEqual(create(0, "- [ ] \n", 6));
  });

  it("no block + document starts with a blank line: creation still happens at the top of the document", () => {
    const doc = "\n\n正文\n";
    expect(planHeaderTodoJump(state(doc), 3, false, false)).toEqual(create(0, "- [ ] \n", 6));
  });

  it("plain note whose first line is an H1 heading with no todo: created at the very top of the file, the heading is pushed to the second line", () => {
    const doc = "# 论 transformer\n\n正文\n";
    expect(planHeaderTodoJump(state(doc), 3, false, false)).toEqual(create(0, "- [ ] \n", 6));
  });

  it("plain note: the header todo area is the very top of the file, todos after H1 do not count (still created at the top)", () => {
    const doc = "# 论 transformer\n- [ ] 正文中的待办\n";
    expect(planHeaderTodoJump(state(doc), 2, false, false)).toEqual(create(0, "- [ ] \n", 6));
  });

  it("no block + daily-note body caret: created after H1 (the daily note's todo area position)", () => {
    const doc = "# 1 2026-10-05\n\n正文\n";
    expect(planHeaderTodoJump(state(doc), 3, false, true)).toEqual(create(14, "\n- [ ] "));
  });

  it("no block + caret on the heading line: a daily note with memory jumps back, without memory creates in place", () => {
    const doc = "# 1 2026-10-05\n";
    expect(planHeaderTodoJump(state(doc), 1, true, true)).toEqual({ action: "back" });
    expect(planHeaderTodoJump(state(doc), 1, false, true)).toEqual(create(14, "\n- [ ] "));
  });

  it("no block + caret on the document's first line: with memory it jumps back, without memory it creates", () => {
    const doc = "正文\n- [ ] 块外的待办不算头部\n";
    expect(planHeaderTodoJump(state(doc), 1, true, false)).toEqual({ action: "back" });
    expect(planHeaderTodoJump(state(doc), 1, false, false)).toEqual(create(0, "- [ ] \n", 6));
  });

  it("the header scan stops at the first line that is neither blank nor a todo: body todos do not form a header block (caret in the body → create)", () => {
    const doc = "段落\n- [ ] 不是头部\n";
    expect(planHeaderTodoJump(state(doc), 2, false, false)).toEqual(create(0, "- [ ] \n", 6));
  });

  it("empty document: create without a trailing newline", () => {
    expect(planHeaderTodoJump(state(""), 1, false, false)).toEqual(create(0, "- [ ] "));
  });
});

describe("jumpHeaderTodos: end-to-end creation of an empty todo with ⌘T", () => {
  const setFile = (path: string) => useAppStore.setState({ currentFile: path });

  it("daily note without todos: an empty todo is created with the caret after the marker; after typing, ⌘T again returns to the original body position", () => {
    resetHeaderTodoReturnForTest(); // the module-level round-trip memory would leak across test cases
    setFile("/v/Daily/2026-10-05.md");
    // press ⌘T at line 3 (the body line), column 2
    const view = makeView("# 1 2026-10-05\n\n正文在这里\n", [18]);
    jumpHeaderTodos(view);
    expect(text(view)).toBe("# 1 2026-10-05\n- [ ] \n\n正文在这里\n");
    expect(pos(view)).toBe(21); // end of the `- [ ] ` line, after the todo marker
    // the user types the todo content directly (typing on the same line does not affect the origin's line/column anchor)
    view.dispatch({ changes: [{ from: 21, insert: "第一件事" }] });
    expect(text(view)).toBe("# 1 2026-10-05\n- [ ] 第一件事\n\n正文在这里\n");
    // the new todo line is already part of the header block and a return memory
    // exists → go back exactly to the body line/column from before the creation
    jumpHeaderTodos(view);
    const cur = view.state.doc.lineAt(pos(view));
    expect(cur.number).toBe(4); // the "正文在这里" line (the creation pushed it to line 4)
    expect(pos(view) - cur.from).toBe(2); // column 2, same as before the creation
  });

  it("plain note without todos: created at the top of the document, the original content is pushed to the next line", () => {
    resetHeaderTodoReturnForTest();
    setFile("/v/笔记.md");
    const view = makeView("笔记正文\n", [2]);
    jumpHeaderTodos(view);
    expect(text(view)).toBe("- [ ] \n笔记正文\n");
    expect(pos(view)).toBe("- [ ] ".length);
  });

  it("plain note (starting with an H1 heading) without todos: the todo becomes the first line; ⌘T again returns to the original body position", () => {
    resetHeaderTodoReturnForTest();
    setFile("/v/笔记.md");
    const view = makeView("# 论 transformer\n\n正文\n", [17]); // start of the "正文" line
    jumpHeaderTodos(view);
    expect(text(view)).toBe("- [ ] \n# 论 transformer\n\n正文\n");
    expect(pos(view)).toBe("- [ ] ".length);
    // the todo line is part of the header block → pressing again returns to the body line/column from before the creation (which pushed it to line 4)
    jumpHeaderTodos(view);
    const cur = view.state.doc.lineAt(pos(view));
    expect(cur.text).toBe("正文");
    expect(pos(view) - cur.from).toBe(0);
  });
});

describe("insertCallout: the inserted shape and the caret landing point", () => {
  it("insert on an empty line: the opening fence carries a title slot and the closing fence follows right after it (no blank line between the two fences)", () => {
    const view = makeView("", [0]);
    insertCallout(view);
    expect(text(view)).toBe("::: \n:::");
    expect(pos(view)).toBe(4); // after the title slot: the title can be typed right away
  });

  it("insert on a non-empty line: the block goes after the end of this line, with the caret after the title slot too", () => {
    const view = makeView("hello", [3]);
    insertCallout(view);
    expect(text(view)).toBe("hello\n::: \n:::");
    expect(pos(view)).toBe(10);
  });

  it("insert inside a list item: both fences land at column 0 (an indented closing fence can never close the block)", () => {
    const view = makeView("  - 项", [5]);
    insertCallout(view);
    expect(text(view)).toBe("  - 项\n::: \n:::");
    expect(pos(view)).toBe(10);
  });

  it("the landing point is the title slot: typed text becomes the callout title, Enter becomes the body line", () => {
    const view = makeView("", [0]);
    insertCallout(view);
    const slot = pos(view);
    // typing: the text lands inside the slot and the caret follows the text (the shape of the input pipeline — the caret moves right with the input)
    view.dispatch({
      changes: { from: slot, insert: "正则化" },
      selection: { anchor: slot + "正则化".length },
    });
    expect(text(view)).toBe("::: 正则化\n:::");
    expect(calloutRegions(view.state)[0].title).toBe("正则化");
    // Enter: the new line under the caret becomes the body line of the block and the title keeps its ownership (there is no blank line between the two lines)
    const at = pos(view);
    view.dispatch({ changes: { from: at, insert: "\n" }, selection: { anchor: at + 1 } });
    expect(text(view)).toBe("::: 正则化\n\n:::");
    expect(view.state.doc.lineAt(pos(view)).number).toBe(2);
    expect(calloutRegions(view.state)[0].title).toBe("正则化");
  });

  it("the inserted block is always closed by the scanner (empty line / body line / list line origins)", () => {
    for (const doc of ["", "hello", "  - 项"]) {
      const view = makeView(doc, [doc.length]);
      insertCallout(view);
      const regions = calloutRegions(view.state);
      expect(regions, `doc=${JSON.stringify(doc)}`).toHaveLength(1);
      expect(regions[0].closed, `doc=${JSON.stringify(doc)}`).toBe(true);
    }
  });

  it("insert with a selection: the block is created after the selection's line (one blank line apart), the original text stays in place, the caret lands on the blank line inside the block", () => {
    const view = makeRangeView("开头\n斜率矩阵\n结尾", 3, 7); // selecting "斜率矩阵"
    insertCallout(view);
    expect(text(view)).toBe("开头\n斜率矩阵\n\n::: 斜率矩阵\n\n:::\n结尾");
    const cur = view.state.doc.lineAt(pos(view));
    expect(cur.text).toBe(""); // the blank line inside the block: typing right away is the explanation
    expect(cur.number).toBe(5);
    expect(view.state.sliceDoc(3, 7)).toBe("斜率矩阵"); // not a single byte of the original text changed
    const regions = calloutRegions(view.state);
    expect(regions).toHaveLength(1);
    expect(regions[0].title).toBe("斜率矩阵");
    expect(regions[0].closed).toBe(true);
  });

  it("exactly one blank line between the selection line and the opening fence, the content after the block is preserved", () => {
    const cases: [string, number, number, string][] = [
      // doc, selection, expected
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

  it("multi-line selection: the title is flattened to one line (newline→space), the block is created after the selection's last line", () => {
    const view = makeRangeView("甲\n乙丙", 0, 3); // selecting "甲\n乙"
    insertCallout(view);
    expect(text(view)).toBe("甲\n乙丙\n\n::: 甲 乙\n\n:::");
    expect(calloutRegions(view.state)[0].title).toBe("甲 乙");
  });

  it("inserting with a selection does not swallow formula/image link source: the title is kept verbatim", () => {
    const doc = "前\n$$E=mc^2$$\n后";
    const view = makeRangeView(doc, 2, 12); // selecting $$E=mc^2$$
    insertCallout(view);
    expect(text(view)).toBe("前\n$$E=mc^2$$\n\n::: $$E=mc^2$$\n\n:::\n后");
    expect(calloutRegions(view.state)[0].title).toBe("$$E=mc^2$$");
  });

  it("anchor round trip: with the caret on the original text ⌘⇧B jumps to the block, pressing again returns to the original text", () => {
    resetCalloutReturnForTest();
    useAppStore.setState({ currentFile: "/v/笔记.md" });
    const doc = "开头\n斜率矩阵\n结尾\n\n::: 斜率矩阵\n\n:::\n";
    const view = makeView(doc, [3]); // the caret lands inside the original "斜率矩阵"
    insertCallout(view);
    // the landing point = the end of the opening line (after the title slot), the same position as when creating a block from a selection
    const cur = view.state.doc.lineAt(pos(view));
    expect(cur.text).toBe("::: 斜率矩阵");
    expect(pos(view)).toBe(cur.to);
    // pressing again: already inside the block with a return memory → back to the original text
    insertCallout(view);
    expect(pos(view)).toBe(3);
  });

  it("no return memory inside the callout: a new block is opened in place as usual (no jump)", () => {
    resetCalloutReturnForTest();
    useAppStore.setState({ currentFile: "/v/笔记.md" });
    const view = makeView("::: 甲\n内容\n:::\n", [8]);
    insertCallout(view);
    expect(text(view)).toBe("::: 甲\n内容\n::: \n:::\n:::\n");
  });

  it("the selection is pure whitespace: no empty-title block is created, it is handled as no selection (an empty block opens in place)", () => {
    const view = makeRangeView("甲 乙", 1, 2); // selecting a single space
    insertCallout(view);
    expect(text(view)).toBe("甲 乙\n::: \n:::");
    expect(calloutRegions(view.state)[0].title).toBe("");
  });
});

describe("calloutInsertAnchor: the landing point when inserting with a selection", () => {
  const anchorOf = (doc: string, from: number, to: number) => {
    const state = EditorState.create({ doc });
    return calloutInsertAnchor(state, from, to);
  };

  it("plain text: the end of the selection's last line (the content originally after the block is pushed behind the block)", () => {
    const doc = "第一行\n第二行\n第三行";
    expect(anchorOf(doc, 0, 3)).toBe(3); // the selection is on line 1
    expect(anchorOf(doc, 4, 8)).toBe(7); // the selection carries the trailing newline and still counts as line 2
  });

  it("inside a fenced code block: it extends to the end of the closing fence line (the code block is not cut)", () => {
    expect(anchorOf("```py\ncode line\n```\n后文", 6, 15)).toBe(19);
  });

  it("inside an unclosed fence: it extends to the end of the document's last line", () => {
    expect(anchorOf("```py\ncode", 6, 10)).toBe(10);
  });

  it("inside a display formula block: it extends to the end of the closing $$ line", () => {
    expect(anchorOf("前\n$$\nE=mc^2\n$$\n后", 5, 11)).toBe(14);
  });

  it("single-line display formula: the landing point is the end of that line", () => {
    expect(anchorOf("前\n$$E=mc^2$$\n后", 2, 12)).toBe(12);
  });
});

describe("planCalloutShortcut: the decision for ⌘⇧B without a selection", () => {
  const mk = (doc: string) => {
    const state = EditorState.create({ doc });
    return { doc: state.doc, callouts: calloutRegions(state) };
  };

  it("caret inside the anchor text: jump to the related callout", () => {
    const { doc, callouts } = mk("斜率矩阵\n\n::: 斜率矩阵\n\n:::\n");
    const p = planCalloutShortcut(doc, callouts, 1, false);
    expect(p.action).toBe("anchor-jump");
    if (p.action === "anchor-jump") expect(p.region.title).toBe("斜率矩阵");
  });

  it("caret just past the anchor's end (the range is right-open): no jump, insert in place", () => {
    const { doc, callouts } = mk("斜率矩阵\n\n::: 斜率矩阵\n\n:::\n");
    expect(planCalloutShortcut(doc, callouts, 4, false)).toEqual({ action: "insert" });
  });

  it("caret inside the callout (boundary lines included): with a return memory it jumps back, without memory it inserts in place", () => {
    const { doc, callouts } = mk("正文\n\n::: 甲\n\n:::\n");
    const inside = doc.line(3).from + 1; // inside the "::: 甲" line
    expect(planCalloutShortcut(doc, callouts, inside, true)).toEqual({ action: "back" });
    expect(planCalloutShortcut(doc, callouts, inside, false)).toEqual({ action: "insert" });
  });

  it("caret on plain text: insert in place", () => {
    const { doc, callouts } = mk("正文\n\n::: 甲\n\n:::\n");
    expect(planCalloutShortcut(doc, callouts, 1, false)).toEqual({ action: "insert" });
  });

  it("untitled bare block: text outside the block produces no anchor", () => {
    const { doc, callouts } = mk("内容\n\n:::\n甲\n:::\n");
    expect(planCalloutShortcut(doc, callouts, 1, false)).toEqual({ action: "insert" });
  });
});

/**
 * Model of the formula block skeleton (⌘M): the inserted block formula **is
 * natively an alignment environment**, not a `$$…$$` block that a `dm`/`#@`
 * snippet then converts. Equals alignment and the continuation line are the
 * Enter semantics of the align environment (alignEnter in matrix.ts), so this
 * locks the "skeleton shape" and the seam between the two modules at once: the
 * environment name the skeleton emits must be the one matrixEnvAt recognizes.
 */
describe("insertMathBlock: the formula block skeleton (⌘M)", () => {
  const SKELETON = "$$\n\\begin{align}\n\n\\end{align}\n$$";

  it("empty line: replaced in place by the align skeleton, the caret lands on the blank line inside the environment", () => {
    const view = makeView("前\n\n后", [2]);
    insertMathBlock(view);
    expect(text(view)).toBe(`前\n${SKELETON}\n后`);
    const line = view.state.doc.lineAt(pos(view));
    expect(line.text).toBe("");
    expect(line.number).toBe(4); // $$ / \begin / ← / \end / $$
    expect(view.state.doc.line(3).text).toBe("\\begin{align}");
  });

  it("non-empty line: the skeleton is inserted after this line, the delimiter lines each take a line of their own", () => {
    const view = makeView("正文", [1]);
    insertMathBlock(view);
    expect(text(view)).toBe(`正文\n${SKELETON}`);
    expect(view.state.doc.lineAt(pos(view)).number).toBe(4);
  });

  it("the Enter seam after insertion: it takes the align continuation path — adding the alignment point & and the trailing \\, the caret lands on the new line", () => {
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
