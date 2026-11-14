import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Window-geometry memory, the tracking half: the write path is debounced,
 * ignores a minimized/fullscreen window, and refuses to record the size the
 * screen lock forces onto the window (that size is not the one the user wants
 * restored on the next launch). The pure normalization rules live in the same
 * file above and are covered by the same suite.
 */

const tauri = vi.hoisted(() => ({
  failCurrentWindow: false,
  minimized: false,
  maximized: false,
  fullscreen: false,
  width: 1280,
  height: 820,
  x: 100,
  y: 80,
  resized: [] as (() => void)[],
  moved: [] as (() => void)[],
  offCalls: 0,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => {
    if (tauri.failCurrentWindow) throw new Error("no tauri runtime");
    return {
      isMinimized: async () => tauri.minimized,
      isMaximized: async () => tauri.maximized,
      isFullscreen: async () => tauri.fullscreen,
      scaleFactor: async () => 2,
      innerSize: async () => ({
        toLogical: () => ({ width: tauri.width, height: tauri.height }),
      }),
      outerPosition: async () => ({
        toLogical: () => ({ x: tauri.x, y: tauri.y }),
      }),
      onResized: async (cb: () => void) => {
        tauri.resized.push(cb);
        return () => {
          tauri.offCalls++;
        };
      },
      onMoved: async (cb: () => void) => {
        tauri.moved.push(cb);
        return () => {
          tauri.offCalls++;
        };
      },
    };
  },
}));

const config = vi.hoisted(() => ({
  snapshot: {} as Record<string, unknown>,
  writes: [] as Record<string, unknown>[],
}));
vi.mock("@/state/appStore", () => ({
  getConfigSnapshot: () => config.snapshot,
  persistConfig: (next: Record<string, unknown>) => {
    config.snapshot = next;
    config.writes.push(next);
  },
}));

const focus = vi.hoisted(() => ({ locked: false }));
vi.mock("@/focus/store", () => ({
  useFocusStore: { getState: () => ({ locked: focus.locked }) },
}));

import {
  MIN_WINDOW_H,
  MIN_WINDOW_W,
  mergeWindowState,
  normalizeWindowState,
  trackWindowState,
} from "./windowState";

beforeEach(() => {
  vi.useFakeTimers();
  tauri.failCurrentWindow = false;
  tauri.minimized = false;
  tauri.maximized = false;
  tauri.fullscreen = false;
  tauri.width = 1280;
  tauri.height = 820;
  tauri.x = 100;
  tauri.y = 80;
  tauri.resized = [];
  tauri.moved = [];
  tauri.offCalls = 0;
  config.snapshot = {};
  config.writes = [];
  focus.locked = false;
});

describe("window geometry", () => {
  it("an old config or bad values are dropped entirely", () => {
    expect(normalizeWindowState(null)).toBeNull();
    expect(normalizeWindowState({})).toBeNull();
    expect(normalizeWindowState({ x: 1, y: 2, width: 800 })).toBeNull();
    expect(normalizeWindowState({ x: Number.NaN, y: 2, width: 800, height: 600 })).toBeNull();
    expect(normalizeWindowState("1280x820")).toBeNull();
  });

  it("the size is clamped to the minimum and rounded, the position is kept as is", () => {
    const state = normalizeWindowState({ x: 12.4, y: -30.6, width: 100, height: 100 });
    expect(state).toEqual({
      x: 12,
      y: -31,
      width: MIN_WINDOW_W,
      height: MIN_WINDOW_H,
      maximized: false,
    });
  });

  it("maximizing keeps the previous normal size and only flips maximized", () => {
    const prev = { x: 100, y: 80, width: 1280, height: 820, maximized: false };
    const maximized = mergeWindowState(prev, { x: 0, y: 25, width: 3456, height: 1080 }, true);
    expect(maximized).toEqual({ ...prev, maximized: true });
    // Un-maximizing returns to the real window size
    expect(mergeWindowState(maximized, { x: 120, y: 90, width: 1000, height: 700 }, false)).toEqual(
      {
        x: 120,
        y: 90,
        width: 1000,
        height: 700,
        maximized: false,
      },
    );
  });

  it("without a previous value, maximizing still records a size as a fallback", () => {
    const state = mergeWindowState(null, { x: 0, y: 25, width: 3456, height: 1080 }, true);
    expect(state).toEqual({ x: 0, y: 25, width: 3456, height: 1080, maximized: true });
  });

  it("the maximized flag is only true for the literal boolean, never for a truthy value", () => {
    expect(
      normalizeWindowState({ x: 0, y: 0, width: 800, height: 600, maximized: 1 }),
    ).toMatchObject({ maximized: false });
    expect(
      normalizeWindowState({ x: 0, y: 0, width: 800, height: 600, maximized: "yes" }),
    ).toMatchObject({ maximized: false });
  });
});

describe("trackWindowState", () => {
  it("records the geometry once on first launch, after the debounce", async () => {
    trackWindowState();
    await vi.advanceTimersByTimeAsync(150);

    expect(config.writes).toEqual([
      { window: { x: 100, y: 80, width: 1280, height: 820, maximized: false } },
    ]);
  });

  it("does not record on first launch when a saved geometry already exists", async () => {
    config.snapshot = { window: { x: 1, y: 2, width: 800, height: 600, maximized: false } };
    trackWindowState();
    await vi.advanceTimersByTimeAsync(500);
    expect(config.writes).toEqual([]);
  });

  it("coalesces a burst of move/resize events into one write", async () => {
    config.snapshot = { window: { x: 1, y: 2, width: 800, height: 600, maximized: false } };
    trackWindowState();
    await vi.advanceTimersByTimeAsync(10);
    expect(tauri.resized).toHaveLength(1);
    expect(tauri.moved).toHaveLength(1);

    tauri.width = 1400;
    tauri.resized[0]?.();
    tauri.width = 1500;
    tauri.resized[0]?.();
    tauri.x = 40;
    tauri.moved[0]?.();
    await vi.advanceTimersByTimeAsync(150);

    expect(config.writes).toHaveLength(1);
    expect(config.writes[0]).toMatchObject({ window: { width: 1500, x: 40 } });
  });

  it("skips a minimized, fullscreen or screen-locked window", async () => {
    config.snapshot = { window: { x: 1, y: 2, width: 800, height: 600, maximized: false } };
    trackWindowState();
    await vi.advanceTimersByTimeAsync(10);

    tauri.minimized = true;
    tauri.resized[0]?.();
    await vi.advanceTimersByTimeAsync(150);
    expect(config.writes).toEqual([]);

    tauri.minimized = false;
    tauri.fullscreen = true;
    tauri.resized[0]?.();
    await vi.advanceTimersByTimeAsync(150);
    expect(config.writes).toEqual([]);

    tauri.fullscreen = false;
    focus.locked = true;
    tauri.resized[0]?.();
    await vi.advanceTimersByTimeAsync(150);
    expect(config.writes).toEqual([]);

    // Once the lock is released the next resize is recorded again.
    focus.locked = false;
    tauri.resized[0]?.();
    await vi.advanceTimersByTimeAsync(150);
    expect(config.writes).toHaveLength(1);
  });

  it("keeps the previous normal size while maximized", async () => {
    config.snapshot = { window: { x: 1, y: 2, width: 800, height: 600, maximized: false } };
    trackWindowState();
    await vi.advanceTimersByTimeAsync(10);

    tauri.maximized = true;
    tauri.width = 3456;
    tauri.height = 1080;
    tauri.resized[0]?.();
    await vi.advanceTimersByTimeAsync(150);

    expect(config.writes[0]).toMatchObject({
      window: { width: 800, height: 600, maximized: true },
    });
  });

  it("the cancel function drops a pending write and every subscription", async () => {
    config.snapshot = { window: { x: 1, y: 2, width: 800, height: 600, maximized: false } };
    const cancel = trackWindowState();
    await vi.advanceTimersByTimeAsync(10);

    tauri.resized[0]?.();
    cancel();
    await vi.advanceTimersByTimeAsync(500);

    expect(config.writes).toEqual([]);
    expect(tauri.offCalls).toBe(2);
  });

  it("in a bare environment without the window API it returns a no-op", async () => {
    tauri.failCurrentWindow = true;
    const cancel = trackWindowState();
    expect(() => cancel()).not.toThrow();
    await vi.advanceTimersByTimeAsync(500);
    expect(config.writes).toEqual([]);
  });
});
