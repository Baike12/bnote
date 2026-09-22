import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { scanMath } from "./mathScan";

function regions(doc: string) {
  return scanMath(EditorState.create({ doc }).doc);
}

const display = (doc: string) => regions(doc).filter((r) => r.display);

/** 正文片段是否被吞进任何公式区域(防"正文被吞"的核心断言)。 */
const insideAny = (doc: string, needle: string) => {
  const at = doc.indexOf(needle);
  return regions(doc).some((r) => at >= r.from && at + needle.length <= r.to);
};

describe("scanMath 块公式配对", () => {
  it("正常块公式照常识别", () => {
    const rs = display("$$\nx=1\n$$\n后面");
    expect(rs).toEqual([{ from: 0, to: 9, display: true, content: "\nx=1\n" }]);
  });

  it("多段落文档里各自配对的公式互不干扰", () => {
    const rs = display("$$\na\n$$\n\n文字\n\n$$\nb\n$$\n\n结尾");
    expect(rs.map((r) => r.content)).toEqual(["\na\n", "\nb\n"]);
  });

  it("开头空行的块照常渲染(打字流:$$ 后连按两次回车再写公式)", () => {
    const rs = display("$$\n\nE=mc^2\n$$\n\n正文");
    expect(rs).toEqual([{ from: 0, to: 13, display: true, content: "\n\nE=mc^2\n" }]);
  });

  it("正文后补空行的块仍是公式:$$\\nx=1\\n\\n$$", () => {
    const rs = display("$$\nx=1\n\n$$\n后面");
    expect(rs).toEqual([{ from: 0, to: 10, display: true, content: "\nx=1\n\n" }]);
  });

  it("空块 $$\\n\\n$$ 仍是公式(IME 跟随与空块渲染依赖它)", () => {
    const rs = display("$$\n\n$$\n后面");
    expect(rs).toEqual([{ from: 0, to: 6, display: true, content: "\n\n" }]);
  });

  it("两侧都留空 = 正文被夹的错位产物,拒绝配对且不吞正文(整体保持普通文本)", () => {
    const doc = "$$\na\n\nb\n$$\n后面";
    expect(display(doc)).toHaveLength(0);
    expect(insideAny(doc, "a")).toBe(false);
    expect(insideAny(doc, "b")).toBe(false);
  });

  it("删掉一个 $$ 后:错位产物不渲染,下方完好公式仍整体配对渲染(公式怪不再移位)", () => {
    // 用户场景:四个 $$ 删掉一个,栈式配对让 m1-m2 被拒,m2-m3(完好公式)照常成对
    const doc = "因为\n1\n$$\n\n后面段落A\n\n$$\n.x\n$$\n\n结尾";
    const rs = display(doc);
    expect(rs.map((r) => r.content)).toEqual(["\n.x\n"]);
    expect(insideAny(doc, "后面段落A")).toBe(false);
    expect(insideAny(doc, "结尾")).toBe(false);
  });

  it("在已有公式上方打字:下方完好公式不受影响,上方闭合后照常配对", () => {
    const doc = "$$\nE\n\n正文\n\n$$\nF\n$$";
    const rs = display(doc);
    expect(rs.map((r) => r.content)).toEqual(["\nF\n"]);
    expect(insideAny(doc, "正文")).toBe(false);
    // 上方补上闭合 $$ 后,打字中的公式也整体配对渲染
    expect(display("$$\nE\n$$\n\n正文\n\n$$\nF\n$$").map((r) => r.content)).toEqual([
      "\nE\n",
      "\nF\n",
    ]);
  });

  it("落单 $$ 只渲染到段落末尾,不吞后续段落", () => {
    const doc = "$$\nx=1\n\n后面文字";
    const rs = display(doc);
    expect(rs).toEqual([{ from: 0, to: 6, display: true, content: "\nx=1" }]);
    expect(doc.indexOf("后面文字")).toBeGreaterThan(rs[0].to - 1);
  });

  it("落单 $$ 后紧跟空行:区域只含 $$ 本身,不越过行尾(行内替换装饰不得跨行)", () => {
    const rs = display("a\n\n$$\n\n结尾");
    expect(rs).toEqual([{ from: 3, to: 5, display: true, content: "" }]);
    expect(insideAny("a\n\n$$\n\n结尾", "结尾")).toBe(false);
  });

  it("未配对 $$ 且其后没有空行:维持到文档末尾(打字中的公式保持实时渲染)", () => {
    const rs = display("前文\n\n$$\nx=1");
    expect(rs).toEqual([{ from: 4, to: 10, display: true, content: "\nx=1" }]);
  });
});

describe("scanMath 既有行为不回归", () => {
  it("转义的 \\$\\$ 不是定界符", () => {
    expect(regions("\\$\\$ 不是公式")).toHaveLength(0);
  });

  it("行内公式照常", () => {
    const rs = regions("因为 $x_1$ 文字");
    expect(rs).toEqual([{ from: 3, to: 8, display: false, content: "x_1" }]);
  });

  it("行内的公式不因块级防护丢失", () => {
    // 错位配对被拒后,该行文本回归普通行,行内公式照常识别
    const doc = "值 $a$ 与 $b$\n\n$$\n\n后面";
    const rs = regions(doc);
    expect(rs.some((r) => r.content === "a" && !r.display)).toBe(true);
    expect(rs.some((r) => r.content === "b" && !r.display)).toBe(true);
  });
});
