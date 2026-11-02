import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { fenceStateScan } from "./context";
import { scanMath } from "./mathScan";
import { calloutRegions, computeCalloutRegions } from "./callout";

/** Pure line-scan entry point: fence state and math regions are computed from the same document on the fly. */
function scan(text: string) {
  const state = EditorState.create({ doc: text });
  const doc = state.doc;
  return computeCalloutRegions(doc, fenceStateScan(doc), scanMath(doc));
}

const regionOf = (text: string) => {
  const regions = scan(text);
  expect(regions).toHaveLength(1);
  return regions[0];
};

describe("callout region scanning", () => {
  it("block without a title: a bare ::: opens and closes it, the range includes both boundary lines", () => {
    const r = regionOf(":::\n内容行\n:::");
    expect(r.openLine).toBe(1);
    expect(r.closeLine).toBe(3);
    expect(r.title).toBe("");
    expect(r.depth).toBe(0);
    expect(r.closed).toBe(true);
    expect(r.from).toBe(0);
    expect(r.to).toBe(":::\n内容行\n:::".length);
  });

  it("with a title: the text after the colon is trimmed into the title", () => {
    const r = regionOf(":::  注意事项  \n内容\n:::");
    expect(r.title).toBe("注意事项");
  });

  it("a bare ::: outside a block opens a titleless block, a bare ::: inside closes the innermost one", () => {
    const regions = scan(":::\n甲\n:::\n乙\n:::\n丙");
    expect(regions).toHaveLength(2);
    expect(regions[0].openLine).toBe(1);
    expect(regions[0].closeLine).toBe(3);
    expect(regions[1].openLine).toBe(5);
    expect(regions[1].closed).toBe(false); // the last ::: block is never closed
  });

  it("nesting: a marker with text always opens, a bare ::: closes the inner level; output is sorted by from ascending (outer first)", () => {
    const regions = scan("::: 外\n::: 内\n甲\n:::\n:::");
    expect(regions).toHaveLength(2);
    expect(regions[0].openLine).toBe(1);
    expect(regions[0].closeLine).toBe(5);
    expect(regions[0].depth).toBe(0);
    expect(regions[1].openLine).toBe(2);
    expect(regions[1].closeLine).toBe(4);
    expect(regions[1].depth).toBe(1);
    expect(regions[1].title).toBe("内");
  });

  it("a ::: inside a code fence is ignored: the block is not closed early by the marker in the fence", () => {
    const r = regionOf(":::\n```\n:::\n```\n:::");
    expect(r.openLine).toBe(1);
    expect(r.closeLine).toBe(5);
  });

  it("a ::: inside a math block is ignored: $$ pairing wins", () => {
    expect(scan("$$\n:::\n$$")).toHaveLength(0);
    // a ::: in the body after the math block still opens a block
    const r = regionOf("$$\n:::\n$$\n:::\n内容\n:::");
    expect(r.openLine).toBe(4);
  });

  it("unclosed: it extends to the end of the document", () => {
    const r = regionOf(":::\n甲\n乙");
    expect(r.closed).toBe(false);
    expect(r.closeLine).toBe(3);
  });

  it("only column 0 counts: an indented ::: is not a marker (a bare ::: at column 0 opens another block)", () => {
    const r = regionOf("  :::\n甲\n:::");
    expect(r.openLine).toBe(3);
    expect(r.closed).toBe(false);
  });

  it("four or more colons behave like :::; a ::: in the middle of a line is not a marker", () => {
    const r = regionOf("::::\n甲\n::::");
    expect(r.openLine).toBe(1);
    expect(r.closeLine).toBe(3);
    expect(scan("文字 ::: 文字")).toHaveLength(0);
  });

  it("an inline formula in the title does not affect opening the block (the skip check only looks at display regions)", () => {
    const r = regionOf("::: 命题 $P \\Rightarrow Q$\n甲\n:::");
    expect(r.title).toBe("命题 $P \\Rightarrow Q$");
  });

  it("a math block inside the block pairs as usual, the callout covers the whole block", () => {
    const r = regionOf(":::\n$$\nx\n$$\n:::");
    expect(r.openLine).toBe(1);
    expect(r.closeLine).toBe(5);
  });

  it("several blocks separated by blank lines are independent", () => {
    const regions = scan("::: 甲\n一\n:::\n\n::: 乙\n二\n:::");
    expect(regions).toHaveLength(2);
    expect(regions[0].title).toBe("甲");
    expect(regions[1].title).toBe("乙");
  });
});

describe("calloutRegions memo", () => {
  it("two calls on the same document share the same array (zero rescans on the decoration hot path)", () => {
    const state = EditorState.create({ doc: ":::\n甲\n:::" });
    expect(calloutRegions(state)).toBe(calloutRegions(state));
  });
});
