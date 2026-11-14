import { describe, expect, it } from "vitest";
import { EditorState, type Text } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import type { FootprintBlock } from "./model";
import { buildFootprintMarks } from "./extension";

/**
 * The source side of the footprint: the first line of every block collected
 * today gets a pip. The contract is the same geometry discipline as
 * daily/marks.ts — a line decoration only, so the inline layout is untouched —
 * and the namespace rule: only blocks inside the viewport are marked, and only
 * their start line (a block body must not be marked again).
 */

const doc = (text: string) => EditorState.create({ doc: text });

function lines(set: DecorationSet, d: Text): number[] {
  const out: number[] = [];
  set.between(0, d.length, (from) => {
    out.push(d.lineAt(from).number);
  });
  return out;
}

function view(text: string, ranges?: { from: number; to: number }[]) {
  const state = doc(text);
  return { state, visibleRanges: ranges ?? [{ from: 0, to: text.length }] };
}

const blocks = (...starts: number[]): FootprintBlock[] =>
  starts.map((start) => ({ text: "x", start, end: start }));

describe("buildFootprintMarks", () => {
  it("marks the start line of each collected block with the pip class and tooltip", () => {
    const v = view("第一段\n第二行\n\n第二段\n");
    const set = buildFootprintMarks(v, blocks(1, 4));
    expect(lines(set, v.state.doc)).toEqual([1, 4]);
    const attrs: Record<string, string>[] = [];
    set.between(0, v.state.doc.length, (_f, _t, value) => {
      attrs.push(value.spec.attributes ?? {});
    });
    expect(attrs.every((a) => a.title === "今日足迹已收录到今日日记")).toBe(true);
    expect(attrs.every((a) => a["data-footprint-sent"] === undefined)).toBe(true);
  });

  it("no blocks or no viewport produces an empty set", () => {
    const v = view("甲\n");
    expect(buildFootprintMarks(v, []).size).toBe(0);
    expect(buildFootprintMarks({ ...v, visibleRanges: [] }, blocks(1)).size).toBe(0);
  });

  it("a block start outside the viewport is not marked, a block inside it is", () => {
    const text = Array.from({ length: 30 }, (_, i) => `段${i}`).join("\n\n");
    const v = view(text);
    // Paragraph i sits on line 2i-1; line 41 is the 21st paragraph
    expect(lines(buildFootprintMarks(v, blocks(1, 41)), v.state.doc)).toEqual([1, 41]);
    const line41 = v.state.doc.line(41);
    const windowed = buildFootprintMarks(
      view(text, [{ from: line41.from, to: line41.to }]),
      blocks(1, 41),
    );
    expect(lines(windowed, v.state.doc)).toEqual([41]);
  });

  it("a start line that no longer exists is ignored instead of throwing", () => {
    const v = view("甲\n");
    expect(lines(buildFootprintMarks(v, blocks(99)), v.state.doc)).toEqual([]);
  });

  it("several blocks starting on the same line produce a single mark (deduplicated by line)", () => {
    const v = view("甲\n");
    expect(lines(buildFootprintMarks(v, blocks(1, 1)), v.state.doc)).toEqual([1]);
  });

  it("an empty document does not throw for a one-line block start", () => {
    const v = view("");
    expect(() => buildFootprintMarks(v, blocks(1))).not.toThrow();
  });
});
