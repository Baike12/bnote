import { describe, expect, it } from "vitest";
import { pickKeyRegion, type FocusRegion } from "./globalKeys";

/**
 * 区域归属的根因门禁。
 *
 * 归属只认「用户最近一次在哪个区域动手」,不是 `document.activeElement`:
 * 阅读区(PDF)故意不取得 DOM 焦点(给阅读器加 tabindex/focus 会让 WebKit
 * 的文字选区锚点跳变),所以滚页面、点正文都不改 activeElement——焦点还停在
 * Agent 输入框 / 笔记编辑器上,阅读区的快捷键(截图、区域切换)就会静默落到
 * 别的命令上或什么也不做。反过来,不在场的区域(三栏里被临时隐藏/收起、
 * 或不在学习模式时没有 Agent/阅读区)同样不能占着键盘。
 */
const ALL: FocusRegion[] = ["reading", "notes", "agent", "project"];
const onScreenAll = () => true;

describe("pickKeyRegion", () => {
  it("最近一次动手的区域优先于焦点所在(滚过 PDF 后键盘归阅读区)", () => {
    expect(
      pickKeyRegion({
        owner: "reading",
        focus: "agent", // 焦点还停在 Agent 输入框里
        onScreen: onScreenAll,
      }),
    ).toBe("reading");
  });

  it("只有焦点时听焦点的", () => {
    expect(
      pickKeyRegion({ owner: null, focus: "agent", onScreen: onScreenAll }),
    ).toBe("agent");
  });

  it("已不可见的区域不能占键(按键不许落到不在场的区域上)", () => {
    const onScreen = (region: FocusRegion) => region !== "notes";
    expect(pickKeyRegion({ owner: "notes", focus: "notes", onScreen })).toBe("reading");
    expect(pickKeyRegion({ owner: "notes", focus: null, onScreen })).toBe("reading");
  });

  it("主区域被隐藏时,退到场上的焦点区域", () => {
    const onScreen = (region: FocusRegion) => region !== "agent";
    expect(pickKeyRegion({ owner: "agent", focus: "notes", onScreen })).toBe("notes");
  });

  it("无主也无焦点时按阅读区 → 项目卡片 → 笔记区 → Agent 兜底(阅读区不取焦点,最安全)", () => {
    expect(
      pickKeyRegion({
        owner: null,
        focus: null,
        onScreen: () => true,
      }),
    ).toBe("reading");
    // 阅读区不在场:项目管理排在笔记区之前——项目视图刚切进来时还没有
    // 「最近动手」,键盘该落在中间的卡片,而不是右栏日记。
    expect(
      pickKeyRegion({
        owner: null,
        focus: null,
        onScreen: (region) => region !== "reading",
      }),
    ).toBe("project");
    expect(
      pickKeyRegion({
        owner: null,
        focus: null,
        onScreen: (region) => region !== "reading" && region !== "project",
      }),
    ).toBe("notes");
  });

  it("一个区域都不在场(普通布局)时退回笔记区", () => {
    expect(
      pickKeyRegion({ owner: "reading", focus: null, onScreen: () => false }),
    ).toBe("notes");
  });

  it("从不在集合里的焦点区域(焦点在侧栏/标题栏)不改变归属", () => {
    for (const owner of ALL) {
      expect(
        pickKeyRegion({ owner, focus: null, onScreen: onScreenAll }),
      ).toBe(owner);
    }
  });
});
