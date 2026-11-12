import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FocusStatus } from "@/lib/tauri";
import { createTimerState, remainingMs } from "./timer";
import { emptySchedule } from "./schedule";

/**
 * The native side (covering the window, the window level, the event tap) is a
 * fake implementation here: the layer this test locks down is the **promise
 * rules** - pressing start means the hard lock is armed, the exclusive lock is
 * taken and the timing starts, all at once; the locks are released only when the
 * stretch ran out; a failed start leaves no half state where the timer runs but
 * the lock is not on. The real window behaviour can only be verified in the real
 * app.
 */
const focusMock = vi.hoisted(() => ({
  status: vi.fn(async () => ({
    locked: false,
    hard_lock: false,
    hard_active: false,
    trusted: true,
    seen: 0,
    swallowed: 0,
  })),
  lock: vi.fn(async () => ({
    locked: true,
    hard_lock: false,
    hard_active: false,
    trusted: true,
    seen: 0,
    swallowed: 0,
  })),
  unlock: vi.fn(async () => ({
    locked: false,
    hard_lock: false,
    hard_active: false,
    trusted: true,
    seen: 0,
    swallowed: 0,
  })),
  setHardLock: vi.fn(async (enabled: boolean) => ({
    locked: false,
    hard_lock: enabled,
    hard_active: false,
    trusted: true,
    seen: 0,
    swallowed: 0,
  })),
  setHardLockActive: vi.fn(async (active: boolean) => ({
    locked: false,
    hard_lock: true,
    hard_active: active,
    trusted: true,
    seen: 0,
    swallowed: 0,
  })),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    // Persisting has no IPC in the node environment: use an empty implementation
    // so the test does not spam a screen of warnings.
    api: { ...actual.api, saveAppConfig: async () => {} },
    focusApi: focusMock,
  };
});

const { useFocusStore } = await import("./store");

const T0 = 1_700_000_000_000;

function resetMocks() {
  focusMock.status.mockReset();
  focusMock.lock.mockReset();
  focusMock.unlock.mockReset();
  focusMock.setHardLock.mockReset();
  focusMock.setHardLockActive.mockReset();

  focusMock.status.mockResolvedValue({
    locked: false,
    hard_lock: false,
    hard_active: false,
    trusted: true,
    seen: 0,
    swallowed: 0,
  });
  focusMock.lock.mockResolvedValue({
    locked: true,
    hard_lock: false,
    hard_active: false,
    trusted: true,
    seen: 0,
    swallowed: 0,
  });
  focusMock.unlock.mockResolvedValue({
    locked: false,
    hard_lock: false,
    hard_active: false,
    trusted: true,
    seen: 0,
    swallowed: 0,
  });
  focusMock.setHardLock.mockImplementation(async (enabled: boolean) => ({
    locked: false,
    hard_lock: enabled,
    hard_active: false,
    trusted: true,
    seen: 0,
    swallowed: 0,
  }));
  focusMock.setHardLockActive.mockImplementation(async (active: boolean) => ({
    locked: false,
    hard_lock: true,
    hard_active: active,
    trusted: true,
    seen: 0,
    swallowed: 0,
  }));
}

function resetStore() {
  useFocusStore.setState({
    timer: createTimerState(),
    schedule: emptySchedule(),
    now: T0,
    locked: false,
    hardLock: false,
    hardActive: false,
    pendingHardLock: false,
    trusted: true,
    seen: 0,
    swallowed: 0,
    error: null,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetMocks();
  resetStore();
});

afterEach(async () => {
  // Let a stretch that may still be running finish: applyTimer(stop) clears the
  // internal tick handle, otherwise the next case would inherit a timer of the
  // previous fake clock that never fires.
  vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
  await vi.advanceTimersByTimeAsync(2_000);
  vi.useRealTimers();
});

describe("start is a promise: hard lock + exclusive lock + timing all take effect together", () => {
  it("pressing start arms the hard lock first, then starts the timer and takes the lock", async () => {
    await useFocusStore.getState().start();

    expect(focusMock.setHardLock).toHaveBeenCalledWith(true);
    expect(focusMock.lock).toHaveBeenCalledTimes(1);
    expect(useFocusStore.getState().timer.phase).toBe("focus");
    expect(useFocusStore.getState().timer.endsAt).toBe(T0 + 25 * 60_000);
    expect(useFocusStore.getState().locked).toBe(true);
    expect(useFocusStore.getState().hardActive).toBe(true);

    // Order: the hard lock first, then the timer and the screen lock (there must
    // never be a "timer runs but ⌘Tab is not blocked" state).
    const arm = focusMock.setHardLock.mock.invocationCallOrder[0];
    const lock = focusMock.lock.mock.invocationCallOrder[0];
    expect(arm).toBeLessThan(lock);
  });

  it("starting again is a no-op: it does not restart and does not call the native lock a second time", async () => {
    await useFocusStore.getState().start();
    const endsAt = useFocusStore.getState().timer.endsAt;
    await useFocusStore.getState().start();
    expect(useFocusStore.getState().timer.endsAt).toBe(endsAt);
    expect(focusMock.lock).toHaveBeenCalledTimes(1);
    expect(focusMock.setHardLock).toHaveBeenCalledTimes(1);
  });

  it("the clicked duration decides the length: start(90) runs 90 minutes, not the first configured one", async () => {
    useFocusStore.setState({
      timer: createTimerState({ focusDurations: [25, 50, 90] }),
    });
    await useFocusStore.getState().start(90);

    expect(useFocusStore.getState().timer.endsAt).toBe(T0 + 90 * 60_000);
    expect(remainingMs(useFocusStore.getState().timer, T0)).toBe(90 * 60_000);
    // The offered list is untouched: it only describes what the chips show.
    expect(useFocusStore.getState().timer.config.focusDurations).toEqual([25, 50, 90]);
  });

  it("the hard lock has no permission: the stretch does not start at all (no self-deception)", async () => {
    focusMock.setHardLock.mockRejectedValueOnce(
      new Error("NEEDS_ACCESSIBILITY: 硬锁需要辅助功能权限"),
    );
    await useFocusStore.getState().start();

    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(useFocusStore.getState().timer.endsAt).toBeNull();
    expect(focusMock.lock).not.toHaveBeenCalled();
    expect(useFocusStore.getState().pendingHardLock).toBe(true);
    expect(useFocusStore.getState().hardActive).toBe(false);
  });

  it("the hard lock was armed but the tap did not come up: the stretch does not start either", async () => {
    focusMock.setHardLockActive.mockResolvedValueOnce({
      locked: false,
      hard_lock: true,
      hard_active: false,
      trusted: true,
      seen: 0,
      swallowed: 0,
    });
    await useFocusStore.getState().start();

    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(useFocusStore.getState().hardActive).toBe(false);
    expect(focusMock.lock).not.toHaveBeenCalled();
  });

  it("taking the lock fails: the stretch is taken back, the hard lock stops as well", async () => {
    focusMock.lock.mockRejectedValueOnce(new Error("LOCK_FAILED: 进不了锁"));
    await useFocusStore.getState().start();

    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(useFocusStore.getState().timer.endsAt).toBeNull();
    expect(useFocusStore.getState().locked).toBe(false);
    expect(useFocusStore.getState().hardActive).toBe(false);
    expect(focusMock.setHardLockActive).toHaveBeenLastCalledWith(false);
  });

  it("there is no way out halfway: the actions pause / stop / exitLock no longer exist", () => {
    const api = useFocusStore.getState() as unknown as Record<string, unknown>;
    for (const gone of ["pause", "stop", "enterLock", "exitLock", "toggleLock", "setHardLock"]) {
      expect(api[gone], gone).toBeUndefined();
    }
  });

  it("changing the duration only affects the next stretch: the running endsAt does not move", async () => {
    await useFocusStore.getState().start();
    const endsAt = useFocusStore.getState().timer.endsAt;
    useFocusStore.getState().setDurations({ focusDurations: [40] });
    expect(useFocusStore.getState().timer.endsAt).toBe(endsAt);
    expect(useFocusStore.getState().timer.config.focusDurations).toEqual([40]);
  });
});

describe("wrapping up at the deadline: disarm the hard lock first, then release the lock", () => {
  it("after 25 minutes → idle + unlock + stop intercepting", async () => {
    await useFocusStore.getState().start();
    await vi.advanceTimersByTimeAsync(25 * 60_000 + 1000);

    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(useFocusStore.getState().timer.endsAt).toBeNull();
    expect(useFocusStore.getState().locked).toBe(false);
    expect(useFocusStore.getState().hardActive).toBe(false);
    expect(focusMock.unlock).toHaveBeenCalledTimes(1);
    expect(focusMock.setHardLockActive).toHaveBeenLastCalledWith(false);

    // Stop intercepting first, then release the screen lock (the other order
    // would leave a window between the two native calls).
    const order = focusMock.setHardLockActive.mock.invocationCallOrder;
    const disarm = order[order.length - 1];
    const unlock = focusMock.unlock.mock.invocationCallOrder[0];
    expect(disarm).toBeLessThan(unlock);
  });

  it("no automatic next stretch", async () => {
    await useFocusStore.getState().start();
    await vi.advanceTimersByTimeAsync(25 * 60_000 + 1000);
    expect(focusMock.lock).toHaveBeenCalledTimes(1);
    expect(useFocusStore.getState().timer.phase).toBe("idle");
  });
});

describe("the countdown is running", () => {
  it("after 3 seconds: now advances, the remaining time shrinks by 3 seconds", async () => {
    await useFocusStore.getState().start();
    const before = remainingMs(useFocusStore.getState().timer, useFocusStore.getState().now);
    expect(before).toBe(25 * 60_000);

    await vi.advanceTimersByTimeAsync(3000);
    const after = remainingMs(useFocusStore.getState().timer, useFocusStore.getState().now);
    expect(useFocusStore.getState().now).toBe(T0 + 3000);
    expect(before - after).toBe(3000);
  });

  it("the window is suspended for a long time and comes back (reconciliation): it follows the real clock, not the number of ticks", async () => {
    await useFocusStore.getState().start();
    vi.setSystemTime(T0 + 10 * 60_000);
    useFocusStore.getState().syncNow();
    const { timer, now } = useFocusStore.getState();
    expect(now).toBe(T0 + 10 * 60_000);
    expect(remainingMs(timer, now)).toBe(15 * 60_000);
  });

  it("the reconciliation finds the deadline already passed: it wraps up right away", async () => {
    await useFocusStore.getState().start();
    vi.setSystemTime(T0 + 30 * 60_000);
    useFocusStore.getState().syncNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(useFocusStore.getState().locked).toBe(false);
  });
});

describe("scheduled blocks: an absolute deadline and an append-only week", () => {
  it("startScheduled ends on the block's deadline rather than now + a configured duration", async () => {
    await useFocusStore.getState().startScheduled(T0 + 50 * 60_000);

    expect(useFocusStore.getState().timer.phase).toBe("focus");
    expect(useFocusStore.getState().timer.endsAt).toBe(T0 + 50 * 60_000);
    expect(focusMock.lock).toHaveBeenCalledTimes(1);
    expect(useFocusStore.getState().hardActive).toBe(true);
  });

  it("a window that is already over arms nothing: no lock, no timer", async () => {
    await useFocusStore.getState().startScheduled(T0);

    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(focusMock.setHardLock).not.toHaveBeenCalled();
    expect(focusMock.lock).not.toHaveBeenCalled();
  });

  it("saving unions the cells and reports only the newly added blocks", () => {
    const day = "2026-11-07";
    expect(
      useFocusStore.getState().saveSchedule([
        { day, hour: 9 },
        { day, hour: 10 },
      ]),
    ).toBe(2);
    expect(useFocusStore.getState().schedule).toEqual({ days: { [day]: [9, 10] } });

    // Saving an overlapping selection can only add: there is no removal path.
    expect(
      useFocusStore.getState().saveSchedule([
        { day, hour: 10 },
        { day, hour: 11 },
      ]),
    ).toBe(1);
    expect(useFocusStore.getState().schedule).toEqual({ days: { [day]: [9, 10, 11] } });
  });

  it("restoring reads the persisted week and drops malformed entries", async () => {
    await useFocusStore
      .getState()
      .restore(undefined, { days: { "2026-11-07": [9, 9, 24], "not-a-date": [7] } });
    expect(useFocusStore.getState().schedule).toEqual({ days: { "2026-11-07": [9] } });
  });
});

describe("across a restart: quitting the app does not end the stretch", () => {
  it("restoring a still running stretch: the timing continues, both locks are attached again", async () => {
    const saved = { ...createTimerState(), phase: "focus" as const, endsAt: T0 + 10 * 60_000 };
    await useFocusStore.getState().restore(saved);

    expect(useFocusStore.getState().timer.endsAt).toBe(T0 + 10 * 60_000);
    expect(focusMock.lock).toHaveBeenCalledTimes(1);
    expect(focusMock.setHardLock).toHaveBeenCalledWith(true);
    expect(useFocusStore.getState().locked).toBe(true);
    expect(useFocusStore.getState().hardActive).toBe(true);
  });

  it("the restore finds the stretch already at the deadline: it wraps up immediately, it does not restart", async () => {
    const saved = { ...createTimerState(), phase: "focus" as const, endsAt: T0 - 1000 };
    await useFocusStore.getState().restore(saved);
    await vi.advanceTimersByTimeAsync(0);

    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(focusMock.lock).not.toHaveBeenCalled();
  });

  it("a break phase state from the old version is read back as idle (there is no break phase concept anymore)", async () => {
    const legacy = {
      phase: "break",
      endsAt: T0 + 5 * 60_000,
      cycle: 3,
      config: { focusMinutes: 30, breakMinutes: 5 },
    } as unknown as ReturnType<typeof createTimerState>;
    await useFocusStore.getState().restore(legacy);

    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(useFocusStore.getState().timer.endsAt).toBeNull();
    // The duration must not be thrown off by the old fields
    expect(useFocusStore.getState().timer.config.focusDurations).toEqual([30]);
  });

  it("a paused phase from the old version (without endsAt) is read back as idle: pausing has no meaning anymore", async () => {
    const legacy = {
      phase: "focus",
      endsAt: null,
      pausedRemaining: 10 * 60_000,
      config: { focusMinutes: 25 },
    } as unknown as ReturnType<typeof createTimerState>;
    await useFocusStore.getState().restore(legacy);
    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(focusMock.lock).not.toHaveBeenCalled();
  });
});

describe("reconciliation with the native state (leftover from a crash)", () => {
  it("idle but still locked: refreshStatus releases the window", async () => {
    useFocusStore.setState({ locked: true });
    focusMock.status.mockResolvedValueOnce({
      locked: true,
      hard_lock: false,
      hard_active: false,
      trusted: true,
      seen: 0,
      swallowed: 0,
    });
    await useFocusStore.getState().refreshStatus();
    expect(focusMock.unlock).toHaveBeenCalledTimes(1);
    expect(useFocusStore.getState().locked).toBe(false);
  });

  it("a session is running but the lock / hard lock was lost: refreshStatus puts it back", async () => {
    useFocusStore.setState({
      timer: { ...createTimerState(), phase: "focus", endsAt: T0 + 60_000 },
      locked: false,
      hardLock: false,
    });
    await useFocusStore.getState().refreshStatus();
    expect(focusMock.lock).toHaveBeenCalledTimes(1);
    expect(focusMock.setHardLock).toHaveBeenCalledWith(true);
    expect(useFocusStore.getState().hardActive).toBe(true);
  });
});

describe("unlocking follows the native side, the front-end flag does not block it", () => {
  it("at the deadline locked was already cleared by a stale reconciliation, the native unlock is still called", async () => {
    await useFocusStore.getState().start();
    // A stale reconciliation cleared the flag while the stretch was running.
    useFocusStore.setState({ locked: false });

    vi.setSystemTime(T0 + 26 * 60_000);
    useFocusStore.getState().syncNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(focusMock.unlock).toHaveBeenCalled();
    expect(useFocusStore.getState().locked).toBe(false);
    expect(useFocusStore.getState().timer.phase).toBe("idle");
  });

  it("the idle reconciliation trusts the native read: a window that already reports normal is not released again", async () => {
    // The window is normal on the native side. Releasing it again would re-run
    // the whole restore (level, collection behavior, responder) right after
    // the session end restored it; the end of a stretch has to stay silent, so
    // a stale `locked` flag in the store must not cause a second restore.
    useFocusStore.setState({ locked: true });
    focusMock.status.mockResolvedValueOnce({
      locked: false,
      hard_lock: false,
      hard_active: false,
      trusted: true,
      seen: 0,
      swallowed: 0,
    });

    await useFocusStore.getState().refreshStatus();

    expect(focusMock.unlock).not.toHaveBeenCalled();
    expect(useFocusStore.getState().locked).toBe(false);
  });

  it("a failed release is retried on the next reconciliation", async () => {
    focusMock.status.mockResolvedValueOnce({
      locked: true,
      hard_lock: false,
      hard_active: false,
      trusted: true,
      seen: 0,
      swallowed: 0,
    });
    focusMock.unlock.mockRejectedValueOnce(new Error("MAIN_THREAD_TIMEOUT: busy"));

    await useFocusStore.getState().refreshStatus();
    expect(focusMock.unlock).toHaveBeenCalledTimes(1);

    // The native read now says normal, but the failed release means the
    // geometry was never restored: the next reconciliation retries it.
    await useFocusStore.getState().refreshStatus();
    expect(focusMock.unlock).toHaveBeenCalledTimes(2);
  });

  it("a stale reconciliation result is not written back: no repeated lock / arm", async () => {
    let release!: (status: FocusStatus) => void;
    const stale = new Promise<FocusStatus>((resolve) => {
      release = resolve;
    });
    focusMock.status.mockReturnValueOnce(stale);

    const refreshing = useFocusStore.getState().refreshStatus();
    await useFocusStore.getState().start();
    const lockCalls = focusMock.lock.mock.calls.length;

    release({
      locked: false,
      hard_lock: false,
      hard_active: false,
      trusted: true,
      seen: 0,
      swallowed: 0,
    });
    await refreshing;

    expect(focusMock.lock.mock.calls.length).toBe(lockCalls);
    expect(useFocusStore.getState().locked).toBe(true);
  });
});
