import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * IME 切换的在途合并（latest-wins）。每次切换在 Rust 侧要占 1-3 次主线程
 * TIS 往返（macOS 26 竞态还可能升级成 macism 子进程）， overlapping 的切换
 * 风暴会直接卡 UI 主线程——这里锁死：同一时刻至多一个在途调用，爆发式
 * 翻转合并成「首发 + 收尾一次」，收尾永远是最新意图；失焦挂起后不再补发。
 */

const setInputSource = vi.hoisted(() => vi.fn());
const getCurrentInputSource = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  api: {
    setInputSource,
    getCurrentInputSource,
  },
}));

import { imeApply, imeOnWindowBlur, imeYield } from "./imeSwitch";
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

const drain = async () => {
  while (pending.length) pending.shift()!();
  await Promise.resolve();
  await Promise.resolve();
};

describe("imeApply 在途合并", () => {
  it("爆发翻转只发首发 + 收尾一次,收尾是最新意图", async () => {
    imeApply("A");
    imeApply("B");
    imeApply("C");
    imeApply("C"); // 重复目标不再排队
    expect(setInputSource).toHaveBeenCalledTimes(1);
    expect(setInputSource).toHaveBeenNthCalledWith(1, "A");

    await drain(); // 首发落定 → 补发最新意图 C(只一次)
    expect(setInputSource).toHaveBeenCalledTimes(2);
    expect(setInputSource).toHaveBeenNthCalledWith(2, "C");

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

  it("失焦挂起后,排队中的收尾不再补发(用户的原始源刚被还回去)", async () => {
    imeApply("A");
    imeApply("B"); // 排队
    imeOnWindowBlur(); // 挂起
    await drain();
    // 只有两类调用:首发 A + blur 归还用户的基线源;排队中的 B 永远不补发。
    expect(setInputSource).toHaveBeenCalledTimes(2);
    expect(setInputSource).toHaveBeenNthCalledWith(1, "A");
    expect(setInputSource).toHaveBeenLastCalledWith("com.apple.keylayout.ABC");
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
