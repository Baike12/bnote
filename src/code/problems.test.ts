import { describe, expect, it } from "vitest";
import { nextProblemTarget, type ProblemTarget } from "./problems";

/**
 * Root-cause gate for F8 / ⇧F8.
 *
 * The old implementation used "the 0th diagnostic of the current file" as its
 * cursor instead of the caret position: pressing F8 repeatedly in one file
 * always returned to the 0th entry, so in practice it jumped back and forth
 * between two files. This gate pins down the three rules that replace it: the
 * caret is the cursor, entries are ordered by position within a group, and the
 * walk wraps around across files.
 */

const at = (path: string, line: number, character = 0): ProblemTarget => ({
  path,
  position: { line, character },
});

const problems = [
  at("a.ts", 5),
  at("a.ts", 1),
  at("a.ts", 9),
  at("b.ts", 2),
  at("b.ts", 7),
  at("c.ts", 4),
];

describe("next / previous problem", () => {
  it("no diagnostics means no jump", () => {
    expect(
      nextProblemTarget([], { path: "a.ts", position: { line: 0, character: 0 } }, 1),
    ).toBeNull();
  });

  it("inside one file the next one is taken by position, and out-of-order diagnostics are sorted first", () => {
    const hit = nextProblemTarget(
      problems,
      { path: "a.ts", position: { line: 0, character: 0 } },
      1,
    );
    expect(hit).toEqual(at("a.ts", 1));
  });

  it("when the caret sits on a diagnostic it is skipped and the next one is taken", () => {
    const hit = nextProblemTarget(
      problems,
      { path: "a.ts", position: { line: 5, character: 0 } },
      1,
    );
    expect(hit).toEqual(at("a.ts", 9));
  });

  it("at the end of the current file it crosses over to the first one of the next file", () => {
    const hit = nextProblemTarget(
      problems,
      { path: "a.ts", position: { line: 9, character: 0 } },
      1,
    );
    expect(hit).toEqual(at("b.ts", 2));
  });

  it("at the end of the last file it wraps around to the first file (cyclic)", () => {
    const hit = nextProblemTarget(
      problems,
      { path: "c.ts", position: { line: 9, character: 0 } },
      1,
    );
    expect(hit).toEqual(at("a.ts", 1));
  });

  it("a single file cycles too: after the last entry it returns to the first", () => {
    const one = [at("a.ts", 1), at("a.ts", 3)];
    const hit = nextProblemTarget(one, { path: "a.ts", position: { line: 9, character: 0 } }, 1);
    expect(hit).toEqual(at("a.ts", 1));
  });

  it("mirrored upwards: it jumps to the nearest one before the caret", () => {
    const hit = nextProblemTarget(
      problems,
      { path: "b.ts", position: { line: 5, character: 0 } },
      -1,
    );
    expect(hit).toEqual(at("b.ts", 2));
  });

  it("upwards at the end: it crosses over to the last one of the previous file", () => {
    const hit = nextProblemTarget(
      problems,
      { path: "b.ts", position: { line: 0, character: 0 } },
      -1,
    );
    expect(hit).toEqual(at("a.ts", 9));
  });

  it("the current file has no diagnostics: downwards starts at the first entry of the whole list, upwards at the last one", () => {
    expect(
      nextProblemTarget(problems, { path: "z.ts", position: { line: 0, character: 0 } }, 1),
    ).toEqual(at("a.ts", 1));
    expect(
      nextProblemTarget(problems, { path: "z.ts", position: { line: 0, character: 0 } }, -1),
    ).toEqual(at("c.ts", 4));
  });

  it("without a caret position (no editor) it gives the head / tail of the current file", () => {
    expect(nextProblemTarget(problems, { path: "b.ts", position: null }, 1)).toEqual(at("b.ts", 2));
    expect(nextProblemTarget(problems, { path: "b.ts", position: null }, -1)).toEqual(
      at("b.ts", 7),
    );
  });

  it("entries on the same line are compared by column", () => {
    const cols = [at("a.ts", 3, 0), at("a.ts", 3, 8)];
    const hit = nextProblemTarget(cols, { path: "a.ts", position: { line: 3, character: 4 } }, 1);
    expect(hit).toEqual(at("a.ts", 3, 8));
  });
});
