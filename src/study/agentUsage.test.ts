import { describe, expect, it } from "vitest";
import {
  contextLabel,
  formatPercent,
  formatTokenCount,
  occupancyPercent,
  usageTitle,
} from "./agentUsage";

describe("formatTokenCount", () => {
  it("千以下原样,千/百万按 1 位小数省略 .0", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(61_800)).toBe("61.8k");
    expect(formatTokenCount(420_000)).toBe("420k");
    expect(formatTokenCount(1_500_000)).toBe("1.5m");
  });

  it("坏数据给占位符", () => {
    expect(formatTokenCount(NaN)).toBe("—");
    expect(formatTokenCount(-1)).toBe("—");
  });
});

describe("contextLabel / occupancyPercent", () => {
  it("已用 = input + output,与上限并列", () => {
    expect(contextLabel({ input: 61_800, output: 10_000 }, 420_000)).toBe("71.8k/420k");
    expect(contextLabel(null, 128_000)).toBe("—/128k");
  });

  it("占用率按最近一次请求算,并封顶 999", () => {
    expect(occupancyPercent({ input: 50_000, output: 20_000 }, 200_000)).toBe(35);
    expect(occupancyPercent({ input: 900, output: 100 }, 1000)).toBe(100);
    expect(occupancyPercent({ input: 10_000, output: 0 }, 1000)).toBe(999);
  });

  it("没有 usage / 上限无效时为 null", () => {
    expect(occupancyPercent(null, 128_000)).toBeNull();
    expect(occupancyPercent({ input: 1, output: 1 }, 0)).toBeNull();
  });

  it("百分比格式去尾 .0", () => {
    expect(formatPercent(35)).toBe("35%");
    expect(formatPercent(18.25)).toBe("18.3%");
    expect(formatPercent(null)).toBe("—");
  });
});

describe("usageTitle", () => {
  it("无 usage 时说明等待本轮回复", () => {
    expect(usageTitle(null, 420_000, "MiniMax-M3.1")).toContain("本轮回复后显示");
  });

  it("有 usage 时给出输入/输出/占用率全量", () => {
    const title = usageTitle({ input: 61_800, output: 10_000 }, 420_000, "MiniMax");
    expect(title).toContain("71.8k / 420k");
    expect(title).toContain("输入 61.8k");
    expect(title).toContain("输出 10k");
  });
});
