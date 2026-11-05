import { beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { compileSnippets, findSnippet, parseReplacement, reloadSnippets } from "./engine";
import { LATEX_SUITE_WORD_DELIMITERS } from "./config";
import { DEFAULT_SNIPPETS } from "./default-snippets";
import type { RawSnippet } from "./default-snippets";

/** The minimal snippet set used by the tests, so they do not depend on the
 *  exact content of the full built-in set. */
const FIXTURE: RawSnippet[] = [
  { trigger: "dm", replacement: "$$\n$0\n$$", options: "tAw" },
  { trigger: "(", replacement: "($0)$1", options: "mA" },
  { trigger: "bf", replacement: "\\mathbf{$0}$1", options: "mA" },
  { trigger: "([a-zA-Z])hat", replacement: "\\hat{[[0]]}", options: "rmA" },
];

beforeEach(() => {
  reloadSnippets(FIXTURE, true);
});

const state = (doc: string, cursor?: number) =>
  EditorState.create({ doc, selection: { anchor: cursor ?? doc.length } });

describe("findSnippet: word boundaries of the w snippet", () => {
  it("dm at the start of a line is a word boundary and must expand (regression: a newline used to be outside the boundary set)", () => {
    // The user's real scenario: the previous line is prose, and dm at the
    // start of the new line opens a formula block.
    const m = findSnippet(state("正文\n\ndm"), 6, "m", { auto: true, visualText: null });
    expect(m?.snippet.trigger).toBe("dm");
  });

  it("dm at the very start of the document expands as well", () => {
    const m = findSnippet(state("dm"), 2, "m", { auto: true, visualText: null });
    expect(m?.snippet.trigger).toBe("dm");
  });

  it("dm followed by a newline (typed at the end of a line) is a boundary too", () => {
    const m = findSnippet(state("dm\n下一行"), 2, "m", { auto: true, visualText: null });
    expect(m?.snippet.trigger).toBe("dm");
  });

  it("a letter right next to a letter (xdm) is not a boundary, so it does not expand", () => {
    const m = findSnippet(state("xdm"), 3, "m", { auto: true, visualText: null });
    expect(m).toBeNull();
  });

  it("a CJK neighbour is a boundary (typing dm after Chinese expands)", () => {
    const m = findSnippet(state("公式dm"), 4, "m", { auto: true, visualText: null });
    expect(m?.snippet.trigger).toBe("dm");
  });
});

describe("findSnippet: mode context", () => {
  it("a ( inside math mode auto-expands into a pair of brackets", () => {
    // Inline formula $x()$: the caret is right after the just-typed ( (position
    // 3) and the region is complete (the closing $ comes later).
    const m = findSnippet(state("$x()$", 3), 3, "(", { auto: true, visualText: null });
    expect(m?.snippet.trigger).toBe("(");
    expect(m?.start).toBe(2);
    expect(m?.replacement.text).toBe("()");
  });

  it("a ( in body text does not expand (mA only applies in math mode)", () => {
    const m = findSnippet(state("普通(x", 4), 4, "(", { auto: true, visualText: null });
    expect(m).toBeNull();
  });

  it("a regex trigger is anchored before the caret: a letter + hat inside math mode expands to an accent", () => {
    // The m of rmA means math mode: x|hat inside an inline formula triggers.
    const m = findSnippet(state("$xhat$", 5), 5, "t", { auto: true, visualText: null });
    expect(m?.replacement.text).toBe("\\hat{x}");
    expect(m?.start).toBe(1);
  });

  it("manual expansion (the Tab path) does not accept auto snippets: in the plugin an auto snippet requires a real single character to have been typed", () => {
    // dm is tAw (auto): the plugin's runSnippetCursor requires
    // `key.length === 1` for an auto snippet, and Tab's key is "Tab" (length
    // 3), so it is always skipped. If Tab accepted auto snippets, a caret
    // resting on an already complete tail like `\theta` would be expanded a
    // second time by the "add a backslash to Greek letters" regex (Tab ->
    // `\th\eta`); the end-to-end regression lives in tabout.test.ts.
    const m = findSnippet(state("dm", 2), 2, null, { auto: false, visualText: null });
    expect(m).toBeNull();
  });

  it("manual expansion still accepts non-auto snippets (only m, no A)", () => {
    reloadSnippets([{ trigger: "sr", replacement: "^{2}", options: "m" }], true);
    const m = findSnippet(state("$xsr$", 4), 4, null, { auto: false, visualText: null });
    expect(m?.snippet.trigger).toBe("sr");
  });
});

describe("same-priority triggers compete: a regex takes part in the ordering by source length (latex-suite getTriggerLength)", () => {
  const load = (s: RawSnippet[]) => reloadSnippets(s, true);
  // In the real snippet set both of these exist: xhat must take the former,
  // \hat the latter.
  const ACCENT: RawSnippet[] = [
    { trigger: /([a-zA-Z])hat/, replacement: "\\hat{[[0]]}", options: "rmA" },
    { trigger: "hat", replacement: "\\hat{$0}$1", options: "mA" },
  ];

  it("with a letter in front (xhat) the regex wins, not the trailing hat string snippet", () => {
    load(ACCENT);
    const m = findSnippet(state("$xhat$", 5), 5, "t", { auto: true, visualText: null });
    expect(m?.snippet.displayTrigger).toBe("([a-zA-Z])hat");
    expect(m?.start).toBe(1);
    expect(m?.replacement.text).toBe("\\hat{x}");
  });

  it("when the regex does not match it falls back to the hat snippet", () => {
    load(ACCENT);
    const m = findSnippet(state("$hat$", 4), 4, "t", { auto: true, visualText: null });
    expect(m?.snippet.displayTrigger).toBe("hat");
    expect(m?.replacement.text).toBe("\\hat{}");
  });
});

describe("parseReplacement: tabstops and escapes", () => {
  it("$0/$1 produce empty tabstops", () => {
    const r = parseReplacement("($0)$1", [], null);
    expect(r.text).toBe("()");
    expect(r.stops).toEqual([
      { index: 0, from: 1, to: 1 },
      { index: 1, from: 2, to: 2 },
    ]);
  });

  it("${0:default} carries placeholder text", () => {
    const r = parseReplacement("\\sum_{${0:i}=${1:1}}^{${2:N}} $3", [], null);
    expect(r.text).toBe("\\sum_{i=1}^{N} ");
    expect(r.stops).toEqual([
      { index: 0, from: 6, to: 7 },
      { index: 1, from: 8, to: 9 },
      { index: 2, from: 12, to: 13 },
      { index: 3, from: 15, to: 15 },
    ]);
  });

  it("[[n]] references a regex capture group, \\[[0]] is a literal backslash plus a group reference", () => {
    expect(parseReplacement("\\hat{[[0]]}", ["x"], null).text).toBe("\\hat{x}");
    expect(parseReplacement("\\[\\[0]]", ["x"], null).text).toBe("\\[\\[0]]");
  });

  it("\\$ and \\\\ are escapes, every other \\x keeps its backslash", () => {
    expect(parseReplacement("\\$0", [], null).text).toBe("$0");
    expect(parseReplacement("\\\\", [], null).text).toBe("\\");
    expect(parseReplacement("\\vec{", [], null).text).toBe("\\vec{");
  });

  it("${VISUAL} takes the selected text and is an empty string without a selection", () => {
    expect(parseReplacement("(${VISUAL})", [], "a+b").text).toBe("(a+b)");
    expect(parseReplacement("(${VISUAL})", [], null).text).toBe("()");
  });
});

describe("compileSnippets: ordering contract", () => {
  it("priority descends and longer triggers win within one level (a regex takes part by source length)", () => {
    const { list } = compileSnippets([
      { trigger: "a", replacement: "1", options: "tA" },
      { trigger: "abc", replacement: "2", options: "tA" },
      { trigger: /ab/, replacement: "3", options: "rA" },
      { trigger: "abx", replacement: "4", options: "tA", priority: 1 },
    ]);
    expect(list.map((s) => s.displayTrigger)).toEqual(["abx", "abc", "ab", "a"]);
  });
});

describe("function-type replacement (latex-suite semantics)", () => {
  const load = (s: RawSnippet[]) => reloadSnippets(s, true);

  it("a regex trigger receives the exec result array, so match[1] is capture group 1", () => {
    load([
      { trigger: /iden(\d)/, replacement: (m) => `n=${(m as RegExpExecArray)[1]}`, options: "mA" },
    ]);
    const m = findSnippet(state("$iden3$", 6), 6, "3", { auto: true, visualText: null });
    expect(m?.replacement.text).toBe("n=3");
  });

  it("a string trigger receives the trigger itself", () => {
    load([{ trigger: "zz", replacement: (m) => `[${String(m)}]`, options: "mA" }]);
    const m = findSnippet(state("$zz$", 3), 3, "z", { auto: true, visualText: null });
    expect(m?.replacement.text).toBe("[zz]");
  });

  it("a visual snippet receives the selected text", () => {
    load([{ trigger: "(", replacement: (m) => `(${String(m)})`, options: "mAv" }]);
    const m = findSnippet(state("$($"), 2, "(", { auto: false, visualText: "a+b" });
    expect(m?.replacement.text).toBe("(a+b)");
  });

  it("tabstops in the returned value are parsed as usual ($0 has a landing spot)", () => {
    load([{ trigger: "hh", replacement: () => "\\hat{$0}$1", options: "mA" }]);
    const m = findSnippet(state("$hh$", 3), 3, "h", { auto: true, visualText: null });
    expect(m?.replacement.text).toBe("\\hat{}");
    expect(m?.replacement.stops).toEqual([
      { index: 0, from: 5, to: 5 },
      { index: 1, from: 6, to: 6 },
    ]);
  });

  it("returning a non-string means the snippet does not match (the next candidate gets its turn)", () => {
    load([
      {
        trigger: "kk",
        replacement: (() => undefined) as unknown as RawSnippet["replacement"],
        options: "mA",
      },
      { trigger: "kk", replacement: "fallback", options: "mA" },
    ]);
    const m = findSnippet(state("$kk$", 3), 3, "k", { auto: true, visualText: null });
    expect(m?.replacement.text).toBe("fallback");
  });

  it("the built-in iden3 generates a 3×3 identity matrix (the only function-type snippet in the plugin)", () => {
    load(DEFAULT_SNIPPETS);
    const m = findSnippet(state("$iden3$", 6), 6, "3", { auto: true, visualText: null });
    expect(m?.replacement.text).toBe(
      "\\begin{pmatrix}\n1 & 0 & 0 \\\\\n0 & 1 & 0 \\\\\n0 & 0 & 1\n\\end{pmatrix}",
    );
  });
});

describe("removeSnippetWhitespace (inline formulas only)", () => {
  it("trailing whitespace is removed inside an inline formula", () => {
    reloadSnippets([{ trigger: "sp", replacement: "a ", options: "mA" }], true);
    const m = findSnippet(state("$sp$", 3), 3, "p", { auto: true, visualText: null });
    expect(m?.replacement.text).toBe("a");
  });

  it("inside an inline formula the space before a `${n}` tabstop is removed while the tabstop stays", () => {
    reloadSnippets([{ trigger: "tu", replacement: "a x $2", options: "mA" }], true);
    const m = findSnippet(state("$tu$", 3), 3, "u", { auto: true, visualText: null });
    expect(m?.replacement.text).toBe("a x");
  });

  it("a block formula is left alone (the space before the newline is part of the layout)", () => {
    reloadSnippets([{ trigger: "sp", replacement: "a ", options: "MA" }], true);
    const m = findSnippet(state("$$\nsp\n$$"), 5, "p", { auto: true, visualText: null });
    expect(m?.replacement.text).toBe("a ");
  });

  it("it can be turned off (with the setting off the replacement expands verbatim)", () => {
    reloadSnippets([{ trigger: "sp", replacement: "a ", options: "mA" }], true);
    const m = findSnippet(state("$sp$", 3), 3, "p", {
      auto: true,
      visualText: null,
      removeSnippetWhitespace: false,
    });
    expect(m?.replacement.text).toBe("a ");
  });
});

describe("wordDelimiters is configurable", () => {
  const load = () => reloadSnippets([{ trigger: "dm", replacement: "x", options: "tAw" }], true);

  it("the default uses the plugin delimiter set: * is not in it → *dm does not expand", () => {
    load();
    const m = findSnippet(state("*dm"), 3, "m", { auto: true, visualText: null });
    expect(m).toBeNull();
  });

  it("widening the delimiter set makes * a boundary as well → it expands at the same position", () => {
    load();
    const m = findSnippet(state("*dm"), 3, "m", {
      auto: true,
      visualText: null,
      wordDelimiters: "*",
    });
    expect(m?.snippet.trigger).toBe("dm");
  });

  it("a literal \\n in the setting string turns back into a real newline (dm at the line start is still a boundary)", () => {
    load();
    const m = findSnippet(state("正文\ndm"), 5, "m", {
      auto: true,
      visualText: null,
      wordDelimiters: LATEX_SUITE_WORD_DELIMITERS,
    });
    expect(m?.snippet.trigger).toBe("dm");
  });

  it("a CJK neighbour is always a boundary (independent of the delimiter set, required for Chinese notes)", () => {
    load();
    const m = findSnippet(state("测试dm"), 4, "m", {
      auto: true,
      visualText: null,
      wordDelimiters: "",
    });
    expect(m?.snippet.trigger).toBe("dm");
  });
});
