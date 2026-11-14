import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The switch contract's second half: the web input context is created at focus
 * time and captures the source active then. A select made in the helper
 * process does not propagate into it — the menu bar follows the system-wide
 * change notification, WebKit keeps typing with the source captured at focus
 * ("menu bar switched, the app still types latin"). After a REAL switch
 * (switched=true) the focused editor's context is re-created (same-frame blur
 * + focus on contentDOM), re-capturing the new source.
 *
 * jsdom cannot verify the native IME follow-up; what is locked here is the
 * trigger discipline: only a real switch (switched=true), only the focused
 * editor, never during composition.
 */

const setInputSource = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  api: {
    setInputSource,
    getCurrentInputSource: vi.fn().mockResolvedValue("com.apple.keylayout.ABC"),
    listInputSources: vi.fn().mockResolvedValue([]),
  },
}));

import { registerEditorView, unregisterEditorView } from "./api";
import { imeApply } from "./imeSwitch";
import { useAppStore } from "@/state/appStore";
import type { EditorView } from "@codemirror/view";

/** Releases the launch deferred to the end of the task and settles the call. */
const drain = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

/** A minimal stand-in for a focused CodeMirror view: contentDOM plus the flag the refresh reads. */
function fakeView(
  composing: boolean,
  focused: boolean,
): {
  view: EditorView;
  dom: HTMLElement;
  counts: { blurs: number; focuses: number; focusArgs: FocusOptions[] };
} {
  const dom = document.createElement("div");
  document.body.append(dom);
  if (focused) {
    Object.defineProperty(document, "activeElement", {
      configurable: true,
      get: () => dom,
    });
  }
  const state = { blurs: 0, focuses: 0, focusArgs: [] as FocusOptions[] };
  dom.blur = () => {
    state.blurs++;
  };
  dom.focus = (...args: Parameters<typeof HTMLElement.prototype.focus>) => {
    state.focuses++;
    state.focusArgs.push(args[0] ?? {});
  };
  const view = { contentDOM: dom, composing } as unknown as EditorView;
  registerEditorView(view);
  // The counters travel by reference: blur/focus run after the promise chain.
  return { view, dom, counts: state };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The store defaults to ime.enabled=false; every path under test requires it.
  const { patchSettings } = useAppStore.getState();
  patchSettings({
    ime: {
      enabled: true,
      chineseFields: true,
      insertSource: "com.sogou.inputmethod.sogou.pinyin",
      normalSource: "com.apple.keylayout.ABC",
      mathKeepsEnglish: true,
      codeKeepsEnglish: true,
    },
  });
  setInputSource.mockResolvedValue({ switched: true, tisMs: 1 });
  // Whatever the previous test left focused must not leak in.
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => document.body,
  });
});

describe("the input-context re-mount after a real switch", () => {
  it("a real switch re-mounts the focused editor's context (blur + focus, same frame)", async () => {
    const { view, counts } = fakeView(false, true);
    imeApply("com.sogou.inputmethod.sogou.pinyin");
    await drain();
    expect(setInputSource).toHaveBeenCalledWith("com.sogou.inputmethod.sogou.pinyin");
    expect(counts.blurs).toBe(1);
    expect(counts.focuses).toBe(1);
    // contentDOM spans the whole document: focus() without preventScroll
    // would scroll the notes page to its top on every real switch.
    expect(counts.focusArgs).toEqual([{ preventScroll: true }]);
    unregisterEditorView(view);
  });

  it("a no-op switch (already on the target source) does not re-mount", async () => {
    const { view, counts } = fakeView(false, true);
    setInputSource.mockResolvedValue({ switched: false, tisMs: 1 });
    imeApply("com.apple.keylayout.ABC");
    await drain();
    expect(counts.blurs).toBe(0);
    unregisterEditorView(view);
  });

  it("no re-mount during composition (it would abort the IME session)", async () => {
    const { view, counts } = fakeView(true, true);
    imeApply("com.sogou.inputmethod.sogou.pinyin");
    await drain();
    expect(counts.blurs).toBe(0);
    unregisterEditorView(view);
  });

  it("no re-mount when the editor is not focused (the typing context belongs to someone else)", async () => {
    const { view, counts } = fakeView(false, false);
    imeApply("com.sogou.inputmethod.sogou.pinyin");
    await drain();
    expect(counts.blurs).toBe(0);
    unregisterEditorView(view);
  });
});
