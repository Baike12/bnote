import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * When an IME switch is initiated and how in-flight calls merge (latest-wins).
 *
 * Two disciplines:
 * 1. **Never initiate in the keystroke's own frame** — the switch request is
 *    deferred until after the current task (scheduleLaunch), so the mode
 *    switch's own DOM sync + measure lands first; consecutive flips in the
 *    same task collapse into one, and only the latest intent goes out.
 * 2. **At most one in-flight call at a time**. Each switch occupies a
 *    main-thread TIS round trip on the Rust side (the macOS 26 race may even
 *    escalate into a macism subprocess), and an overlapping storm stalls the
 *    UI main thread outright — so a burst of flips collapses into "one first
 *    call + one trailing call", and the trailing call always carries the
 *    latest intent; nothing is re-sent after a blur suspend, and the system
 *    IME is not touched at all when nothing was really switched.
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

/** Controllable in-flight: the setInputSource promise only settles at drain(). */
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
  // Settle both the hand-back call and its trailing chain: one unsettled
  // setInputSource leaves `switching` stuck at true, so the next test's switch
  // only queues and never goes out.
  await drain();
  await drain();
});

/** Releases the launch deferred to the end of the task, settles the in-flight call, and flushes the microtasks. */
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
    imeApply("C"); // a repeated target is not queued again
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
    imeApply("B"); // A has settled, so B sends one itself
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
    imeApply("B"); // queued
    imeOnWindowBlur(); // suspended (no forced switch has really gone out yet)
    await drain();
    expect(setInputSource).not.toHaveBeenCalled();
  });

  it("已经强制切过:失焦时归还用户的原始输入源", async () => {
    imeApply("A");
    await drain(); // A really went out
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
    imeApply("A"); // in the suspended state the same target must be sent again (the user's IME was just handed back)
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
    // The user switched back to English with Ctrl+Space inside the field: the
    // frontend's `desired` is still Chinese, and the ordinary dedup swallows it.
    imeOnChineseFocus();
    await drain();
    expect(setInputSource).toHaveBeenCalledTimes(1);
    // Clicking back in / pressing the shortcut again = explicitly entering the
    // Chinese field, so the Chinese source is force-resent.
    imeOnChineseFocus(true);
    await drain();
    expect(setInputSource).toHaveBeenCalledTimes(2);
    expect(setInputSource).toHaveBeenLastCalledWith("com.apple.inputmethod.SCIM");
  });

  it("force 在途时切着英文:落定后补发中文(收尾意图不被丢)", async () => {
    imeApply("com.apple.keylayout.ABC");
    await new Promise((r) => setTimeout(r, 0)); // the English switch is out and in flight
    expect(pending.length).toBe(1);
    imeOnChineseFocus(true);
    await new Promise((r) => setTimeout(r, 0)); // the forced intent expires and queues into the trailing step
    pending.shift()!(); // English settles → the trailing step sends Chinese
    await new Promise((r) => setTimeout(r, 0));
    expect(setInputSource).toHaveBeenCalledTimes(2);
    expect(setInputSource).toHaveBeenLastCalledWith("com.apple.inputmethod.SCIM");
    pending.shift()!(); // Chinese settles, so `switching` does not stay stuck
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
    // "Remember input source per context" is on: once the focus switch
    // completes, AppKit restores the source remembered for that context,
    // which shows up as the Sogou icon flashing and disappearing.
    vi.stubGlobal("document", {
      activeElement: { hasAttribute: (n: string) => n === "data-ime-chinese" },
    });
    try {
      imeOnChineseFocus(true);
      await drain();
      expect(setInputSource).toHaveBeenCalledTimes(1);
      // the check timer (120ms) expires: the system source is ABC → it disagrees with the intent → re-send
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
      await drain(); // baseline records ABC, then switches to Chinese
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
      await drain(); // hands ABC back
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
 * The input source intent at math boundaries. User report: after tabbing out
 * / switching to normal and leaving the formula, the caret still sat on the
 * English source after the closing `$`, and typing then pushed raw Chinese
 * text into the body as if it were a formula; the same happened with a
 * block-level formula moved to the trailing `$$` and re-entering insert.
 *
 * The decision looks at "where does the next character land": only inside
 * the math body is it the English source; after the boundary it is body text
 * and the insert source (Chinese) applies. For an unclosed block (still being
 * typed) `to` is still body — there the caret lands on `to` after every
 * keystroke.
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
    // before the opening delimiter (3) and after the closing one (9): the next character lands outside the formula.
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

/** Popups like the quick todo: opening switches to Chinese, closing hands back exactly the source that was active before opening. */
describe("临时中文输入作用域(快速待办弹窗)", () => {
  const ZH = "com.apple.inputmethod.SCIM";
  const EN = "com.apple.keylayout.ABC";

  /** One setTimeout(0) tick each: read the source → queue the switch → actually send it; three ticks converge. */
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  };
  /** Waits for the in-flight call to appear (so the assertions do not depend on the timers' relative order). */
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
    await waitInFlight(); // the Chinese switch is out but not settled yet
    expect(setInputSource).toHaveBeenLastCalledWith(ZH);

    imeEndTransientChinese();
    await drain(); // the in-flight call settles → the trailing step sends the original source
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
    imeBeginTransientChinese(); // re-render / focus again
    await settle();
    expect(getCurrentInputSource).toHaveBeenCalledTimes(1);
    expect(setInputSource).toHaveBeenCalledTimes(1);
  });

  it("还回原源后,同一个目标不再重复切(意图与真实源保持一致)", async () => {
    imeBeginTransientChinese();
    await waitInFlight();
    await drain(); // the Chinese switch settles
    imeEndTransientChinese();
    await drain(); // the original source goes back
    const calls = setInputSource.mock.calls.length;
    imeApply(EN);
    await settle();
    expect(setInputSource).toHaveBeenCalledTimes(calls);
  });
});
