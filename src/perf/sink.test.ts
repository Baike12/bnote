import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { appendFile } = vi.hoisted(() => ({
  appendFile: vi.fn<(path: string, text: string) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/tauri", () => ({ api: { appendFile } }));

import { flushPerf, installPerfSink } from "./sink";
import { clearPerf, recordSpanMs, setPerfLevel } from "./trace";

const VAULT = "/tmp/bnote-perf-test";

beforeAll(async () => {
  // One sink per process: installPerfSink registers a record listener.
  installPerfSink({ getVaultPath: () => VAULT, getContext: () => ({}) });
  await flushPerf(); // The session header.
});

beforeEach(() => {
  vi.useFakeTimers();
  appendFile.mockReset();
  appendFile.mockResolvedValue(undefined);
  clearPerf();
  setPerfLevel("slow");
  appendFile.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("perf sink: what reaches the JSONL", () => {
  it("keeps a fast span only when it was recorded during a full trace", async () => {
    setPerfLevel("full");
    recordSpanMs(2, "fast.full");
    setPerfLevel("slow");
    recordSpanMs(2, "fast.slow"); // Below the slow threshold and not full.
    recordSpanMs(30, "slow.span");
    await flushPerf();
    const text = appendFile.mock.calls.map((call) => call[1]).join("");
    expect(text).toContain("fast.full");
    expect(text).not.toContain("fast.slow");
    expect(text).toContain("slow.span");
    expect(appendFile.mock.calls[0][0]).toBe(`${VAULT}/.bnote/perf/editor-${localDay()}.jsonl`);
  });

  it("retains a failed batch and writes it on the next flush", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    appendFile.mockRejectedValueOnce(new Error("disk full"));
    recordSpanMs(30, "retry.span");
    await flushPerf();
    expect(appendFile).toHaveBeenCalledTimes(1);
    await flushPerf();
    const text = appendFile.mock.calls.map((call) => call[1]).join("");
    expect(text).toContain("retry.span");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

function localDay(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
