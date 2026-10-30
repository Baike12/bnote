import { describe, expect, it } from "vitest";
import { cleanGeneratedTitle, displayTitle, firstOwnUserText } from "./sessionTitle";

describe("会话自有第一条用户消息", () => {
  const entries = [
    { role: "user", text: "父会话的问题" },
    { role: "assistant", text: "父会话的回答" },
    { role: "user", text: "子会话自己的问题" },
  ];

  it("主会话从第一条开始找", () => {
    expect(firstOwnUserText(entries, 0)).toBe("父会话的问题");
  });

  it("辅助会话跳过分叉复制的前缀", () => {
    expect(firstOwnUserText(entries, 2)).toBe("子会话自己的问题");
  });

  it("自己的消息还没发出时返回空串", () => {
    expect(firstOwnUserText(entries, 3)).toBe("");
  });

  it("forkAt 越界(坏记录)按边界夹住", () => {
    expect(firstOwnUserText(entries, 99)).toBe("");
    expect(firstOwnUserText(entries, -1)).toBe("父会话的问题");
  });

  it("跳过空白消息", () => {
    const list = [
      { role: "user", text: "   " },
      { role: "assistant", text: "回答" },
      { role: "user", text: "真正的问题" },
    ];
    expect(firstOwnUserText(list, 0)).toBe("真正的问题");
  });
});

describe("模型标题清洗", () => {
  it("去掉成对引号与书名号", () => {
    expect(cleanGeneratedTitle('"线性代数的特征值"')).toBe("线性代数的特征值");
    expect(cleanGeneratedTitle("「矩阵乘法与秩」")).toBe("矩阵乘法与秩");
    expect(cleanGeneratedTitle("《算法复杂度》")).toBe("算法复杂度");
  });

  it("去掉「标题：」这类前缀", () => {
    expect(cleanGeneratedTitle("标题：傅里叶变换要点")).toBe("傅里叶变换要点");
    expect(cleanGeneratedTitle("会话标题 - 概率论基础")).toBe("概率论基础");
    expect(cleanGeneratedTitle("Title: eigenvalues")).toBe("eigenvalues");
  });

  it("去句末标点与多余空白", () => {
    expect(cleanGeneratedTitle("  什么是  导数。 ")).toBe("什么是 导数");
    expect(cleanGeneratedTitle("二次型正定性？")).toBe("二次型正定性");
  });

  it("只取第一行(模型偶尔带解释)", () => {
    expect(cleanGeneratedTitle("矩阵的秩\n\n这条可以吗?")).toBe("矩阵的秩");
  });

  it("按字符截断,不切坏代理对", () => {
    expect(Array.from(cleanGeneratedTitle("一二三四五六七八九十", 4)).join("")).toBe("一二三四");
    expect(cleanGeneratedTitle("😀😀😀😀😀", 2)).toBe("😀😀");
  });

  it("清洗后为空返回空串,调用方保留兜底标题", () => {
    expect(cleanGeneratedTitle("")).toBe("");
    expect(cleanGeneratedTitle("  \n\t ")).toBe("");
    expect(cleanGeneratedTitle("「」")).toBe("");
  });
});

describe("展示标题层级", () => {
  it("辅助会话带 ↳ 前缀", () => {
    expect(displayTitle("特征值", true)).toBe("↳ 特征值");
  });

  it("已带前缀不重复叠", () => {
    expect(displayTitle("↳ 特征值", true)).toBe("↳ 特征值");
  });

  it("主会话不加前缀", () => {
    expect(displayTitle("特征值", false)).toBe("特征值");
  });
});
