import { describe, expect, it } from "vitest";
import {
  DRAWING_DEFAULT_HEIGHT,
  DRAWING_DEFAULT_WIDTH,
  DRAWING_MIN_HEIGHT,
  DRAWING_MIN_WIDTH,
  centeredRect,
  clampDrawingSize,
  fitRect,
  moveRect,
  normalizeDrawingHeight,
  normalizeDrawingWidth,
  resizeRect,
  type DrawingRect,
} from "./drawingWindow";

/**
 * The window model of the drawing canvas.
 *
 * Three invariants that a wrong implementation breaks visibly:
 * - the dialog never opens larger than the screen (a small screen is common
 *   when the app runs on a projector), and never below the usable minimum;
 * - a resize anchors the **opposite** edge: dragging the left edge must not
 *   move the right one, otherwise the pointer and the edge drift apart;
 * - a move or a resize can never push the dialog partly off screen.
 */

const VIEWPORT = { width: 1440, height: 900 };

function rect(left: number, top: number, width: number, height: number): DrawingRect {
  return { left, top, width, height };
}

describe("normalizeDrawingWidth / Height", () => {
  it("bad data falls back to the default", () => {
    for (const value of [undefined, null, "900", NaN, Infinity, 0, -3, {}]) {
      expect(normalizeDrawingWidth(value)).toBe(DRAWING_DEFAULT_WIDTH);
      expect(normalizeDrawingHeight(value)).toBe(DRAWING_DEFAULT_HEIGHT);
    }
  });

  it("a hand-edited value below the minimum is lifted to it", () => {
    expect(normalizeDrawingWidth(10)).toBe(DRAWING_MIN_WIDTH);
    expect(normalizeDrawingHeight(10)).toBe(DRAWING_MIN_HEIGHT);
  });

  it("a valid value is kept as an integer", () => {
    expect(normalizeDrawingWidth(1234.6)).toBe(1235);
    expect(normalizeDrawingHeight(600)).toBe(600);
  });
});

describe("clampDrawingSize", () => {
  it("a stored size larger than the screen shrinks to the screen minus the margin", () => {
    expect(clampDrawingSize(3000, 2000, VIEWPORT)).toEqual({ width: 1408, height: 868 });
  });

  it("the minimum wins over a tiny viewport", () => {
    expect(clampDrawingSize(100, 100, { width: 400, height: 300 })).toEqual({
      width: DRAWING_MIN_WIDTH,
      height: DRAWING_MIN_HEIGHT,
    });
  });
});

describe("centeredRect", () => {
  it("opens centered with the preferred size", () => {
    expect(centeredRect(1000, 600, VIEWPORT)).toEqual({
      left: 220,
      top: 150,
      width: 1000,
      height: 600,
    });
  });

  it("opens centered and fits the screen when the preference is too large", () => {
    const r = centeredRect(3000, 2000, VIEWPORT);
    expect(r).toEqual({ left: 16, top: 16, width: 1408, height: 868 });
  });
});

describe("resizeRect", () => {
  const base = rect(200, 150, 1000, 600);

  it("the east edge grows to the right and the west edge stays", () => {
    expect(resizeRect(base, "e", 40, 0, VIEWPORT)).toMatchObject({ left: 200, width: 1040 });
  });

  it("the west edge grows to the left and the east edge stays", () => {
    const r = resizeRect(base, "w", -40, 0, VIEWPORT);
    expect(r).toMatchObject({ left: 160, width: 1040 });
    expect(r.left + r.width).toBe(base.left + base.width);
  });

  it("a corner moves both axes", () => {
    const r = resizeRect(base, "nw", -20, -30, VIEWPORT);
    expect(r).toMatchObject({ left: 180, top: 120, width: 1020, height: 630 });
    expect(r.left + r.width).toBe(1200);
    expect(r.top + r.height).toBe(750);
  });

  it("dragging past the opposite edge stops at the minimum size", () => {
    const r = resizeRect(base, "e", -5000, 0, VIEWPORT);
    expect(r.width).toBe(DRAWING_MIN_WIDTH);
    expect(r.left).toBe(200);
  });

  it("an edge does not grow past the viewport edge", () => {
    // left 200, viewport 1440: at most 1240 wide, and the margin caps it earlier.
    const r = resizeRect(base, "e", 5000, 0, VIEWPORT);
    expect(200 + r.width).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it("a window flush with the right edge cannot grow further", () => {
    const flush = rect(1440 - 800, 100, 800, 500);
    expect(resizeRect(flush, "e", 100, 0, VIEWPORT).width).toBe(800);
  });
});

describe("moveRect", () => {
  it("moves by the delta", () => {
    expect(moveRect(rect(200, 150, 800, 600), 60, -40, VIEWPORT)).toMatchObject({
      left: 260,
      top: 110,
    });
  });

  it("stops at the screen edges instead of going off screen", () => {
    expect(moveRect(rect(200, 150, 800, 600), -500, 0, VIEWPORT).left).toBe(0);
    const r = moveRect(rect(200, 150, 800, 600), 5000, 5000, VIEWPORT);
    expect(r.left).toBe(VIEWPORT.width - 800);
    expect(r.top).toBe(VIEWPORT.height - 600);
  });
});

describe("fitRect", () => {
  it("an oversized rect shrinks and moves back inside", () => {
    expect(fitRect(rect(-50, -20, 3000, 2000), VIEWPORT)).toEqual({
      left: 0,
      top: 0,
      width: 1408,
      height: 868,
    });
  });
});
