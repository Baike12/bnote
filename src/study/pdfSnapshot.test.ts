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

describe("planSnapshot 取景几何", () => {
  it("横向只取页面列:左侧目录/批注留白不进图", () => {
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

  it("纵向裁掉视口上方/下方的页面外留白", () => {
    // The page starts at y=50; the top 50px of the viewport is background and is not captured.
    const plan = planSnapshot(rect(0, 0, 500, 800), [
      page({ box: rect(0, 50, 500, 900), full: rect(0, 50, 500, 900) }),
    ]);
    expect(plan!.origin.top).toBe(50);
    expect(plan!.height).toBe(1500); // (800-50) × 2
    expect(plan!.pages[0].src.top).toBe(0);
  });

  it("跨页:两页各自搬运,页间空隙保留为底色", () => {
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

  it("显示范围(裁剪)按整页坐标换算源矩形与批注基准", () => {
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

  it("可见页 canvas 还没渲染完 → null(调用方下一帧重试)", () => {
    const plan = planSnapshot(rect(0, 0, 500, 750), [page({ pixels: 0 })]);
    expect(plan).toBeNull();
  });

  it("没有页面与视口相交 → null", () => {
    const plan = planSnapshot(rect(0, 0, 500, 750), [
      page({ box: rect(0, 2000, 500, 750), full: rect(0, 2000, 500, 750) }),
    ]);
    expect(plan).toBeNull();
  });

  it("视口边缘不足 2px 的碎片不算内容", () => {
    const plan = planSnapshot(rect(0, 0, 500, 750), [
      page({ box: rect(0, 749, 500, 750), full: rect(0, 749, 500, 750) }),
    ]);
    expect(plan).toBeNull();
  });

  it("intersectRect 只返回真正重叠的部分", () => {
    expect(intersectRect(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toEqual(
      rect(5, 5, 5, 5),
    );
    expect(intersectRect(rect(0, 0, 10, 10), rect(20, 20, 5, 5))).toBeNull();
  });
});

describe("阅读分区:压暗的旧内容不进图", () => {
  it("currentRegion 只保留当前内容区(阴影下沿以下)", () => {
    expect(currentRegion(rect(0, 100, 500, 800), 500)).toEqual(
      rect(0, 500, 500, 400),
    );
  });

  it("没有压暗层 → 整屏都是当前内容", () => {
    expect(currentRegion(rect(0, 100, 500, 800), null)).toEqual(
      rect(0, 100, 500, 800),
    );
  });

  it("压暗层下沿在视口之上 → 不裁(整屏都在当前区)", () => {
    expect(currentRegion(rect(0, 100, 500, 800), 20)).toEqual(
      rect(0, 100, 500, 800),
    );
  });

  it("压暗层盖住整个视口 → 没有可截的内容", () => {
    expect(currentRegion(rect(0, 100, 500, 800), 900)).toBeNull();
  });

  it("取景从阴影下沿开始:上半屏的旧内容不进图", () => {
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

  it("不传阴影边界 → 旧行为不变(整屏取景)", () => {
    const plan = planSnapshot(rect(0, 0, 500, 800), [
      page({ box: rect(0, -100, 500, 900), full: rect(0, -100, 500, 900) }),
    ]);
    expect(plan!.origin).toEqual({ left: 0, top: 0 });
    expect(plan!.height).toBe(1600);
  });

  it("阴影盖住整屏 → null(调用方提示没有当前内容)", () => {
    const plan = planSnapshot(rect(0, 0, 500, 800), [
      page({ box: rect(0, -100, 500, 900), full: rect(0, -100, 500, 900) }),
    ], { currentTop: 900 });
    expect(plan).toBeNull();
  });

  it("完全落在阴影里的页面不进图", () => {
    // The page 0..300 lies entirely in the shade (0..400), so it is not in the current region.
    const plan = planSnapshot(
      rect(0, 0, 500, 800),
      [page({ box: rect(0, 0, 500, 300), full: rect(0, 0, 500, 300) })],
      { currentTop: 400 },
    );
    expect(plan).toBeNull();
  });
});
