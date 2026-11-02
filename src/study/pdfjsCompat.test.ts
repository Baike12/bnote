import { afterEach, describe, expect, it } from "vitest";
import { installSumPrecise, sumPrecise } from "./pdfjsCompat";

/**
 * pdf.js 6 compiles embedded fonts into OpenType and sizes those tables with
 * `Math.sumPrecise`. WebKit (macOS 15) has no such function, so every
 * `Font.convert()` threw and pdf.js quietly replaced the embedded font with a
 * system one — an entire paper rendered in Helvetica. These tests pin the
 * replacement and the install guard.
 */

const math = Math as typeof Math & { sumPrecise?: (items: Iterable<number>) => number };
const original = math.sumPrecise;

afterEach(() => {
  if (original === undefined) {
    delete math.sumPrecise;
  } else {
    math.sumPrecise = original;
  }
});

describe("the Math.sumPrecise compatibility implementation", () => {
  it("cancelling terms keep their precision: 1e20 + 1 - 1e20 = 1 (a naive sum gives 0)", () => {
    expect(sumPrecise([1e20, 1, -1e20])).toBe(1);
    expect([1e20, 1, -1e20].reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("ten 0.1 add up exactly to 1", () => {
    expect(sumPrecise(Array.from({ length: 10 }, () => 0.1))).toBe(1);
  });

  it("the empty input and zero follow the spec: empty = -0, all -0 = -0, with +0 = +0", () => {
    expect(Object.is(sumPrecise([]), -0)).toBe(true);
    expect(Object.is(sumPrecise([-0, -0]), -0)).toBe(true);
    expect(Object.is(sumPrecise([-0, 0]), 0)).toBe(true);
  });

  it("NaN and ±Infinity propagate as the spec says", () => {
    expect(Number.isNaN(sumPrecise([1, NaN]))).toBe(true);
    expect(sumPrecise([1, Infinity])).toBe(Infinity);
    expect(sumPrecise([1, -Infinity])).toBe(-Infinity);
    expect(Number.isNaN(sumPrecise([Infinity, -Infinity]))).toBe(true);
  });

  it("any iterable is accepted, a non-number throws a TypeError", () => {
    expect(sumPrecise(new Set([2, 3]))).toBe(5);
    expect(sumPrecise((function* () { yield 4; yield 5; })())).toBe(9);
    expect(() => sumPrecise([1, "2" as unknown as number])).toThrow(TypeError);
  });

  it("after the import it is patched onto Math, so the way pdf.js calls it works directly", () => {
    expect(typeof math.sumPrecise).toBe("function");
    expect(math.sumPrecise?.([1e20, 1, -1e20])).toBe(1);
  });

  it("an implementation already in the engine is not overwritten (it steps aside once WebKit catches up)", () => {
    const sentinel = () => 42;
    math.sumPrecise = sentinel;
    expect(installSumPrecise()).toBe(false);
    expect(math.sumPrecise).toBe(sentinel);
    delete math.sumPrecise;
  });

  it("when it is missing it is installed and the install is reported", () => {
    delete math.sumPrecise;
    expect(installSumPrecise()).toBe(true);
    const installed = math.sumPrecise as unknown as (items: Iterable<number>) => number;
    expect(installed([2, 3])).toBe(5);
    expect(installSumPrecise()).toBe(false);
  });
});
