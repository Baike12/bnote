import { describe, expect, it } from "vitest";
import { mergeWindowState, normalizeWindowState, MIN_WINDOW_H, MIN_WINDOW_W } from "./windowState";

describe("窗口几何", () => {
  it("旧配置/坏值整条丢弃", () => {
    expect(normalizeWindowState(null)).toBeNull();
    expect(normalizeWindowState({})).toBeNull();
    expect(normalizeWindowState({ x: 1, y: 2, width: 800 })).toBeNull();
    expect(normalizeWindowState({ x: Number.NaN, y: 2, width: 800, height: 600 })).toBeNull();
    expect(normalizeWindowState("1280x820")).toBeNull();
  });

  it("尺寸夹进最小值并取整,位置原样保留", () => {
    const state = normalizeWindowState({ x: 12.4, y: -30.6, width: 100, height: 100 });
    expect(state).toEqual({
      x: 12,
      y: -31,
      width: MIN_WINDOW_W,
      height: MIN_WINDOW_H,
      maximized: false,
    });
  });

  it("最大化时保留上一次的普通尺寸,只翻 maximized", () => {
    const prev = { x: 100, y: 80, width: 1280, height: 820, maximized: false };
    const maximized = mergeWindowState(prev, { x: 0, y: 25, width: 3456, height: 1080 }, true);
    expect(maximized).toEqual({ ...prev, maximized: true });
    // 取消最大化后回到真实窗口尺寸
    expect(mergeWindowState(maximized, { x: 120, y: 90, width: 1000, height: 700 }, false)).toEqual({
      x: 120,
      y: 90,
      width: 1000,
      height: 700,
      maximized: false,
    });
  });

  it("没有历史值时,最大化也记一份尺寸兜底", () => {
    const state = mergeWindowState(null, { x: 0, y: 25, width: 3456, height: 1080 }, true);
    expect(state).toEqual({ x: 0, y: 25, width: 3456, height: 1080, maximized: true });
  });
});
