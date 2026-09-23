import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({ api: {} }));

import { useAppStore } from "./appStore";

/**
 * 「聚焦侧边栏」(⌘I) 的请求语义：一次性票据，不是历史计数器。
 *
 * 计数器写法（tick++）在侧栏重新挂载时会被读成「刚收到的新请求」——⌘\ 收起
 * 再展开就会去抢编辑器焦点。票据被消费即归零，重新挂载看到的只会是「没有请求」。
 */

const request = () => useAppStore.getState().sidebarFocusRequest;

beforeEach(() => {
  useAppStore.setState({ sidebarOpen: false, sidebarFocusRequest: null });
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
    // 票据只是「有没有待处理请求」的载体，序号本身不参与判断
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
