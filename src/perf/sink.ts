/**
 * Persistence for the editor tracer: an append-only JSONL file under
 * `<vault>/.bnote/perf/`, flushed in batches off the keystroke path.
 *
 * What is written (bounded, so a long session cannot fill the disk):
 * - `session`: once per launch — user agent, settings snapshot, level;
 * - `key`: a keydown whose keydown→paint time crossed SLOW_KEY_MS (or every
 *   key while full tracing is on), with the spans that made up the update;
 * - `longtask`: a browser-reported main-thread block, with the recent spans;
 * - `span`: only spans at/above SLOW_SPAN_MS (a slow KaTeX render, a
 *   full-document scan);
 * - `event`: level changes.
 *
 * The hot path only appends to an array; the IPC write happens 1.5s later and
 * failures are reported once (a missing vault or a read-only folder must not
 * turn into a per-keystroke warning).
 */
import { api } from "@/lib/tauri";
import { onPerfRecord, perfLevel, SLOW_SPAN_MS, type PerfRecord } from "./trace";

export interface PerfHost {
  /** The open vault (null before startup finishes / in tests). */
  getVaultPath: () => string | null;
  /** A settings/platform snapshot for the session header. */
  getContext: () => Record<string, unknown>;
}

let host: PerfHost | null = null;
const buffer: PerfRecord[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let warned = false;

const FLUSH_DELAY_MS = 1500;
const MAX_RETRY_DELAY_MS = 60_000;
const FLUSH_BATCH = 200;
const BUFFER_CAP = 500;
let retryDelay = FLUSH_DELAY_MS;

export function installPerfSink(h: PerfHost): void {
  host = h;
  onPerfRecord(queuePerfRecord);
  emitSession();
}

function shouldPersist(record: PerfRecord): boolean {
  switch (record.kind) {
    case "session":
    case "event":
    case "key":
    case "longtask":
      return true;
    case "span":
      // A full trace promises every span, including the fast ones.
      return record.full === true || (record.ms ?? 0) >= SLOW_SPAN_MS;
    case "frame":
      return (record.ms ?? 0) >= 50;
    default:
      return false;
  }
}

export function queuePerfRecord(record: PerfRecord): void {
  if (!shouldPersist(record)) return;
  buffer.push(record);
  if (buffer.length > BUFFER_CAP) buffer.splice(0, buffer.length - BUFFER_CAP);
  scheduleFlush();
}

function scheduleFlush(delay = FLUSH_DELAY_MS): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPerf();
  }, delay);
}

/** Flush immediately (tests / a deliberate report export). */
export async function flushPerf(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const current = host;
  if (!current) return;
  const vaultPath = current.getVaultPath();
  if (!vaultPath) {
    // Startup: the vault is still restoring. Keep the records and retry with
    // the same backoff, or a quiet session never persists even its header.
    if (buffer.length > 0) {
      retryDelay = Math.min(MAX_RETRY_DELAY_MS, retryDelay * 2);
      scheduleFlush(retryDelay);
    }
    return;
  }
  if (buffer.length === 0) return;

  const batch = buffer.splice(0, FLUSH_BATCH);
  if (buffer.length > 0) scheduleFlush();
  const day = localDay();
  const path = `${vaultPath}/.bnote/perf/editor-${day}.jsonl`;
  const text = batch.map((record) => JSON.stringify(record)).join("\n") + "\n";
  try {
    await api.appendFile(path, text);
    retryDelay = FLUSH_DELAY_MS;
  } catch (e) {
    // Keep the batch (bounded by BUFFER_CAP) and retry with backoff: the
    // session header and the first slow key are exactly the evidence a later
    // diagnosis needs, so a transient failure must not drop them. Trim from
    // the END instead of the front: the retried batch is the oldest (and most
    // valuable) part of the buffer.
    buffer.unshift(...batch);
    if (buffer.length > BUFFER_CAP) buffer.length = BUFFER_CAP;
    if (!warned) {
      warned = true;
      console.warn("[bnote] performance log write failed", e);
    }
    retryDelay = Math.min(MAX_RETRY_DELAY_MS, retryDelay * 2);
    scheduleFlush(retryDelay);
  }
}

function localDay(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emitSession(): void {
  if (!host) return;
  let context: Record<string, unknown> = {};
  try {
    context = host.getContext();
  } catch {
    // The session header must never take the app down.
  }
  queuePerfRecord({
    t: Date.now(),
    kind: "session",
    data: {
      level: perfLevel(),
      ua: typeof navigator === "undefined" ? "" : navigator.userAgent,
      ...context,
    },
  });
}
