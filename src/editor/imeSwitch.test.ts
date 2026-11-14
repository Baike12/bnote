import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * When an IME switch is initiated and how in-flight calls merge (latest-wins).
 *
 * Two disciplines:
 * 1. **Never initiate inside the keystroke's own task** — the switch request is
 *    deferred to the end of the task (so the mode change and its DOM work land
 *    first); consecutive flips collapse into one, and only the latest intent
 *    goes out.
 * 2. **At most one in-flight call at a time**. Each switch occupies the app
 *    main thread for the duration of the TIS call (HIToolbox runs it there;
 *    2–10 ms warm, up to ~170 ms while a third-party input method activates),
 *    so a burst of flips collapses into "one first call + one trailing call",
 *    and the trailing call always carries the latest intent; nothing is re-sent
 *    after a blur suspend, and the system IME is not touched at all when
 *    nothing was really switched.
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
        pending.push(() => resolve({ switched: true, tisMs: 1 }));
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
  vi.unstubAllGlobals();
});

/** Releases the launch deferred to the end of the task, settles the in-flight call, and flushes the microtasks. */
const drain = async () => {
  await new Promise((r) => setTimeout(r, 0));
  while (pending.length) pending.shift()!();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe("imeApply launch timing and in-flight merging", () => {
  it("no IPC is sent at the moment of the keystroke; it is deferred to the end of the task", () => {
    imeApply("A");
    expect(setInputSource).not.toHaveBeenCalled();
  });

  it("the launch goes out on the next task tick, never inside the keystroke's own task", async () => {
    imeApply("A");
    expect(setInputSource).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(setInputSource).toHaveBeenCalledTimes(1);
    expect(setInputSource).toHaveBeenLastCalledWith("A");
    await drain();
  });

  it("a synchronous burst of flips sends only one call, and it is the latest intent (the first call is not wasted)", async () => {
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

  /**
   * The real-trace churn (`.bnote/perf`, 2026-11-12): repeated Chinese-field
   * enter/leave and window focus changes produced a burst of sogou↔ABC
   * switches. Each round trip costs a hand-over window, so the budget is per
   * distinct intent, never per focus event.
   */
  it("N field enter/leave transitions cost exactly N+1 hand-backs, one switch per intent", async () => {
    for (let i = 0; i < 5; i++) {
      imeOnChineseFocus(true); // enter: force re-sends even when desired matches
      await drain();
      imeYield(); // leave: hand the user's source back
      await drain();
    }
    // 5 × (Chinese on enter + original on leave); the first enter also
    // captures the baseline, which costs no extra switch.
    expect(setInputSource).toHaveBeenCalledTimes(10);
  });

  it("ten back-to-back transitions collapse into one in-flight + one trailing call", async () => {
    for (let i = 0; i < 10; i++) {
      imeOnChineseFocus(true);
      imeYield();
    }
    await drain();
    const calls = setInputSource.mock.calls.length;
    expect(calls).toBeLessThanOrEqual(3);
    await drain();
    expect(setInputSource.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("flips during an in-flight call merge into a single trailing call", async () => {
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

  it("after the trailing call settles, switching back to the old target is sent normally again (mode round trip)", async () => {
    imeApply("EN");
    await drain();
    imeApply("ZH");
    await drain();
    imeApply("EN");
    await drain();
    expect(setInputSource).toHaveBeenCalledTimes(3);
    expect(setInputSource).toHaveBeenLastCalledWith("EN");
  });

  it("after a blur suspends it, the queued intent is never sent later and the system IME is not touched", async () => {
    imeApply("A");
    imeApply("B"); // queued
    imeOnWindowBlur(); // suspended (no forced switch has really gone out yet)
    await drain();
    expect(setInputSource).not.toHaveBeenCalled();
  });

  it("after a forced switch has gone out: the blur hands the user's original input source back", async () => {
    imeApply("A");
    await drain(); // A really went out
    expect(setInputSource).toHaveBeenCalledTimes(1);
    imeOnWindowBlur();
    await drain();
    expect(setInputSource).toHaveBeenCalledTimes(2);
    expect(setInputSource).toHaveBeenLastCalledWith("com.apple.keylayout.ABC");
  });

  it("after refocusing it switches once more according to the current context", async () => {
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

  it("when ime.enabled is off no call is sent at all", async () => {
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

describe("annotation input focus", () => {
  it("focusing switches to the insert source from the settings (for Chinese annotations)", async () => {
    imeOnChineseFocus();
    expect(setInputSource).not.toHaveBeenCalled();
    await drain();
    expect(setInputSource).toHaveBeenCalledWith("com.apple.inputmethod.SCIM");
  });

  it("force bypasses the dedup: clicking into the input field again after Chinese was already switched still re-sends the Chinese source", async () => {
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

  it("force while a switch to English is in flight: Chinese is sent again once it settles (the trailing intent is not lost)", async () => {
    // A yield leaves `desired` on the restored source, so this flow re-enters
    // the way the app does after a hand-back: blur suspends, focus re-applies.
    imeOnWindowBlur();
    imeOnWindowFocus();
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

  it("force is bound by the enabled / chineseFields switches as well", async () => {
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

  it("when the system restores the source to English after the focus settles, the check re-sends Chinese once", async () => {
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

  it("when the system is already Chinese at check time: nothing is sent again", async () => {
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

  it("the input field was left before the check: nothing is sent", async () => {
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

  it("when ime.enabled is off the system IME is not touched", async () => {
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

  it("when chineseFields is off, focusing does not switch (the behavior can be disabled independently)", async () => {
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

  it("while a Chinese writing input field holds focus, imeSyncToEditor does not override it with the editor context (Chinese is not lost when the window regains focus)", async () => {
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

  it("when the focus is not in a Chinese writing input field, imeSyncToEditor hands it back as usual (returns the baseline)", async () => {
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

  it("after the blur hands it back, refocusing while the focus is still on the Chinese input field re-sends the Chinese source", async () => {
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
  it("when enabled it warms up TIS once (moving the cold start out of the keystroke path) and triggers no switch", async () => {
    const { imeWarmUp } = await import("./imeSwitch");
    imeWarmUp();
    await drain();
    expect(listInputSources).toHaveBeenCalledTimes(1);
    expect(setInputSource).not.toHaveBeenCalled();
  });

  it("no warm-up when ime is off", async () => {
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
  it("after focusing it realigns according to the current context (no action when vim is off)", async () => {
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
describe("the input source decision at math boundaries (insertRegionWantsEnglishAt)", () => {
  const wantsEnglish = (doc: string, pos: number) =>
    insertRegionWantsEnglishAt(useAppStore.getState().settings, EditorState.create({ doc }), pos);

  it("inline formula: only the strict interior is the English source, after the closing `$` it goes back to Chinese", () => {
    const doc = "前文 $f(x)$ 后文"; // $f(x)$ = 3..9
    expect(wantsEnglish(doc, 4)).toBe(true);
    expect(wantsEnglish(doc, 6)).toBe(true);
    expect(wantsEnglish(doc, 8)).toBe(true);
    // before the opening delimiter (3) and after the closing one (9): the next character lands outside the formula.
    expect(wantsEnglish(doc, 3)).toBe(false);
    expect(wantsEnglish(doc, 9)).toBe(false);
    expect(wantsEnglish(doc, 10)).toBe(false);
  });

  it("block formula: after the trailing `$$` (the region's to) it goes back to Chinese", () => {
    const doc = "$$\nx=1\n$$"; // 0..9
    expect(wantsEnglish(doc, 1)).toBe(true);
    expect(wantsEnglish(doc, 8)).toBe(true);
    expect(wantsEnglish(doc, 0)).toBe(false);
    expect(wantsEnglish(doc, 9)).toBe(false);
  });

  it("unclosed block: the end is still the English source (the formula is still being typed)", () => {
    const doc = "$$\nx=1"; // 0..6, unclosed
    expect(wantsEnglish(doc, 6)).toBe(true);
  });

  it("inline formula with a trailing space before the closing $ stays English (regression: `$s |$`)", () => {
    // The state right after typing a space inside a fresh inline formula. A
    // region that drops here switches the IME back to Chinese, and the next
    // space is consumed by the IME instead of reaching the document (the
    // report: `s` + space + `s` collapses to `ss` and expands to \sigma).
    const doc = "$s $"; // 0..4
    expect(wantsEnglish(doc, 3)).toBe(true);
  });

  it("typing right after a single `$$` is still the English source", () => {
    expect(wantsEnglish("$$", 2)).toBe(true);
  });

  it("when mathKeepsEnglish is off: the insert source is used inside formulas too", () => {
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
describe("transient Chinese input scope (quick todo popup)", () => {
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

  it("on open: read the current source first, then switch to Chinese; on close: hand that source back", async () => {
    imeBeginTransientChinese();
    await settle();
    expect(setInputSource).toHaveBeenCalledTimes(1);
    expect(setInputSource).toHaveBeenLastCalledWith(ZH);

    imeEndTransientChinese();
    await drain();
    expect(setInputSource).toHaveBeenCalledTimes(2);
    expect(setInputSource).toHaveBeenLastCalledWith(EN);
  });

  it("closing while the Chinese switch is in flight: the trailing call carries the original source and does not late-push the user back to Chinese", async () => {
    imeBeginTransientChinese();
    await waitInFlight(); // the Chinese switch is out but not settled yet
    expect(setInputSource).toHaveBeenLastCalledWith(ZH);

    imeEndTransientChinese();
    await drain(); // the in-flight call settles → the trailing step sends the original source
    expect(setInputSource).toHaveBeenCalledTimes(2);
    expect(setInputSource).toHaveBeenLastCalledWith(EN);
  });

  it("closing before the source read returns: Chinese is not switched and no extra switch call is sent", async () => {
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

  it("re-entering does not overwrite 'the original source'", async () => {
    imeBeginTransientChinese();
    await waitInFlight();
    imeBeginTransientChinese(); // re-render / focus again
    await settle();
    // Two captures: the transient scope's own read, plus the baseline for this
    // focus session (imeYield consumed the previous baseline, so the first
    // forced switch of the new session captures a fresh one).
    expect(getCurrentInputSource).toHaveBeenCalledTimes(2);
    expect(setInputSource).toHaveBeenCalledTimes(1);
  });

  it("after the original source is handed back, the same target is not switched again (the intent stays consistent with the real source)", async () => {
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
