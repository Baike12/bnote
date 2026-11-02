import { describe, expect, it } from "vitest";
import { cropFromDrag, normalizeCrop, MIN_CROP_SIZE } from "./crop";

describe("cropFromDrag", () => {
  it("a rectangle dragged in any direction is normalized to a positive box", () => {
    expect(cropFromDrag(0.2, 0.3, 0.8, 0.7)).toEqual({
      x: 0.2,
      y: 0.3,
      w: expect.closeTo(0.6, 10),
      h: expect.closeTo(0.4, 10),
    });
    expect(cropFromDrag(0.8, 0.7, 0.2, 0.3)).toEqual({
      x: 0.2,
      y: 0.3,
      w: expect.closeTo(0.6, 10),
      h: expect.closeTo(0.4, 10),
    });
  });

  it("cropping only the top and bottom whitespace (almost the full width) is a valid crop", () => {
    expect(cropFromDrag(0.01, 0.1, 0.99, 0.9)).toEqual({
      x: expect.closeTo(0.01, 10),
      y: 0.1,
      w: expect.closeTo(0.98, 10),
      h: 0.8,
    });
  });

  it("out-of-page start and end points are clamped back into the page first", () => {
    // After clamping it covers the whole page = no crop
    expect(cropFromDrag(-0.5, -0.2, 1.5, 1.4)).toBeNull();
    expect(cropFromDrag(-0.2, 0.2, 0.6, 1.4)).toEqual({
      x: 0,
      y: 0.2,
      w: expect.closeTo(0.6, 10),
      h: expect.closeTo(0.8, 10),
    });
  });

  it("a single click, a shaky drag, and a full-page drag all count as no crop", () => {
    expect(cropFromDrag(0.5, 0.5, 0.5, 0.5)).toBeNull();
    expect(cropFromDrag(0.5, 0.5, 0.5 + MIN_CROP_SIZE / 2, 0.9)).toBeNull();
    expect(cropFromDrag(0, 0, 1, 1)).toBeNull();
    expect(cropFromDrag(NaN, 0, 1, 0.5)).toBeNull();
  });
});

describe("normalizeCrop", () => {
  it("valid values are accepted unchanged", () => {
    expect(normalizeCrop({ x: 0.1, y: 0.2, w: 0.5, h: 0.6 })).toEqual({
      x: 0.1,
      y: 0.2,
      w: 0.5,
      h: 0.6,
    });
  });

  it("out-of-bounds width and height are clamped inside the page bounds", () => {
    expect(normalizeCrop({ x: 0.5, y: 0.5, w: 2, h: 2 })).toEqual({
      x: 0.5,
      y: 0.5,
      w: 0.5,
      h: 0.5,
    });
  });

  it("bad data, too small and full-page crops all fall back to null", () => {
    expect(normalizeCrop(null)).toBeNull();
    expect(normalizeCrop("{}")).toBeNull();
    expect(normalizeCrop({ x: 0, y: 0, w: "1", h: 1 })).toBeNull();
    expect(normalizeCrop({ x: 0, y: 0, w: 0.01, h: 0.5 })).toBeNull();
    expect(normalizeCrop({ x: 0, y: 0, w: 1, h: 1 })).toBeNull();
  });
});
