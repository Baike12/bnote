import { beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { compileSnippets, findSnippet, parseReplacement, reloadSnippets } from "./engine";
import { LATEX_SUITE_WORD_DELIMITERS } from "./config";
import { DEFAULT_SNIPPETS } from "./default-snippets";
import type { RawSnippet } from "./default-snippets";

/** 测试用最小片段集,避免依赖内置全集的具体内容。 */
const FIXTURE: RawSnippet[] = [
  { trigger: "dm", replacement: "$$\n$0\n$$", options: "tAw" },
  { trigger: "(", replacement: "($0)$1", options: "mA" },
  { trigger: "bf", replacement: "\\mathbf{$0}$1", options: "mA" },
  { trigger: "([a-zA-Z])hat", replacement: "\\hat{[[0]]}", options: "rmA" },
];

beforeEach(() => {
  reloadSnippets(FIXTURE, true);
});

const state = (doc: string, cursor?: number) =>
  EditorState.create({ doc, selection: { anchor: cursor ?? doc.length } });

describe("findSnippet:w 片段的词边界", () => {
  it("行首输入 dm 是词边界——必须展开(回归:换行曾是边界集合外的字符)", () => {
    // 用户真实场景:上一行是正文,新行行首打 dm 起公式块
    const m = findSnippet(state("正文\n\ndm"), 6, "m", { auto: true, visualText: null });
    expect(m?.snippet.trigger).toBe("dm");
  });

  it("dm 在文档开头同样展开", () => {
    const m = findSnippet(state("dm"), 2, "m", { auto: true, visualText: null });
    expect(m?.snippet.trigger).toBe("dm");
  });

  it("dm 后面跟着换行(行尾输入)也是边界", () => {
    const m = findSnippet(state("dm\n下一行"), 2, "m", { auto: true, visualText: null });
    expect(m?.snippet.trigger).toBe("dm");
  });

  it("字母贴着字母(xdm)不是边界,不展开", () => {
    const m = findSnippet(state("xdm"), 3, "m", { auto: true, visualText: null });
    expect(m).toBeNull();
  });

  it("CJK 邻接是边界(中文后打 dm 展开)", () => {
    const m = findSnippet(state("公式dm"), 4, "m", { auto: true, visualText: null });
    expect(m?.snippet.trigger).toBe("dm");
  });
});

describe("findSnippet:模式上下文", () => {
  it("数学态内 ( 自动展开为配对括号", () => {
    // 行内公式 $x()$:光标在刚键入的 ( 之后(位置 3),区域完整(闭 $ 在后)
    const m = findSnippet(state("$x()$", 3), 3, "(", { auto: true, visualText: null });
    expect(m?.snippet.trigger).toBe("(");
    expect(m?.start).toBe(2);
    expect(m?.replacement.text).toBe("()");
  });

  it("正文里的 ( 不展开(mA 只在数学态)", () => {
    const m = findSnippet(state("普通(x", 4), 4, "(", { auto: true, visualText: null });
    expect(m).toBeNull();
  });

  it("正则触发器锚定在光标前:数学态内字母+hat 展开重音", () => {
    // rmA 的 m = 数学态:行内公式里的 x|hat 触发
    const m = findSnippet(state("$xhat$", 5), 5, "t", { auto: true, visualText: null });
    expect(m?.replacement.text).toBe("\\hat{x}");
    expect(m?.start).toBe(1);
  });

  it("手动展开(Tab 路径):非 auto 上下文下 typedKey=null 也要能命中", () => {
    const m = findSnippet(state("dm", 2), 2, null, { auto: false, visualText: null });
    expect(m?.snippet.trigger).toBe("dm");
  });
});

describe("parseReplacement:制表位与转义", () => {
  it("$0/$1 产出空制表位", () => {
    const r = parseReplacement("($0)$1", [], null);
    expect(r.text).toBe("()");
    expect(r.stops).toEqual([
      { index: 0, from: 1, to: 1 },
      { index: 1, from: 2, to: 2 },
    ]);
  });

  it("${0:默认值} 带占位文本", () => {
    const r = parseReplacement("\\sum_{${0:i}=${1:1}}^{${2:N}} $3", [], null);
    expect(r.text).toBe("\\sum_{i=1}^{N} ");
    expect(r.stops).toEqual([
      { index: 0, from: 6, to: 7 },
      { index: 1, from: 8, to: 9 },
      { index: 2, from: 12, to: 13 },
      { index: 3, from: 15, to: 15 },
    ]);
  });

  it("[[n]] 引用正则捕获组,\\[[0]] 是字面反斜杠+组引用", () => {
    expect(parseReplacement("\\hat{[[0]]}", ["x"], null).text).toBe("\\hat{x}");
    expect(parseReplacement("\\[\\[0]]", ["x"], null).text).toBe("\\[\\[0]]");
  });

  it("\\$ 与 \\\\ 是转义,其余 \\x 保留反斜杠", () => {
    expect(parseReplacement("\\$0", [], null).text).toBe("$0");
    expect(parseReplacement("\\\\", [], null).text).toBe("\\");
    expect(parseReplacement("\\vec{", [], null).text).toBe("\\vec{");
  });

  it("${VISUAL} 取选中文本,无选区时空串", () => {
    expect(parseReplacement("(${VISUAL})", [], "a+b").text).toBe("(a+b)");
    expect(parseReplacement("(${VISUAL})", [], null).text).toBe("()");
  });
});

describe("compileSnippets:排序契约", () => {
  it("priority 降序,同级长触发器优先(正则最后)", () => {
    const { list } = compileSnippets([
      { trigger: "a", replacement: "1", options: "tA" },
      { trigger: "abc", replacement: "2", options: "tA" },
      { trigger: /ab/, replacement: "3", options: "rA" },
      { trigger: "abx", replacement: "4", options: "tA", priority: 1 },
    ]);
    expect(list.map((s) => s.displayTrigger)).toEqual(["abx", "abc", "a", "ab"]);
  });
});

describe("函数型 replacement(latex-suite 语义)", () => {
  const load = (s: RawSnippet[]) => reloadSnippets(s, true);

  it("正则触发:入参是 exec 结果数组,match[1] 就是第 1 个捕获组", () => {
    load([{ trigger: /iden(\d)/, replacement: (m) => `n=${(m as RegExpExecArray)[1]}`, options: "mA" }]);
    const m = findSnippet(state("$iden3$", 6), 6, "3", { auto: true, visualText: null });
    expect(m?.replacement.text).toBe("n=3");
  });

  it("字符串触发:入参是 trigger 本身", () => {
    load([{ trigger: "zz", replacement: (m) => `[${String(m)}]`, options: "mA" }]);
    const m = findSnippet(state("$zz$", 3), 3, "z", { auto: true, visualText: null });
    expect(m?.replacement.text).toBe("[zz]");
  });

  it("可视片段:入参是选中的文本", () => {
    load([{ trigger: "(", replacement: (m) => `(${String(m)})`, options: "mAv" }]);
    const m = findSnippet(state("$($"), 2, "(", { auto: false, visualText: "a+b" });
    expect(m?.replacement.text).toBe("(a+b)");
  });

  it("返回值里的制表位照常解析($0 有落点)", () => {
    load([{ trigger: "hh", replacement: () => "\\hat{$0}$1", options: "mA" }]);
    const m = findSnippet(state("$hh$", 3), 3, "h", { auto: true, visualText: null });
    expect(m?.replacement.text).toBe("\\hat{}");
    expect(m?.replacement.stops).toEqual([
      { index: 0, from: 5, to: 5 },
      { index: 1, from: 6, to: 6 },
    ]);
  });

  it("返回非字符串=该片段不匹配(交回下一个候选)", () => {
    load([
      { trigger: "kk", replacement: (() => undefined) as unknown as RawSnippet["replacement"], options: "mA" },
      { trigger: "kk", replacement: "fallback", options: "mA" },
    ]);
    const m = findSnippet(state("$kk$", 3), 3, "k", { auto: true, visualText: null });
    expect(m?.replacement.text).toBe("fallback");
  });

  it("内置 iden3 生成 3×3 单位阵(插件里唯一那条函数型片段)", () => {
    load(DEFAULT_SNIPPETS);
    const m = findSnippet(state("$iden3$", 6), 6, "3", { auto: true, visualText: null });
    expect(m?.replacement.text).toBe(
      "\\begin{pmatrix}\n1 & 0 & 0 \\\\\n0 & 1 & 0 \\\\\n0 & 0 & 1\n\\end{pmatrix}",
    );
  });
});

describe("removeSnippetWhitespace(仅行内公式)", () => {
  it("行内公式里去掉尾部空格", () => {
    reloadSnippets([{ trigger: "sp", replacement: "a ", options: "mA" }], true);
    const m = findSnippet(state("$sp$", 3), 3, "p", { auto: true, visualText: null });
    expect(m?.replacement.text).toBe("a");
  });

  it("行内公式里 `${n}` 制表位前的空格去掉、制表位保留", () => {
    reloadSnippets([{ trigger: "tu", replacement: "a x $2", options: "mA" }], true);
    const m = findSnippet(state("$tu$", 3), 3, "u", { auto: true, visualText: null });
    expect(m?.replacement.text).toBe("a x");
  });

  it("块级公式里不动(换行前的空格是排版的一部分)", () => {
    reloadSnippets([{ trigger: "sp", replacement: "a ", options: "MA" }], true);
    const m = findSnippet(state("$$\nsp\n$$"), 5, "p", { auto: true, visualText: null });
    expect(m?.replacement.text).toBe("a ");
  });

  it("可关闭(设置关掉后原样展开)", () => {
    reloadSnippets([{ trigger: "sp", replacement: "a ", options: "mA" }], true);
    const m = findSnippet(state("$sp$", 3), 3, "p", {
      auto: true,
      visualText: null,
      removeSnippetWhitespace: false,
    });
    expect(m?.replacement.text).toBe("a ");
  });
});

describe("wordDelimiters 可配", () => {
  const load = () => reloadSnippets([{ trigger: "dm", replacement: "x", options: "tAw" }], true);

  it("默认用插件的分隔符集:* 不在其中 → *dm 不展开", () => {
    load();
    const m = findSnippet(state("*dm"), 3, "m", { auto: true, visualText: null });
    expect(m).toBeNull();
  });

  it("把分隔符集放宽:* 也算边界 → 同一位置展开", () => {
    load();
    const m = findSnippet(state("*dm"), 3, "m", {
      auto: true,
      visualText: null,
      wordDelimiters: "*",
    });
    expect(m?.snippet.trigger).toBe("dm");
  });

  it("设置串里的字面 \\n 还原成真换行(行首 dm 仍是边界)", () => {
    load();
    const m = findSnippet(state("正文\ndm"), 5, "m", {
      auto: true,
      visualText: null,
      wordDelimiters: LATEX_SUITE_WORD_DELIMITERS,
    });
    expect(m?.snippet.trigger).toBe("dm");
  });

  it("CJK 邻接始终是边界(与分隔符集无关,中文笔记必需)", () => {
    load();
    const m = findSnippet(state("测试dm"), 4, "m", {
      auto: true,
      visualText: null,
      wordDelimiters: "",
    });
    expect(m?.snippet.trigger).toBe("dm");
  });
});
