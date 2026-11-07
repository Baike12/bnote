import { describe, expect, it } from "vitest";
import {
  NAV_BACK_LIMIT,
  popNavBack,
  pushNavBack,
  sameLocation,
  type CodeLocation,
} from "./navHistory";

const at = (path: string, line: number, character = 0): CodeLocation => ({
  path,
  position: { line, character },
});

describe("pushNavBack: one entry per jump origin", () => {
  it("appends the origin at the end (the most recent last)", () => {
    const stack = pushNavBack([], at("a.ts", 1));
    expect(pushNavBack(stack, at("b.ts", 2))).toEqual([at("a.ts", 1), at("b.ts", 2)]);
  });

  it("collapses consecutive duplicates: jumping twice from one caret is one place", () => {
    const stack = pushNavBack([at("a.ts", 1)], at("a.ts", 1));
    expect(stack).toEqual([at("a.ts", 1)]);
  });

  it("does not collapse a different position in the same file", () => {
    expect(pushNavBack([at("a.ts", 1)], at("a.ts", 2))).toEqual([at("a.ts", 1), at("a.ts", 2)]);
  });

  it("drops the oldest entries beyond the limit and keeps the newest", () => {
    let stack: CodeLocation[] = [];
    for (let i = 0; i < NAV_BACK_LIMIT + 5; i++) stack = pushNavBack(stack, at("f.ts", i));
    expect(stack).toHaveLength(NAV_BACK_LIMIT);
    expect(stack[0]).toEqual(at("f.ts", 5));
    expect(stack[stack.length - 1]).toEqual(at("f.ts", NAV_BACK_LIMIT + 4));
  });

  it("does not mutate the input stack", () => {
    const stack = [at("a.ts", 1)];
    pushNavBack(stack, at("b.ts", 2));
    expect(stack).toEqual([at("a.ts", 1)]);
  });
});

describe("popNavBack: one step back", () => {
  it("returns the most recent origin and the rest of the stack", () => {
    const stack = [at("a.ts", 1), at("b.ts", 2)];
    expect(popNavBack(stack)).toEqual({ target: at("b.ts", 2), rest: [at("a.ts", 1)] });
  });

  it("an empty history has no target", () => {
    expect(popNavBack([])).toEqual({ target: null, rest: [] });
  });

  it("walking back twice reaches the earlier origin in order", () => {
    let stack = [at("a.ts", 1), at("b.ts", 2), at("c.ts", 3)];
    const first = popNavBack(stack);
    stack = first.rest;
    const second = popNavBack(stack);
    expect(first.target).toEqual(at("c.ts", 3));
    expect(second.target).toEqual(at("b.ts", 2));
  });

  it("does not mutate the input stack", () => {
    const stack = [at("a.ts", 1)];
    popNavBack(stack);
    expect(stack).toEqual([at("a.ts", 1)]);
  });
});

describe("sameLocation: file plus position", () => {
  it("compares both fields", () => {
    expect(sameLocation(at("a.ts", 1), at("a.ts", 1, 0))).toBe(true);
    expect(sameLocation(at("a.ts", 1), at("b.ts", 1))).toBe(false);
    expect(sameLocation(at("a.ts", 1), at("a.ts", 1, 2))).toBe(false);
  });
});
