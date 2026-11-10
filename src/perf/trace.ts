/**
 * Editor performance tracing: the budget-keeper of bnote's lifeline.
 *
 * Cost model (the tracer itself must never jank):
 * - a span is two `performance.now()` calls and one Map lookup; no closure and
 *   no allocation on the fast path;
 * - the last 64 spans live in preallocated columns, so a slow key can show the
 *   phases that produced it without keeping every fast span alive;
 * - events (a slow span, a slow key, a long task) are the only allocations and
 *   only when the threshold is crossed;
 * - persistence is batched off the hot path (see sink.ts).
 *
 * Levels:
 * - `slow` (default, always on): record spans/keys/long tasks above the
 *   thresholds. This is what answers "it froze, why" after the fact.
 * - `full`: record every span and every frame for a bounded session; used by
 *   the "性能：开始详细追踪" command when a problem is being chased.
 * - `off`: no clocks at all (the hot path still pays one boolean check).
 */

export type PerfLevel = "off" | "slow" | "full";

export interface PerfSpan {
  name: string;
  start: number;
  ms: number;
}

export interface PerfRecord {
  /** Wall clock (Date.now) so persisted lines sort across sessions. */
  t: number;
  kind: "span" | "key" | "longtask" | "event" | "session" | "frame";
  name?: string;
  ms?: number;
  data?: Record<string, unknown>;
  /** Recorded during a full-trace window: the sink keeps it even below the
   *  slow-span threshold (full mode promises every span). */
  full?: boolean;
  /** The spans that led to this record (slow keys/long tasks only). */
  recent?: PerfSpan[];
}

export interface PerfStat {
  name: string;
  n: number;
  total: number;
  max: number;
  p50: number;
  p95: number;
}

export interface PerfReport {
  level: PerfLevel;
  since: number;
  stats: PerfStat[];
  events: PerfRecord[];
}

/** Spans at or above this are recorded even in `slow` mode. */
export const SLOW_SPAN_MS = 25;
/** Keys whose keydown→paint time crosses this are recorded. */
export const SLOW_KEY_MS = 50;
/** Long tasks are recorded by the browser's own longtask observer. */
export const RECENT_CAPACITY = 64;
const MAX_EVENTS = 300;
const SAMPLE_CAPACITY = 256;

let level: PerfLevel = "slow";
let startedAt = Date.now();

const recentNames: string[] = new Array<string>(RECENT_CAPACITY).fill("");
const recentStarts = new Float64Array(RECENT_CAPACITY);
const recentDurs = new Float64Array(RECENT_CAPACITY);
let recentCursor = 0;

const stats = new Map<string, { n: number; total: number; max: number; samples: number[] }>();
const events: PerfRecord[] = [];

/* ---- listeners (the sink subscribes; the tracer does not import app code) ---- */

type RecordListener = (record: PerfRecord) => void;
const listeners: RecordListener[] = [];

export function onPerfRecord(listener: RecordListener): () => void {
  listeners.push(listener);
  return () => {
    const i = listeners.indexOf(listener);
    if (i >= 0) listeners.splice(i, 1);
  };
}

function emit(record: PerfRecord): void {
  events.push(record);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  for (const listener of listeners) listener(record);
}

/* ---- level control ---- */

export function perfLevel(): PerfLevel {
  return level;
}

export function setPerfLevel(next: PerfLevel): void {
  level = next;
  startedAt = Date.now();
  if (next !== "off") emit({ t: Date.now(), kind: "event", name: "level", data: { level: next } });
}

/** A bounded full-tracing window; returns the timer that would end it early. */
export function startFullTrace(seconds: number): void {
  setPerfLevel("full");
  if (fullTraceTimer !== null) clearTimeout(fullTraceTimer);
  fullTraceTimer = setTimeout(
    () => {
      fullTraceTimer = null;
      setPerfLevel("slow");
    },
    Math.max(1, seconds) * 1000,
  );
}

let fullTraceTimer: ReturnType<typeof setTimeout> | null = null;

export function stopFullTrace(): void {
  if (fullTraceTimer !== null) {
    clearTimeout(fullTraceTimer);
    fullTraceTimer = null;
  }
  setPerfLevel("slow");
}

/* ---- spans ---- */

/** Names of the numeric/string values attached to a span. A fixed array per
 *  call site (module-level) — the hot path passes values positionally, so no
 *  data object is allocated unless the span is actually recorded. */
export type PerfFields = readonly [string, string?, string?];

export function perfFields<const T extends PerfFields>(...names: T): T {
  return names;
}

/** Start a span; returns -1 when tracing is off (perfEnd then does nothing). */
export function perfStart(): number {
  return level === "off" ? -1 : performance.now();
}

/**
 * End a span. `start` is the perfStart() token. The field names are a static
 * array and the values are primitives, so a fast span allocates nothing: the
 * data object is built only inside the record threshold.
 */
export function perfEnd(
  start: number,
  name: string,
  fields?: PerfFields,
  v1?: unknown,
  v2?: unknown,
  v3?: unknown,
): void {
  if (start < 0) return;
  recordSpan(performance.now() - start, name, start, fields, v1, v2, v3);
}

function packFields(
  fields: PerfFields | undefined,
  v1: unknown,
  v2: unknown,
  v3: unknown,
): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const data: Record<string, unknown> = { [fields[0]]: v1 };
  if (fields[1] !== undefined) data[fields[1]] = v2;
  if (fields[2] !== undefined) data[fields[2]] = v3;
  return data;
}

/**
 * Record an already measured span. Exported for async legs (IPC, file writes)
 * and for the gates, which must not depend on wall-clock thresholds.
 */
export function recordSpanMs(ms: number, name: string, data?: Record<string, unknown>): void {
  recordSpan(ms, name, performance.now() - ms, undefined, undefined, undefined, undefined, data);
}

function recordSpan(
  ms: number,
  name: string,
  startedAt: number,
  fields?: PerfFields,
  v1?: unknown,
  v2?: unknown,
  v3?: unknown,
  data?: Record<string, unknown>,
): void {
  const bag = stats.get(name);
  if (bag) {
    bag.n++;
    bag.total += ms;
    if (ms > bag.max) bag.max = ms;
    if (bag.samples.length >= SAMPLE_CAPACITY) bag.samples.shift();
    bag.samples.push(ms);
  } else {
    stats.set(name, { n: 1, total: ms, max: ms, samples: [ms] });
  }

  recentNames[recentCursor] = name;
  recentStarts[recentCursor] = startedAt;
  recentDurs[recentCursor] = ms;
  recentCursor = (recentCursor + 1) % RECENT_CAPACITY;

  if (ms >= SLOW_SPAN_MS || level === "full") {
    emit({
      t: Date.now(),
      kind: "span",
      name,
      ms: round(ms),
      data: data ?? packFields(fields, v1, v2, v3),
      full: level === "full" ? true : undefined,
    });
  }
}

/** The recent spans in chronological order (a snapshot; allocates). With
 *  `since`, only spans that started at/after that clock reading are returned —
 *  a key event can then name the phases of **its own** update, without the
 *  previous key's work in the window. */
export function recentSpans(since?: number): PerfSpan[] {
  const out: PerfSpan[] = [];
  for (let i = 0; i < RECENT_CAPACITY; i++) {
    const idx = (recentCursor + i) % RECENT_CAPACITY;
    const name = recentNames[idx];
    if (!name) continue;
    if (since !== undefined && recentStarts[idx] < since) continue;
    out.push({ name, start: round(recentStarts[idx]), ms: round(recentDurs[idx]) });
  }
  return out;
}

/** Record a key/long-task/frame event with its phase context. */
export function recordPerfEvent(
  kind: PerfRecord["kind"],
  name: string,
  ms: number,
  data?: Record<string, unknown>,
  since?: number,
): void {
  emit({
    t: Date.now(),
    kind,
    name,
    ms: round(ms),
    data,
    recent: recentSpans(since),
  });
}

/* ---- reports ---- */

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

export function perfStats(): PerfStat[] {
  const out: PerfStat[] = [];
  for (const [name, bag] of stats) {
    const sorted = [...bag.samples].sort((a, b) => a - b);
    out.push({
      name,
      n: bag.n,
      total: round(bag.total),
      max: round(bag.max),
      p50: round(percentile(sorted, 0.5)),
      p95: round(percentile(sorted, 0.95)),
    });
  }
  return out.sort((a, b) => b.max - a.max);
}

export function perfReport(): PerfReport {
  return { level, since: startedAt, stats: perfStats(), events: [...events] };
}

export function perfEvents(): PerfRecord[] {
  return [...events];
}

export function clearPerf(): void {
  stats.clear();
  events.length = 0;
  recentNames.fill("");
  recentStarts.fill(0);
  recentDurs.fill(0);
  recentCursor = 0;
  startedAt = Date.now();
}

export function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

/* ---- browser observers (long tasks and event timing) ---- */

let observersInstalled = false;

/**
 * Installs the passive observers. Long tasks have no attribution API; the
 * recent-span ring is the attribution: a 200ms task shows exactly which phase
 * (KaTeX, a full-document scan, an IME call) was running right before it.
 */
export function installPerfObservers(): void {
  if (observersInstalled) return;
  observersInstalled = true;
  if (typeof PerformanceObserver === "undefined") return;
  try {
    const longTask = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < SLOW_KEY_MS) continue;
        recordPerfEvent("longtask", entry.name || "longtask", entry.duration, {
          entryType: entry.entryType,
        });
      }
    });
    longTask.observe({ entryTypes: ["longtask"] });
  } catch {
    // WebKit without longtask: key latency + spans still cover the diagnosis.
  }
}
