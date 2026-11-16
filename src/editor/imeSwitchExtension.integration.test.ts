import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * The whole switch chain at the editor's own seam: a vim mode change runs
 * through `imeSwitchExtension.updateListener` -> `imeApply` -> the
 * `set_input_source` IPC -> (on `switched`) the input-context re-mount.
 *
 * The intent state machine is locked separately (imeSwitch.test.ts) and so is
 * the re-mount discipline (imeSwitchContext.integration.test.ts); what this
 * file adds is the wiring between them: the extension only exists inside the
 * editor tree, reads the mode from the live view, and decides the math/code
 * "keep English" case from the actual document position. A regression here is
 * invisible to the other two suites.
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

/** Mounts a real editor with the production extension; returns the re-mount counters. */
function mount(doc = "hello"): {
  view: EditorView;
  counts: { blurs: number; focuses: number };
} {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [imeSwitchExtension()] }),
    parent: document.body,
  });
  views.push(view);
  registerEditorView(view);
  const counts = { blurs: 0, focuses: 0 };
  view.contentDOM.blur = () => {
    counts.blurs++;
  };
  view.contentDOM.focus = () => {
    counts.focuses++;
  };
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => view.contentDOM,
  });
  return { view, counts };
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
  tauri.setInputSource.mockResolvedValue({ switched: true, tisMs: 1 });
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
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => document.body,
  });
});

describe("the editor-level switch chain", () => {
  it("normal -> insert sends the insert source and re-mounts the input context in the same call", async () => {
    const { view, counts } = mount();
    resetListener(view);
    vimMode.current = "normal";
    view.dispatch({});
    await tick();

    counts.blurs = 0;
    counts.focuses = 0;
    tauri.setInputSource.mockClear();

    vimMode.current = "insert";
    view.dispatch({});
    await tick();

    expect(tauri.setInputSource).toHaveBeenCalledTimes(1);
    expect(tauri.setInputSource).toHaveBeenCalledWith(SOGOU);
    expect(counts.blurs).toBe(1);
    expect(counts.focuses).toBe(1);
  });

  it("insert -> normal hands the normal source back", async () => {
    const { view, counts } = mount();
    resetListener(view);
    vimMode.current = "insert";
    view.dispatch({});
    await tick();

    counts.blurs = 0;
    counts.focuses = 0;
    tauri.setInputSource.mockClear();

    vimMode.current = "normal";
    view.dispatch({});
    await tick();

    expect(tauri.setInputSource).toHaveBeenCalledTimes(1);
    expect(tauri.setInputSource).toHaveBeenCalledWith(ABC);
    // A real switch re-mounts the context regardless of direction.
    expect(counts.blurs).toBe(1);
    expect(counts.focuses).toBe(1);
  });

  it("a repeated transaction in the same mode sends nothing (the listener dedups)", async () => {
    const { view } = mount();
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
    const { view } = mount("前文 $f(x)$ 后文");
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
    const { view } = mount();
    useAppStore.getState().patchSettings({ vim: false });
    vimMode.current = "insert";
    view.dispatch({});
    await tick();

    expect(tauri.setInputSource).not.toHaveBeenCalled();
  });
});
