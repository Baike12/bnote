import { describe, expect, it } from "vitest";
import { staleDays, stalenessLabel } from "./staleness";

/**
 * The staleness converter's contract: each market ages from its own session
 * close (the first version anchored every market at the CN 15:00+08:00 close
 * and made a fresh US bar read one day old), a future timestamp is not a
 * negative age, and the 7-day flag is the only visible signal.
 */

// 2026-11-18 09:00 Beijing = 01:00 UTC.
const NOW = Date.parse("2026-11-18T09:00:00+08:00");

describe("staleDays", () => {
  it("a fresh CN bar (closed yesterday 15:00 CST) is 0 days old", () => {
    expect(staleDays("2026-11-17", "cn", NOW)).toBe(0);
  });

  it("a fresh US bar closes in ET, not at the CN close — it is 0 days old too", () => {
    // 2026-11-17 16:00 ET = 2026-11-18 05:00 Beijing; at 09:00 Beijing the
    // old +08:00 anchor read this as 1 day old.
    expect(staleDays("2026-11-17", "us", NOW)).toBe(0);
  });

  it("a fresh HK bar closes at 16:00 HKT", () => {
    expect(staleDays("2026-11-17", "hk", NOW)).toBe(0);
  });

  it("an unknown market falls back to the CN close", () => {
    expect(staleDays("2026-11-17", "whatever", NOW)).toBe(0);
  });

  it("an 8-day-old bar crosses the 7-day threshold", () => {
    // 11-09 15:00 CST → 11-18 09:00 CST is 8d18h; the floor keeps the
    // partial day out of the count.
    expect(staleDays("2026-11-09", "cn", NOW)).toBe(8);
  });

  it("a future or invalid timestamp is not an age", () => {
    expect(staleDays("2026-11-30", "cn", NOW)).toBeNull();
    expect(staleDays("not-a-date", "cn", NOW)).toBeNull();
  });
});

describe("stalenessLabel", () => {
  it("names the as-of date while fresh", () => {
    expect(stalenessLabel("2026-11-17", "cn", NOW)).toBe("数据截至 2026-11-17");
  });

  it("flags a stale dataset past 7 days", () => {
    expect(stalenessLabel("2026-11-09", "cn", NOW)).toBe("⚠ 数据截至 2026-11-09(已 8 天未更新)");
  });

  it("no bar, no label", () => {
    expect(stalenessLabel(undefined, "cn", NOW)).toBeNull();
  });
});
