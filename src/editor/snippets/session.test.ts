import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  buildSession,
  exitChain,
  exitCursorPosition,
  planTab,
  runTab,
  setSession,
  snippetField,
  tryAutoExpand,
  type SnippetSession,
} from "./extension";
import { parseReplacement } from "./engine";

/** Drives the snippetField without DOM: EditorState.update creates the
 *  transactions and the field is read for the assertions. */
function withSession(doc: string, session: SnippetSession | null): EditorState {
  const base = EditorState.create({ doc, extensions: [snippetField] });
  return base.update({ effects: setSession.of(session) }).state;
}

const dm = () => buildSession(0, parseReplacement("$$\n$0\n$$", [], null))!;
const paren = () => buildSession(0, parseReplacement("($0)$1", [], null))!;

/** A view with only the {state, dispatch} face, plus real typing through the
 *  same entry the editor uses (an input.type transaction and then the auto
 *  expansion check), so the sessions are the ones real typing produces. */
function typedView(doc: string): EditorView {
  let state = EditorState.create({ doc, extensions: [snippetField] });
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

function type(view: EditorView, ch: string): void {
  const head = view.state.selection.main.head;
  view.dispatch({
    changes: { from: head, insert: ch },
    selection: { anchor: head + ch.length },
    userEvent: "input.type",
  });
  tryAutoExpand(view, ch, null);
}

const headOf = (view: EditorView) => view.state.selection.main.head;

describe("planTab: Tab advances between tabstops and pops out", () => {
  it("a single-$0 snippet (dm): Tab ends the session and the landing spot is clamped by exitCursorPosition", () => {
    const s = dm();
    expect(s.order).toEqual([0]);
    expect(planTab(s)).toEqual({ kind: "end", session: s });
  });

  it("($0)$1: Tab walks $0 → $1 in turn and the next Tab ends the session", () => {
    const s = paren();
    const p1 = planTab(s);
    expect(p1).toEqual({ kind: "select", session: s, index: 1 });
    const s2 = { ...s, active: 1 };
    expect(planTab(s2)).toEqual({ kind: "end", session: s2 });
  });

  it("nesting: the inner level finishes first and ends on its own session — the parent waits for the next press", () => {
    // A two-stop snippet expanded inside the dm session (e.g. bf →
    // \mathbf{$0}$1)
    const outer = dm();
    const inner = buildSession(3, parseReplacement("\\mathbf{$0}$1", [], null), outer)!;
    // Inner $0 → inner $1 (after the brace); then the inner level ends — it
    // must not be handed to the outer level's next tab stop in the same press.
    expect(planTab(inner)).toEqual({ kind: "select", session: inner, index: 1 });
    const afterInner = { ...inner, active: 1 };
    expect(planTab(afterInner)).toEqual({ kind: "end", session: afterInner });
  });

  it("each level ends on its own session, one press per level (no recursion into the parent)", () => {
    const root = paren(); // [0,1]
    const mid = buildSession(1, parseReplacement("[$0]$1", [], null), { ...root, active: 0 })!;
    const leaf = buildSession(2, parseReplacement("<$0>", [], null), mid)!;
    // The leaf has only one stop: the first press ends the **leaf**; the
    // mid and root levels still have their own stops and follow on later
    // presses.
    expect(planTab(leaf)).toEqual({ kind: "end", session: leaf });
    const doneMid = { ...mid, active: 1 };
    expect(planTab(doneMid)).toEqual({ kind: "end", session: doneMid });
    const doneRoot = { ...root, active: 1 };
    expect(planTab(doneRoot)).toEqual({ kind: "end", session: doneRoot });
  });
});

describe("exitCursorPosition: the landing spot when a session ends (clamped to the formula region)", () => {
  it("a bracket snippet inside a formula block: Tab lands after the closing bracket (finalPos stays strictly inside the region)", () => {
    // The real shape: bf expanded inside a dm block, the document = the
    // expanded text.
    const doc = "$$\n\\mathbf{}\n$$"; // 3 + 9 + 3
    const s = buildSession(3, parseReplacement("\\mathbf{$0}", [], null))!; // finalPos = 12 (after the })
    const state = withSession(doc, s);
    const st = state.update({ selection: { anchor: 11 } }).state; // The caret is inside the {}
    expect(s.finalPos).toBe(12);
    expect(doc.length).toBe(15); // The closing $$ is after finalPos
    expect(exitCursorPosition(st, st.field(snippetField)!)).toBe(12);
  });

  it("a whole-block creation snippet (dm): finalPos lands exactly past the closing $$, so the session ends in place instead of leaving the formula block", () => {
    const s = dm(); // The replacement text "$$\n\n$$", finalPos = 6
    const doc = "$$\n\n$$"; // Same as the replacement text: the region includes the
    // delimiters, to = 6 = finalPos
    const state = withSession(doc, s);
    const st = state.update({ selection: { anchor: 3 } }).state; // The caret is on the empty line (inside the block)
    expect(s.finalPos).toBe(6);
    expect(exitCursorPosition(st, st.field(snippetField)!)).toBeNull();
  });

  it("inline creation (the ma shape $$0$): after typing inside the block finalPos maps to just past the closing $, in place", () => {
    const s = buildSession(0, parseReplacement("$$0$", [], null))!; // text "$$", the stop is at 1, finalPos = 2
    const st0 = withSession("$$", s);
    // Typing x at the stop: the doc becomes "$x$" and finalPos is mapped by
    // the transaction to 3 == region.to
    const st = st0.update({ changes: { from: 1, insert: "x" }, selection: { anchor: 1 } }).state;
    const field = st.field(snippetField)!;
    expect(st.doc.toString()).toBe("$x$");
    expect(field.finalPos).toBe(3);
    expect(exitCursorPosition(st, field)).toBeNull();
  });

  it("a non-formula context: always lands at the end of the replacement text (the old finalPos semantics)", () => {
    const s = buildSession(0, parseReplacement("($0)", [], null))!;
    const state = withSession("()", s);
    const st = state.update({ selection: { anchor: 1 } }).state;
    expect(exitCursorPosition(st, st.field(snippetField)!)).toBe(s.finalPos);
  });
});

describe("exitChain: the session pops out as soon as the caret leaves", () => {
  it("inside the inner region: it is kept in place", () => {
    const outer = paren();
    const inner = buildSession(1, parseReplacement("<$0>", [], null), outer)!;
    expect(exitChain(inner, 2)).toBe(inner);
  });

  it("leaving the inner region but still inside the parent: it pops back to the parent", () => {
    const outer = paren(); // [0,3): inside the brackets is the child session's
    // region, 0 belongs to the parent level alone
    const inner = buildSession(1, parseReplacement("x$0", [], null), outer)!;
    expect(exitChain(inner, 0)).toBe(outer);
  });

  it("leaving the whole chain: null (everything ends)", () => {
    const outer = paren();
    const inner = buildSession(1, parseReplacement("x$0", [], null), outer)!;
    expect(exitChain(inner, 10)).toBeNull();
  });
});

describe("snippetField: chain mapping and full replacement", () => {
  it("after a document edit the stops of every session in the chain are mapped to the new positions", () => {
    const outer = paren();
    const st = withSession("()", outer);
    // Typing "x" inside $0 (position 1): the active stop grows to enclose the
    // input, the other stops shift.
    const edited = st.update({ changes: { from: 1, to: 1, insert: "x" } }).state;
    const mapped = edited.field(snippetField)!;
    expect(mapped).not.toBeNull();
    expect(mapped.stops.get(0)![0]).toEqual({ from: 1, to: 2 });
    expect(mapped.stops.get(1)![0]).toEqual({ from: 3, to: 3 });
    expect(mapped.end).toBe(3);
  });

  it("in the child session expansion transaction the parent active stop grows in step (the data basis for mirror sync)", () => {
    const outer = paren(); // ($0)$1,$0=[1,1]
    const st = withSession("()", outer);
    // The child session expands at the parent's $0 ("Y$0"), with the changes
    // and the effect in the same transaction — the shape of a real expansion.
    const child = buildSession(1, parseReplacement("Y$0", [], null), st.field(snippetField)!)!;
    const edited = st.update({
      changes: { from: 1, to: 1, insert: "Y" },
      effects: setSession.of(child),
    }).state;
    const field = edited.field(snippetField)!;
    // The child session itself is built against the document after the
    // transaction and is not mapped again; the parent chain is mapped into a
    // new object (different identity, current positions).
    expect(field.base).toBe(child.base);
    expect(field.stops.get(0)![0]).toEqual({ from: 2, to: 2 });
    expect(field.parent).not.toBeNull();
    // The parent's $0 is the active stop: after the -1/+1 growth it must
    // enclose the text the child session expanded.
    const parentStop = field.parent!.stops.get(0)![0];
    expect(parentStop).toEqual({ from: 1, to: 2 });
  });

  it("a full document replacement (switching files / loading a whole document) clears the whole chain", () => {
    const outer = paren();
    const inner = buildSession(1, parseReplacement("<$0>", [], null), outer)!;
    const st = withSession("(x<<>>)", inner);
    const replaced = st.update({
      changes: { from: 0, to: st.doc.length, insert: "另一个文件的内容" },
    }).state;
    expect(replaced.field(snippetField)).toBeNull();
  });

  it("ordinary input does not clear the session by mistake", () => {
    const s = dm();
    const st = withSession("$$\n\n$$", s);
    const edited = st.update({ changes: { from: 3, to: 3, insert: "E" } }).state;
    expect(edited.field(snippetField)).not.toBeNull();
  });
});

describe("buildSession: tabstop order and mirroring", () => {
  it("$0 is the first navigation position, the rest follow in order of appearance", () => {
    const s = buildSession(0, parseReplacement("\\sum_{${0:i}=${1:1}}^{${2:N}} $3", [], null))!;
    expect(s.order).toEqual([0, 1, 2, 3]);
  });

  it("without $0 the navigation follows the order of appearance", () => {
    const s = buildSession(0, parseReplacement("ab$1cd$2", [], null))!;
    expect(s.order).toEqual([1, 2]);
  });

  it("a mirrored stop ($0 appears twice) shares one ranges group", () => {
    const s = buildSession(0, parseReplacement("\\begin{$0}\n$1\n\\end{$0}", [], null))!;
    expect(s.order).toEqual([0, 1]);
    expect(s.stops.get(0)!.length).toBe(2);
  });

  it("a replacement without a stop builds no session", () => {
    expect(buildSession(0, parseReplacement("\\alpha", [], null))).toBeNull();
  });
});

describe("Tab inside nested brackets: one level per press (regression: `(a_{t|})`)", () => {
  it("typed from scratch: Tab leaves the subscript brace and does not reach the paren", () => {
    const view = typedView("$$\n\n$$");
    view.dispatch({ selection: { anchor: 3 } });
    for (const ch of ["(", "a", "_", "t"]) type(view, ch);
    const doc = view.state.doc.toString();
    expect(doc).toBe("$$\n(a_{t})\n$$");
    expect(headOf(view)).toBe(doc.indexOf("}")); // After the t, before the }
    expect(runTab(view)).toBe(true);
    expect(headOf(view)).toBe(doc.indexOf("}") + 1); // After } — the paren is still ahead
    expect(runTab(view)).toBe(true);
    expect(headOf(view)).toBe(doc.indexOf(")") + 1); // Now the paren's level
  });

  it("a finished inner snippet (\mathbf{$0}) inside a bracket session: the same one-level rule", () => {
    const view = typedView("$$\n\n$$");
    view.dispatch({ selection: { anchor: 3 } });
    for (const ch of ["(", "b", "f"]) type(view, ch);
    const doc = view.state.doc.toString();
    expect(doc).toBe("$$\n(\\mathbf{})\n$$");
    expect(runTab(view)).toBe(true);
    expect(headOf(view)).toBe(doc.indexOf("}") + 1); // The brace's own level, not past the )
  });

  it("the caret moved back inside the finished brace: Tab still leaves only that brace", () => {
    const view = typedView("$$\n\n$$");
    view.dispatch({ selection: { anchor: 3 } });
    for (const ch of ["(", "a", "_", "t"]) type(view, ch);
    const doc = view.state.doc.toString();
    runTab(view); // Drops the session onto its last stop (after })
    view.dispatch({ selection: { anchor: doc.indexOf("}") } }); // The caret is back before the }
    expect(runTab(view)).toBe(true);
    expect(headOf(view)).toBe(doc.indexOf("}") + 1);
  });
});
