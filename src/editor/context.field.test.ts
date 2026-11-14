import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { scanMath } from "./mathScan";
import { mathRegions, mathRegionsField } from "./context";
import { renumberHeadings } from "./numbering";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * The incremental math field's two remaining decisions, plus the renumber
 * command's dispatch rule.
 *
 * The field is a cache over `scanMath`: an edit that cannot change pairing maps
 * the stored regions instead of rescanning (a rescan on every keystroke is the
 * O(document) cost the field exists to avoid), while an edit that can change
 * pairing must rescan. The mapping half has two shapes — a region the edit
 * intersects gets its content re-sliced, a region it merely shifts keeps its
 * content string — and only the second one appears when the edit is far from
 * every formula.
 */
function stateOf(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [mathRegionsField] });
  state.field(mathRegionsField); // force the initial scan outside any measurement
  return state;
}

function insert(state: EditorState, from: number, text: string): EditorState {
  return state.update({
    changes: { from, insert: text },
    selection: { anchor: from + text.length },
  }).state;
}

describe("mathRegionsField: a region the edit only shifts keeps its content slice", () => {
  it("typing before a formula moves the region without re-slicing its content", () => {
    let state = stateOf("$x+y$ tail");
    const before = mathRegions(state)[0];
    state = insert(state, 0, "abc");
    const after = mathRegions(state)[0];
    expect(after.content).toBe(before.content);
    expect(after.from).toBe(before.from + 3);
    expect(after.to).toBe(before.to + 3);
  });

  it("typing after a formula leaves the region object untouched", () => {
    const state = stateOf("$x$ tail");
    const regions = mathRegions(state);
    const next = insert(state, state.doc.length, "!");
    expect(mathRegions(next)).toEqual(regions);
  });

  it("typing inside the formula body re-slices only that region's content", () => {
    let state = stateOf("$x$ and $y$");
    state = insert(state, 2, "+1");
    const regions = mathRegions(state);
    expect(regions.map((r) => r.content)).toEqual(["x+1", "y"]);
  });

  it("the mapped regions always equal a fresh scan (the field never goes stale)", () => {
    let state = stateOf("a $x$ b\n\n$$\ny\n$$");
    state = insert(state, 0, "prefix ");
    state = insert(state, state.doc.length, " suffix");
    expect(mathRegions(state)).toEqual(scanMath(state.doc));
  });
});

describe("mathRegionsField: an edit that can change pairing rescans", () => {
  it("a character inserted between a backslash and a dollar flips the escape, so it rescans", () => {
    // "\\$x$" — the first `$` is escaped, so only the second one is text; after
    // inserting `a` between them the escape is gone and a formula appears.
    const state = stateOf("\\$x$");
    expect(mathRegions(state)).toEqual([]);
    const next = insert(state, 1, "a");
    expect(mathRegions(next)).toEqual(scanMath(next.doc));
    expect(mathRegions(next)).toHaveLength(1);
  });

  it("deleting the character between a backslash and a dollar rescans too", () => {
    const state = stateOf("\\a$");
    const next = state.update({ changes: { from: 1, to: 2 } }).state;
    expect(mathRegions(next)).toEqual(scanMath(next.doc));
  });
});

describe("mathRegions without the field (bare states in tests)", () => {
  it("falls back to a doc-keyed memo that returns the identical array twice", () => {
    const state = EditorState.create({ doc: "a $x$ b" });
    const first = mathRegions(state);
    expect(mathRegions(state)).toBe(first);
    expect(first).toEqual(scanMath(state.doc));
  });

  it("an empty document has no regions", () => {
    expect(mathRegions(EditorState.create({ doc: "" }))).toEqual([]);
  });
});

describe("renumberHeadings: dispatches only when numbers actually change", () => {
  function makeView(doc: string) {
    let state = EditorState.create({ doc });
    const dispatches: TransactionSpec[] = [];
    const view = {
      get state() {
        return state;
      },
      dispatch: (spec: TransactionSpec) => {
        dispatches.push(spec);
        state = state.update(spec).state;
      },
    } as unknown as EditorView;
    return { view, dispatches, text: () => state.doc.toString() };
  }

  it("a document with stale numbers is renumbered in one dispatch", () => {
    const { view, dispatches, text } = makeView("# 旧\n## 旧节");
    renumberHeadings(view);
    expect(dispatches).toHaveLength(1);
    expect(text()).toBe("# 1 旧\n## 1.1 旧节");
  });

  it("an already-correct document produces no transaction (no undo entry, no re-render)", () => {
    const { view, dispatches } = makeView("# 1 旧\n## 1.1 旧节");
    renumberHeadings(view);
    expect(dispatches).toHaveLength(0);
  });

  it("a document without headings produces no transaction", () => {
    const { view, dispatches } = makeView("just a paragraph");
    renumberHeadings(view);
    expect(dispatches).toHaveLength(0);
  });

  it("the renumber transaction carries its own user event so the update listener cannot loop", () => {
    const { view, dispatches } = makeView("# 旧");
    renumberHeadings(view);
    expect(dispatches[0]).toMatchObject({ userEvent: "input.bnote-renumber" });
  });
});
