import { describe, expect, it } from "vitest";
import {
  currentRegion,
  intersectRect,
  planSnapshot,
  type SnapshotPage,
  type SnapshotRect,
} from "./pdfSnapshot";

const rect = (
  left: number,
  top: number,
  width: number,
  height: number,
): SnapshotRect => ({ left, top, width, height });

/** One page: the display window equals the whole page (no display range), canvas 2x DPR. */
function page(over: Partial<SnapshotPage> = {}): SnapshotPage {
  return {
    box: rect(0, 0, 500, 750),
    full: rect(0, 0, 500, 750),
    pixels: 1000,
    annotations: [],
    ...over,
  };
}

describe("the planSnapshot framing geometry", () => {
  it("horizontally only the page column is taken: the outline/annotation margin on the left is not captured", () => {
    // Viewport 0..1000, page column 300..800; the 0..300 margin must be cut away.
    const plan = planSnapshot(rect(0, 0, 1000, 800), [
      page({ box: rect(300, 0, 500, 900), full: rect(300, 0, 500, 900) }),
    ]);
    expect(plan).not.toBeNull();
    expect(plan!.origin).toEqual({ left: 300, top: 0 });
    expect(plan!.width).toBe(1000); // 500 CSS × 2(Dpr)
    expect(plan!.pages[0].dest).toEqual(rect(0, 0, 1000, 1600));
    expect(plan!.pages[0].src.left).toBe(0);
  });

  it("vertically the whitespace above and below the page is cut off from the viewport", () => {
    // The page starts at y=50; the top 50px of the viewport is background and is not captured.
    const plan = planSnapshot(rect(0, 0, 500, 800), [
      page({ box: rect(0, 50, 500, 900), full: rect(0, 50, 500, 900) }),
    ]);
    expect(plan!.origin.top).toBe(50);
    expect(plan!.height).toBe(1500); // (800-50) × 2
    expect(plan!.pages[0].src.top).toBe(0);
  });

  it("spanning pages: each page is carried over separately, the gap between pages stays as background", () => {
    const viewport = rect(0, 0, 500, 800);
    const plan = planSnapshot(viewport, [
      page({ box: rect(0, -100, 500, 500), full: rect(0, -100, 500, 500) }),
      page({ box: rect(0, 414, 500, 800), full: rect(0, 414, 500, 800) }),
    ]);
    expect(plan!.pages).toHaveLength(2);
    // First page: the viewport top cuts 100px off the page (y = -100 -> source y 200)
    expect(plan!.pages[0].src).toEqual(rect(0, 200, 1000, 800));
    expect(plan!.pages[0].dest).toEqual(rect(0, 0, 1000, 800));
    // Second page: starts at y=414, the 14px gap between pages = 28 output pixels
    expect(plan!.pages[1].dest.top).toBe(828);
    expect(plan!.pages[1].src.top).toBe(0);
  });

  it("the display range (crop) is converted to the source rectangle and the annotation base in whole-page coordinates", () => {
    const plan = planSnapshot(rect(0, 0, 1000, 1000), [
      page({
        box: rect(40, 70, 400, 600),
        full: rect(0, 0, 500, 750),
      }),
    ]);
    const p = plan!.pages[0];
    expect(plan!.origin).toEqual({ left: 40, top: 70 });
    expect(p.src).toEqual(rect(80, 140, 800, 1200));
    expect(p.dest).toEqual(rect(0, 0, 800, 1200));
    // Position of the whole page in the output: the origin is cropped off to the top-left, the clip drops the part outside the box.
    expect(p.sheet).toEqual(rect(-80, -140, 1000, 1500));
  });

  it("the visible page canvas has not finished rendering → null (the caller retries on the next frame)", () => {
    const plan = planSnapshot(rect(0, 0, 500, 750), [page({ pixels: 0 })]);
    expect(plan).toBeNull();
  });

  it("no page intersects the viewport → null", () => {
    const plan = planSnapshot(rect(0, 0, 500, 750), [
      page({ box: rect(0, 2000, 500, 750), full: rect(0, 2000, 500, 750) }),
    ]);
    expect(plan).toBeNull();
  });

  it("a fragment smaller than 2px at the viewport edge does not count as content", () => {
    const plan = planSnapshot(rect(0, 0, 500, 750), [
      page({ box: rect(0, 749, 500, 750), full: rect(0, 749, 500, 750) }),
    ]);
    expect(plan).toBeNull();
  });

  it("intersectRect returns only the part that truly overlaps", () => {
    expect(intersectRect(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toEqual(
      rect(5, 5, 5, 5),
    );
    expect(intersectRect(rect(0, 0, 10, 10), rect(20, 20, 5, 5))).toBeNull();
  });
});

describe("reading regions: the dimmed old content is not captured", () => {
  it("currentRegion keeps only the current content region (below the lower edge of the shade)", () => {
    expect(currentRegion(rect(0, 100, 500, 800), 500)).toEqual(
      rect(0, 500, 500, 400),
    );
  });

  it("no shade layer → the whole screen is current content", () => {
    expect(currentRegion(rect(0, 100, 500, 800), null)).toEqual(
      rect(0, 100, 500, 800),
    );
  });

  it("the lower edge of the shade is above the viewport → no crop (the whole screen is in the current region)", () => {
    expect(currentRegion(rect(0, 100, 500, 800), 20)).toEqual(
      rect(0, 100, 500, 800),
    );
  });

  it("the shade covers the whole viewport → there is nothing to capture", () => {
    expect(currentRegion(rect(0, 100, 500, 800), 900)).toBeNull();
  });

  it("the framing starts at the lower edge of the shade: the old content in the upper half is not captured", () => {
    // Viewport 0..800, the shade covers 0..400 (old content), the current content region is 400..800.
    const plan = planSnapshot(
      rect(0, 0, 500, 800),
      [page({ box: rect(0, -100, 500, 900), full: rect(0, -100, 500, 900) })],
      { currentTop: 400 },
    );
    expect(plan).not.toBeNull();
    expect(plan!.origin).toEqual({ left: 0, top: 400 });
    expect(plan!.height).toBe(800); // 400 CSS × 2(Dpr)
    // The source rect moves up in step: those 500px of old content are not captured.
    expect(plan!.pages[0].src).toEqual(rect(0, 1000, 1000, 800));
    expect(plan!.pages[0].dest).toEqual(rect(0, 0, 1000, 800));
  });

  it("no shade boundary passed → the old behaviour is unchanged (the whole screen is framed)", () => {
    const plan = planSnapshot(rect(0, 0, 500, 800), [
      page({ box: rect(0, -100, 500, 900), full: rect(0, -100, 500, 900) }),
    ]);
    expect(plan!.origin).toEqual({ left: 0, top: 0 });
    expect(plan!.height).toBe(1600);
  });

  it("the shade covers the whole screen → null (the caller reports that there is no current content)", () => {
    const plan = planSnapshot(rect(0, 0, 500, 800), [
      page({ box: rect(0, -100, 500, 900), full: rect(0, -100, 500, 900) }),
    ], { currentTop: 900 });
    expect(plan).toBeNull();
  });

  it("a page that lies entirely in the shade is not captured", () => {
    // The page 0..300 lies entirely in the shade (0..400), so it is not in the current region.
    const plan = planSnapshot(
      rect(0, 0, 500, 800),
      [page({ box: rect(0, 0, 500, 300), full: rect(0, 0, 500, 300) })],
      { currentTop: 400 },
    );
    expect(plan).toBeNull();
  });
});
