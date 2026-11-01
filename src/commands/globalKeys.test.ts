import { describe, expect, it } from "vitest";
import { pickKeyRegion, type FocusRegion } from "./globalKeys";

/**
 * Root-cause gate for region ownership.
 *
 * Ownership only follows "where the user last acted", not
 * `document.activeElement`: the reading region (PDF) deliberately does not
 * take DOM focus (giving the reader a tabindex/focus makes WebKit's text
 * selection anchor jump), so scrolling the page or clicking the body never
 * changes activeElement — with the focus still in the Agent input / note
 * editor, the reading region's bindings (screenshot, region switch) would
 * silently fall through to another command or do nothing. Conversely, a
 * region that is not on screen (temporarily hidden/collapsed inside the
 * three columns, or no Agent/reading region outside study mode) must not
 * hold the keyboard either.
 */
const ALL: FocusRegion[] = ["reading", "notes", "agent", "project"];
const onScreenAll = () => true;

describe("pickKeyRegion", () => {
  it("最近一次动手的区域优先于焦点所在(滚过 PDF 后键盘归阅读区)", () => {
    expect(
      pickKeyRegion({
        owner: "reading",
        focus: "agent", // the focus is still in the Agent input
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
    // The reading region is absent: project management comes before the notes
    // region — right after switching into the project view there is no
    // "recent activity" yet, so the keyboard belongs to the cards in the
    // middle, not to the journal on the right.
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
