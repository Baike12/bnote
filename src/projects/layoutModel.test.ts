import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_WIDTH,
  DEFAULT_SIDE_WIDTH,
  MIN_CENTER_WIDTH,
  RESIZER_WIDTH,
  dragDailyEdge,
  dragSideEdge,
  minColumnWidth,
  normalizeDailyWidth,
  normalizeSideWidth,
} from "./layoutModel";

const HOST = 1400;
const centerOf = (side: number, daily: number) => HOST - side - daily - RESIZER_WIDTH * 2;

describe("dragSideEdge", () => {
  it("指针位置就是导航栏右缘(位移从线的当前位置起算)", () => {
    expect(dragSideEdge(320, HOST, DEFAULT_DAILY_WIDTH)).toBe(319);
  });

  it("导航栏到 10% 就顶住,不再变窄", () => {
    expect(dragSideEdge(0, HOST, DEFAULT_DAILY_WIDTH)).toBe(minColumnWidth(HOST));
  });

  it("看板到最小可用宽度就顶住,日记栏宽度不变", () => {
    const daily = DEFAULT_DAILY_WIDTH;
    const side = dragSideEdge(HOST, HOST, daily);
    expect(centerOf(side, daily)).toBe(MIN_CENTER_WIDTH);
  });

  it("窗口窄到三栏放不下时也返回导航栏下限,不返回负数", () => {
    expect(dragSideEdge(9999, 600, 400)).toBe(minColumnWidth(600));
  });
});

describe("dragDailyEdge", () => {
  it("指针位置就是日记栏左缘", () => {
    expect(dragDailyEdge(HOST - DEFAULT_DAILY_WIDTH, HOST, DEFAULT_SIDE_WIDTH)).toBe(
      DEFAULT_DAILY_WIDTH,
    );
  });

  it("日记栏到 10% 就顶住,不再变窄", () => {
    expect(dragDailyEdge(HOST, HOST, DEFAULT_SIDE_WIDTH)).toBe(minColumnWidth(HOST));
  });

  it("看板到最小可用宽度就顶住,导航栏宽度不变", () => {
    const side = DEFAULT_SIDE_WIDTH;
    const daily = dragDailyEdge(0, HOST, side);
    expect(centerOf(side, daily)).toBe(MIN_CENTER_WIDTH);
  });

  it("拖动不改变导航栏宽度", () => {
    const side = 260;
    const before = side;
    dragDailyEdge(700, HOST, side);
    expect(side).toBe(before);
  });
});

describe("往返幂等", () => {
  it("拖到界再拖回来,回到原来的宽度", () => {
    const daily = DEFAULT_DAILY_WIDTH;
    const pinned = dragSideEdge(0, HOST, daily);
    const back = dragSideEdge(pinned + RESIZER_WIDTH, HOST, daily);
    expect(back).toBe(pinned);
  });
});

describe("归一持久化宽度", () => {
  it("坏数据回落默认值", () => {
    for (const bad of [null, undefined, NaN, 0, -5, "300"]) {
      expect(normalizeSideWidth(bad)).toBe(DEFAULT_SIDE_WIDTH);
      expect(normalizeDailyWidth(bad)).toBe(DEFAULT_DAILY_WIDTH);
    }
  });

  it("正常像素值原样保留(整数化)", () => {
    expect(normalizeSideWidth(301.6)).toBe(302);
    expect(normalizeDailyWidth(480)).toBe(480);
  });
});
