import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/commands/builtin";
import { getCommand } from "./registry";
import { useAppStore } from "@/state/appStore";
import { useCodeStore } from "@/code/store";
import {
  registerCodeEditor,
  unregisterCodeEditor,
  type CodeEditorHandle,
} from "@/code/editor/registry";

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

/**
 * A code editor handle whose selection is `from..to` of `text`, with just the
 * parts `quoteCodeSelection` reads. Cast because an EditorView is a whole
 * runtime; building one in node would test CodeMirror, not the quote.
 */
function fakeEditor(text: string, from: number, to: number): CodeEditorHandle {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
  const view = {
    state: {
      doc: {
        lineAt: (pos: number) => {
          let number = 1;
          for (let i = 0; i < starts.length; i += 1) if (starts[i] <= pos) number = i + 1;
          return { number };
        },
      },
      selection: { main: { from, to, empty: from === to } },
      sliceDoc: (a: number, b: number) => text.slice(a, b),
    },
    dom: { isConnected: true },
  };
  return {
    root: "/proj",
    path: "src/a.ts",
    language: "typescript",
    view,
  } as unknown as CodeEditorHandle;
}

const SOURCE = "function a() {\n  return 1;\n}\n";

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

  /**
   * The chord doubles as "quote this code": with a selection in the editor the
   * reference travels with the focus signal, so the box opens already holding
   * it. Zed spells this `agent::AddSelectionToThread`; the text form has to
   * carry the path and the line range itself.
   */
  it("carries a selected block of code into the input signal", () => {
    const from = SOURCE.indexOf("  return");
    const handle = fakeEditor(SOURCE, from, from + "  return 1;".length);
    registerCodeEditor(handle);
    try {
      useAppStore.setState({ mode: "code", mainColumn: "content", agentPanelCommand: null });
      getCommand("region.focus-agent")?.run();
      const req = useAppStore.getState().agentPanelCommand;
      expect(req?.kind).toBe("focus-input");
      expect(req?.insert).toBe("src/a.ts:2\n```typescript\n  return 1;\n```\n");
    } finally {
      unregisterCodeEditor(handle);
    }
  });

  it("only moves the keyboard when nothing is selected", () => {
    const handle = fakeEditor(SOURCE, 5, 5);
    registerCodeEditor(handle);
    try {
      useAppStore.setState({ mode: "code", mainColumn: "content", agentPanelCommand: null });
      getCommand("region.focus-agent")?.run();
      const req = useAppStore.getState().agentPanelCommand;
      expect(req?.kind).toBe("focus-input");
      expect(req?.insert).toBeUndefined();
    } finally {
      unregisterCodeEditor(handle);
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

/**
 * The panel actions (new / fork / back / history) belong to the panel, and the
 * panel is mounted in both three-column layouts. They were gated on
 * `mode === "study"`, so in code mode the fork binding fell through to the next
 * candidate for ⌘N — the global "new note" — and created a note instead
 * (observed). The gate is the layout, not the mode.
 */
describe("assistant panel actions in the code layout", () => {
  it("fork and back run in code mode, like in study mode", () => {
    for (const mode of ["study", "code"] as const) {
      useAppStore.setState({ mode, agentPanelCommand: null });
      expect(getCommand("agent.fork-session")?.when?.() ?? true).toBe(true);
      getCommand("agent.fork-session")?.run();
      expect(useAppStore.getState().agentPanelCommand?.kind).toBe("fork");
      getCommand("agent.back-from-fork")?.run();
      expect(useAppStore.getState().agentPanelCommand?.kind).toBe("back");
    }
  });

  it("is unavailable where no panel is mounted", () => {
    for (const mode of ["notes", "projects"] as const) {
      useAppStore.setState({ mode });
      expect(getCommand("agent.fork-session")?.when?.() ?? true).toBe(false);
      expect(getCommand("agent.back-from-fork")?.when?.() ?? true).toBe(false);
    }
  });
});
