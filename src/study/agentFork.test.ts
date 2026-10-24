import { describe, expect, it } from "vitest";
import { forkCutoff, forkLabel } from "./agentFork";

describe("forkCutoff", () => {
  it("取该消息自己的计数(含本条的前缀条数)", () => {
    const entries = [
      { role: "user" as const, items: 1 },
      { role: "assistant" as const, items: 3 },
      { role: "user" as const, items: 4 },
    ];
    expect(forkCutoff(entries, 1)).toBe(3);
    expect(forkCutoff(entries, 2)).toBe(4);
  });

  it("计数缺失时退到最近一条有计数的消息", () => {
    const entries = [
      { role: "user" as const, items: 1 },
      { role: "assistant" as const, items: 3 },
      { role: "assistant" as const, items: null },
      { role: "user" as const, items: null },
    ];
    expect(forkCutoff(entries, 3)).toBe(3);
    expect(forkCutoff(entries, 2)).toBe(3);
  });

  it("全部未知 / 空会话时从零开始", () => {
    expect(forkCutoff([{ role: "assistant", items: null }], 0)).toBe(0);
    expect(forkCutoff([], 0)).toBe(0);
  });
});

describe("forkLabel", () => {
  it("取首行并截断", () => {
    expect(forkLabel("第一行\n第二行")).toBe("第一行");
    // 20 个汉字,截到 18 个
    expect(forkLabel("一二三四五六七八九十一二三四五六七八九十继续")).toBe(
      "一二三四五六七八九十一二三四五六七八…",
    );
  });

  it("空文本回退占位", () => {
    expect(forkLabel("")).toBe("空消息");
    expect(forkLabel("  \n  ")).toBe("空消息");
  });
});
