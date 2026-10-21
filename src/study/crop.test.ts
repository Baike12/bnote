import { describe, expect, it } from "vitest";
import { cropFromDrag, normalizeCrop, MIN_CROP_SIZE } from "./crop";

describe("cropFromDrag", () => {
  it("按任意方向拖出的矩形都归一成正框", () => {
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

  it("只裁上下留白(横向几乎全宽)是合法裁剪", () => {
    expect(cropFromDrag(0.01, 0.1, 0.99, 0.9)).toEqual({
      x: expect.closeTo(0.01, 10),
      y: 0.1,
      w: expect.closeTo(0.98, 10),
      h: 0.8,
    });
  });

  it("起点终点越出页面时先夹回页内", () => {
    // 夹回后盖满整页 = 没裁
    expect(cropFromDrag(-0.5, -0.2, 1.5, 1.4)).toBeNull();
    expect(cropFromDrag(-0.2, 0.2, 0.6, 1.4)).toEqual({
      x: 0,
      y: 0.2,
      w: expect.closeTo(0.6, 10),
      h: expect.closeTo(0.8, 10),
    });
  });

  it("单击/手抖/盖满整页都视为没框选", () => {
    expect(cropFromDrag(0.5, 0.5, 0.5, 0.5)).toBeNull();
    expect(cropFromDrag(0.5, 0.5, 0.5 + MIN_CROP_SIZE / 2, 0.9)).toBeNull();
    expect(cropFromDrag(0, 0, 1, 1)).toBeNull();
    expect(cropFromDrag(NaN, 0, 1, 0.5)).toBeNull();
  });
});

describe("normalizeCrop", () => {
  it("原样接受合法值", () => {
    expect(normalizeCrop({ x: 0.1, y: 0.2, w: 0.5, h: 0.6 })).toEqual({
      x: 0.1,
      y: 0.2,
      w: 0.5,
      h: 0.6,
    });
  });

  it("越界宽高夹到页面边界以内", () => {
    expect(normalizeCrop({ x: 0.5, y: 0.5, w: 2, h: 2 })).toEqual({
      x: 0.5,
      y: 0.5,
      w: 0.5,
      h: 0.5,
    });
  });

  it("坏数据/过小/整页都退回 null", () => {
    expect(normalizeCrop(null)).toBeNull();
    expect(normalizeCrop("{}")).toBeNull();
    expect(normalizeCrop({ x: 0, y: 0, w: "1", h: 1 })).toBeNull();
    expect(normalizeCrop({ x: 0, y: 0, w: 0.01, h: 0.5 })).toBeNull();
    expect(normalizeCrop({ x: 0, y: 0, w: 1, h: 1 })).toBeNull();
  });
});
