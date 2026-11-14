import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import {
  buildBracketColors,
  buildCursorBrackets,
  enclosingBrackets,
  findMatchingBracket,
  getCloseBracket,
  getOpenBracket,
  withinEnv,
} from "./brackets";

/**
 * Bracket geometry: the pairing lookup, the enclosing-pair walk and the two
 * decoration builders' edge cases. The rules mirror obsidian-latex-suite
 * exactly (literal counting with no escape handling, three rotating colors by
 * nesting depth, the caret character and the one before it), and each of them
 * is a visible behavior: a mismatch in the pairing makes the colored pairs
 * jump colors on every keystroke, and a wrong enclosing lookup highlights the
 * wrong pair after typing `)`.
 */

const decos = (set: DecorationSet) => {
  const out: { from: number; to: number; cls: string }[] = [];
  set.between(0, 1e9, (from, to, deco) => {
    out.push({ from, to, cls: (deco.spec as { class?: string }).class ?? "" });
  });
  return out;
};

describe("the bracket tables", () => {
  it("each closer maps to its opener and back", () => {
    expect(getOpenBracket(")")).toBe("(");
    expect(getOpenBracket("]")).toBe("[");
    expect(getOpenBracket("}")).toBe("{");
    expect(getCloseBracket("(")).toBe(")");
    expect(getCloseBracket("[")).toBe("]");
    expect(getCloseBracket("{")).toBe("}");
  });

  it("an opener has no opener entry (the table is one-directional)", () => {
    expect(getOpenBracket("(")).toBeUndefined();
    expect(getCloseBracket(")")).toBeUndefined();
  });
});

describe("findMatchingBracket: literal counting", () => {
  it("a nested pair resolves to the outermost closer, not the inner one", () => {
    expect(findMatchingBracket("(a(b)c)", 0, "(", ")")).toBe(6);
  });

  it("a mismatched closer does not decrement (braces and parens never cross-pair)", () => {
    // "(a]b)": the `]` is not a closer for `(`, so the `)` at 4 is the match.
    expect(findMatchingBracket("(a]b)", 0, "(", ")")).toBe(4);
  });

  it("the stop argument bounds the forward scan (stop is exclusive)", () => {
    expect(findMatchingBracket("(a)b)", 0, "(", ")", false, 2)).toBe(-1);
    expect(findMatchingBracket("(a)b)", 0, "(", ")", false, 3)).toBe(2);
  });

  it("an escaped brace still counts (the plugin has no escape handling)", () => {
    expect(findMatchingBracket("\\{a}", 1, "{", "}")).toBe(3);
  });

  it("a backwards scan without a matching opener returns -1", () => {
    expect(findMatchingBracket("a)", 1, "(", ")", true)).toBe(-1);
  });

  it("an empty string has no pair", () => {
    expect(findMatchingBracket("", 0, "(", ")")).toBe(-1);
  });
});

describe("enclosingBrackets: the innermost pair strictly around the position", () => {
  it("a position on the closer itself still sees its pair; the space after it finds the enclosing one", () => {
    // "x (a [b] c) y": position 7 is the `]` itself, so `[b]` encloses it.
    expect(enclosingBrackets("x (a [b] c) y", 7)).toEqual({ left: 5, right: 7 });
    // Position 8 is the space after `]`: that pair ends before it, so the walk
    // backs over the whole group and lands on `( … )`.
    expect(enclosingBrackets("x (a [b] c) y", 8)).toEqual({ left: 2, right: 10 });
  });

  it("a position before any bracket has no enclosing pair", () => {
    expect(enclosingBrackets("(a)", 0)).toBeNull();
  });

  it("an unbalanced closer makes the walk give up instead of pairing with a farther opener", () => {
    expect(enclosingBrackets(") (a)", 5)).toBeNull();
  });

  it("an opener with no closer does not enclose anything", () => {
    expect(enclosingBrackets("(a b", 4)).toBeNull();
  });

  it("nested pairs of different kinds resolve innermost first", () => {
    expect(enclosingBrackets("{(a)}", 3)).toEqual({ left: 1, right: 3 });
  });
});

describe("withinEnv: single-bracket and multi-character environments", () => {
  it("a single-bracket environment searches for the complete opener, not the bare bracket", () => {
    expect(withinEnv("\\pu{a}", 4, "\\pu{", "}")).toBe(true);
    // A plain brace group is not the environment.
    expect(withinEnv("{a}", 2, "\\pu{", "}")).toBe(false);
  });

  it("a multi-character environment counts whole command strings", () => {
    const text = "\\begin{pmatrix}a\\end{pmatrix}";
    expect(withinEnv(text, 15, "\\begin{pmatrix}", "\\end{pmatrix}")).toBe(true);
    expect(withinEnv(text, 0, "\\begin{pmatrix}", "\\end{pmatrix}")).toBe(false);
  });

  it("sibling environments of the same name do not leak into each other", () => {
    const text = "\\pu{a}\\pu{b}"; // the second `\pu{` starts at 6; its body is 10..11
    expect(withinEnv(text, 10, "\\pu{", "}")).toBe(true);
    expect(withinEnv(text, 4, "\\pu{", "}")).toBe(true);
    // Position 6 is between the two environments: neither encloses it.
    expect(withinEnv(text, 6, "\\pu{", "}")).toBe(false);
  });

  it("an opener with no closer anywhere reports false", () => {
    expect(withinEnv("\\pu{a", 4, "\\pu{", "}")).toBe(false);
  });

  it("an empty string has no environment", () => {
    expect(withinEnv("", 0, "\\pu{", "}")).toBe(false);
  });
});

describe("buildBracketColors: colors rotate with depth, mismatches are ignored", () => {
  const colorView = (doc: string) => {
    const state = EditorState.create({ doc });
    return { state, visibleRanges: [{ from: 0, to: doc.length }] };
  };

  it("the innermost pair is color 0 and an outer pair is color 1 (depth after the pop)", () => {
    // "$$(a(b))$$": `(a(b))` 2..8, the inner `(b)` 4..7.
    const doc = "$$(a(b))$$";
    const marks = decos(buildBracketColors(colorView(doc)));
    expect(marks).toEqual([
      { from: 2, to: 3, cls: "cw-bracket-0" },
      { from: 4, to: 5, cls: "cw-bracket-1" },
      { from: 6, to: 7, cls: "cw-bracket-1" },
      { from: 7, to: 8, cls: "cw-bracket-0" },
    ]);
  });

  it("colors rotate by nesting level with three colors (outermost 0, then 1, then 2)", () => {
    // "$${[(x)]}$$": `{` at 2, `[` at 3, `(` at 4, `)` at 6, `]` at 7, `}` at 8.
    // The color is the stack depth after the pop: `{` → 0, `[` → 1, `(` → 2.
    const doc = "$${[(x)]}$$";
    const marks = decos(buildBracketColors(colorView(doc)));
    const colorAt = new Map(marks.map((m) => [m.from, m.cls]));
    expect(colorAt.get(2)).toBe("cw-bracket-0");
    expect(colorAt.get(8)).toBe("cw-bracket-0");
    expect(colorAt.get(3)).toBe("cw-bracket-1");
    expect(colorAt.get(7)).toBe("cw-bracket-1");
    expect(colorAt.get(4)).toBe("cw-bracket-2");
    expect(colorAt.get(6)).toBe("cw-bracket-2");
  });

  it("a bracket run with no math region produces nothing", () => {
    expect(decos(buildBracketColors(colorView("(a) outside math")))).toEqual([]);
  });

  it("a mismatched closer is skipped without consuming the opener", () => {
    // "[)" never pairs: no decoration at all.
    expect(decos(buildBracketColors(colorView("$$[)$$")))).toEqual([]);
  });

  it("an unclosed opener on the left end of the document produces nothing", () => {
    expect(decos(buildBracketColors(colorView("$$((a)$$"))).length).toBe(2);
  });

  it("a formula outside the viewport is not decorated", () => {
    const doc = "$$(a)$$\n\ntext\n\n$$(b)$$";
    const state = EditorState.create({ doc });
    const marks = decos(buildBracketColors({ state, visibleRanges: [{ from: 0, to: 8 }] }));
    expect(marks.every((m) => m.from < 8)).toBe(true);
    expect(marks).toHaveLength(2);
  });
});

describe("buildCursorBrackets: the characters at and before the caret", () => {
  const cursorView = (doc: string, pos: number) => {
    const state = EditorState.create({ doc, selection: EditorSelection.cursor(pos) });
    return { state };
  };

  it("caret right after an opener pairs it with its closer", () => {
    const doc = "$$(ab)$$";
    const open = doc.indexOf("(");
    expect(decos(buildCursorBrackets(cursorView(doc, open + 1)))).toEqual([
      { from: open, to: open + 1, cls: "cw-bracket-match" },
      { from: doc.indexOf(")"), to: doc.indexOf(")") + 1, cls: "cw-bracket-match" },
    ]);
  });

  it("caret right after a closer pairs it backwards with its opener", () => {
    const doc = "$$(ab)$$";
    const close = doc.indexOf(")");
    const open = doc.indexOf("(");
    // The scan starts at range.to and walks back one character, so the caret
    // just past `)` resolves that closer against its opener. Decoration.set
    // sorts the ranges, so the opener comes first.
    expect(decos(buildCursorBrackets(cursorView(doc, close + 1)))).toEqual([
      { from: open, to: open + 1, cls: "cw-bracket-match" },
      { from: close, to: close + 1, cls: "cw-bracket-match" },
    ]);
  });

  it("an empty selection with no bracket at the caret falls back to the enclosing pair", () => {
    const doc = "$$(a b)$$";
    const marks = decos(buildCursorBrackets(cursorView(doc, doc.indexOf("b"))));
    expect(marks).toHaveLength(2);
    expect(marks.map((m) => m.from)).toEqual([doc.indexOf("("), doc.indexOf(")")]);
  });

  it("a bracket with no partner produces no decoration", () => {
    const doc = "$$(a$$";
    expect(decos(buildCursorBrackets(cursorView(doc, doc.indexOf("(") + 1)))).toEqual([]);
  });

  it("the caret on a non-bracket character with no enclosing pair produces nothing", () => {
    expect(decos(buildCursorBrackets(cursorView("$$abc$$", 4)))).toEqual([]);
  });

  it("a caret at the document start does not read past the edges", () => {
    expect(() => buildCursorBrackets(cursorView("$(", 0))).not.toThrow();
  });

  it("a caret at the document end does not read past the edges", () => {
    const doc = "$$a)$$";
    expect(() => buildCursorBrackets(cursorView(doc, doc.length))).not.toThrow();
  });
});
