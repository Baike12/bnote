import { describe, expect, it } from "vitest";
import { parseMinutesDraft } from "./duration";

/**
 * Regression: the digit in the input could not be deleted; the root cause is
 * "cleared → Number('') === 0 → normalized to 1". Draft parsing must treat an
 * empty string as "invalid", not as "0 minutes".
 */
describe("分钟输入的草稿解析", () => {
  it("空串/空白不是时长:保留原值,不能被夹成 1", () => {
    expect(parseMinutesDraft("")).toBeNull();
    expect(parseMinutesDraft("   ")).toBeNull();
  });

  it("正常输入:取整,前后空格无所谓", () => {
    expect(parseMinutesDraft("25")).toBe(25);
    expect(parseMinutesDraft(" 30 ")).toBe(30);
    expect(parseMinutesDraft("12.9")).toBe(12);
  });

  it("越界夹进 1..180", () => {
    expect(parseMinutesDraft("0")).toBe(1);
    expect(parseMinutesDraft("-5")).toBe(1);
    expect(parseMinutesDraft("999")).toBe(180);
  });

  it("非法输入保留原值(返回 null)", () => {
    expect(parseMinutesDraft("abc")).toBeNull();
    expect(parseMinutesDraft("-")).toBeNull();
    expect(parseMinutesDraft("Infinity")).toBeNull();
  });
});
