import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { caretInMathBody, mathBodySpan, selectionInMathBody } from "./context";
import { scanMath, type MathRegion } from "./mathScan";

/**
 * Model of a formula's **body position**: whether the next typed character
 * goes into the formula source.
 *
 * A CM6 position sits between characters: when `$f(x)$` occupies 3..9, 3 is
 * before the opening delimiter and 9 after the closing one — both count as the
 * body side, so typing there lands outside the formula. The IME picks its
 * English/Chinese source by this rule, and the inline-formula source expansion
 * follows it too (with the caret on a boundary the formula is already
 * rendered and the caret sits outside the widget).
 *
 * An unclosed region (a `$$…` being typed) is the only exception: it has no
 * closing delimiter, so `to` is the end of the body and typing there still
 * goes into the formula — otherwise every keystroke would leave the caret on
 * `to`, the formula would collapse into a widget on the spot and the source
 * would never be visible again.
 */
function regionsOf(doc: string): MathRegion[] {
  return scanMath(EditorState.create({ doc }).doc);
}

const INLINE = "前文 $f(x)$ 后文"; // $f(x)$ = 3..9

describe("caretInMathBody: inline formula boundaries belong to the body side", () => {
  const region = regionsOf(INLINE)[0];

  it("only strictly inside (4..8) counts as body", () => {
    for (const pos of [4, 5, 6, 7, 8]) expect(caretInMathBody(region, pos)).toBe(true);
  });

  it("before the opening delimiter (3) and after the closing delimiter (9) are not body", () => {
    for (const pos of [0, 1, 2, 3, 9, 10, 11]) expect(caretInMathBody(region, pos)).toBe(false);
  });
});

describe("caretInMathBody: block formula boundaries belong to the body side too", () => {
  const closed = regionsOf("$$\nx=1\n$$")[0]; // 0..9

  it("closed block: inside is body, both boundaries are not", () => {
    expect(caretInMathBody(closed, 1)).toBe(true);
    expect(caretInMathBody(closed, 8)).toBe(true);
    expect(caretInMathBody(closed, 0)).toBe(false);
    expect(caretInMathBody(closed, 9)).toBe(false);
  });

  it("single-line display block $$x$$ (0..5): inside is body, the boundaries are not", () => {
    const single = regionsOf("$$x$$")[0];
    expect(caretInMathBody(single, 1)).toBe(true);
    expect(caretInMathBody(single, 4)).toBe(true);
    expect(caretInMathBody(single, 0)).toBe(false);
    expect(caretInMathBody(single, 5)).toBe(false);
  });
});

describe("caretInMathBody: an unclosed block (while typing) counts to as body", () => {
  const stray = regionsOf("$$\nx=1")[0]; // 0..6,unclosed

  it("the region carries the unclosed flag", () => {
    expect(stray.unclosed).toBe(true);
    expect(stray.to).toBe(6);
  });

  it("the end (to) still counts as body: every keystroke leaves the caret there", () => {
    for (const pos of [1, 5, 6]) expect(caretInMathBody(stray, pos)).toBe(true);
  });

  it("a lone $$ (t=2) also counts as body: typing next is writing the formula", () => {
    const bare = regionsOf("$$")[0];
    expect(bare.unclosed).toBe(true);
    expect(caretInMathBody(bare, 2)).toBe(true);
  });

  it("once closed, the same position is back on the body side: the extra character no longer enters the formula", () => {
    const closed = regionsOf("$$\nx=1\n$$")[0];
    expect(caretInMathBody(closed, 9)).toBe(false);
  });
});

describe("selectionInMathBody: a non-empty selection expands only when it intersects the body", () => {
  const region = regionsOf(INLINE)[0];

  it("an empty selection is equivalent to the caret check", () => {
    expect(selectionInMathBody(region, 6, 6)).toBe(true);
    expect(selectionInMathBody(region, 3, 3)).toBe(false);
    expect(selectionInMathBody(region, 9, 9)).toBe(false);
  });

  it("a selection that covers any body expands (including one starting at a boundary)", () => {
    expect(selectionInMathBody(region, 2, 4)).toBe(true);
    expect(selectionInMathBody(region, 8, 10)).toBe(true);
    expect(selectionInMathBody(region, 0, 9)).toBe(true);
  });

  it("a selection entirely outside the body side does not expand", () => {
    expect(selectionInMathBody(region, 0, 3)).toBe(false);
    expect(selectionInMathBody(region, 9, 11)).toBe(false);
  });
});

describe("mathBodySpan: the landing range when clicking a rendered formula", () => {
  it("inline drops the delimiter bytes on both sides", () => {
    expect(mathBodySpan(regionsOf(INLINE)[0])).toEqual({ from: 4, to: 8 });
  });

  it("block drops the surrounding $$", () => {
    expect(mathBodySpan(regionsOf("$$\nx=1\n$$")[0])).toEqual({ from: 2, to: 7 });
  });

  it("for an unclosed block to is itself the end of the body", () => {
    expect(mathBodySpan(regionsOf("$$\nx=1")[0])).toEqual({ from: 2, to: 6 });
  });
});
