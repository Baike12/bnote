import { describe, expect, it } from "vitest";
import { num, pct, sharesToLots, signedPct, yi } from "./format";

/**
 * The unit contract's single converters (docs/TESTING.md registry:
 * "unit-contract violation"). These locks are what made the -0.0327% and
 * "5.13 万亿 without a currency" bug classes impossible to reintroduce.
 */
describe("invest display formatters", () => {
  it("pct renders a 0–1 fraction without leaking float tails", () => {
    expect(pct(0.17)).toBe("17.00%");
    expect(pct(0.0032)).toBe("0.32%");
    expect(pct(1)).toBe("100.00%");
    expect(pct(null)).toBe("—");
    expect(pct(Number.NaN)).toBe("—");
  });

  it("signedPct carries the + for gains and nothing for zero", () => {
    expect(signedPct(0.013)).toBe("+1.30%");
    expect(signedPct(-0.0098)).toBe("-0.98%");
    expect(signedPct(0)).toBe("0.00%");
    expect(signedPct(null)).toBe("—");
  });

  it("num groups zh-CN style with a bounded tail", () => {
    expect(num(1453.9)).toBe("1,453.9");
    expect(num(45958723, 0)).toBe("45,958,723");
    expect(num(null)).toBe("—");
  });

  it("yi names the scale and rides the pricing currency inline", () => {
    expect(yi(18_174.94 * 1e8)).toBe("1.82 万亿");
    expect(yi(5_126_663_166_000, "USD")).toBe("5.13 万亿 USD");
    expect(yi(162_403_561, null)).toBe("1.62 亿");
    expect(yi(null)).toBe("—");
  });

  it("sharesToLots converts shares to whole lots (cn display convention)", () => {
    expect(sharesToLots(3_996_700)).toBe("39,967");
    expect(sharesToLots(0)).toBe("0");
    expect(sharesToLots(null)).toBe("—");
  });
});
