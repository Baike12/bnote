import { describe, expect, it } from "vitest";
import { loadVerdict, PERF_LOAD_CEILING, skipNotice } from "./loadGate";

describe("perf load gate", () => {
  it("treats an idle machine as fit", () => {
    expect(loadVerdict(0.4, 10).fit).toBe(true);
  });

  it("rejects a machine loaded beyond the ceiling", () => {
    const verdict = loadVerdict(11, 12);
    expect(verdict.fit).toBe(false);
    expect(verdict.limit).toBe(9);
  });

  it("keeps a two-task floor on small machines", () => {
    // 4 cpus × 0.75 = 3, so the floor only binds at 1–2 cpus.
    expect(loadVerdict(1, 2).limit).toBe(2);
    expect(loadVerdict(1, 2).fit).toBe(true);
    expect(loadVerdict(2, 2).fit).toBe(false);
  });

  it("puts the ceiling strictly below one task per core", () => {
    expect(PERF_LOAD_CEILING).toBeLessThan(1);
  });

  it("names the load, the limit and the rerun command when skipping", () => {
    expect(skipNotice(loadVerdict(0.4, 10))).toBeNull();
    const notice = skipNotice(loadVerdict(11, 12));
    expect(notice).toContain("11.00");
    expect(notice).toContain("≥ 9 limit");
    expect(notice).toContain("12 cpus");
    expect(notice).toContain("pnpm test:perf");
  });
});
