import { describe, expect, it } from "vitest";
import { DEFAULT_BINDINGS, bindingsForCommand } from "./keys";

/**
 * ⌘⇧O 的唯一归属门禁:只有「打开今日日记」能拿这个键位。它此前属于
 * workspace.open-vault——任何人再把别的命令绑到 ⌘⇧O,这条会拦下来(键位重复
 * 由窗口级分发的命令顺序决定,静默抢占比报错更难查)。
 */
describe("默认键位", () => {
  it("Mod-Shift-o 归 workspace.open-daily,且无人与之重复", () => {
    expect(bindingsForCommand("workspace.open-daily")).toEqual(["Mod-Shift-o"]);
    const others = Object.entries(DEFAULT_BINDINGS).filter(
      ([id, key]) => id !== "workspace.open-daily" && key === "Mod-Shift-o",
    );
    expect(others).toEqual([]);
  });

  it("workspace.open-vault 不再占 Mod-Shift-o(仍可从命令面板调用)", () => {
    expect(bindingsForCommand("workspace.open-vault")).toEqual([]);
  });

  it("Mod-Shift-b 归 edit.insert-callout,且无人与之重复", () => {
    expect(bindingsForCommand("edit.insert-callout")).toEqual(["Mod-Shift-b"]);
    const others = Object.entries(DEFAULT_BINDINGS).filter(
      ([id, key]) => id !== "edit.insert-callout" && key === "Mod-Shift-b",
    );
    expect(others).toEqual([]);
  });
});
