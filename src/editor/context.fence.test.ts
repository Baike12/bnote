import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { insideFencedCode, insideFencedCodeByScan } from "./context";

/**
 * 「光标在不在围栏代码块内」的共享判定(IME 保持英文、回车续行守卫共用):
 *  - 树就绪:走语法树查询,围栏标记行自身也算块内;
 *  - 树未就绪(文件刚载入,后台解析未完成):退回行扫描,围栏标记行不算。
 *
 * 分层说明:node 环境里语法树在 EditorState.create 时就同步解析完成
 * (无视图便没有后台解析窗口),insideFencedCode 的兜底分支在单测里无法
 * 驱动——扫描语义由纯函数 insideFencedCodeByScan 直接锚定,两条路径的
 * 差异(围栏行自身)在注释与这里的断言里都写死,防止只改一边。
 */

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
  });
}

/** 树就绪路径:建 state 后强制全文解析。 */
function parsedState(doc: string): EditorState {
  const state = makeState(doc);
  ensureSyntaxTree(state, state.doc.length);
  return state;
}

const atLineEnd = (state: EditorState, lineNo: number) => state.doc.line(lineNo).to;
const atLineMid = (state: EditorState, lineNo: number, col: number) =>
  state.doc.line(lineNo).from + col;

describe("insideFencedCode:树就绪(语法树路径)", () => {
  const state = parsedState(
    ["正文一段", "", "```python", "x = 1", "print(x)", "```", "", "~~~ts", "const a = 1;", "~~~", ""].join("\n"),
  );

  it("围栏内容行在内,正文行不在", () => {
    expect(insideFencedCode(state, atLineMid(state, 1, 1))).toBe(false);
    expect(insideFencedCode(state, atLineEnd(state, 4))).toBe(true);
    expect(insideFencedCode(state, atLineEnd(state, 5))).toBe(true);
    expect(insideFencedCode(state, atLineMid(state, 7, 0))).toBe(false); // 空行在两块之间
  });

  it("围栏标记行自身算块内(光标在 ``` 行上敲语言名也是敲代码)", () => {
    expect(insideFencedCode(state, atLineEnd(state, 3))).toBe(true);
    expect(insideFencedCode(state, atLineEnd(state, 6))).toBe(true);
  });

  it("波浪号围栏同样识别;其他语言无关(是块就保持英文)", () => {
    expect(insideFencedCode(state, atLineEnd(state, 9))).toBe(true);
    expect(insideFencedCode(state, atLineEnd(state, 10))).toBe(true);
  });

  it("列表内缩进围栏也算(行首缩进不影响树归属)", () => {
    const indented = parsedState(["- 项目", "", "  ```python", "  x = 1", "  ```"].join("\n"));
    expect(insideFencedCode(indented, atLineEnd(indented, 4))).toBe(true);
    expect(insideFencedCode(indented, atLineEnd(indented, 1))).toBe(false);
  });
});

describe("insideFencedCode:行扫描兜底的纯函数语义", () => {
  // node 里语法树始终同步就绪,insideFencedCode 的兜底分支只能在运行期
  // 触发;这里直接锁住兜底所用的纯函数(与 fenceStateScan 同一扫描模型)。
  const doc = ["```python", "x = 1", "```", "正文", "", "```ts", "const b = 2;"].join("\n");
  const state = makeState(doc);
  const lineLen = (n: number) => state.doc.line(n).to;

  it("内容行在内;开栏行不在(其闭栏行按扫描语义算在内),正文不在", () => {
    expect(insideFencedCodeByScan(state.doc, 1)).toBe(false); // ```python 开栏行:处理到它才开栏
    expect(insideFencedCodeByScan(state.doc, 2)).toBe(true);
    expect(insideFencedCodeByScan(state.doc, 3)).toBe(true); // ``` 闭栏行:该行之前的行仍开着
    expect(insideFencedCodeByScan(state.doc, 4)).toBe(false);
  });

  it("未闭合围栏到文档末尾都在内", () => {
    expect(insideFencedCodeByScan(state.doc, 7)).toBe(true);
  });

  it("与树路径的已知差异只在围栏行自身(树算,扫描不算)", () => {
    expect(insideFencedCode(state, lineLen(1))).toBe(true); // 树:FencedCode 含标记行
    expect(insideFencedCodeByScan(state.doc, 1)).toBe(false); // 扫描:不算
  });
});
