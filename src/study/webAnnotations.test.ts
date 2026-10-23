import { describe, expect, it } from "vitest";
import {
  buildWebAnnotationScript,
  locateQuote,
  mergeUrlAnnotations,
  normalizeWebAnnotations,
  parseWebAnnotationFile,
  parseWebAnnotations,
  webAnnotationFileName,
  webAnnotationRelPath,
  type WebAnnotation,
} from "./webAnnotations";
import { normalizePageStep, snapScrollTopToLine } from "./reading";

function ann(id: string, quote: string, offset: number, extra: Partial<WebAnnotation> = {}): WebAnnotation {
  return {
    id,
    quote,
    prefix: "",
    suffix: "",
    offset,
    kind: "highlight",
    text: "",
    createdAt: 1,
    ...extra,
  };
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
    // 旧数据没有 kind/text:按高亮读,文字为空。
    expect(out[0].kind).toBe("highlight");
    expect(out[0].text).toBe("");
  });

  it("文字批注的 kind/text 原样保留,超长文字裁剪", () => {
    const out = normalizeWebAnnotations([
      ann("n", "q", 0, { kind: "note", text: "这是一条批注" }),
      { id: "long", quote: "q", offset: 0, kind: "note", text: "字".repeat(3000) },
      { id: "bad", quote: "q", offset: 0, kind: "weird", text: 42 },
    ]);
    expect(out[0]).toMatchObject({ kind: "note", text: "这是一条批注" });
    expect(out[1].text.length).toBe(2000);
    // 未知 kind 退回高亮,非字符串 text 归空。
    expect(out[2]).toMatchObject({ kind: "highlight", text: "" });
  });

  it("一个网址一个文件:同一网址稳定,不同网址分开", () => {
    const a = "https://example.com/a?x=1";
    const b = "https://example.com/b?x=1";
    expect(webAnnotationFileName(a)).toBe(webAnnotationFileName(a));
    expect(webAnnotationFileName(a)).not.toBe(webAnnotationFileName(b));
    expect(webAnnotationFileName(a)).toMatch(/^example\.com-[a-z0-9]+\.json$/);
    expect(webAnnotationRelPath(a)).toMatch(/^web-annotations\/example\.com-/);
    expect(webAnnotationFileName("not a url")).toMatch(/^page-[a-z0-9]+\.json$/);
  });

  it("坏文件退回空库;文件里的网址与批注都按字段校验", () => {
    expect(parseWebAnnotationFile("{oops")).toEqual({
      version: 1,
      url: "",
      annotations: [],
    });
    const file = parseWebAnnotationFile(
      JSON.stringify({
        version: 1,
        url: "https://a",
        annotations: [ann("1", "q", 0), { id: "bad" }],
      }),
    );
    expect(file.url).toBe("https://a");
    expect(file.annotations.map((a) => a.id)).toEqual(["1"]);
    expect(parseWebAnnotations(JSON.stringify({ annotations: [ann("2", "x", 1)] }))).toHaveLength(1);
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
    // 翻页入口与主窗口推送步长/键位的通道。
    expect(script).toContain("__bnoteReader");
    expect(script).toContain("setStep");
    expect(script).toContain("setKeys");
    expect(script).toContain("bnote-read-shade-host");
    expect(script).toContain("snapScrollTopToLine");
    // 文字批注(页内批注卡)与阅读位置、笔形光标。
    expect(script).toContain("bnote:web-position:v1:");
    expect(script).toContain("scheduleRestore");
    expect(script).toContain("data:image/png;base64");
    expect(script).toContain("bnote-annotating");
    expect(script).toContain("cursorHighlight");
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
    const isolatedStep = new Function(
      `return (${normalizePageStep.toString()});`,
    )() as typeof normalizePageStep;
    expect(isolatedStep(undefined)).toBe(0.5);
    const isolatedSnap = new Function(
      `return (${snapScrollTopToLine.toString()});`,
    )() as typeof snapScrollTopToLine;
    expect(
      isolatedSnap(350, 700, 5000, 350, [{ top: 335, bottom: 357 }], 14),
    ).toBe(357);
  });
});
