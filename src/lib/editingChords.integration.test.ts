import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setClipboardOverrides } from "@/lib/clipboard";
import { installEditingChords } from "./editingChords";

/**
 * WKWebView delivers ⌘C/X/V/A to the page as keydown and never runs the
 * AppKit menu role, so form elements rely on this fallback. The contract:
 * only a focused, editable input/textarea outside the editor is handled, the
 * clipboard side effect matches the chord, and `preventDefault` +
 * `stopPropagation` keep the platform from handling the same chord again.
 */

/** jsdom reports a non-Mac platform; the fallback reads it to pick meta vs ctrl. */
function useMacPlatform(): void {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
}

function key(target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    metaKey: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function input(value = ""): HTMLInputElement {
  const el = document.createElement("input");
  el.value = value;
  document.body.append(el);
  el.focus();
  return el;
}

let clipboardText: string | null;
const write = vi.fn(async (text: string) => {
  clipboardText = text;
  return true;
});
const read = vi.fn(async () => clipboardText);

beforeAll(() => {
  useMacPlatform();
  installEditingChords();
});

beforeEach(() => {
  clipboardText = null;
  write.mockClear();
  read.mockClear();
  setClipboardOverrides({ read, write });
});

afterEach(() => {
  setClipboardOverrides(null);
  vi.restoreAllMocks();
});

describe("selection and copy", () => {
  it("⌘A selects the field and consumes the event", () => {
    const el = input("hello");
    const event = key(el, "a");

    expect(event.defaultPrevented).toBe(true);
    expect(el.selectionStart).toBe(0);
    expect(el.selectionEnd).toBe(5);
  });

  it("⌘C copies only the selected slice", () => {
    const el = input("hello world");
    el.setSelectionRange(6, 11);
    const event = key(el, "c");

    expect(event.defaultPrevented).toBe(true);
    expect(write).toHaveBeenCalledWith("world");
    expect(el.value).toBe("hello world");
  });

  it("⌘C with no selection consumes the chord without writing", () => {
    const el = input("hello");
    el.setSelectionRange(2, 2);

    expect(key(el, "c").defaultPrevented).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it("⌘X copies, removes the selection and reports the change as input", async () => {
    const el = input("hello world");
    el.setSelectionRange(5, 11);
    const onInput = vi.fn();
    el.addEventListener("input", onInput);

    key(el, "x");

    expect(write).toHaveBeenCalledWith(" world");
    expect(el.value).toBe("hello");
    expect(el.selectionStart).toBe(5);
    expect(onInput).toHaveBeenCalledTimes(1);
  });
});

describe("paste", () => {
  it("⌘V inserts the clipboard text at the selection and reports input", async () => {
    clipboardText = "X";
    const el = input("abc");
    el.setSelectionRange(1, 2);
    const onInput = vi.fn();
    el.addEventListener("input", onInput);

    const event = key(el, "v");
    expect(event.defaultPrevented).toBe(true);

    await vi.waitFor(() => expect(el.value).toBe("aXc"));
    expect(el.selectionStart).toBe(2);
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it("⌘V leaves the field alone when the clipboard cannot be read", async () => {
    clipboardText = null;
    const el = input("abc");
    el.setSelectionRange(1, 1);

    key(el, "v");
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    expect(el.value).toBe("abc");
  });
});

describe("scope", () => {
  it("ignores read-only and disabled fields", () => {
    const readOnly = input("fixed");
    readOnly.readOnly = true;
    readOnly.setSelectionRange(0, 5);
    expect(key(readOnly, "c").defaultPrevented).toBe(false);

    // A disabled control cannot hold focus in jsdom; the runtime reads the
    // active element, so expose the disabled field as the active one.
    const disabled = input("off");
    disabled.disabled = true;
    const active = vi.spyOn(document, "activeElement", "get").mockReturnValue(disabled);
    expect(key(disabled, "a").defaultPrevented).toBe(false);
    active.mockRestore();

    expect(write).not.toHaveBeenCalled();
  });

  it("ignores a keydown with no form element focused", () => {
    const event = key(document.body, "c");
    expect(event.defaultPrevented).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("ignores Alt-modified chords and non-editing keys", () => {
    const el = input("hello");
    el.setSelectionRange(0, 5);
    expect(key(el, "c", { altKey: true }).defaultPrevented).toBe(false);
    expect(key(el, "b").defaultPrevented).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("lets the CodeMirror keymap own chords inside the editor", async () => {
    const { editorApi } = await import("@/editor/api");
    const el = input("hello");
    el.setSelectionRange(0, 5);
    const contentDOM = document.createElement("div");
    contentDOM.append(el);
    document.body.append(contentDOM);

    // The editor's contentDOM contains the focused element: the CM keymap runs.
    // The registry is a single mutable slot, so restore it afterwards.
    const previous = editorApi.view;
    editorApi.view = { contentDOM } as unknown as typeof editorApi.view;
    try {
      const event = key(el, "c");
      expect(event.defaultPrevented).toBe(false);
      expect(write).not.toHaveBeenCalled();
    } finally {
      editorApi.view = previous;
    }
  });

  it("stops the chord from bubbling to other window listeners", () => {
    const el = input("hello");
    el.setSelectionRange(0, 5);
    const bubble = vi.fn();
    window.addEventListener("keydown", bubble);
    try {
      key(el, "c");
    } finally {
      window.removeEventListener("keydown", bubble);
    }
    expect(bubble).not.toHaveBeenCalled();
  });
});
