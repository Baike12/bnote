import { describe, expect, it } from "vitest";
import { buildSnapshotMarkdown } from "./snapshotNote";
import type { InvestFundFlowDay, InvestSnapshot } from "./types";

const snapshot: InvestSnapshot = {
  code: "600519",
  market: "cn",
  price: 1453.9,
  prev_close: 1435.26,
  open: 1426.3,
  high: 1454.93,
  low: 1425.0,
  volume: 3_996_700,
  amount: 576_730_571_400,
  turnover: 0.0032,
  pe: 22.12,
  pb: 6.7,
  market_cap: 1_817_494_000_000,
  float_cap: null,
  limit_up: 1578.79,
  limit_down: 1291.73,
  amplitude: 0.0209,
  volume_ratio: 1.23,
  currency: "CNY",
  fetched_at: 1_763_364_093,
};

const flow: InvestFundFlowDay = {
  date: "2026-11-14",
  close: 1435.26,
  change_ratio: -0.0132,
  turnover: 0.0031,
  net_amount: -120_000_000,
  net_ratio: -0.02,
  main_net: -80_000_000,
  main_ratio: -0.013,
};

describe("buildSnapshotMarkdown", () => {
  it("renders the metric table with the display conventions and the as-of stamp", () => {
    const md = buildSnapshotMarkdown("贵州茅台", "600519", snapshot, [flow]);
    expect(md).toContain("## 贵州茅台 600519 快照");
    // H6: the pricing currency rides inline (a bare "1.82 万亿" in a USD
    // note reads as CNY).
    expect(md).toContain("| 现价 | 1,453.9 CNY |");
    expect(md).toContain("| 计价货币 | CNY |");
    // Signed percentage, 0–1 fraction contract.
    expect(md).toContain("+1.30%");
    // Yuan → 万亿 for the market cap.
    expect(md).toContain("1.82 万亿 CNY");
    // The fund-flow row carries the signed net flow.
    expect(md).toContain("-1.20 亿");
    // The stamp is pinned to Beijing time: the note is a durable copy, and a
    // machine-zone-dependent stamp makes two copies incomparable.
    expect(md).toContain("快照（2025/11/17 15:21:33）");
  });

  it("never emits NaN or undefined cells on partial data", () => {
    const bare = { ...snapshot, price: null, amount: null, fetched_at: NaN };
    const md = buildSnapshotMarkdown("测试", "000001", bare, []);
    expect(md).not.toContain("NaN");
    expect(md).not.toContain("undefined");
    expect(md).toContain("—");
  });
});
