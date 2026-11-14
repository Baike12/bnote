import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sink's contract is "a bounded number of lines, written off the hot path,
 * never dropped because the vault was still restoring". The retry path is the
 * subtle part: a batch that failed must keep its place at the FRONT of the
 * buffer (it is the oldest and most valuable evidence), and the backoff must
 * grow to a cap instead of retrying in a tight loop.
 *
 * The module holds one listener and a module-level buffer, so each test loads
 * both modules fresh.
 */

const io = vi.hoisted(() => ({
  appendFile: vi.fn<(path: string, text: string) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/tauri", () => ({
  api: { appendFile: (...args: [string, string]) => io.appendFile(...args) },
}));

type Sink = typeof import("./sink");
type Trace = typeof import("./trace");
type Record_ = import("./trace").PerfRecord;

let sink: Sink;
let trace: Trace;

const VAULT = "/tmp/bnote-sink-test";

function localDay(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Every record written so far, parsed back from the JSONL. */
function written(): Record_[] {
  return io.appendFile.mock.calls
    .map((call) => call[1])
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record_);
}

/**
 * A fresh module pair with an installed sink. The level is set BEFORE the
 * listener exists, so the level-change event does not pollute the buffer; the
 * session header is the first buffered record and is cleared here so each test
 * asserts only its own records.
 */
async function freshModules(
  getVaultPath: () => string | null = () => VAULT,
  getContext: () => Record<string, unknown> = () => ({ note: "header" }),
): Promise<void> {
  vi.resetModules();
  trace = await import("./trace");
  sink = await import("./sink");
  trace.setPerfLevel("slow");
  trace.clearPerf();
  sink.installPerfSink({ getVaultPath, getContext });
  await sink.flushPerf();
  io.appendFile.mockClear();
}

beforeEach(async () => {
  vi.useFakeTimers();
  io.appendFile.mockReset();
  io.appendFile.mockResolvedValue(undefined);
  await freshModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("session header", () => {
  it("is a session record carrying the level and the host context", async () => {
    vi.resetModules();
    trace = await import("./trace");
    sink = await import("./sink");
    sink.installPerfSink({ getVaultPath: () => VAULT, getContext: () => ({ note: "header" }) });
    await sink.flushPerf();

    const header = written().find((r) => r.kind === "session");
    expect(header).toMatchObject({ kind: "session", data: { level: "slow", note: "header" } });
  });

  it("a throwing context provider cannot take the app down", async () => {
    vi.resetModules();
    trace = await import("./trace");
    sink = await import("./sink");
    sink.installPerfSink({
      getVaultPath: () => VAULT,
      getContext: () => {
        throw new Error("boom");
      },
    });
    await sink.flushPerf();

    const header = written().find((r) => r.kind === "session");
    expect(header?.data).toMatchObject({ level: expect.any(String) });
  });
});

describe("what is persisted", () => {
  it("writes into <vault>/.bnote/perf/editor-<day>.jsonl", async () => {
    trace.recordSpanMs(30, "slow.span");
    await sink.flushPerf();
    expect(io.appendFile.mock.calls[0]?.[0]).toBe(
      `${VAULT}/.bnote/perf/editor-${localDay()}.jsonl`,
    );
  });

  it("keeps a fast span only during a full trace and a slow one always", async () => {
    trace.setPerfLevel("full");
    trace.recordSpanMs(2, "fast.full");
    trace.setPerfLevel("slow");
    trace.recordSpanMs(2, "fast.slow");
    trace.recordSpanMs(30, "slow.span");
    await sink.flushPerf();

    const names = written().map((r) => r.name);
    expect(names).toContain("fast.full");
    expect(names).not.toContain("fast.slow");
    expect(names).toContain("slow.span");
  });

  it("keeps key, longtask and event records; drops frames below 50ms", async () => {
    trace.recordPerfEvent("key", "a", 80);
    trace.recordPerfEvent("longtask", "task", 200);
    trace.recordPerfEvent("frame", "fast-frame", 10);
    trace.recordPerfEvent("frame", "slow-frame", 60);
    await sink.flushPerf();

    const names = written().map((r) => r.name);
    expect(names).toEqual(["a", "task", "slow-frame"]);
  });

  it("writes one JSON object per line", async () => {
    trace.recordSpanMs(30, "a");
    trace.recordSpanMs(30, "b");
    await sink.flushPerf();

    const calls = io.appendFile.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1].trim().split("\n")).toHaveLength(2);
    expect(calls[0]?.[1].endsWith("\n")).toBe(true);
  });
});

describe("batching and backoff", () => {
  it("waits for the vault before writing and retries later", async () => {
    let vaultPath: string | null = null;
    await freshModules(() => vaultPath);

    trace.recordSpanMs(30, "held.span");
    await sink.flushPerf();
    expect(io.appendFile).not.toHaveBeenCalled();

    vaultPath = VAULT;
    await vi.advanceTimersByTimeAsync(3000);
    await sink.flushPerf();

    expect(written().map((r) => r.name)).toContain("held.span");
  });

  it("nothing buffered and no vault: no write is attempted", async () => {
    await freshModules(() => null);
    await sink.flushPerf();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(io.appendFile).not.toHaveBeenCalled();
  });

  it("retains a failed batch at the front and writes it on the next flush", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    io.appendFile.mockRejectedValueOnce(new Error("disk full"));

    trace.recordSpanMs(30, "retry.span");
    await sink.flushPerf();
    expect(io.appendFile).toHaveBeenCalledTimes(1);
    // The failed call is part of the mock history, so only the retry's text
    // counts as written evidence.
    io.appendFile.mockClear();

    io.appendFile.mockResolvedValue(undefined);
    await sink.flushPerf();
    expect(written().map((r) => r.name)).toEqual(["retry.span"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("reports a persistent write failure only once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    io.appendFile.mockRejectedValue(new Error("read-only"));

    trace.recordSpanMs(30, "span-1");
    await sink.flushPerf();
    trace.recordSpanMs(30, "span-2");
    await sink.flushPerf();
    await sink.flushPerf();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("flushing during a pending debounce cancels the timer and writes at once", async () => {
    trace.recordSpanMs(30, "debounced");
    await sink.flushPerf();
    expect(io.appendFile).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(io.appendFile).toHaveBeenCalledTimes(1);
  });

  it("the scheduled flush runs without an explicit call", async () => {
    trace.recordSpanMs(30, "scheduled");
    await vi.advanceTimersByTimeAsync(1500);
    expect(io.appendFile).toHaveBeenCalledTimes(1);
    expect(written().map((r) => r.name)).toContain("scheduled");
  });
});

describe("buffer bounds", () => {
  it("a batch larger than 200 records is written in follow-up batches", async () => {
    for (let i = 0; i < 205; i++) trace.recordPerfEvent("key", `k${i}`, 60);

    await sink.flushPerf();
    expect(written()).toHaveLength(200);

    await vi.advanceTimersByTimeAsync(1500);
    expect(written()).toHaveLength(205);
    expect(written()[204]?.name).toBe("k204");
  });

  it("the buffer never grows past 500 records while the vault is unavailable", async () => {
    await freshModules(() => null);
    trace.recordPerfEvent("key", "before", 60);
    for (let i = 0; i < 900; i++) trace.recordPerfEvent("key", `k${i}`, 60);

    // Nothing can be written yet, and the call itself must stay cheap.
    await sink.flushPerf();
    expect(io.appendFile).not.toHaveBeenCalled();

    // Once the vault appears the buffered head is written, bounded by the cap.
    await freshModules(() => VAULT);
    for (let i = 0; i < 900; i++) trace.recordPerfEvent("key", `j${i}`, 60);
    await sink.flushPerf();
    expect(written().length).toBeLessThanOrEqual(200);
    expect(written().map((r) => r.name)).not.toContain("before");
  });
});
