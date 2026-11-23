import { describe, expect, it } from "vitest";
import { ZOOM_MAX, ZOOM_MIN, parseViewBox, zoomAround, zoomBy } from "./mermaidView";

describe("parseViewBox", () => {
  it("reads the width and height of the first viewBox", () => {
    expect(parseViewBox('<svg viewBox="4 4 360 297"></svg>')).toEqual({ width: 360, height: 297 });
    expect(parseViewBox('<svg viewBox="0,0,12.5,7"></svg>')).toEqual({ width: 12.5, height: 7 });
  });

  it("returns null when the attribute is missing", () => {
    expect(parseViewBox("<svg></svg>")).toBeNull();
    expect(parseViewBox("")).toBeNull();
  });

  it("returns null for a malformed value", () => {
    expect(parseViewBox('<svg viewBox="0 0 10"></svg>')).toBeNull();
    expect(parseViewBox('<svg viewBox="0 0 10 10 10"></svg>')).toBeNull();
    expect(parseViewBox('<svg viewBox="0 0 10 nope"></svg>')).toBeNull();
  });

  it("returns null when width or height is not positive", () => {
    expect(parseViewBox('<svg viewBox="0 0 0 10"></svg>')).toBeNull();
    expect(parseViewBox('<svg viewBox="0 0 10 -5"></svg>')).toBeNull();
  });
});

describe("zoomBy", () => {
  it("multiplies the scale and scales the translation with it (center stays fixed)", () => {
    expect(zoomBy({ scale: 1, x: 10, y: -4 }, 2)).toEqual({ scale: 2, x: 20, y: -8 });
  });

  it("clamps at the maximum and stops moving once clamped", () => {
    const top = zoomBy({ scale: ZOOM_MAX, x: 5, y: 6 }, 2);
    expect(top).toEqual({ scale: ZOOM_MAX, x: 5, y: 6 });
    expect(zoomBy({ scale: 7, x: 0, y: 0 }, 8).scale).toBe(ZOOM_MAX);
  });

  it("clamps at the minimum", () => {
    expect(zoomBy({ scale: ZOOM_MIN, x: 0, y: 0 }, 0.5)).toEqual({ scale: ZOOM_MIN, x: 0, y: 0 });
    expect(zoomBy({ scale: 0.3, x: 0, y: 0 }, 0.1).scale).toBe(ZOOM_MIN);
  });
});

describe("zoomAround", () => {
  it("keeps the stage point under the anchor fixed", () => {
    const view = { scale: 2, x: 10, y: -5 };
    const anchor = { x: 100, y: 50 };
    const modelX = (anchor.x - view.x) / view.scale;
    const modelY = (anchor.y - view.y) / view.scale;
    const next = zoomAround(view, 1.25, anchor.x, anchor.y);
    expect(next.x + next.scale * modelX).toBeCloseTo(anchor.x, 10);
    expect(next.y + next.scale * modelY).toBeCloseTo(anchor.y, 10);
  });

  it("zooming out around an off-center anchor moves the view the other way", () => {
    const next = zoomAround({ scale: 2, x: 0, y: 0 }, 0.5, 100, 0);
    expect(next).toEqual({ scale: 1, x: 50, y: 0 });
  });
});
