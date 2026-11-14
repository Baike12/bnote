import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The performance entry point wires the sink, the observers and the debugging
 * surface together. The contract that matters: installing it publishes
 * `window.__bnotePerf` with working verbs, and the "start" verb is a bounded
 * trace rather than an open one (nobody should be able to leave full tracing
 * on by accident).
 */

const harness = vi.hoisted(() => ({
  installPerfSink: vi.fn(),
  flushPerf: vi.fn(async () => {}),
  installPerfObservers: vi.fn(),
}));

vi.mock("./sink", () => ({
  installPerfSink: harness.installPerfSink,
  flushPerf: harness.flushPerf,
}));

vi.mock("./editorProbe", () => ({ editorPerfProbe: () => [] }));

vi.mock("./trace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./trace")>();
  return { ...actual, installPerfObservers: harness.installPerfObservers };
});

import { installPerf } from "./index";
import { perfLevel, setPerfLevel, stopFullTrace } from "./trace";

const host = { getVaultPath: () => null, getContext: () => ({}) };

function perfApi() {
  return (globalThis as { window?: { __bnotePerf?: Record<string, unknown> } }).window
    ?.__bnotePerf as Record<string, (...args: never[]) => unknown> & Record<string, unknown>;
}

beforeEach(() => {
  vi.stubGlobal("window", {});
  harness.installPerfSink.mockClear();
  harness.installPerfObservers.mockClear();
  setPerfLevel("slow");
});

afterEach(() => {
  stopFullTrace();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("installPerf", () => {
  it("installs the sink and the observers, then publishes the debugging surface", () => {
    installPerf(host);

    expect(harness.installPerfSink).toHaveBeenCalledWith(host);
    expect(harness.installPerfObservers).toHaveBeenCalledTimes(1);
    const api = perfApi();
    expect(Object.keys(api).sort()).toEqual(
      ["clear", "events", "flush", "level", "report", "start", "stats", "stop"].sort(),
    );
  });

  it("start() begins a bounded full trace and stop() ends it", () => {
    installPerf(host);
    const api = perfApi();

    api.start();
    expect(perfLevel()).toBe("full");

    api.stop();
    expect(perfLevel()).toBe("slow");
  });

  it("level() reflects the current level", () => {
    installPerf(host);
    expect(perfApi().level()).toBe("slow");
  });

  it("the flushing verb reaches the sink", async () => {
    installPerf(host);
    await perfApi().flush();
    expect(harness.flushPerf).toHaveBeenCalledTimes(1);
  });
});
