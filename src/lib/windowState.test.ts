import { describe, expect, it } from "vitest";
import { mergeWindowState, normalizeWindowState, MIN_WINDOW_H, MIN_WINDOW_W } from "./windowState";

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
    expect(mergeWindowState(maximized, { x: 120, y: 90, width: 1000, height: 700 }, false)).toEqual({
      x: 120,
      y: 90,
      width: 1000,
      height: 700,
      maximized: false,
    });
  });

  it("without a previous value, maximizing still records a size as a fallback", () => {
    const state = mergeWindowState(null, { x: 0, y: 25, width: 3456, height: 1080 }, true);
    expect(state).toEqual({ x: 0, y: 25, width: 3456, height: 1080, maximized: true });
  });
});
