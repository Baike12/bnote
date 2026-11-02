import { beforeEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { autoEnlargeBrackets, enlargeBracketEdits } from "./enlarge";
import { MATRIX_ROW_BREAK, alignEnterPlan, matrixEnter, matrixEnvAt, matrixSeparator } from "./matrix";
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
import { reloadSnippets } from "./engine";
import { tryAutoExpand } from "./extension";
import { DEFAULT_SNIPPETS } from "./default-snippets";
import { buildBracketColors, buildCursorBrackets, enclosingBrackets, findMatchingBracket, withinEnv } from "./brackets";
import { configureLatexSuite, resetLatexConfig } from "./config";

beforeEach(() => {
  resetLatexConfig();
});

/** Only relies on the {state, dispatch} face of the view (the same fake view
 *  as in ops.test.ts). */
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

describe("enlargeBracketEdits: a big operator inside the brackets upgrades them to \\left…\\right", () => {
  const run = (doc: string, triggers = ["sum", "int", "frac", "prod", "bigcup", "bigcap"]) =>
    enlargeBracketEdits(doc, 0, doc.length, triggers);

  it("a \\sum inside round brackets: an enlarging command is inserted on both sides and one space is left", () => {
    expect(run("(\\sum_{i} x)")).toEqual([
      { from: 0, to: 1, insert: "\\left( " },
      { from: 11, to: 12, insert: " \\right)" },
    ]);
  });

  it("no trigger word in the content: nothing is changed", () => {
    expect(run("(x + y)")).toEqual([]);
  });

  it("an already enlarged pair is skipped and never enlarged twice", () => {
    expect(run("\\left(\\sum x\\right)")).toEqual([]);
  });

  it("nesting: the inner and the outer pair are enlarged each on their own (a pair with a trigger word is not skipped wholesale)", () => {
    expect(run("((\\sum x))").map((e) => e.insert)).toEqual([
      "\\left( ",
      " \\right)",
      "\\left( ",
      " \\right)",
    ]);
  });

  it("square brackets and escaped braces are enlarged just the same", () => {
    expect(run("[\\int x]").map((e) => e.insert)).toEqual(["\\left[ ", " \\right]"]);
    expect(run("\\{\\sum\\}").map((e) => e.insert)).toEqual(["\\left\\{ ", " \\right\\}"]);
  });

  it("multi-character brackets such as \\langle…\\rangle are recognized too (the plugin's table of eight bracket pairs)", () => {
    expect(run("\\langle \\sum \\rangle").map((e) => e.insert)).toEqual([
      "\\left\\langle ",
      " \\right\\rangle",
    ]);
  });

  it("no matching closing bracket: nothing is changed", () => {
    expect(run("(\\sum x")).toEqual([]);
  });

  it("the trigger word matches as a substring (like the plugin: \\internal also enlarges because it contains \\int)", () => {
    expect(run("(\\internal)").map((e) => e.insert)).toEqual(["\\left( ", " \\right)"]);
  });
});

describe("autoEnlargeBrackets: it runs only after the expansion and only recognizes the text inserted this time", () => {
  it("after inserting \\frac the outer brackets are upgraded (the path after an auto fraction)", () => {
    const view = makeView("$(\\frac{a}{b})$", [2]);
    expect(autoEnlargeBrackets(view, "\\frac{a}{b}")).toBe(true);
    expect(text(view)).toBe("$\\left( \\frac{a}{b} \\right)$");
  });

  it("no trigger word in the inserted text: not a single character of the whole equation changes", () => {
    const view = makeView("$(\\sum x)$", [2]);
    expect(autoEnlargeBrackets(view, "\\alpha")).toBe(false);
    expect(text(view)).toBe("$(\\sum x)$");
  });

  it("with the toggle off it does not run at all", () => {
    configureLatexSuite({ autoEnlargeBrackets: false });
    const view = makeView("$(\\frac{a}{b})$", [2]);
    expect(autoEnlargeBrackets(view, "\\frac{a}{b}")).toBe(false);
    expect(text(view)).toBe("$(\\frac{a}{b})$");
  });

  it("the caret is not inside a formula: nothing is changed (enlarging only happens within an equation)", () => {
    const view = makeView("正文\n\n$(\\frac{a}{b})$", [0]);
    expect(autoEnlargeBrackets(view, "\\frac")).toBe(false);
  });
});

describe("matrix environment detection and shortcuts", () => {
  const BLOCK = "$$\n\\begin{pmatrix}\nQ & b\n\\end{pmatrix}\n$$";

  it("a matrix environment is recognized inside a block formula", () => {
    const pos = BLOCK.indexOf("Q & b") + 1;
    expect(matrixEnvAt(EditorState.create({ doc: BLOCK }), pos)).toBe("pmatrix");
  });

  it("environment names such as cases / align are all in the settings table", () => {
    for (const env of ["cases", "align", "bmatrix", "array"]) {
      // Q is used as the body text: an environment name may contain x/a
      // (bmatrix, matrix), and using those as the caret marker would land
      // inside the environment name.
      const doc = `$$\n\\begin{${env}}\nQ\n\\end{${env}}\n$$`;
      const state = EditorState.create({ doc });
      expect(matrixEnvAt(state, doc.indexOf("Q") + 1)).toBe(env);
    }
  });

  it("outside an environment (inside the formula but not inside a matrix) it returns null", () => {
    const doc = "$$\na & b\n$$";
    const state = EditorState.create({ doc });
    expect(matrixEnvAt(state, doc.indexOf("&"))).toBeNull();
  });

  it("it does not apply inside an inline formula (the plugin only triggers in block math)", () => {
    const doc = "$\\begin{pmatrix}a\\end{pmatrix}$";
    const state = EditorState.create({ doc });
    expect(matrixEnvAt(state, doc.indexOf("a"))).toBeNull();
  });

  it("the matrix column separator hangs on Shift+Tab and outside an environment it hands back to further handling (false)", () => {
    const inside = makeView(BLOCK, [BLOCK.indexOf("Q")]);
    expect(matrixSeparator(inside)).toBe(true);
    expect(text(inside)).toBe(BLOCK.replace("Q", " & Q"));

    const outside = makeView("$$x$$", [2]);
    expect(matrixSeparator(outside)).toBe(false);
    expect(text(outside)).toBe("$$x$$");
  });

  it("Enter inside a matrix completes a `\\\\` line break: the row separator is two backslashes plus a newline", () => {
    expect([...MATRIX_ROW_BREAK]).toEqual([" ", "\\", "\\", "\n"]);
    const view = makeView(BLOCK, [BLOCK.indexOf("Q")]);
    expect(matrixEnter(view)).toBe(true);
    expect(text(view)).toBe(
      "$$\n\\begin{pmatrix}\n \\\\\nQ & b\n\\end{pmatrix}\n$$",
    );
  });

  it("Shift+Enter only sends the caret to the end of the next line and does not touch the document", () => {
    const view = makeView(BLOCK, [BLOCK.indexOf("Q")]);
    const before = text(view);
    expect(matrixEnter(view, true)).toBe(true);
    expect(text(view)).toBe(before);
    // The caret starts on line 3 (Q & b); shift+Enter sends it to the end of
    // line 4 (the line with \end{pmatrix}).
    expect(view.state.doc.lineAt(head(view)).number).toBe(4);
    expect(head(view)).toBe(view.state.doc.line(4).to);
  });

  it("with the toggle off neither Shift+Tab nor Enter is recognized", () => {
    configureLatexSuite({ matrixShortcuts: false });
    const view = makeView(BLOCK, [BLOCK.indexOf("Q")]);
    expect(matrixSeparator(view)).toBe(false);
    expect(matrixEnter(view)).toBe(false);
  });
});

describe("align continuation: Enter adds the relation symbol & and the trailing \\\\", () => {
  const ALIGN = "$$\n\\begin{align}\nLINE\n\\end{align}\n$$";
  const inAlign = (line: string) => ALIGN.replace("LINE", line);
  const enterAt = (line: string, ch: number) => {
    const doc = inAlign(line);
    // An empty or repeated line cannot be located with indexOf: take the
    // start of the line by its (first) line number.
    const lines = doc.split("\n");
    const lineNo = lines.indexOf(line) + 1;
    const at = view0.state.doc.line(lineNo).from + ch;
    const view = makeView(doc, [at]);
    const handled = matrixEnter(view);
    return { handled, view };
  };
  const view0 = makeView(ALIGN, [0]);

  it("a pure function: a relation symbol with no space before the equals sign gets &, and the line end gets \\\\ plus a newline", () => {
    expect(alignEnterPlan("c=d")).toBe("c&=d \\\\\n");
    expect(alignEnterPlan("a = b")).toBe("a &= b \\\\\n");
    // For <= and >= the alignment point is the start of the relation operator
    // (&<= and not <&=).
    expect(alignEnterPlan("a <= b")).toBe("a &<= b \\\\\n");
    expect(alignEnterPlan("x >= y")).toBe("x &>= y \\\\\n");
    // A line without a relation operator only gets the row separator.
    expect(alignEnterPlan("\\alpha")).toBe("\\alpha \\\\\n");
    // An existing & is the user's own alignment point; nothing is inserted.
    expect(alignEnterPlan("a &= b")).toBe("a &= b \\\\\n");
    // An escaped relation operator (\=) is not an alignment point.
    expect(alignEnterPlan("a \\=b")).toBe("a \\=b \\\\\n");
  });

  it("a pure function: empty lines, begin/end lines and lines that already have \\\\ are not taken over (null)", () => {
    expect(alignEnterPlan("")).toBeNull();
    expect(alignEnterPlan("   ")).toBeNull();
    expect(alignEnterPlan("\\begin{align}")).toBeNull();
    expect(alignEnterPlan("\\end{align}")).toBeNull();
    expect(alignEnterPlan("a &= b \\\\")).toBeNull();
    expect(alignEnterPlan("a &= b\\\\ ")).toBeNull();
  });

  it("Enter completes the half line in front of the caret, the caret lands at the start of the new line and the second half moves down naturally", () => {
    // The caret is at the end of the line (after the d of c=d): the whole line
    // is completed and broken; a break at the line end means the same as a
    // plain Enter (\end moves down, a caret line is left in between).
    const { handled, view } = enterAt("c=d", 3);
    expect(handled).toBe(true);
    // A break at the line end has the semantics of a plain line break: the
    // line is completed, the caret sits on an empty new line, \end moves down.
    expect(text(view)).toBe(inAlign("c&=d \\\\\n"));
    const newLine = view.state.doc.lineAt(head(view));
    expect(head(view)).toBe(newLine.from);
    expect(newLine.text).toBe(""); // The caret rests on the empty new line.
    // The caret breaks in the middle of the line (and there is no relation
    // operator before the break): only the first half gets the row
    // separator, the second half becomes the new line.
    const mid = enterAt("c=d", 1);
    expect(mid.handled).toBe(true);
    // The third line is `c \` (a double backslash at the end of the line), the
    // fourth is `=d`.
    const lines = text(mid.view).split("\n");
    expect(lines[2]).toBe("c \\\\");
    expect(lines[3]).toBe("=d");
  });

  it("a line that is not taken over is handed back to the default (it returns false and the document does not change)", () => {
    for (const line of ["", "a &= b \\\\", "\\end{align}"]) {
      const { handled, view } = enterAt(line, line.length);
      expect(handled).toBe(false);
      expect(text(view)).toBe(inAlign(line));
    }
    // A caret at the start of the line (empty first half) is not taken over
    // either.
    const atStart = enterAt("c=d", 0);
    expect(atStart.handled).toBe(false);
  });

  it("pmatrix and other matrix environments are unaffected and still insert `\\\\\\\n`", () => {
    const PMATRIX = "$$\n\\begin{pmatrix}\nQ & b\n\\end{pmatrix}\n$$";
    const view = makeView(PMATRIX, [PMATRIX.indexOf("Q")]);
    expect(matrixEnter(view)).toBe(true);
    expect(text(view)).toBe("$$\n\\begin{pmatrix}\n \\\\\nQ & b\n\\end{pmatrix}\n$$");
  });
});

describe("the dm snippet: a formula block directly produces an align environment", () => {
  it("the built-in dm has the shape $$ + align($0 inside the environment body)", () => {
    const dm = DEFAULT_SNIPPETS.find((s) => s.trigger === "dm");
    expect(dm?.replacement).toBe("$$\n\\begin{align}\n$0\n\\end{align}\n$$");
  });
});

describe("no auto expansion inside an environment name (the root cause of the caret drift)", () => {
  const envNameView = (doc: string, cursor: number): EditorView => {
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
  };

  beforeEach(() => {
    reloadSnippets([{ trigger: "ali", replacement: "\\begin{align}\n$0\n\\end{align}", options: "mA" }], true);
  });

  it("ali still expands as usual inside a formula body", () => {
    const view = envNameView("$$ali", 5);
    expect(tryAutoExpand(view, "i", null)).toBe(true);
    expect(view.state.doc.toString()).toBe("$$\\begin{align}\n\n\\end{align}");
  });

  it("typing inside the environment name of \\begin{ does not trigger (the root cause of a broken environment name and the caret jumping away)", () => {
    const view = envNameView("$$\\begin{al", 11);
    expect(tryAutoExpand(view, "i", null)).toBe(false);
    expect(view.state.doc.toString()).toBe("$$\\begin{al");
  });

  it("typing inside the environment name of \\end{ does not trigger either", () => {
    const view = envNameView("$$\\begin{x}\\end{al", 18);
    expect(tryAutoExpand(view, "i", null)).toBe(false);
    expect(view.state.doc.toString()).toBe("$$\\begin{x}\\end{al");
  });

  it("the expansion decision recovers once the environment name is closed", () => {
    const view = envNameView("$$\\begin{x}ali", 14);
    expect(tryAutoExpand(view, "i", null)).toBe(true);
  });
});

describe("autoDelete$: the caret between two $ deletes both at once", () => {
  it("an empty inline formula `$|$` is deleted in one go, leaving no stray $", () => {
    const view = makeView("$$", [1]);
    expect(deleteDollarPair(view)).toBe(true);
    expect(text(view)).toBe("");
  });

  it("an empty block formula `$$|$$` likewise deletes both at once", () => {
    const view = makeView("$$$$", [2]);
    expect(deleteDollarPair(view)).toBe(true);
    expect(text(view)).toBe("$$");
  });

  it("only one $ next to the caret: it hands back to the default deletion", () => {
    const view = makeView("$x$", [2]);
    expect(deleteDollarPair(view)).toBe(false);
    expect(text(view)).toBe("$x$");
  });

  it("two $ outside a formula are not deleted (a dollar sign in body text)", () => {
    const view = makeView("价格$5 和 $10 不同", [5]);
    expect(deleteDollarPair(view)).toBe(false);
  });

  it("with the toggle off it does not take over Backspace", () => {
    configureLatexSuite({ autoDeleteDollar: false });
    const view = makeView("$$", [1]);
    expect(deleteDollarPair(view)).toBe(false);
  });
});

describe("deleteScriptBraces: an empty script brace pair is deleted together with its marker", () => {
  const atBrace = (doc: string) => doc.indexOf("}");

  it("`_{|}` is deleted in one go, leaving no `_}` that needs two more presses", () => {
    const doc = "$x_{}$";
    const view = makeView(doc, [atBrace(doc)]);
    expect(deleteScriptBraces(view)).toBe(true);
    expect(text(view)).toBe("$x$");
  });

  it("`^{|}` is deleted in one go as well", () => {
    const doc = "$a^{}$";
    const view = makeView(doc, [atBrace(doc)]);
    expect(deleteScriptBraces(view)).toBe(true);
    expect(text(view)).toBe("$a$");
  });

  it("it works the same inside a block formula", () => {
    const doc = "$$\nx_{}\n$$";
    const view = makeView(doc, [atBrace(doc)]);
    expect(deleteScriptBraces(view)).toBe(true);
    expect(text(view)).toBe("$$\nx\n$$");
  });

  it("when nested only the innermost pair is deleted", () => {
    const doc = "$x_{a_{}}$";
    const view = makeView(doc, [atBrace(doc)]);
    expect(deleteScriptBraces(view)).toBe(true);
    expect(text(view)).toBe("$x_{a}$");
  });

  it("there is content inside the braces: that is an ordinary deletion and it does not take over", () => {
    const doc = "$x_{a}$";
    const view = makeView(doc, [doc.indexOf("}")]);
    expect(deleteScriptBraces(view)).toBe(false);
    expect(text(view)).toBe("$x_{a}$");
  });

  it("a `_{}` outside a formula is left alone (in body text `_` is an emphasis marker)", () => {
    const doc = "x_{}";
    const view = makeView(doc, [atBrace(doc)]);
    expect(deleteScriptBraces(view)).toBe(false);
    expect(text(view)).toBe("x_{}");
  });

  it("with a selection it does not take over and hands back to the default deletion", () => {
    const doc = "$x_{}$";
    const view = makeView(doc, [atBrace(doc)]);
    view.dispatch({ selection: EditorSelection.range(2, 5) });
    expect(deleteScriptBraces(view)).toBe(false);
  });
});

/** A fake view wrapping a state that carries the snippetField: the deleted
 *  range is exactly the active region sj expanded, which verifies the session
 *  mapping. */
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

describe("deleteScriptBraces: with an sj/sk session present the whole pair is deleted", () => {
  it("the session is mapped to a single point at the deletion site, with no coordinate pointing outside the document", () => {
    const doc = "$x_{}$";
    // sj's replacement text `_{$0}` expands at position 2: base=2 and the
    // active region is between the `{}` (position 4).
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
    // The caret is still on this level's point: it is kept; moving one more
    // character pops it by the existing rule, leaving no leftover level.
    expect(exitChain(field, 2)).toBe(field);
    expect(exitChain(field, 3)).toBeNull();
  });

  it("with an outer session only that inner level is deleted", () => {
    // The outer \frac occupies [1,13) (the denominator $1 is the active stop
    // and the inner sj grows inside it).
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
    // The parent chain is still there and the whole chain is mapped to the new
    // document coordinates (the denominator's { } collapses onto the
    // deletion point).
    expect(field.parent!.base).toBe(1);
    expect(field.parent!.end).toBe(10);
    expect(field.parent!.stops.get(1)![0]).toEqual({ from: 9, to: 9 });
  });
});

describe("bracket geometry", () => {
  it("findMatchingBracket pairs forward (multi-character brackets supported)", () => {
    expect(findMatchingBracket("(a(b)c)", 0, "(", ")")).toBe(6);
    expect(findMatchingBracket("\\langle \\sum \\rangle", 0, "\\langle", "\\rangle")).toBe(13);
    expect(findMatchingBracket("(abc", 0, "(", ")")).toBe(-1);
  });

  it("reverse pairing: from the closing bracket to the opening one", () => {
    expect(findMatchingBracket("(a(b)c)", 6, "(", ")", true)).toBe(0);
    expect(findMatchingBracket("\\frac{a}{b}", 10, "{", "}", true)).toBe(8);
  });

  it("withinEnv: with nested environments of the same name it finds the layer that really encloses the caret", () => {
    const text2 = "\\pu{a \\pu{b} c}";
    const inner = text2.indexOf("b");
    expect(withinEnv(text2, inner, "\\pu{", "}")).toBe(true);
    const after = text2.length; // Outside the environment
    expect(withinEnv(text2, after, "\\pu{", "}")).toBe(false);
  });

  it("enclosingBrackets: takes the innermost enclosing brackets and returns null when the caret is outside them", () => {
    expect(enclosingBrackets("x (a [b] c) y", 7)).toEqual({ left: 5, right: 7 });
    expect(enclosingBrackets("a b c", 3)).toBeNull();
  });
});

/**
 * The gate for the **geometric source** of the two bracket decoration
 * builders. They run on every selection change (the caret highlight) or used
 * to (the colored pairs), so who reads the full text and who is independent
 * of the selection must be locked down:
 *   - The colored pairs depend only on the document + viewport — that is why
 *     the plugin does not rebuild on selectionSet;
 *   - The caret highlight looks only at the two characters at the caret plus
 *     the one formula region it sits in; it must not stringify the whole
 *     document (the former `state.doc.toString()` copied the full text on
 *     every selection change).
 */
describe("the geometric source of the bracket decorations", () => {
  /** A fake view that only needs {state, visibleRanges}. */
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

  it("the colored pairs do not depend on the selection (two different carets in one document → the same decorations)", () => {
    const doc = "前置\n\n$$a+(b)\\cdot[c]$$\n\n后置\n";
    const a = decoView(doc, 0);
    const b = { state: a.state.update({ selection: EditorSelection.cursor(8) }).state, visibleRanges: a.visibleRanges };
    expect(decos(buildBracketColors(b))).toEqual(decos(buildBracketColors(a)));
    expect(decos(buildBracketColors(a)).length).toBeGreaterThan(0);
  });

  it("the colored pairs only paint formulas inside the viewport", () => {
    const doc = "$$a+(b)$$\n\n中间隔开的一些正文\n\n$$c+[d]$$\n";
    const first = { from: 0, to: 10 };
    const marks = decos(buildBracketColors(decoView(doc, 0, first)));
    const open = doc.indexOf("(");
    const close = doc.indexOf(")");
    // The one bracket pair of the first formula (outermost → color 0)
    expect(marks).toEqual([
      `cw-bracket-0@${open}-${open + 1}`,
      `cw-bracket-0@${close}-${close + 1}`,
    ]);
    // Not a single decoration is drawn for the second formula (c+[d]) outside
    // the viewport.
    expect(marks.every((m) => Number(m.split("@")[1].split("-")[0]) <= first.to)).toBe(true);
  });

  it("caret highlight: when the caret is right next to a bracket it yields the two paired characters", () => {
    const doc = "$$a+(b+c)+d$$\n";
    const open = doc.indexOf("(");
    // The caret rests right after `(` (vim's insert mode is exactly this
    // adjacent position)
    const marks = decos(buildCursorBrackets(decoView(doc, open + 1)));
    expect(marks).toEqual([
      `cw-bracket-match@${open}-${open + 1}`,
      `cw-bracket-match@${doc.indexOf(")")}-${doc.indexOf(")") + 1}`,
    ]);
  });

  it("caret highlight: outside a formula there is no decoration (no full-document scan)", () => {
    const doc = "普通文本 (含括号) 但不长在公式里\n";
    const open = doc.indexOf("(");
    expect(decos(buildCursorBrackets(decoView(doc, open + 1)))).toEqual([]);
  });

  it("caret highlight: in a long formula it still reads the characters by position only (the geometry does not depend on the full text)", () => {
    const filler = "x_{1}+".repeat(400); // ~2000 characters
    const doc = `$$${filler}\\left(a+(b)\\right)$$\n`;
    const open = doc.indexOf("(b)");
    const marks = decos(buildCursorBrackets(decoView(doc, open + 1)));
    expect(marks).toEqual([
      `cw-bracket-match@${open}-${open + 1}`,
      `cw-bracket-match@${open + 2}-${open + 3}`,
    ]);
  });
});
