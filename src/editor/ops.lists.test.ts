import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import type { EditorView } from "@codemirror/view";
import {
  copySelection,
  cutSelection,
  enterContinueListItem,
  insertCodeBlock,
  insertHorizontalRule,
  insertInlineCode,
  insertInlineMath,
  insertWikilinkText,
  pasteClipboard,
  toggleHeading,
  toggleList,
  toggleWrap,
  wikilinkTargetOnLine,
} from "./ops";
import { setClipboardOverrides } from "@/lib/clipboard";
import { useAppStore } from "@/state/appStore";

/**
 * The list/keyboard operations of ops.ts, locked through the same {state,
 * dispatch} fake view the neighbouring tests use: the rules live in the
 * transaction the command builds, so a fake view exercises the real code path.
 *
 * Enter on a list line deliberately replaces lang-markdown's
 * insertNewlineContinueMarkup (tab indent expanded to spaces, stray blank
 * lines on empty items), so the exact leading whitespace and marker of the
 * item are the contract. The marker strip on an empty top-level item is the
 * way out of the list; on an empty nested item one level is dropped per press.
 */
function makeView(doc: string, cursors: number[], extensions = markdownExtensions()): EditorView {
  let state = EditorState.create({
    doc,
    extensions: [EditorState.allowMultipleSelections.of(true), ...extensions],
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
    scrollDOM: { scrollTop: 0, scrollHeight: 0 },
  } as unknown as EditorView;
  return view;
}

function markdownExtensions() {
  return [markdown({ base: markdownLanguage, extensions: [GFM] })];
}

const text = (view: EditorView) => view.state.doc.toString();
const pos = (view: EditorView) => view.state.selection.main.head;

/** Runs one command on a fresh view and returns the resulting text + caret. */
function run(doc: string, cursor: number, command: (view: EditorView) => unknown) {
  const view = makeView(doc, [cursor]);
  const handled = command(view);
  return { view, handled, text: text(view), pos: pos(view) };
}

describe("enterContinueListItem: continuing a list keeps the item's exact whitespace", () => {
  it("a bullet item continues with the same marker at the same indent", () => {
    const doc = "- item";
    expect(run(doc, doc.length, enterContinueListItem)).toMatchObject({
      handled: true,
      text: "- item\n- ",
      pos: doc.length + 3,
    });
  });

  it("tab indentation is copied byte for byte (no expansion to spaces)", () => {
    const doc = "\t- item";
    expect(run(doc, doc.length, enterContinueListItem).text).toBe("\t- item\n\t- ");
  });

  it("a todo item continues with a fresh, unchecked box", () => {
    const doc = "- [x] done";
    expect(run(doc, doc.length, enterContinueListItem).text).toBe("- [x] done\n- [ ] ");
  });

  it("an ordered item continues with the next number", () => {
    const doc = "3. item";
    expect(run(doc, doc.length, enterContinueListItem).text).toBe("3. item\n4. ");
  });

  it("an ordered item's following siblings are renumbered so the list stays sequential", () => {
    const doc = "1. a\n2. b\n3. c";
    expect(run(doc, 4, enterContinueListItem).text).toBe("1. a\n2. \n3. b\n4. c");
  });

  it("a hand-written 1. 1. 1. list is not renumbered (only items already in the expected slot shift)", () => {
    const doc = "1. a\n1. b";
    expect(run(doc, 4, enterContinueListItem).text).toBe("1. a\n2. \n1. b");
  });

  it("an item with a checkbox and a trailing stamp continues as a plain unchecked todo", () => {
    const doc = "- [x] done ✅ 2026-01-01";
    expect(run(doc, doc.length, enterContinueListItem).text).toBe(
      "- [x] done ✅ 2026-01-01\n- [ ] ",
    );
  });

  it("the cursor in the middle of the text splits the item and keeps the tail on the new line", () => {
    const doc = "- abc";
    expect(run(doc, 4, enterContinueListItem).text).toBe("- ab\n- c");
  });

  it("cursor on the marker continues from the end of the line instead of splitting the marker", () => {
    const doc = "- abc";
    expect(run(doc, 1, enterContinueListItem)).toMatchObject({ handled: true, text: "- abc\n- " });
  });

  it("cursor before an indented item opens a blank line above without copying the indent", () => {
    const doc = "  - abc";
    const result = run(doc, 0, enterContinueListItem);
    expect(result.text).toBe("\n  - abc");
    expect(result.pos).toBe(1);
  });
});

describe("enterContinueListItem: leaving the list by pressing Enter on an empty item", () => {
  it("an empty top-level bullet is replaced by a plain line (the marker is stripped)", () => {
    expect(run("- item\n- ", 9, enterContinueListItem)).toMatchObject({
      handled: true,
      text: "- item\n",
    });
  });

  it("an empty nested item drops one level per press, keeping its marker", () => {
    const doc = "- a\n  - ";
    expect(run(doc, doc.length, enterContinueListItem).text).toBe("- a\n- ");
  });

  it("an empty nested ordered item drops one level and takes the next sibling number", () => {
    const doc = "1. a\n  1. b\n  2. ";
    // The dedented item becomes the second child of "1. a", i.e. number 2.
    expect(run(doc, doc.length, enterContinueListItem).text).toBe("1. a\n  1. b\n2. ");
  });

  it("an indent deeper than the indent unit loses exactly one unit, not the whole indent", () => {
    const doc = "1. a\n   1. b\n   2. ";
    // Three spaces of indent dedent by one two-space unit, leaving one space.
    expect(run(doc, doc.length, enterContinueListItem).text).toBe("1. a\n   1. b\n 1. ");
  });

  it("a tab-indented empty item loses exactly one tab", () => {
    const doc = "- a\n\t- ";
    expect(run(doc, doc.length, enterContinueListItem).text).toBe("- a\n- ");
  });
});

describe("enterContinueListItem: lines it must not touch (the fallback chain)", () => {
  it("a plain paragraph line is left to lang-markdown", () => {
    expect(run("paragraph", 9, enterContinueListItem).handled).toBe(false);
    expect(run("paragraph", 9, enterContinueListItem).text).toBe("paragraph");
  });

  it("a fenced code block's literal `- ` line is not continued", () => {
    const doc = "```\n- literal\n```";
    const cursor = doc.indexOf("literal") + "literal".length;
    expect(run(doc, cursor, enterContinueListItem).handled).toBe(false);
    expect(run(doc, cursor, enterContinueListItem).text).toBe(doc);
  });

  it("a non-empty selection is not a list line to continue", () => {
    const view = makeView("- abc", [2]);
    view.dispatch({ selection: EditorSelection.range(2, 4) });
    expect(enterContinueListItem(view)).toBe(false);
    expect(text(view)).toBe("- abc");
  });

  it("a blockquote line is not a list item", () => {
    expect(run("> quote", 7, enterContinueListItem).handled).toBe(false);
  });

  it("multiple cursors each continue their own item", () => {
    const view = makeView("- a\n- b", [3, 7]);
    expect(enterContinueListItem(view)).toBe(true);
    expect(text(view)).toBe("- a\n- \n- b\n- ");
    expect(view.state.selection.ranges.map((r) => r.head)).toEqual([6, 13]);
  });

  it("the tree-unavailable window still continues a list (no dependence on the background parse)", () => {
    // A bare state has no markdown extension: syntaxTreeAvailable is false, so
    // the markdownLanguage gate is skipped and the line scan decides.
    const view = makeView("- item", [6], []);
    expect(enterContinueListItem(view)).toBe(true);
    expect(text(view)).toBe("- item\n- ");
  });
});

describe("toggleHeading: setting one explicit level per cursor line", () => {
  it("a body line gets the requested level", () => {
    expect(run("正文", 1, (v) => toggleHeading(v, 2)).text).toBe("## 正文");
  });

  it("a heading of the same level returns to body text", () => {
    expect(run("# 标题", 2, (v) => toggleHeading(v, 1)).text).toBe("标题");
  });

  it("a heading of another level switches to the requested one", () => {
    expect(run("## 标题", 1, (v) => toggleHeading(v, 3)).text).toBe("### 标题");
  });

  it("every cursor's line is toggled once (the command works on cursors, not on every covered line)", () => {
    const view = makeView("a\nb", [0, 2]);
    toggleHeading(view, 1);
    expect(text(view)).toBe("# a\n# b");
  });

  it("a selection's head line is the one toggled (a multi-line selection is not expanded)", () => {
    const view = makeView("a\nb", [0]);
    view.dispatch({ selection: EditorSelection.range(0, 3) });
    toggleHeading(view, 1);
    expect(text(view)).toBe("a\n# b");
  });

  it("a cursor alone on one line among several does not touch the others", () => {
    expect(run("a\nb\nc", 2, (v) => toggleHeading(v, 2)).text).toBe("a\n## b\nc");
  });
});

describe("toggleList: converting and cancelling list kinds line by line", () => {
  it("a plain line becomes a bullet", () => {
    expect(run("text", 0, (v) => toggleList(v, "bullet")).text).toBe("- text");
  });

  it("a plain line becomes an ordered item numbered 1", () => {
    expect(run("text", 0, (v) => toggleList(v, "numbered")).text).toBe("1. text");
  });

  it("a bullet toggled to the same kind cancels the list, checkbox included", () => {
    expect(run("- [ ] task", 0, (v) => toggleList(v, "bullet")).text).toBe("task");
  });

  it("an ordered item toggled to numbered cancels the list", () => {
    expect(run("1. item", 0, (v) => toggleList(v, "numbered")).text).toBe("item");
  });

  it("an ordered item converted to a bullet keeps its checkbox", () => {
    expect(run("1. [ ] task", 0, (v) => toggleList(v, "bullet")).text).toBe("- [ ] task");
  });

  it("a bullet converted to ordered keeps its checkbox", () => {
    expect(run("- [x] task", 0, (v) => toggleList(v, "numbered")).text).toBe("1. [x] task");
  });

  it("the line indent is preserved on conversion", () => {
    expect(run("    plain", 4, (v) => toggleList(v, "bullet")).text).toBe("    - plain");
  });

  it("a line inside a fenced code block is left alone", () => {
    const doc = "```\n- literal\n```";
    expect(run(doc, doc.indexOf("literal"), (v) => toggleList(v, "bullet")).text).toBe(doc);
  });

  it("a cursor sitting on the affected prefix lands behind the new marker", () => {
    expect(run("text", 0, (v) => toggleList(v, "bullet")).pos).toBe(2);
  });

  it("a multi-line selection converts every covered line", () => {
    const view = makeView("a\nb\nc", [0]);
    view.dispatch({ selection: EditorSelection.range(0, 3) });
    toggleList(view, "bullet");
    // range.to sits on the first column of "b": only the fully covered lines
    // up to the one holding to-1 take part.
    expect(text(view)).toBe("- a\n- b\nc");
  });
});

const wrap = (marker: string) => (view: EditorView) => toggleWrap(view, marker);

describe("toggleWrap: wrap, unwrap from the outside, unwrap from the inside", () => {
  it("a selection is wrapped on both sides, the selection shrinks to the text", () => {
    const view = makeView("word", [0]);
    view.dispatch({ selection: EditorSelection.range(0, 4) });
    toggleWrap(view, "**");
    expect(text(view)).toBe("**word**");
    expect(view.state.selection.main.from).toBe(2);
    expect(view.state.selection.main.to).toBe(6);
  });

  it("markers sitting right outside a selection are removed (unwrap from the outside)", () => {
    const doc = "**word**";
    const view = makeView(doc, [2]);
    view.dispatch({ selection: EditorSelection.range(2, 6) });
    toggleWrap(view, "**");
    expect(text(view)).toBe("word");
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(4);
  });

  it("a selection that includes the markers unwraps from the inside", () => {
    const view = makeView("**word**", [0]);
    view.dispatch({ selection: EditorSelection.range(0, 8) });
    toggleWrap(view, "**");
    expect(text(view)).toBe("word");
  });

  it("an empty selection places the pair and puts the cursor between the markers", () => {
    const result = run("ab", 1, wrap("$"));
    expect(result.text).toBe("a$$b");
    expect(result.pos).toBe(2);
  });

  it("a marker that only appears on one side does not unwrap; it wraps again", () => {
    const view = makeView("**word", [2]);
    view.dispatch({ selection: EditorSelection.range(2, 6) });
    toggleWrap(view, "**");
    expect(text(view)).toBe("****word**");
  });

  it("a multi-character inner text shorter than two markers is wrapped, not sliced negative", () => {
    const view = makeView("**", [0]);
    view.dispatch({ selection: EditorSelection.range(0, 2) });
    toggleWrap(view, "**");
    // "**" equals the marker length, not twice it: no unwrap from the inside.
    expect(text(view)).toBe("******");
  });
});

describe("insertInlineMath / insertInlineCode: placing a delimiter pair", () => {
  it("an empty selection gets an inline formula skeleton with the caret inside", () => {
    const result = run("a b", 1, insertInlineMath);
    expect(result.text).toBe("a$$ b");
    expect(result.pos).toBe(2);
  });

  it("a selection becomes the formula body", () => {
    const view = makeView("a x b", [2]);
    view.dispatch({ selection: EditorSelection.range(2, 3) });
    insertInlineMath(view);
    expect(text(view)).toBe("a $x$ b");
  });

  it("inline code wraps the selection in single backticks", () => {
    const view = makeView("a x b", [2]);
    view.dispatch({ selection: EditorSelection.range(2, 3) });
    insertInlineCode(view);
    expect(text(view)).toBe("a `x` b");
  });
});

describe("insertCodeBlock: whole-line fences with the configured language", () => {
  beforeEach(() => {
    useAppStore.getState().patchSettings({ codeBlockLang: "ts" });
  });

  it("without a selection the fence opens with the configured language and the caret lands inside", () => {
    const result = run("", 0, insertCodeBlock);
    expect(result.text).toBe("```ts\n\n```");
    expect(result.view.state.doc.lineAt(result.pos).text).toBe("");
    expect(result.view.state.doc.lineAt(result.pos).number).toBe(2);
  });

  it("a blank line is replaced in place instead of pushing the block below it", () => {
    const result = run("前\n\n后", 2, insertCodeBlock);
    expect(result.text).toBe("前\n```ts\n\n```\n后");
  });

  it("a language override wins over the setting", () => {
    expect(run("", 0, (v) => insertCodeBlock(v, "py")).text).toBe("```py\n\n```");
  });

  it("an empty override produces a bare fence", () => {
    expect(run("", 0, (v) => insertCodeBlock(v, "")).text).toBe("```\n\n```");
  });

  it("backticks and newlines cannot break out of the info string", () => {
    expect(run("", 0, (v) => insertCodeBlock(v, "a`b\nc")).text).toBe("```abc\n\n```");
  });

  it("with a selection both ends shift into the block, so the selected text survives byte for byte", () => {
    const doc = "aa\nbb\ncc";
    const view = makeView(doc, [0]);
    view.dispatch({ selection: EditorSelection.range(4, 7) });
    insertCodeBlock(view);
    expect(text(view)).toBe("aa\n```ts\nbb\ncc\n```");
    const sel = view.state.selection.main;
    expect(view.state.sliceDoc(sel.from, sel.to)).toBe("b\nc");
  });

  it("a selection inside one line extends to the whole line", () => {
    const view = makeView("abc\ndef", [0]);
    view.dispatch({ selection: EditorSelection.range(1, 2) });
    insertCodeBlock(view);
    expect(text(view)).toBe("```ts\nabc\n```\ndef");
    const sel = view.state.selection.main;
    // The original "b" was shifted right by the opening fence, not lost.
    expect(view.state.sliceDoc(sel.from, sel.to)).toBe("b");
  });

  it("a selection inside a line extends to that whole line", () => {
    const doc = "abc\ndef";
    const view = makeView(doc, [0]);
    view.dispatch({ selection: EditorSelection.range(1, 2) });
    insertCodeBlock(view);
    expect(text(view)).toBe("```ts\nabc\n```\ndef");
  });
});

describe("insertHorizontalRule: whole-line `---` separated from text", () => {
  it("on an empty line the rule replaces nothing and the caret follows it", () => {
    const result = run("", 0, insertHorizontalRule);
    expect(result.text).toBe("---\n");
    expect(result.pos).toBe(4);
  });

  it("after a text line two newlines keep the rule a rule (not a setext underline)", () => {
    const doc = "text";
    expect(run(doc, 2, insertHorizontalRule).text).toBe("text\n\n---\n");
  });
});

describe("wikilinkTargetOnLine: the first link on the caret line", () => {
  it("a plain link yields its target", () => {
    expect(run("see [[笔记]] here", 6, wikilinkTargetOnLine).handled).toBe("笔记");
  });

  it("an alias is dropped: only the target counts", () => {
    expect(run("[[笔记|别名]]", 2, wikilinkTargetOnLine).handled).toBe("笔记");
  });

  it("a heading anchor is dropped", () => {
    expect(run("[[笔记#小节]]", 2, wikilinkTargetOnLine).handled).toBe("笔记");
  });

  it("a link in inline code is sample text, not a link", () => {
    expect(run("`[[笔记]]`", 4, wikilinkTargetOnLine).handled).toBeNull();
  });

  it("a link in a fenced code block does not count", () => {
    const doc = "```\n[[笔记]]\n```";
    expect(run(doc, doc.indexOf("笔记"), wikilinkTargetOnLine).handled).toBeNull();
  });

  it("a line without `[[` short-circuits to null", () => {
    expect(run("plain", 2, wikilinkTargetOnLine).handled).toBeNull();
  });

  it("the scan skips a code span and takes the next real link", () => {
    const doc = "`[[伪]]` 和 [[真]]";
    expect(run(doc, 2, wikilinkTargetOnLine).handled).toBe("真");
  });

  it("an empty target is not a link", () => {
    expect(run("[[ | alias]]", 2, wikilinkTargetOnLine).handled).toBeNull();
  });
});

describe("insertWikilinkText: writing the link with an optional alias", () => {
  it("without a selection the link is inserted at the caret and the caret lands after it", () => {
    const result = run("ab", 1, (v) => insertWikilinkText(v, "笔记"));
    expect(result.text).toBe("a[[笔记]]b");
    expect(result.pos).toBe(1 + "[[笔记]]".length);
  });

  it("with a selection the selected text becomes the alias", () => {
    const view = makeView("选择此文", [0]);
    view.dispatch({ selection: EditorSelection.range(0, 4) });
    insertWikilinkText(view, "笔记");
    expect(text(view)).toBe("[[笔记|选择此文]]");
  });

  it("link syntax characters inside the alias become spaces (they would truncate the link)", () => {
    const view = makeView("a[b]|c\nd", [0]);
    view.dispatch({ selection: EditorSelection.range(0, 7) });
    insertWikilinkText(view, "目标");
    // Newlines are replaced too, so the alias stays single-line.
    expect(text(view)).toBe("[[目标|a b  c]]d");
  });

  it("a whitespace-only alias falls back to the plain link form", () => {
    const view = makeView("a b", [0]);
    view.dispatch({ selection: EditorSelection.range(1, 2) });
    insertWikilinkText(view, "目标");
    expect(text(view)).toBe("a[[目标]]b");
  });
});

describe("copy / cut / paste go through the clipboard seam", () => {
  const writes: string[] = [];
  let clipboard = "";

  beforeEach(() => {
    writes.length = 0;
    clipboard = "";
    setClipboardOverrides({
      read: async () => clipboard,
      write: async (value) => {
        writes.push(value);
        clipboard = value;
        return true;
      },
    });
  });

  afterEach(() => {
    setClipboardOverrides(null);
  });

  it("copy writes every non-empty selection, joined in document order", () => {
    const view = makeView("abc\ndef", [0]);
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(4, 7)]),
    });
    expect(copySelection(view)).toBe(true);
    expect(writes).toEqual(["a\ndef"]);
    // Copy does not modify the document.
    expect(text(view)).toBe("abc\ndef");
  });

  it("copy with a cursor only (no selection) is not handled", () => {
    const view = makeView("abc", [1]);
    expect(copySelection(view)).toBe(false);
    expect(writes).toEqual([]);
  });

  it("cut writes the selection and removes it", () => {
    const view = makeView("abc", [0]);
    view.dispatch({ selection: EditorSelection.range(1, 3) });
    expect(cutSelection(view)).toBe(true);
    expect(writes).toEqual(["bc"]);
    expect(text(view)).toBe("a");
  });

  it("cut with no selection does nothing", () => {
    const view = makeView("abc", [1]);
    expect(cutSelection(view)).toBe(false);
    expect(text(view)).toBe("abc");
    expect(writes).toEqual([]);
  });

  it("paste replaces the selection with the clipboard text and lands after it", async () => {
    clipboard = "XY";
    const view = makeView("abc", [0]);
    view.dispatch({ selection: EditorSelection.range(1, 2) });
    expect(pasteClipboard(view)).toBe(true);
    await vi.waitFor(() => expect(text(view)).toBe("aXYc"));
    expect(pos(view)).toBe(3);
  });

  it("paste with an empty clipboard leaves the document untouched", async () => {
    clipboard = "";
    const view = makeView("abc", [1]);
    pasteClipboard(view);
    await Promise.resolve();
    await Promise.resolve();
    expect(text(view)).toBe("abc");
  });
});

describe("commands run through the syntax-tree-ready path", () => {
  it("toggleList still skips fenced code when the tree is complete (the tree query and the scan agree)", () => {
    const state = EditorState.create({
      doc: "```\n- literal\n```\nplain",
      extensions: markdownExtensions(),
    });
    ensureSyntaxTree(state, state.doc.length, 10_000);
    let current = state;
    const view = {
      get state() {
        return current;
      },
      dispatch: (spec: TransactionSpec) => {
        current = current.update(spec).state;
      },
      focus: () => {},
    } as unknown as EditorView;
    current = current.update({ selection: EditorSelection.cursor(current.doc.length) }).state;
    toggleList(view, "bullet");
    // The literal line inside the fence keeps its marker; only the body line changes.
    expect(text(view)).toBe("```\n- literal\n```\n- plain");
  });
});
