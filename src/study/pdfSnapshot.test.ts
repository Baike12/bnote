import { describe, expect, it } from "vitest";
import {
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

/** 一页:显示窗口与整页相同(没设显示范围),canvas 2× DPR。 */
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
    // 视口 0..1000,页面列 300..800;留白 0..300 必须被切掉。
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
    // 页面从 y=50 开始;视口顶部 50px 是底色,不进图。
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
    // 第一页:视口顶部切掉页内 100px(y = -100 → 源 y 200)
    expect(plan!.pages[0].src).toEqual(rect(0, 200, 1000, 800));
    expect(plan!.pages[0].dest).toEqual(rect(0, 0, 1000, 800));
    // 第二页:从 y=414 开始,页间 14px 空隙 = 28 输出像素
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
    // 整页在输出里的位置:原点被裁到左上角外侧,批注靠 clip 掉出框的部分。
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
