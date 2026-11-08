import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayKey } from "./schedule";
import { createTimerState } from "./timer";

/**
 * The scheduler is the only automatic start path. The native side is faked
 * here; what is locked down is the clock rule: the open block starts a stretch
 * that ends at its own :50, the ten-minute break starts nothing, and a stretch
 * that is already running (or a block that was already observed) is not
 * replaced by a late start.
 */
const focusMock = vi.hoisted(() => ({
  status: vi.fn(),
  lock: vi.fn(),
  unlock: vi.fn(),
  setHardLock: vi.fn(),
  setHardLockActive: vi.fn(),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    api: { ...actual.api, saveAppConfig: async () => {} },
    focusApi: focusMock,
  };
});

const { useFocusStore } = await import("./store");
const { installFocusScheduler } = await import("./scheduler");

/** 09:00:05 local: the tick fires after the block's start, inside its window. */
const START = new Date(2026, 10, 7, 9, 0, 5).getTime();
const DAY = dayKey(new Date(START));

function at(hour: number, minute = 0): number {
  return new Date(2026, 10, 7, hour, minute, 0).getTime();
}

let stop: (() => void) | null = null;

function resetMocks() {
  focusMock.status.mockReset();
  focusMock.lock.mockReset();
  focusMock.unlock.mockReset();
  focusMock.setHardLock.mockReset();
  focusMock.setHardLockActive.mockReset();

  const status = (locked: boolean, hardLock: boolean, hardActive: boolean) => ({
    locked,
    hard_lock: hardLock,
    hard_active: hardActive,
    trusted: true,
    seen: 0,
    swallowed: 0,
  });
  focusMock.status.mockResolvedValue(status(false, false, false));
  focusMock.lock.mockResolvedValue(status(true, false, false));
  focusMock.unlock.mockResolvedValue(status(false, false, false));
  focusMock.setHardLock.mockImplementation(async (enabled: boolean) =>
    status(false, enabled, false),
  );
  focusMock.setHardLockActive.mockImplementation(async (active: boolean) =>
    status(false, true, active),
  );
}

function resetStore() {
  useFocusStore.setState({
    timer: createTimerState(),
    schedule: { days: { [DAY]: [9] } },
    now: START,
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
  vi.setSystemTime(START);
  resetMocks();
  resetStore();
});

afterEach(async () => {
  stop?.();
  stop = null;
  // Let the store's own expiry tick release a stretch that is still running;
  // otherwise the next case inherits a chain from the previous fake clock.
  vi.setSystemTime(at(23));
  await vi.advanceTimersByTimeAsync(2_000);
  vi.useRealTimers();
});

describe("scheduled focus", () => {
  it("starts the open block and ends the stretch at the block's :50", async () => {
    stop = installFocusScheduler();
    await vi.advanceTimersByTimeAsync(1_500);

    const timer = useFocusStore.getState().timer;
    expect(timer.phase).toBe("focus");
    expect(timer.endsAt).toBe(at(9, 50));
    expect(focusMock.setHardLock).toHaveBeenCalledWith(true);
    expect(focusMock.lock).toHaveBeenCalledTimes(1);
    expect(useFocusStore.getState().hardActive).toBe(true);
  });

  it("starts nothing during the ten-minute break", async () => {
    vi.setSystemTime(at(9, 55));
    useFocusStore.setState({ now: Date.now() });

    stop = installFocusScheduler();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(focusMock.setHardLock).not.toHaveBeenCalled();
    expect(focusMock.lock).not.toHaveBeenCalled();
  });

  it("does not queue a late start after a manual stretch covered the block", async () => {
    // A manual 25-minute stretch starting at 09:00:05: it is the focus for that
    // hour, and when it ends at 09:25 the scheduler must not start 25 minutes
    // into the block.
    await useFocusStore.getState().start(25);
    stop = installFocusScheduler();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(focusMock.lock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(at(9, 26));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(focusMock.lock).toHaveBeenCalledTimes(1);
    expect(focusMock.unlock).toHaveBeenCalled();
  });

  it("a failed start is not retried on every tick", async () => {
    // Arming succeeds but the tap never really intercepts: the stretch is
    // rolled back, and the block is still observed only once - otherwise the
    // user would get the same toast every second.
    focusMock.setHardLockActive.mockResolvedValue({
      locked: false,
      hard_lock: true,
      hard_active: false,
      trusted: true,
      seen: 0,
      swallowed: 0,
    });

    stop = installFocusScheduler();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(focusMock.setHardLock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(focusMock.setHardLock).toHaveBeenCalledTimes(1);
    expect(focusMock.lock).not.toHaveBeenCalled();
  });
});
