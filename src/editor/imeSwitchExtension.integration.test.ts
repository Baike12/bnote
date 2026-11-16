import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * The whole switch chain at the editor's own seam: a vim mode change runs
 * through `imeSwitchExtension.updateListener` -> `imeApply` -> the single
 * `set_input_source` IPC, which carries both halves (the helper's TIS select
 * and the main-thread session rebuild).
 *
 * The intent state machine is locked separately (imeSwitch.test.ts) and so is
 * the one-round-trip discipline (imeSwitchContext.integration.test.ts); what
 * this file adds is the wiring between them: the extension only exists inside
 * the editor tree, reads the mode from the live view, and decides the
 * math/code "keep English" case from the actual document position. A
 * regression here is invisible to the other two suites.
 *
 * The vim engine itself needs a real browser, so only `currentVimMode` is
 * faked; everything else (the extension, the editor, the decision code) is the
 * production implementation.
 */

const tauri = vi.hoisted(() => ({
  setInputSource: vi.fn(),
  getCurrentInputSource: vi.fn(),
  listInputSources: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({ api: tauri }));

const vimMode = vi.hoisted(() => ({ current: null as "insert" | "normal" | "visual" | null }));
vi.mock("./vim/vim", () => ({ currentVimMode: () => vimMode.current }));

import { imeSwitchExtension, imeYield } from "./imeSwitch";
import { registerEditorView, unregisterEditorView } from "./api";
import { useAppStore } from "@/state/appStore";

const SOGOU = "com.sogou.inputmethod.sogou.pinyin";
const ABC = "com.apple.keylayout.ABC";

const views: EditorView[] = [];

/** Mounts a real editor with the production extension. */
function mount(doc = "hello"): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [imeSwitchExtension()] }),
    parent: document.body,
  });
  views.push(view);
  registerEditorView(view);
  return view;
}

/** The listener's documented reset path: a dispatch with vim off clears its dedup memory. */
function resetListener(view: EditorView): void {
  const { patchSettings } = useAppStore.getState();
  patchSettings({ vim: false });
  view.dispatch({});
  patchSettings({ vim: true });
}

/** Settles the deferred launch and the in-flight call. */
const tick = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  vi.clearAllMocks();
  vimMode.current = null;
  tauri.getCurrentInputSource.mockResolvedValue(ABC);
  tauri.listInputSources.mockResolvedValue([]);
  tauri.setInputSource.mockResolvedValue({
    switched: true,
    tisMs: 1,
    contextApplied: true,
    contextMs: 0,
  });
  useAppStore.getState().patchSettings({
    vim: true,
    ime: {
      enabled: true,
      chineseFields: true,
      insertSource: SOGOU,
      normalSource: ABC,
      mathKeepsEnglish: true,
      codeKeepsEnglish: true,
    },
  });
});

afterEach(async () => {
  imeYield();
  await tick();
  await tick();
  for (const view of views.splice(0)) {
    unregisterEditorView(view);
    view.destroy();
  }
});

describe("the editor-level switch chain", () => {
  it("normal -> insert sends the insert source in one round trip", async () => {
    const view = mount();
    resetListener(view);
    vimMode.current = "normal";
    view.dispatch({});
    await tick();
    tauri.setInputSource.mockClear();

    vimMode.current = "insert";
    view.dispatch({});
    await tick();

    expect(tauri.setInputSource).toHaveBeenCalledTimes(1);
    expect(tauri.setInputSource).toHaveBeenCalledWith(SOGOU);
  });

  it("insert -> normal sends the normal source back", async () => {
    const view = mount();
    resetListener(view);
    vimMode.current = "insert";
    view.dispatch({});
    await tick();
    tauri.setInputSource.mockClear();

    vimMode.current = "normal";
    view.dispatch({});
    await tick();

    expect(tauri.setInputSource).toHaveBeenCalledTimes(1);
    expect(tauri.setInputSource).toHaveBeenCalledWith(ABC);
  });

  it("a repeated transaction in the same mode sends nothing (the listener dedups)", async () => {
    const view = mount();
    resetListener(view);
    vimMode.current = "insert";
    view.dispatch({});
    await tick();
    tauri.setInputSource.mockClear();

    view.dispatch({});
    view.dispatch({});
    await tick();

    expect(tauri.setInputSource).not.toHaveBeenCalled();
  });

  it("moving the caret inside a formula in insert mode keeps the English source", async () => {
    // "$f(x)$" spans 3..9; 4 and 8 are inside the body, 0 is outside.
    const view = mount("前文 $f(x)$ 后文");
    resetListener(view);
    vimMode.current = "insert";
    view.dispatch({ selection: { anchor: 0 } });
    await tick();
    expect(tauri.setInputSource).toHaveBeenLastCalledWith(SOGOU);

    tauri.setInputSource.mockClear();

    view.dispatch({ selection: { anchor: 4 } });
    await tick();

    expect(tauri.setInputSource).toHaveBeenCalledTimes(1);
    expect(tauri.setInputSource).toHaveBeenCalledWith(ABC);
  });

  it("with vim off the listener never touches the system IME", async () => {
    const view = mount();
    useAppStore.getState().patchSettings({ vim: false });
    vimMode.current = "insert";
    view.dispatch({});
    await tick();

    expect(tauri.setInputSource).not.toHaveBeenCalled();
  });
});
