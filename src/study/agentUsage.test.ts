import { describe, expect, it } from "vitest";
import {
  contextLabel,
  formatPercent,
  formatTokenCount,
  occupancyPercent,
  usageTitle,
} from "./agentUsage";

describe("formatTokenCount", () => {
  it("below a thousand it is kept as is, thousands and millions use one decimal and drop .0", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(61_800)).toBe("61.8k");
    expect(formatTokenCount(420_000)).toBe("420k");
    expect(formatTokenCount(1_500_000)).toBe("1.5m");
  });

  it("bad data yields a placeholder", () => {
    expect(formatTokenCount(NaN)).toBe("—");
    expect(formatTokenCount(-1)).toBe("—");
  });
});

describe("contextLabel / occupancyPercent", () => {
  it("used = input + output, shown next to the limit", () => {
    expect(contextLabel({ input: 61_800, output: 10_000 }, 420_000)).toBe("71.8k/420k");
    expect(contextLabel(null, 128_000)).toBe("—/128k");
  });

  it("the occupancy rate is computed from the latest request and capped at 999", () => {
    expect(occupancyPercent({ input: 50_000, output: 20_000 }, 200_000)).toBe(35);
    expect(occupancyPercent({ input: 900, output: 100 }, 1000)).toBe(100);
    expect(occupancyPercent({ input: 10_000, output: 0 }, 1000)).toBe(999);
  });

  it("null when there is no usage or the limit is invalid", () => {
    expect(occupancyPercent(null, 128_000)).toBeNull();
    expect(occupancyPercent({ input: 1, output: 1 }, 0)).toBeNull();
  });

  it("the percentage format drops a trailing .0", () => {
    expect(formatPercent(35)).toBe("35%");
    expect(formatPercent(18.25)).toBe("18.3%");
    expect(formatPercent(null)).toBe("—");
  });
});

describe("usageTitle", () => {
  it("without usage it says that it waits for this round's reply", () => {
    expect(usageTitle(null, 420_000, "MiniMax-M3.1")).toContain("本轮回复后显示");
  });

  it("with usage it reports the full input, output and occupancy rate", () => {
    const title = usageTitle({ input: 61_800, output: 10_000 }, 420_000, "MiniMax");
    expect(title).toContain("71.8k / 420k");
    expect(title).toContain("输入 61.8k");
    expect(title).toContain("输出 10k");
  });
});
