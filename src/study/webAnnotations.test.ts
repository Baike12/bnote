import { describe, expect, it } from "vitest";
import {
  buildWebAnnotationScript,
  locateQuote,
  mergeUrlAnnotations,
  normalizeWebAnnotations,
  parseWebAnnotationFile,
  withUrlAnnotations,
  type WebAnnotation,
} from "./webAnnotations";

function ann(id: string, quote: string, offset: number, extra: Partial<WebAnnotation> = {}): WebAnnotation {
  return { id, quote, prefix: "", suffix: "", offset, createdAt: 1, ...extra };
}

describe("网页批注锚点", () => {
  it("优先匹配前后文吻合的候选,而不是第一次出现的位置", () => {
    const text = "记忆系统很重要。另起一段,这里说的记忆系统是用户记忆系统。";
    const quote = "记忆系统";
    const offset = text.lastIndexOf("记忆系统");
    const prefix = text.slice(offset - 8, offset);
    const suffix = text.slice(offset + quote.length, offset + quote.length + 6);
    expect(locateQuote(text, quote, 0, prefix, suffix)).toBe(offset);
  });

  it("上下文相同或缺失时,取离原偏移最近的", () => {
    const text = "同一句话 中间隔开 同一句话";
    const second = text.lastIndexOf("同一句话");
    expect(locateQuote(text, "同一句话", second, "", "")).toBe(second);
    expect(locateQuote(text, "同一句话", 0, "", "")).toBe(0);
  });

  it("文本被改动后找不到就返回 -1(批注不丢,只是这一轮不画)", () => {
    expect(locateQuote("改革后的新正文", "记忆系统", 0, "", "")).toBe(-1);
    expect(locateQuote("anything", "", 0, "", "")).toBe(-1);
  });
});

describe("网页批注数据", () => {
  it("校验页面送来的字段,按 id 去重,裁剪超长引用", () => {
    const out = normalizeWebAnnotations([
      ann("a", "x", 3),
      ann("a", "重复", 4),
      { id: "b", quote: "q".repeat(5000), offset: 1 },
      { id: "c", quote: "", offset: 1 },
      { id: "d", quote: "x", offset: -1 },
      "nope",
    ]);
    expect(out.map((a) => a.id)).toEqual(["a", "b"]);
    expect(out[1].quote.length).toBe(2000);
  });

  it("按 URL 写入/清空不串数据", () => {
    const a = withUrlAnnotations({ version: 1, urls: {} }, "https://a", [ann("1", "q", 0)]);
    const b = withUrlAnnotations(a, "https://b", [ann("2", "q", 0)]);
    expect(Object.keys(b.urls).sort()).toEqual(["https://a", "https://b"]);
    expect(Object.keys(withUrlAnnotations(b, "https://a", []).urls)).toEqual(["https://b"]);
    expect(a.urls["https://a"]).toHaveLength(1);
  });

  it("坏文件退回空库", () => {
    expect(parseWebAnnotationFile("{oops")).toEqual({ version: 1, urls: {} });
    expect(parseWebAnnotationFile(JSON.stringify({ version: 1, urls: { x: [ann("1", "q", 0)] } }))).toEqual({
      version: 1,
      urls: { x: [ann("1", "q", 0)] },
    });
  });

  it("合并按 id 取并集,页面里的覆盖仓库里的", () => {
    const merged = mergeUrlAnnotations(
      [ann("a", "old", 0), ann("b", "keep", 1)],
      [ann("a", "new", 0), ann("c", "add", 2)],
    );
    expect(merged.map((a) => `${a.id}:${a.quote}`)).toEqual(["a:new", "b:keep", "c:add"]);
  });
});

describe("注入脚本", () => {
  it("可编译,且带齐运行时入口", () => {
    const script = buildWebAnnotationScript();
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain("__bnoteAnno");
    expect(script).toContain("bnote-anno:");
    expect(script).toContain("setMode");
    expect(script).toContain("merge");
    // 纯函数被序列化进页面,不能残留模块级常量名。
    expect(script).not.toContain("MAX_WEB_QUOTE");
  });

  it("序列化后的纯函数在空作用域里可独立运行", () => {
    const isolatedLocate = new Function(`return (${locateQuote.toString()});`)() as typeof locateQuote;
    expect(isolatedLocate("abc记忆系统def", "记忆系统", 0, "", "")).toBe(3);
    const isolatedNormalize = new Function(
      `return (${normalizeWebAnnotations.toString()});`,
    )() as typeof normalizeWebAnnotations;
    expect(isolatedNormalize([{ id: "a", quote: "q", offset: 0 }])).toHaveLength(1);
  });
});
