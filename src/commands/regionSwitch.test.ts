import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/commands/builtin";
import { getCommand } from "./registry";
import { useAppStore } from "@/state/appStore";
import { useCodeStore } from "@/code/store";

/**
 * ⌘⌥A and ⌘⌥R mean the same thing in both three-column layouts (study and
 * code), with one deliberate difference:
 *
 * - the Agent input is a text box in both layouts, so the command focuses it in
 *   both (the panel turns the signal into "focus the input, IME to Chinese");
 * - the content column is *read* in study mode (a PDF / web page) and *typed
 *   into* in code mode (the open file), so only code mode moves the caret.
 *
 * Both commands used to be gated on `mode === "study"`, which made them no-ops
 * in code mode (observed: "⌘⌥A does nothing while editing code").
 */

/** The caret is placed on the next frame; node has no frame clock. */
function stubFrame() {
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    fn(0);
    return 0;
  });
}

describe("reaching the agent input", () => {
  beforeEach(stubFrame);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const mode of ["study", "code"] as const) {
    it(`puts the assistant in the middle and asks its panel to focus the input (${mode})`, () => {
      useAppStore.setState({ mode, mainColumn: "content", agentPanelCommand: null });
      getCommand("region.focus-agent")?.run();
      const store = useAppStore.getState();
      expect(store.mainColumn).toBe("agent");
      // Identical in both modes: the signal, not a mode-specific branch.
      expect(store.agentPanelCommand?.kind).toBe("focus-input");
    });
  }

  it("is unavailable where no agent panel is mounted", () => {
    for (const mode of ["notes", "projects"] as const) {
      useAppStore.setState({ mode });
      expect(getCommand("region.focus-agent")?.when?.() ?? true).toBe(false);
    }
  });
});

describe("switching to the content column", () => {
  beforeEach(() => {
    stubFrame();
    useAppStore.setState({ mainColumn: "agent" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("only re-orders the middle column in study mode (the page is read, not typed into)", () => {
    useAppStore.setState({ mode: "study" });
    getCommand("region.focus-reading")?.run();
    expect(useAppStore.getState().mainColumn).toBe("content");
    // The chord may arrive forwarded from inside the page: keepsPageFocus tells
    // the forwarder to leave the first responder where it is (see previewFocus).
    expect(getCommand("region.focus-reading")?.keepsPageFocus).toBe(true);
  });

  it("also leaves the change list in code mode: the content column is the file", () => {
    useAppStore.setState({ mode: "code" });
    useCodeStore.setState({ diffOpen: true });
    getCommand("region.focus-reading")?.run();
    expect(useAppStore.getState().mainColumn).toBe("content");
    expect(useCodeStore.getState().diffOpen).toBe(false);
  });

  it("is unavailable where there is no content column to switch to", () => {
    for (const mode of ["notes", "projects"] as const) {
      useAppStore.setState({ mode });
      expect(getCommand("region.focus-reading")?.when?.() ?? true).toBe(false);
    }
  });
});
