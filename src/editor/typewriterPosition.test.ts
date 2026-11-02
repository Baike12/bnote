import { describe, expect, it } from "vitest";
import {
  DEFAULT_TYPEWRITER_POSITION,
  MAX_TYPEWRITER_POSITION,
  MIN_TYPEWRITER_POSITION,
  normalizeTypewriterPosition,
  typewriterReserve,
  typewriterScrollDelta,
} from "./typewriterPosition";

/**
 * Gate for the typewriter position: the padding and the scroll delta must both
 * be derived from the same ratio.
 *
 * Changing only the top padding, or only the scroll target, leaves one of
 * "the first line can stop at the configured height" and "the last line can
 * stop at the configured height" true — which is exactly why a configured
 * position is invisible at the head and tail of a document.
 */
describe("normalizeTypewriterPosition", () => {
  it("a missing or invalid old config falls back to 50%", () => {
    expect(normalizeTypewriterPosition(undefined)).toBe(0.5);
    expect(normalizeTypewriterPosition(null)).toBe(0.5);
    expect(normalizeTypewriterPosition(Number.NaN)).toBe(0.5);
    expect(normalizeTypewriterPosition("0.3")).toBe(0.5);
  });

  it("out-of-range values are clamped back to 20%–80%", () => {
    expect(normalizeTypewriterPosition(0)).toBe(MIN_TYPEWRITER_POSITION);
    expect(normalizeTypewriterPosition(-1)).toBe(MIN_TYPEWRITER_POSITION);
    expect(normalizeTypewriterPosition(1)).toBe(MAX_TYPEWRITER_POSITION);
    expect(normalizeTypewriterPosition(9)).toBe(MAX_TYPEWRITER_POSITION);
  });

  it("rounded to 1% (the slider and hand-edited JSON have the same precision)", () => {
    expect(normalizeTypewriterPosition(0.333)).toBe(0.33);
    expect(normalizeTypewriterPosition(0.666)).toBe(0.67);
    expect(normalizeTypewriterPosition(0.196)).toBe(0.2);
  });
});

describe("typewriterReserve", () => {
  const H = 1000;
  const LH = 20;

  it("50% matches the old centered padding pixel for pixel", () => {
    const { top, bottom } = typewriterReserve(H, LH, DEFAULT_TYPEWRITER_POSITION);
    expect(top).toBe((H - LH) / 2);
    expect(bottom).toBe((H - LH) / 2);
  });

  it("when positioned high the top padding shrinks and the bottom padding grows (so the first and last line stop at the same point)", () => {
    const { top, bottom } = typewriterReserve(H, LH, 0.3);
    expect(top).toBe(0.3 * H - LH / 2);
    expect(bottom).toBe(0.7 * H - LH / 2);
    // Both paddings plus one line = one screen: the scrollable range at the
    // head and tail of the document is exactly what carries the caret to the
    // configured height
    expect(top + bottom + LH).toBe(H);
  });

  it("out-of-range and invalid values are computed from the normalized ratio", () => {
    expect(typewriterReserve(H, LH, 10)).toEqual(
      typewriterReserve(H, LH, MAX_TYPEWRITER_POSITION),
    );
    expect(typewriterReserve(H, LH, Number.NaN)).toEqual(
      typewriterReserve(H, LH, DEFAULT_TYPEWRITER_POSITION),
    );
  });

  it("the padding is never negative when the viewport is shorter than one line", () => {
    const { top, bottom } = typewriterReserve(10, 20, 0.5);
    expect(top).toBe(0);
    expect(bottom).toBe(0);
  });

  it("reserveTop=false: the first line is pinned to the top, the bottom padding still lets the last line stop at the target height", () => {
    const centered = typewriterReserve(H, LH, 0.5, false);
    expect(centered.top).toBe(0);
    expect(centered.bottom).toBe((H - LH) / 2);
    expect(typewriterReserve(H, LH, 0.3, false)).toEqual({
      top: 0,
      bottom: 0.7 * H - LH / 2,
    });
  });
});

describe("typewriterScrollDelta", () => {
  const H = 1000;

  it("at 50% the center of the caret line aligns with the center of the screen", () => {
    expect(typewriterScrollDelta(400, H, 0.5)).toBe(-100);
    expect(typewriterScrollDelta(600, H, 0.5)).toBe(100);
  });

  it("the higher the position the higher the target (the same caret needs a smaller downward scroll)", () => {
    const caret = 800;
    expect(typewriterScrollDelta(caret, H, 0.3)).toBeGreaterThan(
      typewriterScrollDelta(caret, H, 0.5),
    );
    expect(typewriterScrollDelta(caret, H, 0.7)).toBeLessThan(
      typewriterScrollDelta(caret, H, 0.5),
    );
  });
});
