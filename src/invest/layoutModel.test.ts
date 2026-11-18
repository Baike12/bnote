import { describe, expect, it } from "vitest";
import {
  DEFAULT_INVEST_CONTENT_WIDTH,
  DEFAULT_INVEST_SIDE_WIDTH,
  cycleIndex,
  filterInstruments,
  leftDividerWidths,
  middleDividerWidth,
  importTargetScope,
  normalizeInvestWidth,
  parseScope,
  scopeDocDir,
  scopeFor,
} from "./layoutModel";

describe("normalizeInvestWidth", () => {
  it("falls back to the default on a non-finite width", () => {
    expect(normalizeInvestWidth(Number.NaN, 1000)).toBe(DEFAULT_INVEST_SIDE_WIDTH);
    expect(normalizeInvestWidth(Number.POSITIVE_INFINITY, 1000)).toBe(DEFAULT_INVEST_SIDE_WIDTH);
  });

  it("clamps to the 160px floor and the 80% window ceiling", () => {
    expect(normalizeInvestWidth(10, 1000)).toBe(160);
    // max = 1000 * (1 - 2 * 0.1) = 800
    expect(normalizeInvestWidth(5000, 1000)).toBe(800);
  });

  it("keeps a sane width and rounds it", () => {
    expect(normalizeInvestWidth(280.4, 1000)).toBe(280);
    expect(normalizeInvestWidth(DEFAULT_INVEST_CONTENT_WIDTH, 2000)).toBe(
      DEFAULT_INVEST_CONTENT_WIDTH,
    );
  });
});

describe("the divider seam (the call shape InvestLayout uses)", () => {
  // The bug this locks: the component passed the layout width where the drag
  // model expects the pointer delta, so one drag jumped straight to the
  // clamp bounds (the columns "could not be adjusted").
  const host = 2320;

  it("the middle divider moves exactly with the pointer, not by the window width", () => {
    const m = { middleLeft: 281, middleWidth: 680, hostWidth: host };
    expect(middleDividerWidth(m, 10)).toBe(690);
    expect(middleDividerWidth(m, 120)).toBe(800);
    expect(middleDividerWidth(m, -80)).toBe(600);
  });

  it("the left divider moves the boundary and keeps the two columns' sum", () => {
    const m = { leftWidth: 280, middleWidth: 680, hostWidth: host };
    const widths = leftDividerWidths(m, 80);
    expect(widths.left).toBe(360);
    expect(widths.middle).toBe(600);
    expect(widths.left + widths.middle).toBe(280 + 680);
  });

  it("clamps at the model's 10% floor instead of collapsing a column", () => {
    const m = { middleLeft: 281, middleWidth: 680, hostWidth: host };
    // A huge drag lands at the notes column's 10% floor, not at zero.
    const wide = middleDividerWidth(m, 10_000);
    expect(wide).toBeGreaterThanOrEqual(Math.round(host * 0.1));
    const narrow = middleDividerWidth(m, -10_000);
    expect(narrow).toBeGreaterThanOrEqual(Math.round(host * 0.1));
  });
});

describe("importTargetScope", () => {
  const inst = [
    { code: "000858", name: "五粮液" },
    { code: "NVDA", name: "英伟达" },
  ];
  const sec = [{ code: "801120", name: "食品饮料" }];

  it("jumps to the imported stock, preferring the payload's own name", () => {
    expect(
      importTargetScope(
        { code: "NVDA", instruments: [{ code: "NVDA", name: "英伟达" }] },
        inst,
        sec,
      ),
    ).toEqual({
      scope: "stock:NVDA",
      title: "英伟达",
    });
    // Not in the payload: the store's instrument master supplies the name.
    expect(importTargetScope({ code: "000858" }, inst, sec)).toEqual({
      scope: "stock:000858",
      title: "五粮液",
    });
    // Unknown everywhere: the code itself is a readable title.
    expect(importTargetScope({ code: "00700" }, inst, sec)).toEqual({
      scope: "stock:00700",
      title: "00700",
    });
  });

  it("routes sector-index bars to the sector scope", () => {
    expect(importTargetScope({ code: "801120", bar_kind: "sector" }, inst, sec)).toEqual({
      scope: "sector:801120",
      title: "食品饮料",
    });
  });

  it("has no target when the payload carries no code", () => {
    expect(importTargetScope({}, inst, sec)).toBeNull();
    expect(importTargetScope({ instruments: inst }, inst, sec)).toBeNull();
  });
});

describe("filterInstruments", () => {
  const list = [
    { code: "600519", name: "贵州茅台", industry: "食品饮料" },
    { code: "000001", name: "平安银行", industry: "银行" },
    { code: "300750", name: "宁德时代", industry: "电力设备" },
  ];

  it("passes the list through when the query is blank", () => {
    expect(filterInstruments(list, "  ")).toEqual(list);
    expect(filterInstruments(list, "")).toBe(list);
  });

  const panMarket = [
    ...list,
    { code: "AAPL", name: "苹果", industry: "" },
    { code: "NVDA", name: "英伟达", industry: "" },
    { code: "00700", name: "腾讯控股", industry: "" },
  ];

  it("matches us tickers case-insensitively (blind test: AAPL/aapl/NVDA found nothing)", () => {
    expect(filterInstruments(panMarket, "AAPL")).toHaveLength(1);
    expect(filterInstruments(panMarket, "aapl")[0].code).toBe("AAPL");
    expect(filterInstruments(panMarket, "NV")).toHaveLength(1);
    expect(filterInstruments(panMarket, "NV")[0].code).toBe("NVDA");
  });

  it("matches the hk code tail so leading zeros stay optional (700 → 00700)", () => {
    expect(filterInstruments(panMarket, "700")).toHaveLength(1);
    expect(filterInstruments(panMarket, "700")[0].code).toBe("00700");
    expect(filterInstruments(panMarket, "0700")).toHaveLength(1);
    expect(filterInstruments(panMarket, "00700")).toHaveLength(1);
  });

  it("filters by code prefix when the query is digits", () => {
    expect(filterInstruments(list, "600")).toHaveLength(1);
    expect(filterInstruments(list, "600")[0].code).toBe("600519");
    expect(filterInstruments(list, "30")).toHaveLength(1);
  });

  it("filters by name or industry substring otherwise", () => {
    expect(filterInstruments(list, "茅台")).toHaveLength(1);
    expect(filterInstruments(list, "银行")).toHaveLength(1);
    expect(filterInstruments(list, "电力")).toHaveLength(1);
    expect(filterInstruments(list, "不存在的")).toHaveLength(0);
  });
});

describe("cycleIndex", () => {
  it("wraps forward and backward", () => {
    expect(cycleIndex(0, 3, 1)).toBe(1);
    expect(cycleIndex(2, 3, 1)).toBe(0);
    expect(cycleIndex(0, 3, -1)).toBe(2);
  });

  it("answers 0 for an empty list", () => {
    expect(cycleIndex(0, 0, 1)).toBe(0);
  });
});

describe("scope addresses", () => {
  it("scopeFor builds the one scope address format", () => {
    expect(scopeFor("stock", "600519")).toBe("stock:600519");
    expect(scopeFor("sector", "801010")).toBe("sector:801010");
  });

  it("parseScope accepts exactly stock/sector with a code", () => {
    expect(parseScope("stock:600519")).toEqual({ kind: "stock", code: "600519" });
    expect(parseScope("sector:801010")).toEqual({ kind: "sector", code: "801010" });
    expect(parseScope("portfolio:main")).toBeNull();
    expect(parseScope("stock:")).toBeNull();
    expect(parseScope("market")).toBeNull();
    expect(parseScope("")).toBeNull();
  });

  it("scopeDocDir mirrors the Rust docs::scope_dir layout", () => {
    expect(scopeDocDir("stock:600519")).toBe("stocks/600519");
    expect(scopeDocDir("sector:801010")).toBe("sectors/801010");
    expect(scopeDocDir("portfolio:main")).toBeNull();
  });
});
