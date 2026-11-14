import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The command table imports the code-project commands, which pull xterm in;
// xterm probes a 2D canvas while its module evaluates, and jsdom has no canvas
// implementation. A null context is enough — no test here renders a terminal.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
});

import "@/commands/builtin";
import { setPdfNavHandlers } from "@/study/pdfNav";
import { useAppStore, setConfigSnapshot } from "@/state/appStore";
import {
  activeKeyRegion,
  installGlobalKeybindings,
  keyRegionOwner,
  regionFromTarget,
  regionOnScreen,
  setActiveKeyRegion,
  setHotkeyRecording,
  setKeyModalOpen,
} from "./globalKeys";
import { applyOverrides } from "./keys";

/**
 * The window-level listener is the app's single keyboard entry point: it runs
 * in the capture phase so a chord works in the sidebar, a modal or the editor.
 * These tests dispatch real keydowns at real DOM nodes and assert what the
 * listener did — that is the only place the region scoping of a key is
 * actually observable end to end.
 *
 * `installGlobalKeybindings` is idempotent in the sense that matters here: it
 * has no uninstall, so the file installs it once and every test resets the
 * state the listener reads.
 */

const installed = installGlobalKeybindings;

function region(name: string, visible = true): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-key-region", name);
  // jsdom has no layout, so a mounted region reports no client rects. The
  // region model reads "no rects" as "not on screen"; a test region that is
  // meant to be visible has to say so.
  Object.defineProperty(el, "getClientRects", {
    configurable: true,
    value: () => (visible ? [{ width: 100, height: 100 }] : []),
  });
  document.body.append(el);
  return el;
}

function keydown(target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
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

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  setConfigSnapshot({});
  applyOverrides({});
  setHotkeyRecording(false);
  setKeyModalOpen(false);
  setActiveKeyRegion("notes");
  useAppStore.setState({
    modal: null,
    toast: null,
    mode: "notes",
    mainColumn: "content",
    agentPanelCommand: null,
    studyContent: null,
    settings: { ...useAppStore.getState().settings, vim: false, studyWebZoom: 1 },
  });
  installed();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("region ownership from input events", () => {
  it("the region attribute on the nearest ancestor decides the target's region", () => {
    const notes = region("notes");
    const child = document.createElement("span");
    notes.append(child);

    expect(regionFromTarget(child)).toBe("notes");
    expect(regionFromTarget(notes)).toBe("notes");
    expect(regionFromTarget(document.body)).toBeNull();
    expect(regionFromTarget(null)).toBeNull();
  });

  it("an unknown region name is not a region, so it cannot own the keyboard", () => {
    const el = region("nowhere");
    expect(regionFromTarget(el)).toBeNull();
  });

  it("nested regions resolve to the innermost one: the panel inside a column owns its keys", () => {
    const notes = region("notes");
    const agent = region("agent");
    notes.append(agent);
    const child = document.createElement("b");
    agent.append(child);

    expect(regionFromTarget(child)).toBe("agent");
  });

  it("a region with no layout box or hidden visibility is not on screen and must not take keys", () => {
    expect(regionOnScreen("notes")).toBe(false);

    region("notes");
    expect(regionOnScreen("notes")).toBe(true);

    region("agent", false);
    expect(regionOnScreen("agent")).toBe(false);

    const hidden = region("reading");
    hidden.style.visibility = "hidden";
    expect(regionOnScreen("reading")).toBe(false);
  });

  it("a pointer down inside a region hands it the keyboard", () => {
    const notes = region("notes");
    const agent = region("agent");

    notes.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(keyRegionOwner()).toBe("notes");

    agent.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(keyRegionOwner()).toBe("agent");
  });

  it("scrolling a region hands it the keyboard too: reading a PDF requires no click", () => {
    const reading = region("reading");
    reading.dispatchEvent(new Event("wheel", { bubbles: true }));
    expect(keyRegionOwner()).toBe("reading");
  });

  it("the focused region wins when nothing owns the keyboard yet", () => {
    region("notes");
    region("agent");
    const input = document.createElement("input");
    region("agent").append(input);
    input.focus();

    expect(activeKeyRegion()).toBe("agent");
  });
});

describe("a keydown resolves in the region it was pressed in", () => {
  it("⌘P runs the palette from the notes region and consumes the event", () => {
    const notes = region("notes");
    setActiveKeyRegion("notes");

    const event = keydown(notes, "p");

    expect(event.defaultPrevented).toBe(true);
    expect(useAppStore.getState().modal).toBe("palette");
  });

  it("⌘B is a notes-region binding and does nothing from the reading region", () => {
    const reading = region("reading");
    setActiveKeyRegion("reading");

    const event = keydown(reading, "b");

    expect(event.defaultPrevented).toBe(false);
    expect(useAppStore.getState().toast).toBeNull();
  });

  it("⌘⌥A is captured in the reading region while the agent panel is mounted, and skipped otherwise", () => {
    const reading = region("reading");
    setActiveKeyRegion("reading");

    // Notes mode has no agent panel: the command's when is false, so the
    // candidates run out and the key is passed through.
    expect(keydown(reading, "a", { altKey: true }).defaultPrevented).toBe(false);

    useAppStore.setState({ mode: "study" });
    const event = keydown(reading, "a", { altKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(useAppStore.getState().agentPanelCommand?.kind).toBe("focus-input");
  });

  it("a plain letter is never taken, so typing in the editor is untouched", () => {
    const notes = region("notes");
    setActiveKeyRegion("notes");

    const event = keydown(notes, "b", { metaKey: false });
    expect(event.defaultPrevented).toBe(false);
  });

  it("bare PageDown pages the reading pane only, and only there", () => {
    const reading = region("reading");
    const notes = region("notes");
    const pager = { canFlip: () => true, prev: vi.fn(), next: vi.fn() };
    setPdfNavHandlers(pager);

    try {
      setActiveKeyRegion("reading");
      expect(keydown(reading, "PageDown", { metaKey: false }).defaultPrevented).toBe(true);
      expect(pager.next).toHaveBeenCalledTimes(1);

      // The same bare key in the notes region belongs to the editor: it must
      // not page the PDF and must not be consumed.
      pager.next.mockClear();
      setActiveKeyRegion("notes");
      expect(keydown(notes, "PageDown", { metaKey: false }).defaultPrevented).toBe(false);
      expect(pager.next).not.toHaveBeenCalled();
    } finally {
      setPdfNavHandlers(null);
    }
  });

  it("while a hotkey is being recorded the app takes no key at all", () => {
    const notes = region("notes");
    setActiveKeyRegion("notes");
    setHotkeyRecording(true);

    const event = keydown(notes, "p");
    expect(event.defaultPrevented).toBe(false);
    expect(useAppStore.getState().modal).toBeNull();
  });

  it("while a modal is open only global commands run: ⌘B stays with the overlay's input", () => {
    const notes = region("notes");
    setActiveKeyRegion("notes");
    setKeyModalOpen(true);

    expect(keydown(notes, "b").defaultPrevented).toBe(false);
    expect(keydown(notes, "p").defaultPrevented).toBe(true);
    expect(useAppStore.getState().modal).toBe("palette");
  });

  it("a text input keeps its own editing chords even where the region binds them", () => {
    applyOverrides({ notes: { "edit.toggle-todo": "Mod-a" } });
    const notes = region("notes");
    const input = document.createElement("input");
    notes.append(input);
    setActiveKeyRegion("notes");

    // ⌘A in a form field must select all; the region binding is for the
    // editor, not for inputs.
    input.focus();
    expect(keydown(input, "a").defaultPrevented).toBe(false);

    // Outside the input the same chord is the bound command.
    expect(keydown(notes, "a").defaultPrevented).toBe(true);
  });

  it("bare arrow keys belong to an editable target, modified chords do not", () => {
    region("notes");
    applyOverrides({ notes: { "edit.toggle-todo": "Ctrl-l" } });
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    setActiveKeyRegion("notes");

    textarea.focus();
    expect(keydown(textarea, "ArrowDown", { metaKey: false }).defaultPrevented).toBe(false);
    expect(keydown(textarea, "l", { metaKey: false, ctrlKey: true }).defaultPrevented).toBe(true);
  });
});
