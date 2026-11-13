import { describe, expect, it, vi } from "vitest";
import { createPdfRenderQueue, type PdfRenderJob } from "./pdfRenderQueue";

/** A deterministic clock: `advance` runs the timers the queue scheduled. */
function fakeClock(start = 0) {
  let t = start;
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  return {
    now: () => t,
    schedule: (run: () => void, delayMs: number) => {
      const timer = { at: t + delayMs, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    advance(ms: number) {
      t += ms;
      for (;;) {
        const due = timers
          .filter((timer) => !timer.cancelled && timer.at <= t)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) return;
        due.cancelled = true;
        due.run();
      }
    },
    pendingTimers: () => timers.filter((timer) => !timer.cancelled).length,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let the queue's promise chain (`.finally`) settle. */
async function flush() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

function job(key: number, started: number[], onScreen = () => false): PdfRenderJob {
  return {
    key,
    onScreen,
    run: async () => {
      started.push(key);
    },
  };
}

describe("pdfRenderQueue", () => {
  it("keeps exactly one render in flight", async () => {
    const clock = fakeClock();
    const queue = createPdfRenderQueue({ now: clock.now, schedule: clock.schedule });
    const started: number[] = [];
    const first = deferred();
    const second = deferred();

    queue.enqueue({
      key: 1,
      onScreen: () => false,
      run: async () => {
        started.push(1);
        await first.promise;
      },
    });
    queue.enqueue({
      key: 2,
      onScreen: () => false,
      run: async () => {
        started.push(2);
        await second.promise;
      },
    });

    expect(started).toEqual([1]);
    first.resolve();
    await flush();
    expect(started).toEqual([1, 2]);
    second.resolve();
    await flush();
  });

  it("only lets a visible page start while the reader is scrolling", async () => {
    const clock = fakeClock();
    const queue = createPdfRenderQueue({ now: clock.now, schedule: clock.schedule });
    const started: number[] = [];
    queue.noteScroll();

    queue.enqueue(job(1, started));
    expect(started).toEqual([]);

    // The page that is on screen does not wait for the scroll to end.
    queue.enqueue(job(2, started, () => true));
    await flush();
    expect(started).toEqual([2]);
    expect(clock.pendingTimers()).toBe(1);
  });

  it("drains the deferred pages once the scroll goes quiet", async () => {
    const clock = fakeClock();
    const queue = createPdfRenderQueue({ now: clock.now, schedule: clock.schedule });
    const started: number[] = [];
    queue.noteScroll();
    queue.enqueue(job(1, started));
    queue.enqueue(job(2, started));
    await flush();
    expect(started).toEqual([]);

    // Once the scroll is quiet the queue drains serially (in the reader each
    // render spans many frames, so the next one starts only after it ends).
    clock.advance(121);
    await flush();
    expect(started).toEqual([1, 2]);
  });

  it("replaces a queued job when the same page is queued again", async () => {
    const clock = fakeClock();
    const queue = createPdfRenderQueue({ now: clock.now, schedule: clock.schedule });
    const started: number[] = [];
    const blocker = deferred();

    queue.enqueue({
      key: 1,
      onScreen: () => false,
      run: async () => {
        started.push(1);
        await blocker.promise;
      },
    });
    // Two renders of page 2 while page 1 is running: only the newest counts.
    queue.enqueue(job(2, started));
    queue.enqueue(job(2, started));

    blocker.resolve();
    await flush();
    expect(started).toEqual([1, 2]);
  });

  it("drops a cancelled queued job", async () => {
    const clock = fakeClock();
    const queue = createPdfRenderQueue({ now: clock.now, schedule: clock.schedule });
    const started: number[] = [];
    const blocker = deferred();
    queue.enqueue({
      key: 1,
      onScreen: () => false,
      run: async () => {
        started.push(1);
        await blocker.promise;
      },
    });
    const handle = queue.enqueue(job(2, started));
    handle.cancel();
    blocker.resolve();
    await flush();
    expect(started).toEqual([1]);
  });

  it("aborts a running render when the page is released", async () => {
    const clock = fakeClock();
    const queue = createPdfRenderQueue({ now: clock.now, schedule: clock.schedule });
    const abort = vi.fn();
    const running = deferred();
    const handle = queue.enqueue({
      key: 1,
      onScreen: () => false,
      run: async (setAbort) => {
        setAbort(abort);
        await running.promise;
      },
    });
    handle.cancel();
    expect(abort).toHaveBeenCalledTimes(1);
    running.resolve();
    await flush();
  });

  it("aborts a task that registers its cancel after the release", async () => {
    const clock = fakeClock();
    const queue = createPdfRenderQueue({ now: clock.now, schedule: clock.schedule });
    const abort = vi.fn();
    const running = deferred();
    const handle = queue.enqueue({
      key: 1,
      onScreen: () => false,
      run: async (setAbort) => {
        await Promise.resolve();
        setAbort(abort);
        await running.promise;
      },
    });
    handle.cancel();
    await flush();
    expect(abort).toHaveBeenCalledTimes(1);
    running.resolve();
    await flush();
  });

  it("keeps going after a page render fails", async () => {
    const clock = fakeClock();
    const queue = createPdfRenderQueue({ now: clock.now, schedule: clock.schedule });
    const started: number[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    queue.enqueue({
      key: 1,
      onScreen: () => false,
      run: async () => {
        throw new Error("boom");
      },
    });
    queue.enqueue(job(2, started));
    await flush();
    expect(started).toEqual([2]);
    warn.mockRestore();
  });
});
