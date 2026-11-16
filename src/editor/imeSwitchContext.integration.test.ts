import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The switch contract's second half: the helper's TIS select changes the
 * system source (the menu bar follows), but the app's own text input context
 * keeps the source it was created with — WebKit would keep typing latin. A
 * confirmed real switch therefore hands the new source to the app's context
 * (`apply_input_context_source` -> NSTextInputContext
 * .selectedKeyboardInputSource, applied on the main thread).
 *
 * jsdom cannot verify the native hand-off; what is locked here is the trigger
 * discipline: only a real switch (switched=true) touches the context, and the
 * source handed over is exactly the one that was switched to.
 */

const setInputSource = vi.hoisted(() => vi.fn());
const applyInputContextSource = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  api: {
    setInputSource,
    applyInputContextSource,
    getCurrentInputSource: vi.fn().mockResolvedValue("com.apple.keylayout.ABC"),
    listInputSources: vi.fn().mockResolvedValue([]),
  },
}));

import { imeApply } from "./imeSwitch";
import { useAppStore } from "@/state/appStore";

const SOGOU = "com.sogou.inputmethod.sogou.pinyin";
const ABC = "com.apple.keylayout.ABC";

/** Releases the launch deferred to the end of the task and settles the call. */
const drain = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  vi.clearAllMocks();
  // The store defaults to ime.enabled=false; every path under test requires it.
  const { patchSettings } = useAppStore.getState();
  patchSettings({
    ime: {
      enabled: true,
      chineseFields: true,
      insertSource: SOGOU,
      normalSource: ABC,
      mathKeepsEnglish: true,
      codeKeepsEnglish: true,
    },
  });
  setInputSource.mockResolvedValue({ switched: true, tisMs: 1 });
  applyInputContextSource.mockResolvedValue(true);
});

describe("the input-context hand-off after a real switch", () => {
  it("a real switch hands the new source to the app's input context", async () => {
    imeApply(SOGOU);
    await drain();
    expect(setInputSource).toHaveBeenCalledWith(SOGOU);
    expect(applyInputContextSource).toHaveBeenCalledTimes(1);
    expect(applyInputContextSource).toHaveBeenCalledWith(SOGOU);
  });

  it("a no-op switch (already on the target source) does not touch the context", async () => {
    setInputSource.mockResolvedValue({ switched: false, tisMs: 1 });
    imeApply(ABC);
    await drain();
    expect(applyInputContextSource).not.toHaveBeenCalled();
  });

  it("the hand-off follows the trailing intent, not the cancelled one", async () => {
    // A burst of flips collapses: only the final target is switched to and
    // handed to the context.
    imeApply(SOGOU);
    imeApply(ABC);
    await drain();
    expect(setInputSource).toHaveBeenLastCalledWith(ABC);
    const targets = applyInputContextSource.mock.calls.map((c) => c[0]);
    expect(targets[targets.length - 1]).toBe(ABC);
  });
});
