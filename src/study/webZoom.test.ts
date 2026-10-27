import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEB_ZOOM,
  MAX_WEB_ZOOM,
  MIN_WEB_ZOOM,
  formatWebZoom,
  normalizeWebZoom,
  stepWebZoom,
} from "./webZoom";

describe("网页缩放模型", () => {
  it("默认 100%,坏值回落到默认", () => {
    expect(normalizeWebZoom(undefined)).toBe(DEFAULT_WEB_ZOOM);
    expect(normalizeWebZoom("1.5")).toBe(DEFAULT_WEB_ZOOM);
    expect(normalizeWebZoom(Number.NaN)).toBe(DEFAULT_WEB_ZOOM);
  });

  it("夹进 50%–300%", () => {
    expect(normalizeWebZoom(0.1)).toBe(MIN_WEB_ZOOM);
    expect(normalizeWebZoom(9)).toBe(MAX_WEB_ZOOM);
  });

  it("放大/缩小都在档位上往返,不会累乘漂移", () => {
    expect(stepWebZoom(1, 1)).toBe(1.1);
    expect(stepWebZoom(1.1, -1)).toBe(1);
    expect(stepWebZoom(1, -1)).toBe(0.9);
    expect(stepWebZoom(stepWebZoom(2.5, 1), -1)).toBe(2.5);
  });

  it("端点不越界", () => {
    expect(stepWebZoom(MAX_WEB_ZOOM, 1)).toBe(MAX_WEB_ZOOM);
    expect(stepWebZoom(MIN_WEB_ZOOM, -1)).toBe(MIN_WEB_ZOOM);
    expect(stepWebZoom(MAX_WEB_ZOOM, -1)).toBe(2.5);
    expect(stepWebZoom(MIN_WEB_ZOOM, 1)).toBe(0.67);
  });

  it("手改的非档位值落到相邻档位", () => {
    expect(stepWebZoom(1.2, 1)).toBe(1.25);
    expect(stepWebZoom(1.2, -1)).toBe(1.1);
  });

  it("工具栏读数按百分比取整", () => {
    expect(formatWebZoom(1)).toBe("100%");
    expect(formatWebZoom(0.67)).toBe("67%");
    expect(formatWebZoom(9)).toBe("300%");
  });
});
