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

describe("Math.sumPrecise 兼容实现", () => {
  it("抵消项不丢精度:1e20 + 1 - 1e20 = 1(朴素求和给 0)", () => {
    expect(sumPrecise([1e20, 1, -1e20])).toBe(1);
    expect([1e20, 1, -1e20].reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("十个 0.1 精确等于 1", () => {
    expect(sumPrecise(Array.from({ length: 10 }, () => 0.1))).toBe(1);
  });

  it("按 spec 处理空输入与零:空 = -0,全 -0 = -0,含 +0 = +0", () => {
    expect(Object.is(sumPrecise([]), -0)).toBe(true);
    expect(Object.is(sumPrecise([-0, -0]), -0)).toBe(true);
    expect(Object.is(sumPrecise([-0, 0]), 0)).toBe(true);
  });

  it("NaN 与 ±Infinity 按 spec 传播", () => {
    expect(Number.isNaN(sumPrecise([1, NaN]))).toBe(true);
    expect(sumPrecise([1, Infinity])).toBe(Infinity);
    expect(sumPrecise([1, -Infinity])).toBe(-Infinity);
    expect(Number.isNaN(sumPrecise([Infinity, -Infinity]))).toBe(true);
  });

  it("接受任意可迭代对象,非数字抛 TypeError", () => {
    expect(sumPrecise(new Set([2, 3]))).toBe(5);
    expect(sumPrecise((function* () { yield 4; yield 5; })())).toBe(9);
    expect(() => sumPrecise([1, "2" as unknown as number])).toThrow(TypeError);
  });

  it("导入后补到 Math 上,pdf.js 的调用形式直接可用", () => {
    expect(typeof math.sumPrecise).toBe("function");
    expect(math.sumPrecise?.([1e20, 1, -1e20])).toBe(1);
  });

  it("引擎已有实现时不覆盖(未来 WebKit 补齐后自动让位)", () => {
    const sentinel = () => 42;
    math.sumPrecise = sentinel;
    expect(installSumPrecise()).toBe(false);
    expect(math.sumPrecise).toBe(sentinel);
    delete math.sumPrecise;
  });

  it("缺失时安装,并报告安装过", () => {
    delete math.sumPrecise;
    expect(installSumPrecise()).toBe(true);
    const installed = math.sumPrecise as unknown as (items: Iterable<number>) => number;
    expect(installed([2, 3])).toBe(5);
    expect(installSumPrecise()).toBe(false);
  });
});
