import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/commands/builtin";
import { useAppStore, setConfigSnapshot } from "@/state/appStore";
import {
  resolveBoundCommand,
  runBoundKey,
  setCommandKeyContext,
  setKeyModalOpen,
  setHotkeyRecording,
} from "./globalKeys";
import { getCommand } from "./registry";
import { applyOverrides } from "./keys";

/**
 * Dispatch is one path for both entry points: a keydown in the main window and
 * a chord forwarded from the web page come through `runBoundKey`, which
 * resolves the candidates of the region, skips commands whose `when` is false,
 * and only then runs one. These are the rules that decide what a keystroke
 * actually does — they are gated here without a DOM (the listener itself is
 * exercised in globalKeys.integration.test.ts).
 */

beforeEach(() => {
  applyOverrides({});
  setConfigSnapshot({});
  useAppStore.setState({
    mode: "notes",
    modal: null,
    mainColumn: "content",
    agentPanelCommand: null,
    studyContent: null,
    settings: { ...useAppStore.getState().settings, studyWebZoom: 1, fontSize: 16 },
  });
});

afterEach(() => {
  setCommandKeyContext(null);
  setKeyModalOpen(false);
  setHotkeyRecording(false);
  applyOverrides({});
});

describe("resolving a key to its command", () => {
  it("returns the registered definition itself, so the caller can read keepsPageFocus", () => {
    const resolved = resolveBoundCommand("Mod-b", "notes");
    expect(resolved).toBe(getCommand("edit.toggle-bold"));
  });

  it("falls through to the next candidate while the first one's when guard is false", () => {
    // A deliberate user override puts two commands on one key in the notes
    // region. The web zoom is guarded off until a page is open, so bold runs
    // first; with a page open the zoom takes the key.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    applyOverrides({
      notes: { "study.web-zoom-in": "Ctrl-7", "code.toggle-wrap": "Ctrl-7" },
    });
    expect(useAppStore.getState().studyContent).toBeNull();
    expect(resolveBoundCommand("Ctrl-7", "notes")).toBe(getCommand("code.toggle-wrap"));

    useAppStore.getState().setStudyContent({ kind: "url", url: "https://example.com", title: "x" });
    expect(resolveBoundCommand("Ctrl-7", "notes")).toBe(getCommand("study.web-zoom-in"));
    warn.mockRestore();
  });

  it("returns null when every candidate is guarded off", () => {
    // ⌘⌥A only exists where an agent panel is mounted (study / code).
    expect(resolveBoundCommand("Mod-Alt-a", "reading")).toBeNull();

    useAppStore.setState({ mode: "study" });
    expect(resolveBoundCommand("Mod-Alt-a", "reading")).toBe(getCommand("region.focus-agent"));
  });

  it("returns null for a key that has no binding in the region", () => {
    expect(resolveBoundCommand("Mod-b", "agent")).toBeNull();
    expect(resolveBoundCommand("Mod-Shift-z", "notes")).toBeNull();
  });

  it("resolving does not run anything: the same key can be resolved repeatedly", () => {
    useAppStore.setState({ mode: "study", agentPanelCommand: null });
    resolveBoundCommand("Mod-Alt-a", "reading");
    resolveBoundCommand("Mod-Alt-a", "reading");
    expect(useAppStore.getState().agentPanelCommand).toBeNull();
    expect(useAppStore.getState().mainColumn).toBe("content");
  });
});

describe("running a bound key", () => {
  it("reports false and changes nothing when the key is not bound in the region", () => {
    expect(runBoundKey("Mod-b", "agent")).toBe(false);
    expect(useAppStore.getState().settings.vim).toBe(false);
  });

  it("runs the region binding and reports true", () => {
    useAppStore.setState({ mode: "study", agentPanelCommand: null });
    expect(runBoundKey("Mod-[", "agent")).toBe(true);
    expect(useAppStore.getState().agentPanelCommand?.kind).toBe("back");
  });

  it("runs a global command from any region: the palette opens from the reading pane too", () => {
    expect(runBoundKey("Mod-p", "reading")).toBe(true);
    expect(useAppStore.getState().modal).toBe("palette");
  });

  it("each region keeps its own meaning of the same key (⌘[ is back-from-fork in Agent, back-link in notes)", () => {
    useAppStore.setState({ mode: "study", agentPanelCommand: null });
    expect(runBoundKey("Mod-[", "agent")).toBe(true);
    expect(useAppStore.getState().agentPanelCommand?.kind).toBe("back");
    expect(useAppStore.getState().linkBack).toEqual([]);
    // The notes region's copy is the note back-link; the panel's binding does
    // not fire there.
    expect(resolveBoundCommand("Mod-[", "notes")).toBe(getCommand("nav.back-link"));
  });
});

describe("the drawing mode guard", () => {
  it("blocks a region command while the canvas owns the keys", () => {
    setCommandKeyContext("drawing");
    expect(runBoundKey("Mod-Shift-v", "notes")).toBe(false);
    expect(useAppStore.getState().settings.vim).toBe(false);
  });

  it("lets the three file-switching commands through: a drawing is still a file", () => {
    setCommandKeyContext("drawing");
    expect(runBoundKey("Mod-p", "notes")).toBe(true);
    expect(useAppStore.getState().modal).toBe("palette");

    useAppStore.getState().setModal(null);
    expect(runBoundKey("Mod-o", "notes")).toBe(true);
    expect(useAppStore.getState().modal).toBe("switcher");

    useAppStore.getState().setModal(null);
    expect(runBoundKey("Mod-Shift-o", "notes")).toBe(true);
  });

  it("drops the guard once the canvas closes", () => {
    setCommandKeyContext("drawing");
    expect(runBoundKey("Mod-Shift-v", "notes")).toBe(false);
    setCommandKeyContext(null);
    expect(runBoundKey("Mod-Shift-v", "notes")).toBe(true);
    expect(useAppStore.getState().settings.vim).toBe(true);
  });
});
