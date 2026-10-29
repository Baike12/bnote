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

import {
  imeApply,
  imeBeginTransientChinese,
  imeEndTransientChinese,
  imeOnChineseFocus,
  imeOnWindowBlur,
  imeOnWindowFocus,
  imeSyncToEditor,
  imeYield,
  insertRegionWantsEnglishAt,
} from "./imeSwitch";
import { EditorState } from "@codemirror/state";
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
      chineseFields: true,
      insertSource: "com.apple.inputmethod.SCIM",
      normalSource: "com.apple.keylayout.ABC",
      mathKeepsEnglish: true,
      codeKeepsEnglish: true,
    },
  });
});

afterEach(async () => {
  imeYield();
  // 把归还调用与它的收尾链都落定:留下一条未落定的 setInputSource 会让
  // switching 卡在 true,下一个用例的切换就只会排队、永远发不出去。
  await drain();
  await drain();
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
        chineseFields: true,
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

describe("批注输入框聚焦", () => {
  it("切到设置里的 insert 源（给中文批注用）", async () => {
    imeOnChineseFocus();
    expect(setInputSource).not.toHaveBeenCalled();
    await drain();
    expect(setInputSource).toHaveBeenCalledWith("com.apple.inputmethod.SCIM");
  });

  it("force 绕过去重:已切过中文后再点进输入框仍重发中文源", async () => {
    imeOnChineseFocus();
    await drain();
    expect(setInputSource).toHaveBeenCalledTimes(1);
    expect(setInputSource).toHaveBeenLastCalledWith("com.apple.inputmethod.SCIM");
    // 用户在框里 Ctrl+Space 切回英文:前端 desired 仍是中文,普通去重吞掉。
    imeOnChineseFocus();
    await drain();
    expect(setInputSource).toHaveBeenCalledTimes(1);
    // 再点进来/再按快捷键 = 显式进入中文框,强制重发。
    imeOnChineseFocus(true);
    await drain();
    expect(setInputSource).toHaveBeenCalledTimes(2);
    expect(setInputSource).toHaveBeenLastCalledWith("com.apple.inputmethod.SCIM");
  });

  it("force 在途时切着英文:落定后补发中文(收尾意图不被丢)", async () => {
    imeApply("com.apple.keylayout.ABC");
    await new Promise((r) => setTimeout(r, 0)); // 英文切换已发出、在途
    expect(pending.length).toBe(1);
    imeOnChineseFocus(true);
    await new Promise((r) => setTimeout(r, 0)); // 强制意图到期:排进收尾
    pending.shift()!(); // 英文落定 → 收尾发中文
    await new Promise((r) => setTimeout(r, 0));
    expect(setInputSource).toHaveBeenCalledTimes(2);
    expect(setInputSource).toHaveBeenLastCalledWith("com.apple.inputmethod.SCIM");
    pending.shift()!(); // 中文落定,别让 switching 卡住
    await new Promise((r) => setTimeout(r, 0));
  });

  it("force 同样受 enabled / chineseFields 开关约束", async () => {
    useAppStore.getState().patchSettings({
      ime: {
        enabled: true,
        chineseFields: false,
        insertSource: "ZH",
        normalSource: "EN",
        mathKeepsEnglish: true,
        codeKeepsEnglish: true,
      },
    });
    imeOnChineseFocus(true);
    await drain();
    expect(setInputSource).not.toHaveBeenCalled();
  });

  it("焦点落定后系统把源恢复回英文时,核对补发一次中文", async () => {
    // 「按上下文记忆输入源」开着:焦点切换完成后 AppKit 会把源恢复成该
    // 上下文记住的英文,表现为 Sogou 图标闪一下就没了。
    vi.stubGlobal("document", {
      activeElement: { hasAttribute: (n: string) => n === "data-ime-chinese" },
    });
    try {
      imeOnChineseFocus(true);
      await drain();
      expect(setInputSource).toHaveBeenCalledTimes(1);
      // 核对定时器(120ms)到期:系统源是 ABC → 与意图不一致 → 补发
      await new Promise((r) => setTimeout(r, 160));
      await drain();
      expect(setInputSource).toHaveBeenCalledTimes(2);
      expect(setInputSource).toHaveBeenLastCalledWith("com.apple.inputmethod.SCIM");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("核对时系统已是中文:不重复发送", async () => {
    vi.stubGlobal("document", {
      activeElement: { hasAttribute: (n: string) => n === "data-ime-chinese" },
    });
    getCurrentInputSource.mockResolvedValue("com.apple.inputmethod.SCIM");
    try {
      imeOnChineseFocus(true);
      await drain();
      expect(setInputSource).toHaveBeenCalledTimes(1);
      await new Promise((r) => setTimeout(r, 160));
      await drain();
      expect(setInputSource).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("核对前已离开输入框:不补发", async () => {
    vi.stubGlobal("document", { activeElement: null });
    try {
      imeOnChineseFocus(true);
      await drain();
      expect(setInputSource).toHaveBeenCalledTimes(1);
      await new Promise((r) => setTimeout(r, 160));
      await drain();
      expect(setInputSource).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ime.enabled 关闭时不动系统输入法", async () => {
    useAppStore.getState().patchSettings({
      ime: {
        enabled: false,
        chineseFields: true,
        insertSource: "ZH",
        normalSource: "EN",
        mathKeepsEnglish: true,
        codeKeepsEnglish: true,
      },
    });
    imeOnChineseFocus();
    await drain();
    expect(setInputSource).not.toHaveBeenCalled();
  });

  it("chineseFields 关闭时聚焦不切(可独立关闭该行为)", async () => {
    useAppStore.getState().patchSettings({
      ime: {
        enabled: true,
        chineseFields: false,
        insertSource: "ZH",
        normalSource: "EN",
        mathKeepsEnglish: true,
        codeKeepsEnglish: true,
      },
    });
    imeOnChineseFocus();
    await drain();
    expect(setInputSource).not.toHaveBeenCalled();
  });

  it("中文写作输入框持有焦点时,imeSyncToEditor 不按编辑器上下文覆盖(窗口 focus 回来不丢中文)", async () => {
    vi.stubGlobal("document", {
      activeElement: { hasAttribute: (n: string) => n === "data-ime-chinese" },
    });
    try {
      imeOnChineseFocus();
      await drain();
      expect(setInputSource).toHaveBeenLastCalledWith("com.apple.inputmethod.SCIM");
      const count = setInputSource.mock.calls.length;
      imeSyncToEditor();
      await drain();
      expect(setInputSource).toHaveBeenCalledTimes(count);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("焦点不在中文写作输入框时,imeSyncToEditor 照常交还(归还 baseline)", async () => {
    vi.stubGlobal("document", { activeElement: null });
    try {
      imeOnChineseFocus();
      await drain(); // baseline 记下 ABC,切到中文
      imeSyncToEditor();
      await drain();
      expect(setInputSource).toHaveBeenLastCalledWith("com.apple.keylayout.ABC");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("失焦归还后,焦点还在中文输入框上时重新聚焦会重发中文源", async () => {
    vi.stubGlobal("document", {
      activeElement: { hasAttribute: (n: string) => n === "data-ime-chinese" },
    });
    try {
      imeOnChineseFocus();
      await drain();
      imeOnWindowBlur();
      await drain(); // 归还 ABC
      expect(setInputSource).toHaveBeenLastCalledWith("com.apple.keylayout.ABC");
      imeOnWindowFocus();
      await drain();
      expect(setInputSource).toHaveBeenLastCalledWith("com.apple.inputmethod.SCIM");
    } finally {
      vi.unstubAllGlobals();
    }
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
        chineseFields: true,
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

/**
 * 公式边界处的输入源意图。用户报告:Tab 跳出 / 切 normal 移出公式后,光标
 * 停在闭合 `$` 之后仍是英文源,接着打字把中文原码当公式敲进正文;块级公式
 * 移到末尾 `$$` 再进 insert 也一样。
 *
 * 判定看「下一个字符落在哪儿」:只有公式正文里才是英文源,边界之后是正文,
 * 该回到 insert 源(中文)。未闭合块(打字中)的 `to` 仍是正文——那里每敲一个
 * 字符光标都落在 `to`。
 */
describe("公式边界处的输入源判定（insertRegionWantsEnglishAt）", () => {
  const wantsEnglish = (doc: string, pos: number) =>
    insertRegionWantsEnglishAt(
      useAppStore.getState().settings,
      EditorState.create({ doc }),
      pos,
    );

  it("行内公式：严格内部才是英文源，闭合 `$` 之后回到中文", () => {
    const doc = "前文 $f(x)$ 后文"; // $f(x)$ = 3..9
    expect(wantsEnglish(doc, 4)).toBe(true);
    expect(wantsEnglish(doc, 6)).toBe(true);
    expect(wantsEnglish(doc, 8)).toBe(true);
    // 开符之前(3)与闭合符之后(9):下一个字符落在公式外面。
    expect(wantsEnglish(doc, 3)).toBe(false);
    expect(wantsEnglish(doc, 9)).toBe(false);
    expect(wantsEnglish(doc, 10)).toBe(false);
  });

  it("块级公式：末尾 `$$` 之后(区域 to)回到中文", () => {
    const doc = "$$\nx=1\n$$"; // 0..9
    expect(wantsEnglish(doc, 1)).toBe(true);
    expect(wantsEnglish(doc, 8)).toBe(true);
    expect(wantsEnglish(doc, 0)).toBe(false);
    expect(wantsEnglish(doc, 9)).toBe(false);
  });

  it("未闭合块：末尾仍是英文源（公式还在打字）", () => {
    const doc = "$$\nx=1"; // 0..6, unclosed
    expect(wantsEnglish(doc, 6)).toBe(true);
  });

  it("单个 `$$` 后接着打字仍是英文源", () => {
    expect(wantsEnglish("$$", 2)).toBe(true);
  });

  it("mathKeepsEnglish 关闭：公式里也用 insert 源", () => {
    useAppStore.getState().patchSettings({
      ime: {
        enabled: true,
        chineseFields: true,
        insertSource: "com.apple.inputmethod.SCIM",
        normalSource: "com.apple.keylayout.ABC",
        mathKeepsEnglish: false,
        codeKeepsEnglish: true,
      },
    });
    expect(wantsEnglish("前文 $f(x)$ 后文", 6)).toBe(false);
  });
});

/** 快速待办这类弹窗:打开切中文,关闭把打开前的输入源原样还回去。 */
describe("临时中文输入作用域(快速待办弹窗)", () => {
  const ZH = "com.apple.inputmethod.SCIM";
  const EN = "com.apple.keylayout.ABC";

  /** 每拍 setTimeout(0):read 源 → 排切换 → 真的发出去,三拍足够收敛。 */
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  };
  /** 等在途调用出现(不让断言依赖定时器的相对顺序)。 */
  const waitInFlight = async () => {
    for (let i = 0; i < 20 && pending.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(pending.length).toBe(1);
  };

  it("打开:先读此刻的源再切中文;关闭:还回那个源", async () => {
    imeBeginTransientChinese();
    await settle();
    expect(setInputSource).toHaveBeenCalledTimes(1);
    expect(setInputSource).toHaveBeenLastCalledWith(ZH);

    imeEndTransientChinese();
    await drain();
    expect(setInputSource).toHaveBeenCalledTimes(2);
    expect(setInputSource).toHaveBeenLastCalledWith(EN);
  });

  it("中文切换在途时关闭:收尾那次是原源,不会晚到把用户打回中文", async () => {
    imeBeginTransientChinese();
    await waitInFlight(); // 中文切换已发出、尚未落定
    expect(setInputSource).toHaveBeenLastCalledWith(ZH);

    imeEndTransientChinese();
    await drain(); // 在途落定 → 收尾发原源
    expect(setInputSource).toHaveBeenCalledTimes(2);
    expect(setInputSource).toHaveBeenLastCalledWith(EN);
  });

  it("读源还没返回就关闭:不切中文,也不多发一次切换", async () => {
    let resolveCapture: (id: string) => void = () => {};
    getCurrentInputSource.mockImplementation(
      () => new Promise<string>((resolve) => (resolveCapture = resolve)),
    );
    imeBeginTransientChinese();
    imeEndTransientChinese();
    resolveCapture(EN);
    await settle();
    expect(setInputSource).not.toHaveBeenCalled();
  });

  it("重复进入不覆盖「原来的源」", async () => {
    imeBeginTransientChinese();
    await waitInFlight();
    imeBeginTransientChinese(); // 重渲染/再次聚焦
    await settle();
    expect(getCurrentInputSource).toHaveBeenCalledTimes(1);
    expect(setInputSource).toHaveBeenCalledTimes(1);
  });

  it("还回原源后,同一个目标不再重复切(意图与真实源保持一致)", async () => {
    imeBeginTransientChinese();
    await waitInFlight();
    await drain(); // 中文切换落定
    imeEndTransientChinese();
    await drain(); // 原源还回去
    const calls = setInputSource.mock.calls.length;
    imeApply(EN);
    await settle();
    expect(setInputSource).toHaveBeenCalledTimes(calls);
  });
});
