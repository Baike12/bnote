import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({ api: {} }));

import { useAppStore } from "./appStore";

/**
 * Request semantics of "focus sidebar" (⌘I): a one-shot ticket, not a history
 * counter.
 *
 * A counter (tick++) would be read as "a freshly arrived request" whenever the
 * sidebar remounts — collapsing with ⌘\ and expanding again would steal the
 * editor's focus. A ticket resets to zero once consumed, so a remounted
 * sidebar only ever sees "no request".
 */

const request = () => useAppStore.getState().sidebarFocusRequest;

beforeEach(() => {
  useAppStore.setState({ sidebarOpen: false, sidebarFocusRequest: null });
});

describe("设置默认值", () => {
  it("选中翻译默认关闭", () => {
    expect(useAppStore.getState().settings.studyTranslate.enabled).toBe(false);
  });
});

describe("focusSidebar 请求", () => {
  it("按下时展开侧栏并留下一张待消费的票据", () => {
    useAppStore.getState().focusSidebar();
    expect(useAppStore.getState().sidebarOpen).toBe(true);
    expect(request()).not.toBe(null);
  });

  it("消费即归零：重新挂载的侧栏看不到历史请求", () => {
    useAppStore.getState().focusSidebar();
    useAppStore.getState().clearSidebarFocus();
    expect(request()).toBe(null);
  });

  it("消费后再按一次仍然得到一张新票据", () => {
    useAppStore.getState().focusSidebar();
    useAppStore.getState().clearSidebarFocus();
    useAppStore.getState().focusSidebar();
    expect(request()).not.toBe(null);
    // The ticket only carries "is there a pending request"; the number itself
    // takes no part in the decision
    expect(typeof request()).toBe("number");
  });

  it("未消费时再按一次不会丢请求", () => {
    useAppStore.getState().focusSidebar();
    const first = request();
    useAppStore.getState().focusSidebar();
    expect(request()).not.toBe(null);
    expect(request()).not.toBe(first);
  });

  it("没有请求时消费是空操作（不产生多余的状态写入）", () => {
    let writes = 0;
    const unsub = useAppStore.subscribe(() => {
      writes++;
    });
    useAppStore.getState().clearSidebarFocus();
    expect(writes).toBe(0);
    unsub();
  });
});

describe("toggleSidebar（顶栏按钮的鼠标路径）", () => {
  it("收起→展开只是开合，不产生聚焦票据", () => {
    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarOpen).toBe(true);
    expect(request()).toBe(null);
  });

  it("展开→收起同样不碰票据；未消费的票据也不因此丢失", () => {
    useAppStore.getState().focusSidebar();
    const first = request();
    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarOpen).toBe(false);
    expect(request()).toBe(first);
  });
});
