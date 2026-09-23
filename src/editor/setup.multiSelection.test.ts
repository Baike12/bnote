import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { baseExtensions } from "./setup";

/**
 * 编辑器必须允许多段选区——这是 vim blockwise（Ctrl-V）的前提。
 * 引擎的块选模型就是"每行一段"：y/d/c/p 靠 Vim.forEachSelection 逐段执行
 * （读 cm.listSelections()），块选的逐行增删也建立在多段之上。CM6 默认关闭
 * allowMultipleSelections，任何多段选区在事务落库时被 tr.newSelection.asSingle()
 * 压成主段——于是块选画满三行、按 y 只复制光标那一行（绘制与复制各说各话）。
 *
 * 门禁锁的是**配置本身**：症状只在真按 y/d 时出现，几何/单测都看不出来，掉了
 * facet 也不会有别的测试变红。
 */

const doc = ["abcdefghij", "klmno", "pqrstuvwxy"].join("\n");

const newState = () =>
  EditorState.create({
    doc,
    extensions: baseExtensions({ onDocChanged() {}, onCursorMoved() {} }),
  });

describe("编辑器配置：多段选区（vim blockwise 的前提）", () => {
  it("逐行三段选区原样落库（不被 asSingle 压成主段，主段下标保持）", () => {
    const next = newState().update({
      selection: EditorSelection.create(
        [
          EditorSelection.range(2, 7),
          EditorSelection.range(13, 16),
          EditorSelection.range(19, 24),
        ],
        2,
      ),
    }).state;
    expect(next.selection.ranges.map((r) => `${r.from}..${r.to}`)).toEqual([
      "2..7",
      "13..16",
      "19..24",
    ]);
    expect(next.selection.mainIndex).toBe(2);
  });

  it("单段选区不受影响（普通编辑/鼠标选择的路径照旧）", () => {
    const next = newState().update({ selection: { anchor: 3, head: 6 } }).state;
    expect(next.selection.ranges.length).toBe(1);
    expect(next.selection.main.from).toBe(3);
    expect(next.selection.main.to).toBe(6);
  });
});
