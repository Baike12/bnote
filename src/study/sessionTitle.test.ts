import { describe, expect, it } from "vitest";
import { cleanGeneratedTitle, displayTitle, firstOwnUserText } from "./sessionTitle";

describe("the session's own first user message", () => {
  const entries = [
    { role: "user", text: "父会话的问题" },
    { role: "assistant", text: "父会话的回答" },
    { role: "user", text: "子会话自己的问题" },
  ];

  it("the main session starts the search from the first message", () => {
    expect(firstOwnUserText(entries, 0)).toBe("父会话的问题");
  });

  it("an auxiliary session skips the prefix copied by the fork", () => {
    expect(firstOwnUserText(entries, 2)).toBe("子会话自己的问题");
  });

  it("an empty string when the session has not sent its own message yet", () => {
    expect(firstOwnUserText(entries, 3)).toBe("");
  });

  it("forkAt out of range (bad record) is clamped to the boundary", () => {
    expect(firstOwnUserText(entries, 99)).toBe("");
    expect(firstOwnUserText(entries, -1)).toBe("父会话的问题");
  });

  it("blank messages are skipped", () => {
    const list = [
      { role: "user", text: "   " },
      { role: "assistant", text: "回答" },
      { role: "user", text: "真正的问题" },
    ];
    expect(firstOwnUserText(list, 0)).toBe("真正的问题");
  });
});

describe("model title cleaning", () => {
  it("paired quotes and book title marks are removed", () => {
    expect(cleanGeneratedTitle('"线性代数的特征值"')).toBe("线性代数的特征值");
    expect(cleanGeneratedTitle("「矩阵乘法与秩」")).toBe("矩阵乘法与秩");
    expect(cleanGeneratedTitle("《算法复杂度》")).toBe("算法复杂度");
  });

  it("a prefix like 「标题：」 is removed", () => {
    expect(cleanGeneratedTitle("标题：傅里叶变换要点")).toBe("傅里叶变换要点");
    expect(cleanGeneratedTitle("会话标题 - 概率论基础")).toBe("概率论基础");
    expect(cleanGeneratedTitle("Title: eigenvalues")).toBe("eigenvalues");
  });

  it("trailing punctuation and extra whitespace are removed", () => {
    expect(cleanGeneratedTitle("  什么是  导数。 ")).toBe("什么是 导数");
    expect(cleanGeneratedTitle("二次型正定性？")).toBe("二次型正定性");
  });

  it("only the first line is taken (the model sometimes adds an explanation)", () => {
    expect(cleanGeneratedTitle("矩阵的秩\n\n这条可以吗?")).toBe("矩阵的秩");
  });

  it("truncated by character, surrogate pairs are never split", () => {
    expect(Array.from(cleanGeneratedTitle("一二三四五六七八九十", 4)).join("")).toBe("一二三四");
    expect(cleanGeneratedTitle("😀😀😀😀😀", 2)).toBe("😀😀");
  });

  it("an empty string after cleaning, the caller keeps its fallback title", () => {
    expect(cleanGeneratedTitle("")).toBe("");
    expect(cleanGeneratedTitle("  \n\t ")).toBe("");
    expect(cleanGeneratedTitle("「」")).toBe("");
  });
});

describe("the display title hierarchy", () => {
  it("an auxiliary session carries the ↳ prefix", () => {
    expect(displayTitle("特征值", true)).toBe("↳ 特征值");
  });

  it("a title that already carries the prefix is not stacked again", () => {
    expect(displayTitle("↳ 特征值", true)).toBe("↳ 特征值");
  });

  it("the main session gets no prefix", () => {
    expect(displayTitle("特征值", false)).toBe("特征值");
  });
});
