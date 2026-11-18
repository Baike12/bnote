import { describe, expect, it } from "vitest";
import { marketOf } from "./store";
import type { InvestInstrument } from "./types";

/**
 * H1: the market of a scope comes from the instrument master (the scope
 * string carries no market prefix — codes are unambiguous across cn/hk/us).
 * Locked here because a wrong fall-back silently routes hk/us bars to the
 * cn tables (the exact bug the import router had).
 */

const instruments: InvestInstrument[] = [
  {
    code: "600519",
    market: "cn",
    name: "贵州茅台",
    industry: "白酒",
    sector_code: "801120",
    sector_sub: null,
    kind: "stock",
    note: "",
    watch: true,
  },
  {
    code: "00700",
    market: "hk",
    name: "腾讯控股",
    industry: "",
    sector_code: null,
    sector_sub: null,
    kind: "stock",
    note: "",
    watch: true,
  },
  {
    code: "AAPL",
    market: "us",
    name: "苹果",
    industry: "",
    sector_code: null,
    sector_sub: null,
    kind: "stock",
    note: "",
    watch: true,
  },
];

describe("marketOf", () => {
  it("resolves the market from the instrument master", () => {
    expect(marketOf("stock:600519", instruments)).toBe("cn");
    expect(marketOf("stock:00700", instruments)).toBe("hk");
    expect(marketOf("stock:AAPL", instruments)).toBe("us");
  });

  it("sector scopes are always cn (the SW taxonomy is A-share only)", () => {
    expect(marketOf("sector:801120", instruments)).toBe("cn");
    expect(marketOf("sector:999999", instruments)).toBe("cn");
  });

  it("falls back to cn for an unlisted code (the master is the only fact)", () => {
    expect(marketOf("stock:000001", instruments)).toBe("cn");
    expect(marketOf("stock:NOPE", [])).toBe("cn");
  });

  it("never panics on a scope without a code", () => {
    expect(marketOf("market", instruments)).toBe("cn");
  });
});
