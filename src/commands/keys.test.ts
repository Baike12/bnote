import { describe, expect, it } from "vitest";
import {
  DEFAULT_BINDINGS,
  FIXED_PAGE_COMMANDS,
  bindingsForCommand,
  fixedPageCommandFor,
  isPlainFocusOwnedKey,
  setBindingOverrides,
} from "./keys";

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

/** PageUp/PageDown 是不可覆盖的固定翻页键:改绑之后仍然翻页。 */
describe("固定翻页键", () => {
  const ev = (key: string, mods: Partial<KeyboardEvent> = {}) =>
    ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

  it("PageUp/PageDown 分别对应上一页/下一页", () => {
    expect(FIXED_PAGE_COMMANDS).toEqual({
      PageUp: "study.pdf-prev-page",
      PageDown: "study.pdf-next-page",
    });
    expect(fixedPageCommandFor(ev("PageUp"))).toBe("study.pdf-prev-page");
    expect(fixedPageCommandFor(ev("PageDown"))).toBe("study.pdf-next-page");
  });

  it("改绑 study.pdf-* 之后固定键仍然生效", () => {
    setBindingOverrides({ "study.pdf-next-page": "Mod-j" });
    try {
      expect(bindingsForCommand("study.pdf-next-page")).toEqual(["Mod-j"]);
      expect(fixedPageCommandFor(ev("PageDown"))).toBe("study.pdf-next-page");
    } finally {
      setBindingOverrides({});
    }
  });

  it("带修饰键/其它按键不触发固定翻页", () => {
    expect(fixedPageCommandFor(ev("PageDown", { shiftKey: true }))).toBeNull();
    expect(fixedPageCommandFor(ev("PageDown", { ctrlKey: true }))).toBeNull();
    expect(fixedPageCommandFor(ev("j"))).toBeNull();
  });
});
