import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { visualLineNumbers, visualRangeSpans, visualSelection, visualSelectionDecos } from "./vim";

/**
 * Geometry gate for the visual-mode highlight (the pure functions behind
 * vimVisualHighlight):
 * - Line set: the vim engine's sel (0-based line/ch) wins — linewise visual
 *   often keeps the CM selection empty, so the CM selection is the fallback
 *   only when the engine keeps no sel; a selection ending at a line start
 *   shrinks to the previous line.
 * - Exact range: charwise uses the selection the engine syncs into CM,
 *   blockwise slices the block per line by column.
 * - Painting ownership: once the selection is painted, CM's selection
 *   rectangle must yield (see the describe block below).
 */

// No trailing newline: CM's Text grows an extra phantom empty line for
// "…\n", which is unrelated to the geometry here.
const doc = EditorState.create({ doc: "第一行\n第二行\n第三行\n第四行" }).doc;

interface Pos {
  line: number;
  ch: number;
}
const sel = (anchor: Pos, head: Pos, visualLine = false) => ({
  visualMode: true,
  visualLine,
  sel: { anchor, head },
});
const range = (from: number, to: number) => [{ from, to, empty: from === to }];

describe("visualLineNumbers: the engine sel path", () => {
  it("a forward linewise Vj: the whole line range from anchor to head is highlighted (even when the CM selection is empty)", () => {
    const lines = visualLineNumbers(doc, sel({ line: 1, ch: 0 }, { line: 3, ch: 0 }), [
      { from: 0, to: 0, empty: true },
    ]);
    expect(lines).toEqual([2, 3, 4]);
  });

  it("a backward charwise selection yields the same set as the forward one", () => {
    const forward = visualLineNumbers(doc, sel({ line: 2, ch: 1 }, { line: 3, ch: 2 }), []);
    const backward = visualLineNumbers(doc, sel({ line: 3, ch: 2 }, { line: 2, ch: 1 }), []);
    expect(forward).toEqual([3, 4]);
    expect(backward).toEqual(forward);
  });

  it("a collapsed charwise selection (the caret did not move after vv): no highlighted line", () => {
    expect(visualLineNumbers(doc, sel({ line: 1, ch: 0 }, { line: 1, ch: 0 }), [])).toEqual([]);
  });

  it("a collapsed visualLine (VV) selection is a whole line as well", () => {
    expect(visualLineNumbers(doc, sel({ line: 1, ch: 0 }, { line: 1, ch: 0 }, true), [])).toEqual([
      2,
    ]);
  });

  it("out-of-range line numbers are clamped to the document range (the engine sel may momentarily point past the last line)", () => {
    const lines = visualLineNumbers(doc, sel({ line: 2, ch: 0 }, { line: 99, ch: 0 }), []);
    expect(lines).toEqual([3, 4]);
  });
});

describe("visualLineNumbers: the CM selection fallback path (the engine keeps no sel)", () => {
  it("every line covered by a non-empty CM selection is highlighted", () => {
    // Selection [0, 7): lines 1 and 2
    expect(visualLineNumbers(doc, { visualMode: true }, range(0, 7))).toEqual([1, 2]);
  });

  it("the selection end lands exactly on a line start: it shrinks to the previous line (that line does not count as occupied)", () => {
    // [0, 12): 12 is the start of line 4 → only lines 1-3 are highlighted
    expect(visualLineNumbers(doc, { visualMode: true }, range(0, 12))).toEqual([1, 2, 3]);
  });

  it("an empty CM selection produces no highlight", () => {
    expect(visualLineNumbers(doc, { visualMode: true }, range(4, 4))).toEqual([]);
  });
});

describe("visualLineNumbers: outside visual mode", () => {
  it("with visualMode off the result is always empty (flipping back from normal/insert mode removes the highlight)", () => {
    expect(visualLineNumbers(doc, null, range(0, 15))).toEqual([]);
    expect(visualLineNumbers(doc, { visualMode: false }, range(0, 15))).toEqual([]);
  });
});

/**
 * The exact range (visualRangeSpans) and painting ownership
 * (visualSelectionDecos).
 * The root cause of the defect is "two painters for one state": CM's own
 * selection rectangle is derived from coordinates — horizontally from the
 * padding of .cm-line (this app puts its padding on .cm-content, so the
 * rectangle is wider than the line box and presses against the quote bar),
 * vertically from coordsAtPos(to, -2) (right next to a block-level widget the
 * coordinate falls inside the widget, growing a narrow tall gray band that
 * hangs below the selection). Once the decoration layer takes over, that
 * geometry comes from document coordinates. This gate locks two things: every
 * visual sub-mode can paint a correct range, and "painted ⇔ exclusively
 * painting" (the CM rectangle yields).
 */

const spanDoc = EditorState.create({ doc: "第一行\n第二行\n第三行\n第四行\n第五行" }).doc;
const span = (from: number, to: number) => ({ from, to });

describe("visualRangeSpans: the exact charwise range", () => {
  it("the selection the engine syncs to CM is used verbatim as the painting range (the head character is guaranteed by the engine)", () => {
    expect(
      visualRangeSpans(spanDoc, sel({ line: 1, ch: 3 }, { line: 1, ch: 7 }), [span(7, 12)]),
    ).toEqual([span(7, 12)]);
  });

  it("a multi-line charwise selection is one range covering the whole span", () => {
    expect(
      visualRangeSpans(spanDoc, sel({ line: 0, ch: 0 }, { line: 2, ch: 2 }), [span(0, 12)]),
    ).toEqual([span(0, 12)]);
  });

  it("the collapsed selection right after pressing v is not painted (it returns empty)", () => {
    expect(visualRangeSpans(spanDoc, sel({ line: 1, ch: 3 }, { line: 1, ch: 3 }), [])).toEqual([]);
  });

  it("a linewise selection is left to the line band, so this returns empty (avoiding a darker overlap of the same color)", () => {
    const linewise = {
      visualMode: true,
      visualLine: true,
      sel: { anchor: { line: 1, ch: 0 }, head: { line: 3, ch: 0 } },
    };
    expect(visualRangeSpans(spanDoc, linewise, [span(4, 16)])).toEqual([]);
  });
});

describe("visualRangeSpans: a blockwise selection is cut line by line", () => {
  const block = (anchor: Pos, head: Pos) => ({
    visualMode: true,
    visualBlock: true,
    sel: { anchor, head },
  });

  it("the block shape is cut out line by line by column range (neither a whole line nor only the caret line)", () => {
    // Five-line document: line 1 = [0,3), line 2 = [4,7)…; columns [1,4) cut
    // out [1,3) and [5,7)
    expect(visualRangeSpans(spanDoc, block({ line: 0, ch: 1 }, { line: 1, ch: 3 }), [])).toEqual([
      span(1, 3),
      span(5, 7),
    ]);
  });

  it("a backward block (head above the anchor) yields the same set as the forward one", () => {
    const forward = visualRangeSpans(spanDoc, block({ line: 0, ch: 1 }, { line: 1, ch: 3 }), []);
    const backward = visualRangeSpans(spanDoc, block({ line: 1, ch: 3 }, { line: 0, ch: 1 }), []);
    expect(backward).toEqual(forward);
  });

  it("a line whose columns run past the end is clamped to the line end and a line entirely outside the block produces no zero-width range", () => {
    const blockDoc = EditorState.create({ doc: "abcdef\n\nxyz" }).doc;
    // Line 2 has only two columns and both block boundaries are past the line
    // end → that line has no range
    expect(visualRangeSpans(blockDoc, block({ line: 0, ch: 2 }, { line: 2, ch: 9 }), [])).toEqual([
      span(2, 6),
      span(10, 11),
    ]);
  });
});

describe("visualSelectionDecos: painting ownership", () => {
  const decoClasses = (set: DecorationSet, length: number) => {
    const out: string[] = [];
    set.between(0, length, (from, to, deco) => {
      const cls = (deco as unknown as { spec: { class?: string } }).spec.class ?? "?";
      out.push(`${cls}@${from}..${to}`);
    });
    return out;
  };

  it("charwise: a line band (hint color) + one exact range mark (size = line count + 1)", () => {
    const set = visualSelectionDecos(spanDoc, sel({ line: 1, ch: 3 }, { line: 1, ch: 7 }), [
      span(7, 12),
    ]);
    expect(set.size).toBe(2);
    expect(decoClasses(set, spanDoc.length)).toEqual([
      "cm-vimVisualLineHint@4..4",
      "cm-vimVisualRange@7..12",
    ]);
  });

  it("blockwise: one band per line (hint color) + one range per line", () => {
    const set = visualSelectionDecos(
      spanDoc,
      {
        visualMode: true,
        visualBlock: true,
        sel: { anchor: { line: 0, ch: 1 }, head: { line: 1, ch: 3 } },
      },
      [],
    );
    expect(set.size).toBe(4);
    expect(decoClasses(set, spanDoc.length)).toEqual([
      "cm-vimVisualLineHint@0..0",
      "cm-vimVisualRange@1..3",
      "cm-vimVisualLineHint@4..4",
      "cm-vimVisualRange@5..7",
    ]);
  });

  it("linewise: only the line bands in the selection's own color (it is the selection itself and needs no hint color)", () => {
    const set = visualSelectionDecos(
      spanDoc,
      {
        visualMode: true,
        visualLine: true,
        sel: { anchor: { line: 1, ch: 0 }, head: { line: 3, ch: 0 } },
      },
      [],
    );
    expect(set.size).toBe(3);
    expect(decoClasses(set, spanDoc.length)).toEqual([
      "cm-vimVisualLine@4..4",
      "cm-vimVisualLine@8..8",
      "cm-vimVisualLine@12..12",
    ]);
  });

  it("no painter ⇔ empty set (a collapsed selection / non-visual mode must never block CM's own selection rectangle)", () => {
    expect(visualSelectionDecos(spanDoc, null, [span(0, 10)]).size).toBe(0);
    expect(visualSelectionDecos(spanDoc, { visualMode: false }, [span(0, 10)]).size).toBe(0);
    expect(
      visualSelectionDecos(spanDoc, sel({ line: 1, ch: 3 }, { line: 1, ch: 3 }), []).size,
    ).toBe(0);
  });
});

describe("visualSelection: the selection inserted by ⌘⇧B (the engine sel coordinate model)", () => {
  const vstate = (a: Pos, h: Pos, opts: { line?: boolean; block?: boolean } = {}) => ({
    visualMode: true,
    visualLine: !!opts.line,
    visualBlock: !!opts.block,
    sel: { anchor: a, head: h },
  });

  it("linewise: the whole line (including the trailing newline), the range is the whole-line interval", () => {
    expect(
      visualSelection(doc, vstate({ line: 1, ch: 0 }, { line: 2, ch: 0 }, { line: true })),
    ).toEqual({
      text: "第二行\n第三行",
      from: 4,
      to: 11,
    });
  });

  it("a collapsed linewise selection (VV without moving): a single whole line", () => {
    expect(
      visualSelection(doc, vstate({ line: 1, ch: 0 }, { line: 1, ch: 0 }, { line: true })),
    ).toEqual({
      text: "第二行",
      from: 4,
      to: 7,
    });
  });

  it("a backward linewise selection (Jk upward): the same text and range as the forward one", () => {
    const forward = visualSelection(
      doc,
      vstate({ line: 1, ch: 0 }, { line: 3, ch: 0 }, { line: true }),
    );
    const backward = visualSelection(
      doc,
      vstate({ line: 3, ch: 0 }, { line: 1, ch: 0 }, { line: true }),
    );
    expect(backward).toEqual(forward);
    expect(forward).toEqual({ text: "第二行\n第三行\n第四行", from: 4, to: 15 });
  });

  it("blockwise: the column range is taken line by line (including the head character) and the range is the line interval of the whole block", () => {
    expect(
      visualSelection(doc, vstate({ line: 0, ch: 1 }, { line: 2, ch: 2 }, { block: true })),
    ).toEqual({ text: "一行\n二行\n三行", from: 0, to: 11 });
  });

  it("a blockwise column out of range: clamped to the line end (that is how vim's block selection works)", () => {
    expect(
      visualSelection(doc, vstate({ line: 0, ch: 2 }, { line: 1, ch: 9 }, { block: true })),
    ).toEqual({ text: "行\n行", from: 0, to: 7 });
  });

  it("charwise: the character range from the anchor to the caret (including the head character)", () => {
    expect(visualSelection(doc, vstate({ line: 0, ch: 0 }, { line: 1, ch: 1 }))).toEqual({
      text: "第一行\n第二",
      from: 0,
      to: 6,
    });
  });

  it("a backward charwise selection (moving up after v): the same range as the forward one", () => {
    const forward = visualSelection(doc, vstate({ line: 0, ch: 1 }, { line: 1, ch: 2 }));
    const backward = visualSelection(doc, vstate({ line: 1, ch: 2 }, { line: 0, ch: 1 }));
    expect(backward).toEqual(forward);
    expect(forward).toEqual({ text: "一行\n第二行", from: 1, to: 7 });
  });

  it("outside visual mode / the engine keeps no sel: it returns null", () => {
    expect(
      visualSelection(doc, {
        visualMode: false,
        sel: { anchor: { line: 0, ch: 0 }, head: { line: 1, ch: 0 } },
      }),
    ).toBeNull();
    expect(visualSelection(doc, { visualMode: true })).toBeNull();
    expect(visualSelection(doc, null)).toBeNull();
  });

  it("out-of-range line numbers are clamped to the document range (the engine sel may momentarily point past the end of the document)", () => {
    expect(
      visualSelection(doc, vstate({ line: 2, ch: 0 }, { line: 99, ch: 0 }, { line: true })),
    ).toEqual({
      text: "第三行\n第四行",
      from: 8,
      to: 15,
    });
  });
});
