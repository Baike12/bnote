import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The switch is one round trip: `set_input_source` carries both halves. It
 * hands the target to the app's process-local `NSTextInputContext` first, then
 * the helper updates the system source that the menu bar displays.
 *
 * Splitting them into two commands left a window in which the system source
 * had already switched while the hand-off was still an IPC hop away; that
 * window is what produced "the menu bar changed, typing did not". So the front
 * end must keep issuing exactly one call per real switch, carrying the trailing
 * intent.
 *
 * jsdom cannot verify the native halves; what is locked here is that
 * discipline.
 */

const setInputSource = vi.hoisted(() => vi.fn());
const getCurrentInputSource = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  api: {
    setInputSource,
    getCurrentInputSource,
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
  setInputSource.mockResolvedValue({
    switched: true,
    tisMs: 1,
    contextApplied: true,
    contextMs: 0,
  });
  getCurrentInputSource.mockResolvedValue(ABC);
});

describe("one round trip per real switch", () => {
  it("a real switch issues exactly one command carrying the new source", async () => {
    imeApply(SOGOU);
    await drain();
    expect(setInputSource).toHaveBeenCalledTimes(1);
    expect(setInputSource).toHaveBeenCalledWith(SOGOU);
  });

  it("an already-active source still costs one idempotent call, and nothing else", async () => {
    setInputSource.mockResolvedValue({
      switched: false,
      tisMs: 1,
      contextApplied: null,
      contextMs: 0,
    });
    imeApply(ABC);
    await drain();
    // The command dedups on the Rust side; the front end does not chain a
    // second call on top of it.
    expect(setInputSource).toHaveBeenCalledTimes(1);
  });

  it("a burst of flips collapses into the trailing intent", async () => {
    imeApply(SOGOU);
    imeApply(ABC);
    await drain();
    expect(setInputSource).toHaveBeenCalledTimes(1);
    expect(setInputSource).toHaveBeenLastCalledWith(ABC);
  });
});
