import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECENT_CAPACITY,
  SLOW_KEY_MS,
  SLOW_SPAN_MS,
  clearPerf,
  installPerfObservers,
  onPerfRecord,
  perfEnd,
  perfEvents,
  perfFields,
  perfLevel,
  perfReport,
  perfStart,
  perfStats,
  recentSpans,
  recordPerfEvent,
  recordSpanMs,
  round,
  setPerfLevel,
  startFullTrace,
  stopFullTrace,
} from "./trace";

/**
 * The tracer is the budget-keeper, so its own contract is load-bearing:
 *
 *   - the level decides whether clocks run at all (`off` must cost one boolean);
 *   - the recent-span ring holds exactly the last 64 spans, in order, because a
 *     slow key names the phases of *its own* update from that ring;
 *   - the event log is bounded and the report shape stays stable (the
 *     `pnpm perf:report` tooling reads it).
 *
 * Wall-clock thresholds are asserted from the exported constants, not from
 * guessed durations, so the suite cannot drift from the budget.
 */

beforeEach(() => {
  setPerfLevel("slow");
  clearPerf();
});

afterEach(() => {
  stopFullTrace();
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it("stats sort by worst observed duration, not by name", () => {
    recordSpanMs(5, "small");
    recordSpanMs(40, "large");
    expect(perfStats().map((s) => s.name)).toEqual(["large", "small"]);
  });

  it("n counts every span while the percentile samples stay bounded", () => {
    for (let i = 0; i < 300; i++) recordSpanMs(i, "many");
    const stat = perfStats().find((s) => s.name === "many");
    expect(stat?.n).toBe(300);
    expect(stat?.max).toBe(299);
  });
});

describe("level control", () => {
  it("defaults to slow tracing", () => {
    expect(perfLevel()).toBe("slow");
  });

  it("off makes perfStart a no-op token and perfEnd skip the clock", () => {
    setPerfLevel("off");
    const start = perfStart();
    expect(start).toBe(-1);
    perfEnd(start, "span");
    expect(perfEvents()).toEqual([]);
    expect(perfStats()).toEqual([]);
  });

  it("a level change emits an event carrying the new level and restarts the report window", () => {
    const since = performance.now();
    setPerfLevel("full");
    expect(perfEvents().find((e) => e.name === "level")).toMatchObject({
      kind: "event",
      data: { level: "full" },
    });
    expect(perfReport().since).toBeGreaterThanOrEqual(since);
  });

  it("going off emits nothing (and writing no log is the point of off)", () => {
    setPerfLevel("off");
    expect(perfEvents()).toEqual([]);
  });

  it("a full-trace window falls back to slow when its timer ends", async () => {
    vi.useFakeTimers();
    startFullTrace(2);
    expect(perfLevel()).toBe("full");
    await vi.advanceTimersByTimeAsync(2000);
    expect(perfLevel()).toBe("slow");
  });

  it("a non-positive duration still ends after at least one second", async () => {
    vi.useFakeTimers();
    startFullTrace(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(perfLevel()).toBe("full");
    await vi.advanceTimersByTimeAsync(1);
    expect(perfLevel()).toBe("slow");
  });

  it("stopping early cancels the ending timer and stays at slow", async () => {
    vi.useFakeTimers();
    startFullTrace(120);
    stopFullTrace();
    expect(perfLevel()).toBe("slow");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(perfLevel()).toBe("slow");
  });

  it("starting twice keeps a single ending timer", async () => {
    vi.useFakeTimers();
    startFullTrace(10);
    startFullTrace(10);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(perfLevel()).toBe("slow");
  });
});

describe("span payloads", () => {
  it("a slow span is emitted at the threshold with its rounded duration", () => {
    recordSpanMs(SLOW_SPAN_MS, "slow.phase");
    const record = perfEvents()[0];
    expect(record).toMatchObject({ kind: "span", name: "slow.phase", ms: SLOW_SPAN_MS });
    expect(record?.full).toBeUndefined();
  });

  it("a full trace marks its records so the sink keeps them below the threshold", () => {
    setPerfLevel("full");
    recordSpanMs(2, "fast.phase");
    const span = perfEvents().find((e) => e.kind === "span");
    expect(span?.full).toBe(true);
  });

  it("positional fields are packed only for a recorded span", () => {
    // Slow mode: the fast span is aggregated but never emitted, so no data
    // object is allocated on the hot path.
    perfEnd(perfStart(), "save.note", perfFields("bytes"), 12);
    expect(perfEvents().find((e) => e.name === "save.note")).toBeUndefined();
    expect(perfStats().find((s) => s.name === "save.note")?.n).toBe(1);

    // Full mode records it and the positional values become named fields.
    setPerfLevel("full");
    perfEnd(perfStart(), "async.write", perfFields("bytes", "failed"), 128, true);
    expect(perfEvents().find((e) => e.name === "async.write")?.data).toEqual({
      bytes: 128,
      failed: true,
    });
  });

  it("an explicit data object wins over the positional fields", () => {
    recordSpanMs(SLOW_SPAN_MS, "bridge", { html: "<pdf>" });
    expect(perfEvents()[0]?.data).toEqual({ html: "<pdf>" });
  });
});

describe("recent span ring", () => {
  it("keeps the last 64 spans in chronological order", () => {
    for (let i = 0; i < RECENT_CAPACITY + 5; i++) recordSpanMs(1, `phase-${i}`);
    const names = recentSpans().map((s) => s.name);
    expect(names).toHaveLength(RECENT_CAPACITY);
    expect(names[0]).toBe("phase-5");
    expect(names[names.length - 1]).toBe(`phase-${RECENT_CAPACITY + 4}`);
  });

  it("an empty ring reports nothing", () => {
    expect(recentSpans()).toEqual([]);
  });
});

describe("events and listeners", () => {
  it("a listener sees every record; unsubscribing stops it", () => {
    const seen: string[] = [];
    const off = onPerfRecord((record) => seen.push(record.kind));
    recordSpanMs(SLOW_SPAN_MS, "slow.phase");
    off();
    recordSpanMs(SLOW_SPAN_MS, "after");
    expect(seen).toEqual(["span"]);
  });

  it("unsubscribing twice is harmless", () => {
    const off = onPerfRecord(() => {});
    off();
    expect(() => off()).not.toThrow();
  });

  it("a key event without a window carries the whole recent ring", () => {
    recordSpanMs(1, "phase");
    recordPerfEvent("key", "a", SLOW_KEY_MS);
    expect(perfEvents()[0]?.recent?.map((s) => s.name)).toContain("phase");
  });

  it("the event log is bounded and drops the oldest records", () => {
    for (let i = 0; i < 320; i++) recordPerfEvent("frame", `f${i}`, 60);
    const events = perfEvents();
    expect(events).toHaveLength(300);
    expect(events[0]?.name).toBe("f20");
    expect(events[events.length - 1]?.name).toBe("f319");
  });

  it("the report copies the event list, so a later record cannot mutate an earlier report", () => {
    recordSpanMs(SLOW_SPAN_MS, "first");
    const report = perfReport();
    recordSpanMs(SLOW_SPAN_MS, "second");
    expect(report.events.map((e) => e.name)).toEqual(["first"]);
  });

  it("clearing empties the events, the stats and the ring", () => {
    recordSpanMs(SLOW_SPAN_MS, "slow.phase");
    clearPerf();
    expect(perfEvents()).toEqual([]);
    expect(perfStats()).toEqual([]);
    expect(recentSpans()).toEqual([]);
  });
});

describe("round", () => {
  it("rounds to two decimals", () => {
    expect(round(1.2345)).toBe(1.23);
    expect(round(1.236)).toBe(1.24);
    expect(round(0)).toBe(0);
    expect(round(12.999)).toBe(13);
  });
});

describe("installPerfObservers", () => {
  it("is a no-op without a PerformanceObserver (WebKit without longtask)", () => {
    const original = globalThis.PerformanceObserver;
    // @ts-expect-error -- removed on purpose to model a runtime without it.
    delete globalThis.PerformanceObserver;
    expect(() => installPerfObservers()).not.toThrow();
    globalThis.PerformanceObserver = original;
  });
});
