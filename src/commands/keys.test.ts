import { describe, expect, it } from "vitest";
import { DEFAULT_BINDINGS, bindingsForCommand, isPlainFocusOwnedKey } from "./keys";

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

  it("Mod-Shift-r 归 workspace.switch-recent-vault,且无人与之重复", () => {
    expect(bindingsForCommand("workspace.switch-recent-vault")).toEqual(["Mod-Shift-r"]);
    const others = Object.entries(DEFAULT_BINDINGS).filter(
      ([id, key]) => id !== "workspace.switch-recent-vault" && key === "Mod-Shift-r",
    );
    expect(others).toEqual([]);
  });

  it("PDF 翻页默认 PageUp/PageDown(含方向键),且无人与之重复", () => {
    expect(bindingsForCommand("study.pdf-prev-page")).toEqual(["PageUp", "ArrowLeft"]);
    expect(bindingsForCommand("study.pdf-next-page")).toEqual(["PageDown", "ArrowRight"]);
    const used = ["PageUp", "PageDown", "ArrowLeft", "ArrowRight"];
    const others = Object.entries(DEFAULT_BINDINGS).flatMap(([id, key]) => {
      if (id.startsWith("study.pdf-")) return [];
      const keys = Array.isArray(key) ? key : [key];
      return keys.filter((k) => used.includes(k)).map((k) => `${id}:${k}`);
    });
    expect(others).toEqual([]);
  });
});

/** 编辑器/输入框的按键归属:裸导航键归它们,带修饰键的绑定任何焦点下都生效。 */
describe("裸导航键归属", () => {
  const ev = (key: string, mods: Partial<KeyboardEvent> = {}) =>
    ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

  it("无修饰键的翻页/方向键归编辑器,窗口级命令不得抢", () => {
    expect(isPlainFocusOwnedKey(ev("PageDown"))).toBe(true);
    expect(isPlainFocusOwnedKey(ev("PageUp"))).toBe(true);
    expect(isPlainFocusOwnedKey(ev("ArrowLeft"))).toBe(true);
    expect(isPlainFocusOwnedKey(ev("ArrowRight"))).toBe(true);
  });

  it("带修饰键的组合(如 Ctrl-J)在任何焦点下都交给命令", () => {
    expect(isPlainFocusOwnedKey(ev("j", { ctrlKey: true }))).toBe(false);
    expect(isPlainFocusOwnedKey(ev("PageDown", { shiftKey: true }))).toBe(false);
    expect(isPlainFocusOwnedKey(ev("j", { metaKey: true }))).toBe(false);
  });

  it("普通字符不算导航键", () => {
    expect(isPlainFocusOwnedKey(ev("j"))).toBe(false);
  });
});
