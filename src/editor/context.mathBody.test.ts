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

describe("caretInMathBody：行内公式的边界属于正文侧", () => {
  const region = regionsOf(INLINE)[0];

  it("严格内部(4..8)才算正文", () => {
    for (const pos of [4, 5, 6, 7, 8]) expect(caretInMathBody(region, pos)).toBe(true);
  });

  it("开定界符之前(3)与闭合定界符之后(9)都不是正文", () => {
    for (const pos of [0, 1, 2, 3, 9, 10, 11]) expect(caretInMathBody(region, pos)).toBe(false);
  });
});

describe("caretInMathBody：块级公式的边界同样属于正文侧", () => {
  const closed = regionsOf("$$\nx=1\n$$")[0]; // 0..9

  it("闭合块：内部是正文,两个边界不是", () => {
    expect(caretInMathBody(closed, 1)).toBe(true);
    expect(caretInMathBody(closed, 8)).toBe(true);
    expect(caretInMathBody(closed, 0)).toBe(false);
    expect(caretInMathBody(closed, 9)).toBe(false);
  });

  it("单行显示块 $$x$$(0..5):内部是正文,边界不是", () => {
    const single = regionsOf("$$x$$")[0];
    expect(caretInMathBody(single, 1)).toBe(true);
    expect(caretInMathBody(single, 4)).toBe(true);
    expect(caretInMathBody(single, 0)).toBe(false);
    expect(caretInMathBody(single, 5)).toBe(false);
  });
});

describe("caretInMathBody：未闭合块(打字中)把 to 算作正文", () => {
  const stray = regionsOf("$$\nx=1")[0]; // 0..6,unclosed

  it("区域带 unclosed 标记", () => {
    expect(stray.unclosed).toBe(true);
    expect(stray.to).toBe(6);
  });

  it("末尾(to)仍算正文:每敲一个字符光标都落在那里", () => {
    for (const pos of [1, 5, 6]) expect(caretInMathBody(stray, pos)).toBe(true);
  });

  it("只有一个 $$ 时(t=2)也算正文:接着打字就是在写公式", () => {
    const bare = regionsOf("$$")[0];
    expect(bare.unclosed).toBe(true);
    expect(caretInMathBody(bare, 2)).toBe(true);
  });

  it("闭合后同一位置变回正文侧:多出来的字符不再进公式", () => {
    const closed = regionsOf("$$\nx=1\n$$")[0];
    expect(caretInMathBody(closed, 9)).toBe(false);
  });
});

describe("selectionInMathBody：非空选区与正文相交才展开", () => {
  const region = regionsOf(INLINE)[0];

  it("空选区等价于光标判定", () => {
    expect(selectionInMathBody(region, 6, 6)).toBe(true);
    expect(selectionInMathBody(region, 3, 3)).toBe(false);
    expect(selectionInMathBody(region, 9, 9)).toBe(false);
  });

  it("选区只要覆盖正文就展开(含从边界起选)", () => {
    expect(selectionInMathBody(region, 2, 4)).toBe(true);
    expect(selectionInMathBody(region, 8, 10)).toBe(true);
    expect(selectionInMathBody(region, 0, 9)).toBe(true);
  });

  it("完全在正文侧之外的选择不展开", () => {
    expect(selectionInMathBody(region, 0, 3)).toBe(false);
    expect(selectionInMathBody(region, 9, 11)).toBe(false);
  });
});

describe("mathBodySpan：点击渲染态公式时的落点区间", () => {
  it("行内去掉两侧定界符字节", () => {
    expect(mathBodySpan(regionsOf(INLINE)[0])).toEqual({ from: 4, to: 8 });
  });

  it("块级去掉两侧 $$", () => {
    expect(mathBodySpan(regionsOf("$$\nx=1\n$$")[0])).toEqual({ from: 2, to: 7 });
  });

  it("未闭合块的 to 本身就是正文末尾", () => {
    expect(mathBodySpan(regionsOf("$$\nx=1")[0])).toEqual({ from: 2, to: 6 });
  });
});
