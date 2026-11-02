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
  it("the pointer position is the right edge of the navigation column (the offset counts from the line's current position)", () => {
    expect(dragSideEdge(320, HOST, DEFAULT_DAILY_WIDTH)).toBe(319);
  });

  it("the navigation column hits the 10% floor and stops getting narrower", () => {
    expect(dragSideEdge(0, HOST, DEFAULT_DAILY_WIDTH)).toBe(minColumnWidth(HOST));
  });

  it("the kanban hits the minimum usable width and stops, the daily note column width stays unchanged", () => {
    const daily = DEFAULT_DAILY_WIDTH;
    const side = dragSideEdge(HOST, HOST, daily);
    expect(centerOf(side, daily)).toBe(MIN_CENTER_WIDTH);
  });

  it("a window too narrow for three columns still returns the navigation lower bound, never a negative width", () => {
    expect(dragSideEdge(9999, 600, 400)).toBe(minColumnWidth(600));
  });
});

describe("dragDailyEdge", () => {
  it("the pointer position is the left edge of the daily note column", () => {
    expect(dragDailyEdge(HOST - DEFAULT_DAILY_WIDTH, HOST, DEFAULT_SIDE_WIDTH)).toBe(
      DEFAULT_DAILY_WIDTH,
    );
  });

  it("the daily note column hits the 10% floor and stops getting narrower", () => {
    expect(dragDailyEdge(HOST, HOST, DEFAULT_SIDE_WIDTH)).toBe(minColumnWidth(HOST));
  });

  it("the kanban hits the minimum usable width and stops, the navigation column width stays unchanged", () => {
    const side = DEFAULT_SIDE_WIDTH;
    const daily = dragDailyEdge(0, HOST, side);
    expect(centerOf(side, daily)).toBe(MIN_CENTER_WIDTH);
  });

  it("dragging does not change the navigation column width", () => {
    const side = 260;
    const before = side;
    dragDailyEdge(700, HOST, side);
    expect(side).toBe(before);
  });
});

describe("round-trip idempotence", () => {
  it("dragging to the limit and back returns the original width", () => {
    const daily = DEFAULT_DAILY_WIDTH;
    const pinned = dragSideEdge(0, HOST, daily);
    const back = dragSideEdge(pinned + RESIZER_WIDTH, HOST, daily);
    expect(back).toBe(pinned);
  });
});

describe("normalizing persisted widths", () => {
  it("bad data falls back to the default width", () => {
    for (const bad of [null, undefined, NaN, 0, -5, "300"]) {
      expect(normalizeSideWidth(bad)).toBe(DEFAULT_SIDE_WIDTH);
      expect(normalizeDailyWidth(bad)).toBe(DEFAULT_DAILY_WIDTH);
    }
  });

  it("valid pixel values are kept as is (rounded to integers)", () => {
    expect(normalizeSideWidth(301.6)).toBe(302);
    expect(normalizeDailyWidth(480)).toBe(480);
  });
});
