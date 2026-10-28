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
 * 打字机位置的门禁：留白与滚动增量必须由同一个比例推出。
 *
 * 只改上留白或只改滚动目标，会让「首行能停到设定高度」和「末行能停到设定
 * 高度」只剩一个成立——那正是位置设置在文档头尾看不见的原因。
 */
describe("normalizeTypewriterPosition", () => {
  it("旧配置缺项/坏值回落到 50%", () => {
    expect(normalizeTypewriterPosition(undefined)).toBe(0.5);
    expect(normalizeTypewriterPosition(null)).toBe(0.5);
    expect(normalizeTypewriterPosition(Number.NaN)).toBe(0.5);
    expect(normalizeTypewriterPosition("0.3")).toBe(0.5);
  });

  it("越界值夹回 20%–80%", () => {
    expect(normalizeTypewriterPosition(0)).toBe(MIN_TYPEWRITER_POSITION);
    expect(normalizeTypewriterPosition(-1)).toBe(MIN_TYPEWRITER_POSITION);
    expect(normalizeTypewriterPosition(1)).toBe(MAX_TYPEWRITER_POSITION);
    expect(normalizeTypewriterPosition(9)).toBe(MAX_TYPEWRITER_POSITION);
  });

  it("按 1% 取整（滑杆与手改 JSON 同一精度）", () => {
    expect(normalizeTypewriterPosition(0.333)).toBe(0.33);
    expect(normalizeTypewriterPosition(0.666)).toBe(0.67);
    expect(normalizeTypewriterPosition(0.196)).toBe(0.2);
  });
});

describe("typewriterReserve", () => {
  const H = 1000;
  const LH = 20;

  it("50% 与旧的居中留白逐像素一致", () => {
    const { top, bottom } = typewriterReserve(H, LH, DEFAULT_TYPEWRITER_POSITION);
    expect(top).toBe((H - LH) / 2);
    expect(bottom).toBe((H - LH) / 2);
  });

  it("靠上时上留白变小、下留白变大（首末行都能停在同一点）", () => {
    const { top, bottom } = typewriterReserve(H, LH, 0.3);
    expect(top).toBe(0.3 * H - LH / 2);
    expect(bottom).toBe(0.7 * H - LH / 2);
    // 两段留白加一行 = 一屏：文档头尾可滚动的范围刚好把光标送到设定高度
    expect(top + bottom + LH).toBe(H);
  });

  it("越界/坏值按归一化后的比例算", () => {
    expect(typewriterReserve(H, LH, 10)).toEqual(
      typewriterReserve(H, LH, MAX_TYPEWRITER_POSITION),
    );
    expect(typewriterReserve(H, LH, Number.NaN)).toEqual(
      typewriterReserve(H, LH, DEFAULT_TYPEWRITER_POSITION),
    );
  });

  it("视口比一行还矮时留白不为负", () => {
    const { top, bottom } = typewriterReserve(10, 20, 0.5);
    expect(top).toBe(0);
    expect(bottom).toBe(0);
  });
});

describe("typewriterScrollDelta", () => {
  const H = 1000;

  it("50% 时光标行中心对齐屏幕中线", () => {
    expect(typewriterScrollDelta(400, H, 0.5)).toBe(-100);
    expect(typewriterScrollDelta(600, H, 0.5)).toBe(100);
  });

  it("位置越靠上目标越靠上（同一光标需要更小的向下滚动）", () => {
    const caret = 800;
    expect(typewriterScrollDelta(caret, H, 0.3)).toBeGreaterThan(
      typewriterScrollDelta(caret, H, 0.5),
    );
    expect(typewriterScrollDelta(caret, H, 0.7)).toBeLessThan(
      typewriterScrollDelta(caret, H, 0.5),
    );
  });
});
