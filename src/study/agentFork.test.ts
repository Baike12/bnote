import { describe, expect, it } from "vitest";
import { forkCutoff, forkLabel } from "./agentFork";

describe("forkCutoff", () => {
  it("takes the count of that message itself (including its own prefix count)", () => {
    const entries = [
      { role: "user" as const, items: 1 },
      { role: "assistant" as const, items: 3 },
      { role: "user" as const, items: 4 },
    ];
    expect(forkCutoff(entries, 1)).toBe(3);
    expect(forkCutoff(entries, 2)).toBe(4);
  });

  it("falls back to the nearest message that has a count when the count is missing", () => {
    const entries = [
      { role: "user" as const, items: 1 },
      { role: "assistant" as const, items: 3 },
      { role: "assistant" as const, items: null },
      { role: "user" as const, items: null },
    ];
    expect(forkCutoff(entries, 3)).toBe(3);
    expect(forkCutoff(entries, 2)).toBe(3);
  });

  it("starts from zero when every count is unknown or the session is empty", () => {
    expect(forkCutoff([{ role: "assistant", items: null }], 0)).toBe(0);
    expect(forkCutoff([], 0)).toBe(0);
  });
});

describe("forkLabel", () => {
  it("takes the first line and truncates it", () => {
    expect(forkLabel("第一行\n第二行")).toBe("第一行");
    // 20 Chinese characters, truncated to 18
    expect(forkLabel("一二三四五六七八九十一二三四五六七八九十继续")).toBe(
      "一二三四五六七八九十一二三四五六七八…",
    );
  });

  it("empty text falls back to a placeholder", () => {
    expect(forkLabel("")).toBe("空消息");
    expect(forkLabel("  \n  ")).toBe("空消息");
  });
});
