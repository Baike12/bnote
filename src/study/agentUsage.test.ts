import { describe, expect, it } from "vitest";
import {
  cacheHitRate,
  contextLabel,
  contextOccupancy,
  formatPercent,
  formatTokenCount,
  occupancyPercent,
  sessionHitRate,
  usageTitle,
  type AgentUsage,
} from "./agentUsage";

/** One request's usage; the session totals default to that same request. */
const usage = (input: number, output: number, cacheRead = 0): AgentUsage => ({
  input,
  output,
  cacheRead,
  sessionInput: input,
  sessionCacheRead: cacheRead,
  sessionRequests: 1,
});

describe("formatTokenCount", () => {
  it("below a wan it is kept as is, above it uses the zh wan/unit with one decimal and drops .0", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(9_999)).toBe("9999");
    expect(formatTokenCount(10_000)).toBe("1万");
    expect(formatTokenCount(195_000)).toBe("19.5万");
    expect(formatTokenCount(420_000)).toBe("42万");
    expect(formatTokenCount(1_500_000)).toBe("150万");
    expect(formatTokenCount(150_000_000)).toBe("1.5亿");
  });

  it("bad data yields a placeholder", () => {
    expect(formatTokenCount(NaN)).toBe("—");
    expect(formatTokenCount(-1)).toBe("—");
  });
});

describe("contextLabel / occupancyPercent", () => {
  it("used = input + output, shown next to the limit", () => {
    expect(contextLabel(usage(61_800, 10_000), 420_000)).toBe("7.2万/42万");
    expect(contextLabel(null, 128_000)).toBe("—/12.8万");
  });

  it("the occupancy rate is computed from the latest request and capped at 999", () => {
    expect(occupancyPercent(usage(50_000, 20_000), 200_000)).toBe(35);
    expect(occupancyPercent(usage(900, 100), 1000)).toBe(100);
    expect(occupancyPercent(usage(10_000, 0), 1000)).toBe(999);
  });

  it("null when there is no usage or the limit is invalid", () => {
    expect(occupancyPercent(null, 128_000)).toBeNull();
    expect(occupancyPercent(usage(1, 1), 0)).toBeNull();
  });

  it("the percentage format drops a trailing .0", () => {
    expect(formatPercent(35)).toBe("35%");
    expect(formatPercent(18.25)).toBe("18.3%");
    expect(formatPercent(null)).toBe("—");
  });
});

describe("cacheHitRate", () => {
  it("cache read over the whole input (input already includes the cache read)", () => {
    expect(cacheHitRate(usage(206, 32, 197))).toBeCloseTo(197 / 206);
  });

  it("null when the provider reports no cache reads or no input", () => {
    expect(cacheHitRate(usage(100, 10, 0))).toBeNull();
    expect(cacheHitRate(usage(0, 10, 0))).toBeNull();
    expect(cacheHitRate(null)).toBeNull();
  });
});

describe("usageTitle", () => {
  it("without usage it says that it waits for this round's reply", () => {
    expect(usageTitle(null, 420_000, "MiniMax-M3.1")).toContain("本轮回复后显示");
  });

  it("with usage it reports the full input, output and occupancy rate", () => {
    const title = usageTitle(usage(61_800, 10_000), 420_000, "MiniMax");
    expect(title).toContain("7.2万 / 42万");
    expect(title).toContain("输入 6.2万");
    expect(title).toContain("输出 1万");
  });

  it("with cache reads it reports the hit rate", () => {
    const title = usageTitle(usage(206, 32, 197), 420_000, "MiniMax");
    expect(title).toContain("缓存命中");
  });
});

describe("sessionHitRate", () => {
  // The headline number is the session's, token-weighted: a cold first request
  // must not define it, and a per-request mean would let one cheap request
  // outweigh an expensive one.
  const session = (sessionInput: number, sessionCacheRead: number, requests = 2): AgentUsage => ({
    input: 1_000,
    output: 10,
    cacheRead: 0,
    sessionInput,
    sessionCacheRead,
    sessionRequests: requests,
  });

  it("divides the summed cache reads by the summed input", () => {
    // 0 cached of 40k (cold) + 39k of 41k + 40k of 42k = 79k / 123k.
    const u = session(123_000, 79_000, 3);
    expect(sessionHitRate(u)).toBeCloseTo(79 / 123);
  });

  it("is null before the first request and never exceeds one", () => {
    expect(sessionHitRate(null)).toBeNull();
    expect(sessionHitRate(session(0, 0, 0))).toBeNull();
    expect(sessionHitRate(session(100, 300, 1))).toBe(1);
  });

  it("the latest request's own rate stays available beside it", () => {
    const cold = { ...session(123_000, 79_000, 3), input: 42_000, cacheRead: 0 };
    expect(sessionHitRate(cold)).toBeCloseTo(79 / 123);
    expect(cacheHitRate(cold)).toBeNull();
    expect(usageTitle(cold, 420_000, "m")).not.toContain("本轮");

    const warm = { ...cold, cacheRead: 40_000 };
    expect(cacheHitRate(warm)).toBeCloseTo(40 / 42);
    expect(usageTitle(warm, 420_000, "m")).toContain("本轮 95.2%");
  });
});

/**
 * The context card's numbers: the provider's usage when a request has reported
 * it, the backend's estimate when it has not (a session restored from disk has
 * messages but no usage). Without the fallback the card printed "—/42万" over
 * an empty bar even though the breakdown it had just fetched was complete
 * (observed).
 */
describe("contextOccupancy", () => {
  it("prefers the provider's usage", () => {
    expect(contextOccupancy(usage(50_000, 20_000), 200_000, 999_999)).toEqual({
      used: 70_000,
      estimated: false,
      percent: 35,
    });
  });

  it("falls back to the estimate, marked as one", () => {
    expect(contextOccupancy(null, 420_000, 21_000)).toEqual({
      used: 21_000,
      estimated: true,
      percent: 5,
    });
  });

  it("has nothing to show without usage and without an estimate", () => {
    expect(contextOccupancy(null, 420_000, null)).toBeNull();
    expect(contextOccupancy(null, 420_000, 0)).toBeNull();
  });

  it("keeps the token count when the limit is unknown", () => {
    expect(contextOccupancy(usage(1_000, 0), 0, null)).toEqual({
      used: 1_000,
      estimated: false,
      percent: null,
    });
  });
});
