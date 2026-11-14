import { describe, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import { registerJsonView, saveJsonFile, unregisterJsonView } from "./jsonDocument";

/**
 * The JSON editor registry: at most one editor is mounted, and ⌘S / the
 * autosave go through `saveJsonFile` so the JSON pane and the note editor
 * share one write queue. Two contract points matter:
 *
 *  - saving with nothing mounted resolves instead of rejecting (the command
 *    layer calls it unconditionally);
 *  - unregistering a view that is not the active one must not clear the active
 *    save (the note editor unmounting while the JSON editor still holds a
 *    dirty document would otherwise silently drop the save).
 *
 * The module holds one slot, so every test unregisters what it mounted.
 */
function makeView(): EditorView {
  return { dom: {} } as unknown as EditorView;
}

function makeEditor(save: () => Promise<void>) {
  return { view: makeView(), save };
}

describe("saveJsonFile: the single mounted JSON editor's save", () => {
  it("no editor mounted: resolves without a write", async () => {
    await expect(saveJsonFile()).resolves.toBeUndefined();
  });

  it("the registered save is called and its own promise is handed back", async () => {
    const save = vi.fn(() => Promise.resolve());
    const editor = makeEditor(save);
    registerJsonView(editor);
    await saveJsonFile();
    expect(save).toHaveBeenCalledTimes(1);
    unregisterJsonView(editor.view);
  });

  it("a save promise that rejects is passed through to the caller, not swallowed", async () => {
    const failure = new Error("ENOSPC");
    const editor = makeEditor(() => Promise.reject(failure));
    registerJsonView(editor);
    await expect(saveJsonFile()).rejects.toThrow("ENOSPC");
    unregisterJsonView(editor.view);
  });
});

describe("unregisterJsonView: only the active view can clear the slot", () => {
  it("unregistering the registered view clears it so later saves resolve", async () => {
    const save = vi.fn(() => Promise.resolve());
    const editor = makeEditor(save);
    registerJsonView(editor);
    unregisterJsonView(editor.view);
    await saveJsonFile();
    expect(save).not.toHaveBeenCalled();
  });

  it("unregistering a different view leaves the active save in place", async () => {
    const save = vi.fn(() => Promise.resolve());
    const editor = makeEditor(save);
    registerJsonView(editor);
    unregisterJsonView(makeView());
    await saveJsonFile();
    expect(save).toHaveBeenCalledTimes(1);
    unregisterJsonView(editor.view);
  });
});
