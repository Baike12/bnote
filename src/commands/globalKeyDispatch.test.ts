import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    // ⌘= is the web zoom in the reading region and the editor font size
    // everywhere; with no web page open the first candidate must yield.
    expect(useAppStore.getState().studyContent).toBeNull();
    expect(resolveBoundCommand("Mod-=", "reading")).toBe(getCommand("view.zoom-in"));

    useAppStore.getState().setStudyContent({ kind: "url", url: "https://example.com", title: "x" });
    expect(resolveBoundCommand("Mod-=", "reading")).toBe(getCommand("study.web-zoom-in"));
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

  it("a region's own binding wins over the global meaning of the same key", () => {
    // ⌘[ is the note back-link globally and "back from fork" in the agent
    // panel; with the panel mounted the panel meaning runs.
    useAppStore.setState({ mode: "study", agentPanelCommand: null });
    expect(runBoundKey("Mod-[", "agent")).toBe(true);
    expect(useAppStore.getState().agentPanelCommand?.kind).toBe("back");
    expect(useAppStore.getState().linkBack).toEqual([]);
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
