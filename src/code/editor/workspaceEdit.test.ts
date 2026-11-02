import { describe, expect, it } from "vitest";
import { workspaceEditsOf } from "./workspaceEdit";

/**
 * The gate of the WorkspaceEdit parsing for rename / code actions.
 *
 * The rename of a modern language server (typescript-language-server,
 * rust-analyzer, gopls) answers with `documentChanges`, not `changes`. An
 * implementation that only knows `changes` reports "rename failed" against
 * all of them without any error — this gate pins that shape down.
 */

const range = (line: number, character: number, endCharacter: number) => ({
  start: { line, character },
  end: { line, character: endCharacter },
});

describe("WorkspaceEdit parsing", () => {
  it("the changes shape", () => {
    const out = workspaceEditsOf({
      changes: {
        "file:///p/a.ts": [{ range: range(0, 0, 3), newText: "foo" }],
      },
    });
    expect(out).toEqual([
      { uri: "file:///p/a.ts", edits: [{ range: range(0, 0, 3), newText: "foo" }] },
    ]);
  });

  it("the documentChanges shape (rename from a modern server)", () => {
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

  it("when both shapes are given they are merged by uri", () => {
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

  it("file-level operations (CreateFile / RenameFile) carry no edits and are skipped", () => {
    const out = workspaceEditsOf({
      documentChanges: [
        { kind: "create", uri: "file:///p/d.ts" },
        { kind: "rename", oldUri: "file:///p/e.ts", newUri: "file:///p/f.ts" },
      ],
    });
    expect(out).toEqual([]);
  });

  it("edits with a malformed shape are dropped one by one, leaving the valid ones in the same file", () => {
    const out = workspaceEditsOf({
      changes: {
        "file:///p/a.ts": [
          { range: range(0, 0, 1), newText: "ok" },
          { range: { start: { line: 1, character: 0 } }, newText: "缺 end" },
          { range: range(2, 0, 1) }, // missing newText
          null,
        ],
      },
    });
    expect(out[0].edits).toEqual([{ range: range(0, 0, 1), newText: "ok" }]);
  });

  it("input that is not an object does not throw", () => {
    expect(workspaceEditsOf(null)).toEqual([]);
    expect(workspaceEditsOf("x")).toEqual([]);
    expect(workspaceEditsOf({})).toEqual([]);
  });
});
