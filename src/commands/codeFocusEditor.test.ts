import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/commands/builtin";
import { getCommand } from "./registry";
import { commandsForKey } from "./keys";
import { useCodeStore } from "@/code/store";
import {
  registerCodeEditor,
  unregisterCodeEditor,
  type CodeEditorHandle,
} from "@/code/editor/registry";

/**
 * "聚焦到编辑区" exists because the keyboard is not always in the file: the
 * terminal and the file tree take it, and neither can give it back with Esc
 * (the shell owns Esc, the tree keeps it for the same reason). The command is
 * one chord away from anywhere in the code region and always lands in the
 * open file.
 */

/** The caret is focused on the next frame; node has no frame clock. */
function stubFrame() {
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    fn(0);
    return 0;
  });
}

const focused = vi.fn();

/** Only the parts the command reads: connectivity and `focus`. */
function fakeEditor(): CodeEditorHandle {
  return {
    root: "/proj",
    path: "src/a.ts",
    language: "typescript",
    view: { focus: focused, dom: { isConnected: true } },
  } as unknown as CodeEditorHandle;
}

let handle: CodeEditorHandle | null = null;

beforeEach(() => {
  stubFrame();
  focused.mockClear();
  useCodeStore.setState({ diffOpen: false });
});

afterEach(() => {
  if (handle) unregisterCodeEditor(handle);
  handle = null;
  vi.unstubAllGlobals();
});

describe("focusing the editor", () => {
  it("is bound in the code region, and only there", () => {
    expect(commandsForKey("Mod-Alt-e", "code")).toContain("code.focus-editor");
    expect(commandsForKey("Mod-Alt-e", "notes")).not.toContain("code.focus-editor");
  });

  it("lands the caret in the open file", () => {
    handle = fakeEditor();
    registerCodeEditor(handle);
    getCommand("code.focus-editor")?.run();
    expect(focused).toHaveBeenCalledTimes(1);
  });

  it("closes the change list first: the list is what covers the file", () => {
    handle = fakeEditor();
    registerCodeEditor(handle);
    useCodeStore.setState({ diffOpen: true });
    getCommand("code.focus-editor")?.run();
    expect(useCodeStore.getState().diffOpen).toBe(false);
    expect(focused).toHaveBeenCalledTimes(1);
  });

  it("is unavailable without an editor and without a change list", () => {
    useCodeStore.setState({ diffOpen: false });
    expect(getCommand("code.focus-editor")?.when?.() ?? true).toBe(false);
  });

  it("stays available while the change list covers the file: closing it is part of landing", () => {
    useCodeStore.setState({ diffOpen: true });
    expect(getCommand("code.focus-editor")?.when?.() ?? true).toBe(true);
  });
});
