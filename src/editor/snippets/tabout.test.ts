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

/** Only relies on the {state, dispatch} face of the view (the same fake view
 *  as in session.test.ts / ops.test.ts). */
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

describe("planTabout: it scans forward to a closing symbol and steps over it (one level per press)", () => {
  it("the caret sits on the `)` of \\right): it steps over it without changing a single character", () => {
    const doc = "$\\left( x \\right)$";
    const closers = doc.indexOf(")");
    expect(at(doc, doc.indexOf("\\right)")!)).toEqual({ pos: closers + 1, changes: [] });
  });

  it("with several brackets stacked: one Tab leaves only one level and repeated presses work through them all", () => {
    // The caret is after the x of \frac{a}{x}: `}` → `)` → the closing `$`,
    // three Tabs are needed to get all the way out.
    const doc = "$\\frac{a}{x}(y)$";
    const step1 = at(doc, doc.indexOf("x") + 1)!;
    expect(step1.pos).toBe(doc.indexOf("}(y)") + 1); // The denominator's closing brace
    const step2 = at(doc, step1.pos)!;
    expect(step2.pos).toBe(doc.indexOf(")") + 1); // The closing round bracket of (y)
    const step3 = at(doc, step2.pos)!;
    expect(step3.pos).toBe(doc.length); // Past the closing $, outside the formula
    expect(at(doc, step3.pos)).toBeNull(); // Already outside the formula: Tab is no longer taken over
  });

  it("\\rangle is stepped over as a whole (it does not end with a scannable single character)", () => {
    const doc = "$\\langle x \\rangle$";
    const pos = doc.indexOf("\\rangle");
    expect(at(doc, pos)).toEqual({ pos: pos + "\\rangle".length, changes: [] });
  });

  it("`|` and `>` are in the scan table as well (the plugin\'s original table)", () => {
    expect(at("$a|b$", 1)).toEqual({ pos: 3, changes: [] }); // Skips the a and lands after the |
    expect(at("$a>b$", 1)).toEqual({ pos: 3, changes: [] });
  });

  it("ordinary characters after the caret: it does not take over (it only jumps closing symbols, not content)", () => {
    const doc = "$a)b$";
    expect(at(doc, 3)).toBeNull(); // The `)` is **before** the caret, and the scan only looks forward
  });

  it("Tab in body text does nothing (it only applies inside a formula)", () => {
    expect(at("普通文本(说明)", 2)).toBeNull();
    const doc = "正文\n\n$(x)$";
    expect(at(doc, doc.indexOf("正文"))).toBeNull();
  });

  it("the caret rests on a delimiter (those two or three $ at the formula edges): that is not a jump-out case", () => {
    const inline = "$(x)$";
    expect(at(inline, 0)).toBeNull(); // On the opening $
    expect(at(inline, inline.length)).toBeNull(); // On the closing $
    const block = "$$\n(x)\n$$";
    expect(at(block, 1)).toBeNull(); // On the second $ of the opening $$
    expect(at(block, block.length - 1)).toBeNull(); // On the first $ of the closing $$
  });
});

describe("planTabout: jumping out of a whole formula tail", () => {
  it("an inline formula: the caret is already at the end of the content → it lands after the closing $ (one jump out of the formula)", () => {
    const doc = "$x$";
    expect(at(doc, 2)).toEqual({ pos: doc.length, changes: [] });
  });

  it("`$x $` ending with whitespace is not a formula at all (an inline region may not end that way)", () => {
    expect(at("$x $", 2)).toBeNull();
  });

  it("a block formula: it lands at the start of the line after the bottom $$ and the trailing whitespace on the caret line is removed", () => {
    const doc = "$$\nE[q]   \n$$\n下一段";
    const plan = at(doc, doc.indexOf("E[q]") + 4)!;
    // The three trailing spaces are eaten, so the landing point shifts left:
    // the first character of the next paragraph moves from 14 to 11.
    expect(plan.changes).toEqual([
      { from: doc.indexOf("E[q]"), to: doc.indexOf("E[q]") + 7, insert: "E[q]" },
    ]);
    expect(plan.pos).toBe(11);
    const preview =
      doc.slice(0, doc.indexOf("E[q]") + 4).trimEnd() + doc.slice(doc.indexOf("E[q]") + 7);
    expect(preview.slice(plan.pos)).toBe("下一段");
  });

  it("a block formula: the leading indentation is kept (in a list item it is markdown structure, so it is not trimmed)", () => {
    const doc = "$$\n  E[q]  \n$$\n下一段";
    const plan = at(doc, doc.indexOf("E[q]") + 4)!;
    expect(plan.changes).toEqual([
      { from: doc.indexOf("E[q]") - 2, to: doc.indexOf("E[q]") + 6, insert: "  E[q]" },
    ]);
    expect(plan.pos).toBe(doc.indexOf("下一段") - 2);
  });

  it("the bottom $$ is already the last line: a newline is inserted first so there is a next line to land on", () => {
    const doc = "$$\nx\n$$";
    const plan = at(doc, doc.indexOf("x") + 1)!;
    expect(plan.changes).toEqual([{ from: doc.length, to: doc.length, insert: "\n" }]);
    expect(plan.pos).toBe(doc.length + 1);
  });

  it("the caret rests in the middle of the content (characters follow): it does not jump out of the whole block", () => {
    expect(at("$$\nx\ny\n$$", 4)).toBeNull();
  });
});

describe("tabout: dispatch and the toggle", () => {
  it("the caret lands as planned and the block-level trailing cleanup is dispatched together", () => {
    const doc = "$$\nx   \n$$\n下一段";
    const view = makeView(doc, [doc.indexOf("x") + 1]);
    expect(tabout(view)).toBe(true);
    expect(text(view)).toBe("$$\nx\n$$\n下一段");
    expect(text(view).slice(head(view))).toBe("下一段");
  });

  it("no jump target: it hands back to further handling (false, the Tab is not swallowed)", () => {
    const view = makeView("正文段落", [0]);
    expect(tabout(view)).toBe(false);
    expect(text(view)).toBe("正文段落");
  });

  it("with the toggle off it does not take over at all (the plugin\'s taboutEnabled)", () => {
    configureLatexSuite({ tabout: false });
    const view = makeView("$(x)$", [2]);
    expect(tabout(view)).toBe(false);
  });
});

describe("Tab chain order: session → expansion → tabout (the plugin\'s handleKeydown order)", () => {
  const DM = "$$\n\\begin{pmatrix}\nQ & b\n\\end{pmatrix}\n$$";

  it("with a session: Tab walks the tabstops and does not do tabout", () => {
    const doc = "$\\mathbf{}$";
    const session = buildSession(1, parseReplacement("\\mathbf{$0}$1", [], null))!;
    const view = makeView(doc, [doc.indexOf("}")], session);
    expect(runTab(view)).toBe(true);
    expect(head(view)).toBe(doc.indexOf("}$") + 1); // Advances to $1 (after the closing bracket)
    expect(text(view)).toBe(doc); // Only the caret moves, the document is unchanged
    expect(view.state.field(snippetField)).not.toBeNull(); // The session is still alive
  });

  it("only the Tab after the session has run out goes to tabout: the caret leaves the brackets", () => {
    // The real shape after the sum snippet expanded and autoEnlarge ran: the
    // caret rests after \sum…, with a \right) still outside.
    const doc = "$\\left( \\sum_{i=1}^{N} \\right)$";
    const pos = doc.indexOf("\\sum");
    const session = buildSession(
      pos,
      parseReplacement("\\sum_{${0:i}=${1:1}}^{${2:N}} $3", [], null),
    )!;
    const view = makeView(doc, [doc.indexOf("\\right)")], session);
    // The session is not finished yet: Tab only advances the tab stop.
    runTab(view);
    expect(view.state.field(snippetField, false)).not.toBeNull();
    // Tab after the session ended: only this press is the "leave the
    // bracket" — one level per press, until the closing bracket is behind.
    for (let i = 0; i < 6; i++) runTab(view);
    expect(head(view)).toBeGreaterThan(doc.indexOf(")"));
  });

  it("no session and nothing to expand: Tab falls through to tabout (it no longer ends up in indentMore)", () => {
    const doc = "$$\n\\left( x \\right)\n$$";
    const view = makeView(doc, [doc.indexOf("\\right)")]);
    expect(runTab(view)).toBe(true);
    expect(head(view)).toBe(doc.indexOf(")") + 1);
    expect(text(view)).toBe(doc); // Only the caret moves, the document is unchanged
  });

  it("the caret rests after the complete command \\theta: Tab only steps over the bracket and no longer expands the tail into \\th\\eta", () => {
    // Regression (reproduced on a real machine): after `tt` auto-expanded to
    // `\theta`, pressing Tab let the "add a backslash to Greek letters" auto
    // regex `([^\\])(${GREEK})` match the `h`+`eta` at the end of the line and
    // rewrite `eta` into `\eta`. The plugin's auto snippets require "a
    // character really typed" (key.length === 1), so Tab is not one.
    const doc = "$J(\\theta)$";
    const view = makeView(doc, [doc.indexOf("\\theta") + "\\theta".length]);
    expect(runTab(view)).toBe(true);
    expect(text(view)).toBe(doc);
    expect(head(view)).toBe(doc.indexOf(")") + 1); // Steps over the closing bracket
  });

  it("a plain Tab in a matrix no longer inserts ` & ` (it is left to tabout); only Shift+Tab is the column separator", () => {
    const separator = makeView(DM, [DM.indexOf("Q")]);
    expect(matrixSeparator(separator)).toBe(true);
    expect(text(separator)).toBe(DM.replace("Q", " & Q"));

    const tabbed = makeView(DM, [DM.indexOf("Q")]);
    expect(runTab(tabbed)).toBe(true);
    expect(text(tabbed)).toBe(DM); // No ` & ` was inserted into the formula

    const shifted = makeView(DM, [DM.indexOf("Q")]);
    expect(runShiftTab(shifted)).toBe(true);
    expect(text(shifted)).toBe(DM.replace("Q", " & Q"));
  });

  it("pressing Tab repeatedly in a matrix: the caret is sent past \\end{pmatrix} one level at a time", () => {
    const view = makeView(DM, [DM.indexOf("Q")]);
    expect(runTab(view)).toBe(true);
    // After the line end only the `}` (the environment's closing) and
    // whitespace are left: the first press already steps over \end{pmatrix}
    expect(head(view)).toBe(DM.indexOf("\\end{pmatrix}") + "\\end{pmatrix}".length);
    // One more: only whitespace is left behind the caret → it lands on the
    // line after the bottom $$ (past the last line of the document).
    expect(runTab(view)).toBe(true);
    expect(text(view).slice(head(view)).trim()).toBe("");
  });

  it("outside a matrix Shift+Tab goes back to the previous tabstop (the key is not swallowed and no & is inserted)", () => {
    const doc = "$\\mathbf{}$";
    const session = buildSession(1, parseReplacement("\\mathbf{$0}$1", [], null))!;
    const view = makeView(doc, [doc.indexOf("}$")], { ...session, active: 1 });
    expect(runShiftTab(view)).toBe(true);
    expect(text(view)).toBe(doc);
    expect(head(view)).toBe(doc.indexOf("}")); // Back to $0
  });
});

describe("closing bracket skip: typing the right bracket in front of the caret equals one Tab", () => {
  const session = () => buildSession(0, parseReplacement("($0)$1", [], null))!;

  it("typing `)` after a bracket snippet expands: it is not inserted twice but directly leaves this level", () => {
    const view = makeView("()", [1], session());
    expect(view.state.field(snippetField)!.order).toEqual([0, 1]);
    const before = view.state;
    // The default insertion transaction (where the vim and non-vim typing
    // paths meet)
    view.dispatch({
      changes: { from: 1, insert: ")" },
      selection: { anchor: 2 },
      userEvent: "input.type",
    });
    expect(text(view)).toBe("())"); // The extra one (the intermediate state the after-the-fact decision has to handle)
    expect(closeBracketSkip(view, before, { from: 1, to: 1, insert: ")" }, 2)).toBe(true);
    expect(text(view)).toBe("()"); // The one just inserted is withdrawn, the one already there stays
    expect(head(view)).toBe(2); // The caret jumps out to $1
  });

  it("the last tabstop: it is passed through as the plugin does (the character is inserted as typed)", () => {
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

  it("the character in front of the caret is not the same right bracket: it does not take over (ordinary input)", () => {
    const view = makeView("(x", [2], session());
    const before = view.state;
    view.dispatch({
      changes: { from: 2, insert: ")" },
      selection: { anchor: 3 },
      userEvent: "input.type",
    });
    expect(closeBracketSkip(view, before, { from: 2, to: 2, insert: ")" }, 3)).toBe(false);
  });

  it("no session: it does not take over (the plugin also inserts the character when there is no tabstop)", () => {
    const view = makeView("()", [1]);
    const before = view.state;
    view.dispatch({
      changes: { from: 1, insert: ")" },
      selection: { anchor: 2 },
      userEvent: "input.type",
    });
    expect(closeBracketSkip(view, before, { from: 1, to: 1, insert: ")" }, 2)).toBe(false);
  });

  it("`]` is skipped the same way (the plugin table has only three right brackets)", () => {
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

describe("the seam between a session and tabout", () => {
  it("once tabout takes the caret out of the session range, exitChain closes the session", () => {
    const session = buildSession(0, parseReplacement("($0)$1", [], null))!;
    const doc = "$(x)$";
    const out = doc.indexOf(")") + 1;
    expect(exitChain(session, out)).toBeNull();
  });
});
