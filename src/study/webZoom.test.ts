import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEB_ZOOM,
  MAX_WEB_ZOOM,
  MIN_WEB_ZOOM,
  formatWebZoom,
  normalizeWebZoom,
  stepWebZoom,
} from "./webZoom";

describe("the web zoom model", () => {
  it("the default is 100%, a bad value falls back to the default", () => {
    expect(normalizeWebZoom(undefined)).toBe(DEFAULT_WEB_ZOOM);
    expect(normalizeWebZoom("1.5")).toBe(DEFAULT_WEB_ZOOM);
    expect(normalizeWebZoom(Number.NaN)).toBe(DEFAULT_WEB_ZOOM);
  });

  it("it is clamped into 50%–300%", () => {
    expect(normalizeWebZoom(0.1)).toBe(MIN_WEB_ZOOM);
    expect(normalizeWebZoom(9)).toBe(MAX_WEB_ZOOM);
  });

  it("zoom in / zoom out round-trips on the steps, it does not drift by multiplication", () => {
    expect(stepWebZoom(1, 1)).toBe(1.1);
    expect(stepWebZoom(1.1, -1)).toBe(1);
    expect(stepWebZoom(1, -1)).toBe(0.9);
    expect(stepWebZoom(stepWebZoom(2.5, 1), -1)).toBe(2.5);
  });

  it("the endpoints do not cross the bounds", () => {
    expect(stepWebZoom(MAX_WEB_ZOOM, 1)).toBe(MAX_WEB_ZOOM);
    expect(stepWebZoom(MIN_WEB_ZOOM, -1)).toBe(MIN_WEB_ZOOM);
    expect(stepWebZoom(MAX_WEB_ZOOM, -1)).toBe(2.5);
    expect(stepWebZoom(MIN_WEB_ZOOM, 1)).toBe(0.67);
  });

  it("a manually typed value that is not on a step lands on the adjacent step", () => {
    expect(stepWebZoom(1.2, 1)).toBe(1.25);
    expect(stepWebZoom(1.2, -1)).toBe(1.1);
  });

  it("the toolbar readout is rounded to a percentage", () => {
    expect(formatWebZoom(1)).toBe("100%");
    expect(formatWebZoom(0.67)).toBe("67%");
    expect(formatWebZoom(9)).toBe("300%");
  });
});
