import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPerf,
  perfEvents,
  perfStats,
  recentSpans,
  recordPerfEvent,
  recordSpanMs,
  setPerfLevel,
} from "./trace";

beforeEach(() => {
  setPerfLevel("slow");
  clearPerf();
});

describe("perf tracer: aggregation and record policy", () => {
  it("aggregates n / max / p50 / p95 per span name", () => {
    recordSpanMs(1, "phase");
    recordSpanMs(3, "phase");
    recordSpanMs(5, "phase");
    const stat = perfStats().find((s) => s.name === "phase");
    expect(stat).toEqual({ name: "phase", n: 3, total: 9, max: 5, p50: 3, p95: 5 });
  });

  it("slow mode records slow spans but not fast ones", () => {
    recordSpanMs(30, "slow.phase");
    recordSpanMs(2, "fast.phase");
    const spans = perfEvents().filter((e) => e.kind === "span");
    expect(spans.map((e) => e.name)).toEqual(["slow.phase"]);
  });

  it("full mode records every span", () => {
    setPerfLevel("full");
    recordSpanMs(2, "fast.phase");
    expect(perfEvents().filter((e) => e.kind === "span")).toHaveLength(1);
  });

  it("recentSpans(since) keeps only the spans of the requested clock window", () => {
    const since = performance.now();
    recordSpanMs(1000, "older");
    recordSpanMs(0, "newer");
    const names = recentSpans(since).map((s) => s.name);
    expect(names).toContain("newer");
    expect(names).not.toContain("older");
  });

  it("a key event carries the phases that started in its window", () => {
    // Clock readings carry sub-millisecond noise; widen the window a little.
    const since = performance.now() - 10;
    recordSpanMs(4, "katex.render");
    recordPerfEvent("key", "a", 80, { updateMs: 5 }, since);
    const event = perfEvents().find((e) => e.kind === "key");
    expect(event?.ms).toBe(80);
    expect(event?.data).toEqual({ updateMs: 5 });
    expect(event?.recent?.map((s) => s.name)).toContain("katex.render");
  });
});
