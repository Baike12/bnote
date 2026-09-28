import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * IME 切换的发起时机与在途合并（latest-wins）。
 *
 * 两条纪律:
 * 1. **不在按键那一帧里发起**——切换请求推迟到当前任务之后（scheduleLaunch），
 *    模式切换自己的 DOM 同步 + measure 先落位；同一任务里的连续翻转合并成
 *    一次，只有最新意图会发出去。
 * 2. **同一时刻至多一个在途调用**。每次切换在 Rust 侧要占主线程 TIS 往返
 *    （macOS 26 竞态还可能升级成 macism 子进程），overlapping 的风暴会直接卡
 *    UI 主线程——所以爆发式翻转合并成「首发 + 收尾一次」，收尾永远是最新意图；
 *    失焦挂起后不再补发，且没真切过就不去动系统输入法。
 */

const setInputSource = vi.hoisted(() => vi.fn());
const getCurrentInputSource = vi.hoisted(() => vi.fn());
const listInputSources = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  api: {
    setInputSource,
    getCurrentInputSource,
    listInputSources,
  },
}));

import { imeApply, imeOnWindowBlur, imeOnWindowFocus, imeYield } from "./imeSwitch";
import { useAppStore } from "@/state/appStore";

/** 可控的 in-flight：setInputSource 的 promise 直到 drain() 才落定。 */
const pending: (() => void)[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  pending.length = 0;
  setInputSource.mockImplementation(
    () =>
      new Promise((resolve) => {
        pending.push(() => resolve({ switched: true, fallbackUsed: false }));
      }),
  );
  getCurrentInputSource.mockResolvedValue("com.apple.keylayout.ABC");
  listInputSources.mockResolvedValue([]);
  const { patchSettings } = useAppStore.getState();
  patchSettings({
    ime: {
      enabled: true,
      insertSource: "com.apple.inputmethod.SCIM",
      normalSource: "com.apple.keylayout.ABC",
      mathKeepsEnglish: true,
      codeKeepsEnglish: true,
    },
  });
});

afterEach(() => {
  imeYield();
});

/** 放行推迟到任务末尾的发起，落定在途调用，并把微任务刷干净。 */
const drain = async () => {
  await new Promise((r) => setTimeout(r, 0));
  while (pending.length) pending.shift()!();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe("imeApply 发起时机与在途合并", () => {
  it("按键那一刻不发 IPC，推迟到任务末尾", () => {
    imeApply("A");
    expect(setInputSource).not.toHaveBeenCalled();
  });

  it("同步爆发翻转只发一次，且是最新意图（首发不浪费）", async () => {
    imeApply("A");
    imeApply("B");
    imeApply("C");
    imeApply("C"); // 重复目标不再排队
    await drain();
    expect(setInputSource).toHaveBeenCalledTimes(1);
    expect(setInputSource).toHaveBeenNthCalledWith(1, "C");
    await drain();
    expect(setInputSource).toHaveBeenCalledTimes(1);
  });

  it("在途期间的翻转合并成收尾一次", async () => {
    imeApply("A");
    await drain();
    expect(setInputSource).toHaveBeenCalledTimes(1);
    imeApply("B"); // A 已落定，B 自己发一次
    imeApply("C");
    await drain();
    expect(setInputSource).toHaveBeenCalledTimes(2);
    expect(setInputSource).toHaveBeenLastCalledWith("C");
    await drain();
    expect(setInputSource).toHaveBeenCalledTimes(2);
  });

  it("收尾落定后切回旧目标,正常再次发送(模式往返)", async () => {
    imeApply("EN");
    await drain();
    imeApply("ZH");
    await drain();
    imeApply("EN");
    await drain();
    expect(setInputSource).toHaveBeenCalledTimes(3);
    expect(setInputSource).toHaveBeenLastCalledWith("EN");
  });

  it("失焦挂起后,排队中的意图不再补发,也不去动系统输入法", async () => {
    imeApply("A");
    imeApply("B"); // 排队
    imeOnWindowBlur(); // 挂起（此时还没有任何强制切换真的发出去）
    await drain();
    expect(setInputSource).not.toHaveBeenCalled();
  });

  it("已经强制切过:失焦时归还用户的原始输入源", async () => {
    imeApply("A");
    await drain(); // A 真的发出去了
    expect(setInputSource).toHaveBeenCalledTimes(1);
    imeOnWindowBlur();
    await drain();
    expect(setInputSource).toHaveBeenCalledTimes(2);
    expect(setInputSource).toHaveBeenLastCalledWith("com.apple.keylayout.ABC");
  });

  it("重新聚焦后按当前上下文再切一次", async () => {
    imeApply("A");
    await drain();
    imeOnWindowBlur();
    await drain();
    imeApply("A"); // 挂起态下同一目标也必须重新发（用户输入法刚被还回去）
    await drain();
    expect(setInputSource).toHaveBeenCalledTimes(3);
    expect(setInputSource).toHaveBeenLastCalledWith("A");
    imeYield();
  });

  it("ime.enabled 关闭时不发任何调用", async () => {
    useAppStore.getState().patchSettings({
      ime: {
        enabled: false,
        insertSource: "ZH",
        normalSource: "EN",
        mathKeepsEnglish: true,
        codeKeepsEnglish: true,
      },
    });
    imeApply("A");
    await drain();
    expect(setInputSource).not.toHaveBeenCalled();
  });
});

describe("imeWarmUp", () => {
  it("开启时预热一次 TIS（把冷启动挪出按键路径），且不触发任何切换", async () => {
    const { imeWarmUp } = await import("./imeSwitch");
    imeWarmUp();
    await drain();
    expect(listInputSources).toHaveBeenCalledTimes(1);
    expect(setInputSource).not.toHaveBeenCalled();
  });

  it("关闭 ime 时不预热", async () => {
    useAppStore.getState().patchSettings({
      ime: {
        enabled: false,
        insertSource: "ZH",
        normalSource: "EN",
        mathKeepsEnglish: true,
        codeKeepsEnglish: true,
      },
    });
    const { imeWarmUp } = await import("./imeSwitch");
    imeWarmUp();
    await drain();
    expect(listInputSources).not.toHaveBeenCalled();
  });
});

describe("imeOnWindowFocus", () => {
  it("聚焦后按当前上下文重新对齐（不含 vim 时无动作）", async () => {
    useAppStore.getState().patchSettings({ vim: false });
    imeOnWindowFocus();
    await drain();
    expect(setInputSource).not.toHaveBeenCalled();
  });
});
