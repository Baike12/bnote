import { describe, expect, it } from "vitest";
import { parseMinutesDraft } from "./duration";

/**
 * Regression: the digit in the input could not be deleted; the root cause is
 * "cleared → Number('') === 0 → normalized to 1". Draft parsing must treat an
 * empty string as "invalid", not as "0 minutes".
 */
describe("draft parsing of the minutes input", () => {
  it("an empty or blank string is not a duration: the original value is kept, it must not be clamped to 1", () => {
    expect(parseMinutesDraft("")).toBeNull();
    expect(parseMinutesDraft("   ")).toBeNull();
  });

  it("normal input: rounded, the spaces around it do not matter", () => {
    expect(parseMinutesDraft("25")).toBe(25);
    expect(parseMinutesDraft(" 30 ")).toBe(30);
    expect(parseMinutesDraft("12.9")).toBe(12);
  });

  it("out of range values are clamped into 1..180", () => {
    expect(parseMinutesDraft("0")).toBe(1);
    expect(parseMinutesDraft("-5")).toBe(1);
    expect(parseMinutesDraft("999")).toBe(180);
  });

  it("invalid input keeps the original value (returns null)", () => {
    expect(parseMinutesDraft("abc")).toBeNull();
    expect(parseMinutesDraft("-")).toBeNull();
    expect(parseMinutesDraft("Infinity")).toBeNull();
  });
});
