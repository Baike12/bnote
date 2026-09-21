import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { scanMath } from "./mathScan";

function regions(doc: string) {
  return scanMath(EditorState.create({ doc }).doc);
}

const display = (doc: string) => regions(doc).filter((r) => r.display);

describe("scanMath 块公式的错位配对防护", () => {
  it("正常块公式照常识别", () => {
    const rs = display("$$\nx=1\n$$\n后面");
    expect(rs).toEqual([{ from: 0, to: 9, display: true, content: "\nx=1\n" }]);
  });

  it("多段落文档里各自配对的公式互不干扰", () => {
    const rs = display("$$\na\n$$\n\n文字\n\n$$\nb\n$$\n\n结尾");
    expect(rs.map((r) => r.content)).toEqual(["\na\n", "\nb\n"]);
  });

  it("删掉一个 $$ 后的错位配对不吞正文:跨空行的配对按普通文本渲染", () => {
    // 用户场景:四个 $$ 删掉开头一个,剩下的三个错位。原先 m1 与 m2 配对
    // 会把"后面段落A"吞进公式,m3 落单吞到文档结尾——怎么删都"删不掉"。
    const doc = "因为\n1\n$$\n\n后面段落A\n\n$$\n.x\n$$\n\n结尾";
    const rs = display(doc);
    // 只剩落单 $$ 的段落级区域(.x 那段)
    expect(rs).toHaveLength(1);
    expect(rs[0].content).not.toContain("后面段落A");
    const inside = (needle: string) =>
      regions(doc).some((r) => {
        const at = doc.indexOf(needle);
        return at >= r.from && at + needle.length <= r.to;
      });
    expect(inside("后面段落A")).toBe(false);
    expect(inside("结尾")).toBe(false);
  });

  it("空块 $$\\n\\n$$ 仍是公式(IME 跟随与空块渲染依赖它)", () => {
    const rs = display("$$\n\n$$\n后面");
    expect(rs).toEqual([{ from: 0, to: 6, display: true, content: "\n\n" }]);
  });

  it("正文后补空行的块仍是公式:$$\\nx=1\\n\\n$$", () => {
    const rs = display("$$\nx=1\n\n$$\n后面");
    expect(rs).toEqual([{ from: 0, to: 10, display: true, content: "\nx=1\n\n" }]);
  });

  it("正文被空行夹在中间的配对按错位处理(防护的代价,写明)", () => {
    // 偶数个 $$ 全部配对,配对本身含空行夹正文 → 拒绝,无区域
    expect(display("$$\na\n\nb\n$$\n后面")).toHaveLength(0);
  });

  it("落单 $$ 只渲染到段落末尾,不吞后续段落", () => {
    const doc = "$$\nx=1\n\n后面文字";
    const rs = display(doc);
    expect(rs).toEqual([{ from: 0, to: 6, display: true, content: "\nx=1" }]);
    expect(doc.indexOf("后面文字")).toBeGreaterThan(rs[0].to - 1);
  });

  it("落单 $$ 的区域不越过行尾(单行时行内替换装饰不得跨行)", () => {
    // "$$" 后直接跟空行:区域只含 $$ 本身,恰好止于行尾
    const rs = display("a\n\n$$\n\n结尾");
    expect(rs).toEqual([{ from: 3, to: 5, display: true, content: "" }]);
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
