import { beforeEach, describe, expect, it } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { mathRegions, mathRegionsField, fenceStateScan } from "./context";
import { computeCalloutRegions, calloutRegions, calloutRegionsField } from "./callout";
import { scanMath } from "./mathScan";
import { clearPerf, perfStats, setPerfLevel } from "@/perf/trace";

beforeEach(() => {
  // "slow" records every span in perfStats; a future default change must not
  // make the "0 scans" assertions pass vacuously.
  setPerfLevel("slow");
  clearPerf();
});

function makeState(doc: string, extensions: Extension[] = [mathRegionsField]) {
  const state = EditorState.create({ doc, extensions });
  // Force the lazy initial scan now, so it is not counted inside a measured
  // keystroke window (state.field creates a field on first access).
  state.field(mathRegionsField);
  if (extensions.includes(calloutRegionsField)) state.field(calloutRegionsField);
  // Start every measured window after the initial scan.
  clearPerf();
  return state;
}

function insert(state: EditorState, from: number, text: string): EditorState {
  return state.update({
    changes: { from, insert: text },
    selection: { anchor: from + text.length },
  }).state;
}

const scanned = (name: string): number => perfStats().find((s) => s.name === name)?.n ?? 0;

/** The field is a cache: after any transaction it must equal a fresh scan.
 *  This is the invariant every predicate must preserve; a false negative
 *  leaves stale regions (no live preview, wrong IME context). */
function expectMathFresh(state: EditorState): void {
  expect(state.field(mathRegionsField)).toEqual(scanMath(state.doc));
}

function expectCalloutsFresh(state: EditorState): void {
  // The truth must use a fresh math scan too: using the field's math regions
  // would let a stale math field mask a stale callout field.
  expect(calloutRegions(state)).toEqual(
    computeCalloutRegions(state.doc, fenceStateScan(state.doc), scanMath(state.doc)),
  );
}

describe("mathRegionsField: map ordinary edits, rescan only when pairing can change", () => {
  it("typing inside a formula maps the region and re-slices only that content", () => {
    let state = makeState("前文 $x$ 后文");
    expect(mathRegions(state)[0]).toEqual({ from: 3, to: 6, display: false, content: "x" });
    clearPerf();
    state = insert(state, 4, "a"); // Before the x.
    expect(mathRegions(state)[0]).toMatchObject({ content: "ax" });
    expect(scanned("math.scan")).toBe(0);
  });

  it("a selection-only change reuses the field value without any scan", () => {
    const state = makeState("前文 $x$ 后文");
    const regions = state.field(mathRegionsField);
    const moved = state.update({ selection: { anchor: 1 } }).state;
    expect(moved.field(mathRegionsField)).toBe(regions);
    expect(scanned("math.scan")).toBe(0);
  });

  it("typing a delimiter rescans exactly once", () => {
    let state = makeState("$x$");
    clearPerf();
    state = insert(state, 3, "$");
    expect(scanned("math.scan")).toBe(1);
    // `$x$$`: the first pair is the inline formula, the stray $ stays text.
    expect(mathRegions(state)).toEqual([{ from: 0, to: 3, display: false, content: "x" }]);
  });

  it("deleting a delimiter rescans", () => {
    let state = makeState("$x$");
    clearPerf();
    state = state.update({ changes: { from: 2, to: 3 }, selection: { anchor: 2 } }).state;
    expect(scanned("math.scan")).toBe(1);
    expect(mathRegions(state)).toHaveLength(0);
  });

  it("a newline rescans (block pairing depends on blank lines)", () => {
    const state = makeState("$$\nx=1\n$$");
    clearPerf();
    insert(state, 6, "\n");
    expect(scanned("math.scan")).toBe(1);
  });

  it("typing inside a block formula maps instead of rescanning", () => {
    let state = makeState("$$\nx=1\n$$");
    expect(mathRegions(state)[0].content).toBe("\nx=1\n");
    clearPerf();
    state = insert(state, 6, "y"); // After the 1, before the newline.
    expect(mathRegions(state)[0].content).toBe("\nx=1y\n");
    expect(scanned("math.scan")).toBe(0);
  });

  it("escaping the closing $ rescans and drops the region", () => {
    let state = makeState("$x$");
    clearPerf();
    state = insert(state, 2, "\\");
    expect(scanned("math.scan")).toBe(1);
    expect(mathRegions(state)).toHaveLength(0);
  });

  it("an unclosed block grows its body at `to` and stays fresh while typing", () => {
    let state = makeState("$$\n\n正文");
    expect(mathRegions(state)).toEqual([
      { from: 0, to: 2, display: true, content: "", unclosed: true },
    ]);
    state = insert(state, 2, "x");
    expect(mathRegions(state)[0]).toMatchObject({ to: 3, content: "x" });
    state = insert(state, 3, "y");
    expect(mathRegions(state)[0]).toMatchObject({ to: 4, content: "xy" });
    expect(scanned("math.scan")).toBe(0);
    expectMathFresh(state);
  });

  it("a space after the opening $ rescans (it is not a formula)", () => {
    let state = makeState("a $x$ b");
    clearPerf();
    state = insert(state, 3, " ");
    expect(scanned("math.scan")).toBe(1);
    expectMathFresh(state);
    expect(mathRegions(state)).toEqual([]);
  });

  it("a digit after the closing $ rescans (it is not a formula)", () => {
    let state = makeState("a $x$ b");
    clearPerf();
    state = insert(state, 5, "1");
    expectMathFresh(state);
    expect(mathRegions(state)).toEqual([]);
  });

  it("removing the space that blocked a formula rescans and creates the pair", () => {
    let state = makeState("a $ x$ b");
    expect(mathRegions(state)).toEqual([]);
    clearPerf();
    state = state.update({ changes: { from: 3, to: 4 }, selection: { anchor: 3 } }).state;
    expectMathFresh(state);
    expect(mathRegions(state)).toEqual([{ from: 2, to: 5, display: false, content: "x" }]);
  });

  it("$ $ stays text after typing the space", () => {
    let state = makeState("$$");
    clearPerf();
    state = insert(state, 1, " ");
    expectMathFresh(state);
    expect(mathRegions(state)).toEqual([]);
  });

  it("repairing a refused display block with a character on the blank line rescans", () => {
    let state = makeState("$$\n\nx\n\n$$");
    clearPerf();
    state = insert(state, 3, "y");
    expectMathFresh(state);
    expect(mathRegions(state)).toEqual([{ from: 0, to: 10, display: true, content: "\ny\nx\n\n" }]);
  });

  it("deleting a character next to an escaped dollar rescans", () => {
    let state = makeState("\\x$$a$$");
    clearPerf();
    state = state.update({ changes: { from: 1, to: 2 }, selection: { anchor: 1 } }).state;
    expectMathFresh(state);
  });

  it("typing before a line-leading $$ rescans (its block status flips)", () => {
    let state = makeState("$$\nx = 1");
    clearPerf();
    state = insert(state, 0, "- ");
    expect(scanned("math.scan")).toBe(1);
    expectMathFresh(state);
    expect(mathRegions(state)).toEqual([{ from: 2, to: 4, display: false, content: "" }]);
  });

  it("deleting before a mid-line $$ restores its block status", () => {
    let state = makeState("a$$\nx");
    expect(mathRegions(state)).toEqual([{ from: 1, to: 3, display: false, content: "" }]);
    clearPerf();
    state = state.update({ changes: { from: 0, to: 1 }, selection: { anchor: 0 } }).state;
    expect(scanned("math.scan")).toBe(1);
    expectMathFresh(state);
    expect(mathRegions(state)).toEqual([
      { from: 0, to: 4, display: true, content: "\nx", unclosed: true },
    ]);
  });
});

describe("calloutRegionsField: map body edits, rescan on geometry changes", () => {
  const extensions = [mathRegionsField, calloutRegionsField];

  it("typing in the body maps the region without a scan", () => {
    let state = makeState("::: 标题\n正文\n:::", extensions);
    expect(calloutRegions(state)).toEqual([
      { from: 0, to: 13, openLine: 1, closeLine: 3, title: "标题", depth: 0, closed: true },
    ]);
    clearPerf();
    state = insert(state, 7, "字"); // In the body line.
    expect(scanned("callout.scan")).toBe(0);
    expect(calloutRegions(state)[0]).toMatchObject({ from: 0, title: "标题", closed: true });
    expect(calloutRegions(state)[0].to).toBe(14);
  });

  it("editing the title rescans (the label text changed)", () => {
    let state = makeState("::: 标题\n正文\n:::", extensions);
    clearPerf();
    state = insert(state, 6, "新"); // At the end of the title line.
    expect(scanned("callout.scan")).toBe(1);
    expect(calloutRegions(state)[0].title).toBe("标题新");
  });

  it("inserting a line before the block rescans (line numbers move) and reports the new lines", () => {
    let state = makeState("::: 标题\n正文\n:::", extensions);
    clearPerf();
    state = insert(state, 0, "开头\n");
    expect(scanned("callout.scan")).toBe(1);
    expect(calloutRegions(state)[0]).toMatchObject({ openLine: 2, closeLine: 4, title: "标题" });
  });

  it("a colon (a new/removed marker) rescans", () => {
    const state = makeState("::: 标题\n正文\n:::", extensions);
    clearPerf();
    insert(state, 7, ":");
    expect(scanned("callout.scan")).toBe(1);
  });

  it("a plain character on the closing line rescans (it destroys the marker)", () => {
    let state = makeState("::: A\nbody\n:::\n", extensions);
    clearPerf();
    state = insert(state, 13, "x"); // End of the closing `:::` line.
    expect(scanned("callout.scan")).toBe(1);
    expectCalloutsFresh(state);
    expect(calloutRegions(state)[0]).toMatchObject({ closed: false, to: state.doc.length });
  });

  it("an unclosed callout's `to` follows the document end", () => {
    let state = makeState("::: A\nbody\n", extensions);
    clearPerf();
    state = insert(state, state.doc.length, "z");
    expect(scanned("callout.scan")).toBe(0);
    expectCalloutsFresh(state);
    expect(calloutRegions(state)[0].to).toBe(state.doc.length);
  });

  it("a math pairing change rescans the callouts (display math hides ::: lines)", () => {
    let state = makeState("$$\n\n:::\n\n$$", extensions);
    expect(calloutRegions(state)).toHaveLength(1); // The refused display block leaves the marker visible.
    clearPerf();
    state = insert(state, 3, "y"); // Repairs the block pairing without typing a marker.
    expect(scanned("math.scan")).toBe(1);
    expect(scanned("callout.scan")).toBe(1);
    expectCalloutsFresh(state);
    expect(calloutRegions(state)).toEqual([]);
  });

  it("a letter on a closing fence line rescans (the fence now swallows the markers)", () => {
    const doc = "```\ncode\n```\n::: A\nbody\n:::";
    let state = makeState(doc, extensions);
    expect(calloutRegions(state)).toHaveLength(1);
    const fenceEnd = doc.indexOf("\n```") + 4; // End of the closing fence line.
    clearPerf();
    state = insert(state, fenceEnd, "x");
    expect(scanned("callout.scan")).toBe(1);
    expectCalloutsFresh(state);
    expect(calloutRegions(state)).toEqual([]);
  });
});
