import { describe, expect, it } from "vitest";
import { workspaceEditsOf } from "./workspaceEdit";

/**
 * 重命名 / 代码动作的 WorkspaceEdit 解析门禁。
 *
 * 现代语言服务器(typescript-language-server、rust-analyzer、gopls)的
 * rename 回的是 `documentChanges`,不是 `changes`。只认 `changes` 的实现
 * 对着它们一律「重命名失败」,且不报错——这条门禁把这个形状钉住。
 */

const range = (line: number, character: number, endCharacter: number) => ({
  start: { line, character },
  end: { line, character: endCharacter },
});

describe("WorkspaceEdit 解析", () => {
  it("changes 形状", () => {
    const out = workspaceEditsOf({
      changes: {
        "file:///p/a.ts": [{ range: range(0, 0, 3), newText: "foo" }],
      },
    });
    expect(out).toEqual([
      { uri: "file:///p/a.ts", edits: [{ range: range(0, 0, 3), newText: "foo" }] },
    ]);
  });

  it("documentChanges 形状(现代服务器的 rename)", () => {
    const out = workspaceEditsOf({
      documentChanges: [
        {
          textDocument: { uri: "file:///p/b.ts", version: 3 },
          edits: [{ range: range(2, 4, 8), newText: "bar" }],
        },
      ],
    });
    expect(out).toEqual([
      { uri: "file:///p/b.ts", edits: [{ range: range(2, 4, 8), newText: "bar" }] },
    ]);
  });

  it("两种形状同时给时按 uri 合并", () => {
    const out = workspaceEditsOf({
      changes: { "file:///p/a.ts": [{ range: range(0, 0, 1), newText: "x" }] },
      documentChanges: [
        {
          textDocument: { uri: "file:///p/a.ts" },
          edits: [{ range: range(1, 0, 1), newText: "y" }],
        },
        {
          textDocument: { uri: "file:///p/c.ts" },
          edits: [{ range: range(0, 0, 1), newText: "z" }],
        },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out.find((f) => f.uri === "file:///p/a.ts")?.edits).toHaveLength(2);
    expect(out.find((f) => f.uri === "file:///p/c.ts")?.edits).toHaveLength(1);
  });

  it("文件级操作(CreateFile / RenameFile)没有编辑,跳过", () => {
    const out = workspaceEditsOf({
      documentChanges: [
        { kind: "create", uri: "file:///p/d.ts" },
        { kind: "rename", oldUri: "file:///p/e.ts", newUri: "file:///p/f.ts" },
      ],
    });
    expect(out).toEqual([]);
  });

  it("形状不对的编辑逐条丢掉,不影响同文件里合法的那些", () => {
    const out = workspaceEditsOf({
      changes: {
        "file:///p/a.ts": [
          { range: range(0, 0, 1), newText: "ok" },
          { range: { start: { line: 1, character: 0 } }, newText: "缺 end" },
          { range: range(2, 0, 1) }, // 缺 newText
          null,
        ],
      },
    });
    expect(out[0].edits).toEqual([{ range: range(0, 0, 1), newText: "ok" }]);
  });

  it("不是对象的输入不炸", () => {
    expect(workspaceEditsOf(null)).toEqual([]);
    expect(workspaceEditsOf("x")).toEqual([]);
    expect(workspaceEditsOf({})).toEqual([]);
  });
});
