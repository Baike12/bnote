import { beforeEach, describe, expect, it, vi } from "vitest";

// The command table imports the code-project commands, which pull xterm in;
// xterm probes a 2D canvas while its module evaluates, and jsdom has no canvas
// implementation. A null context is enough — nothing here renders a terminal.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
});

import "@/commands/builtin";
import { useCodeStore } from "@/code/store";
import { useFocusStore } from "@/focus/store";
import { focusedProjectPath, loadProjects, setFocusedProject } from "@/projects/store";
import { registerSwitcherCycle } from "@/lib/switcherSignal";
import { fakeVault } from "@/test/fakeVault";
import { setConfigSnapshot, useAppStore } from "@/state/appStore";
import { getCommand, runCommand } from "./registry";

/**
 * The commands that route a user intent to the store (or to a window event the
 * view listens on). There is no external system to fake: the store is the
 * system, and its state after the command is the observable behavior.
 *
 * These are also the commands the palette drives, so the file doubles as a
 * check that a palette row is not a dead entry.
 */

beforeEach(() => {
  setConfigSnapshot({});
  useAppStore.setState({
    vaultPath: null,
    currentFile: null,
    dirty: false,
    modal: null,
    settingsTab: null,
    sidebarOpen: true,
    sidebarFocusRequest: null,
    linkBack: [],
    linkSuggest: null,
    mode: "notes",
    mainColumn: "content",
    agentPanelCommand: null,
    agentSwitchSessionSignal: 0,
    toast: null,
    studyContent: null,
  });
  useCodeStore.setState({ diffOpen: false });
});

describe("opening a modal", () => {
  it("the palette command opens the palette, the settings command the settings modal", () => {
    runCommand("nav.command-palette");
    expect(useAppStore.getState().modal).toBe("palette");

    runCommand("workspace.open-settings");
    expect(useAppStore.getState().modal).toBe("settings");
  });

  it("the quick-add and capture-todo commands open their dialogs", () => {
    runCommand("workspace.quick-add");
    expect(useAppStore.getState().modal).toBe("quickadd");

    runCommand("workspace.capture-todo");
    expect(useAppStore.getState().modal).toBe("quicktodo");
  });

  it("the quick switcher opens first and then cycles on every repeat instead of re-opening", () => {
    const cycle = vi.fn(() => true);
    registerSwitcherCycle(cycle);
    try {
      runCommand("nav.quick-switcher");
      expect(useAppStore.getState().modal).toBe("switcher");
      expect(cycle).not.toHaveBeenCalled();

      // Holding the chord repeats the command; each repeat must move the
      // selection inside the open switcher, not reset it.
      runCommand("nav.quick-switcher");
      runCommand("nav.quick-switcher");
      expect(cycle.mock.calls).toEqual([[1], [1]]);
    } finally {
      registerSwitcherCycle(null);
    }
  });
});

describe("switching modes", () => {
  it("each view command toggles its own mode and leaves the others alone", () => {
    runCommand("view.toggle-study-mode");
    expect(useAppStore.getState().mode).toBe("study");

    runCommand("view.toggle-code-mode");
    expect(useAppStore.getState().mode).toBe("code");

    runCommand("view.toggle-projects");
    expect(useAppStore.getState().mode).toBe("projects");
  });

  it("pressing the same view command again returns to the notes view", () => {
    runCommand("view.toggle-study-mode");
    runCommand("view.toggle-study-mode");
    expect(useAppStore.getState().mode).toBe("notes");
  });

  it("entering a full-screen view collapses the vault sidebar, leaving it does not expand it back", () => {
    useAppStore.setState({ sidebarOpen: true });
    runCommand("view.toggle-study-mode");
    expect(useAppStore.getState().sidebarOpen).toBe(false);

    useAppStore.setState({ sidebarOpen: false });
    runCommand("view.toggle-study-mode");
    expect(useAppStore.getState().mode).toBe("notes");
    expect(useAppStore.getState().sidebarOpen).toBe(false);
  });
});

describe("the sidebar commands", () => {
  it("⌘\\ closes an open sidebar and expands a closed one", () => {
    useAppStore.setState({ sidebarOpen: true });
    runCommand("nav.toggle-sidebar");
    expect(useAppStore.getState().sidebarOpen).toBe(false);

    runCommand("nav.toggle-sidebar");
    expect(useAppStore.getState().sidebarOpen).toBe(true);
  });

  it("expanding a closed sidebar from the keyboard asks for the file row, unlike a mouse click", () => {
    // The distinction matters: glancing at the tree with the mouse must not
    // steal the editor's focus, but pressing ⌘\\ must land on the open file.
    useAppStore.setState({ sidebarOpen: false, sidebarFocusRequest: null });
    runCommand("nav.toggle-sidebar");
    expect(useAppStore.getState().sidebarOpen).toBe(true);
    expect(useAppStore.getState().sidebarFocusRequest).not.toBeNull();
  });

  it("the dedicated focus command expands the sidebar even when it was collapsed", () => {
    useAppStore.setState({ sidebarOpen: false, sidebarFocusRequest: null });
    runCommand("nav.focus-sidebar");
    expect(useAppStore.getState().sidebarOpen).toBe(true);
    expect(useAppStore.getState().sidebarFocusRequest).toBe(1);
  });
});

describe("region signals", () => {
  it("the focus-project command dispatches the window event the board listens on", () => {
    const heard = vi.fn();
    window.addEventListener("bnote:focus-project", heard);
    try {
      runCommand("region.focus-project");
    } finally {
      window.removeEventListener("bnote:focus-project", heard);
    }
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("each project action dispatches its own event, so a listener cannot mismatch them", () => {
    const events = ["bnote:new-project", "bnote:delete-project", "bnote:focus-daily"];
    const heard: string[] = [];
    const listener = (e: Event) => heard.push(e.type);
    for (const name of events) window.addEventListener(name, listener);
    try {
      runCommand("project.new");
      runCommand("project.delete");
      runCommand("project.focus-daily");
    } finally {
      for (const name of events) window.removeEventListener(name, listener);
    }
    expect(heard).toEqual(events);
  });

  it("working in the agent panel sends the panel command the store expects", () => {
    useAppStore.setState({ mode: "study", agentPanelCommand: null });
    runCommand("agent.new-session");
    expect(useAppStore.getState().agentPanelCommand?.kind).toBe("new");

    runCommand("agent.toggle-creative");
    expect(useAppStore.getState().agentPanelCommand?.kind).toBe("toggle-creative");

    runCommand("agent.focus-history");
    expect(useAppStore.getState().agentPanelCommand?.kind).toBe("history");
  });

  it("switching the assistant session bumps the signal the panel watches", () => {
    const before = useAppStore.getState().agentSwitchSessionSignal;
    runCommand("study.agent-switch-session");
    expect(useAppStore.getState().agentSwitchSessionSignal).toBe(before + 1);
  });

  it("the focus-agent command puts the assistant in the middle column and asks for its input", () => {
    useAppStore.setState({ mode: "study", mainColumn: "content", agentPanelCommand: null });
    runCommand("region.focus-agent");
    expect(useAppStore.getState().mainColumn).toBe("agent");
    expect(useAppStore.getState().agentPanelCommand?.kind).toBe("focus-input");
  });

  it("the focus-reading command only re-orders the columns in study mode: the page is read, not typed into", () => {
    useAppStore.setState({ mode: "study", mainColumn: "agent" });
    runCommand("region.focus-reading");
    expect(useAppStore.getState().mainColumn).toBe("content");
  });

  it("the focus-reading command also leaves the change list in code mode", () => {
    useAppStore.setState({ mode: "code", mainColumn: "agent" });
    useCodeStore.setState({ diffOpen: true });
    runCommand("region.focus-reading");
    expect(useCodeStore.getState().diffOpen).toBe(false);
  });
});

describe("WeRead", () => {
  it("opens the reading shelf in study mode, from whichever mode the user is in", () => {
    runCommand("view.open-weread");
    const state = useAppStore.getState();
    expect(state.mode).toBe("study");
    expect(state.studyContent?.kind).toBe("url");
    expect(state.studyContent?.kind === "url" ? state.studyContent.title : "").toBe("微信读书");
  });
});

describe("focus mode", () => {
  it("the pomodoro command starts the timer through its single writer", () => {
    // The command calls `useFocusStore.getState().start`, so the spy has to
    // sit on that action, not on a snapshot taken earlier.
    const store = useFocusStore.getState();
    const start = vi.spyOn(store, "start").mockResolvedValue(undefined);
    let calls = 0;
    try {
      runCommand("focus.pomodoro-start");
      calls = start.mock.calls.length;
    } finally {
      // mockRestore clears the recorded calls, so read the count first.
      start.mockRestore();
    }
    expect(calls).toBe(1);
  });
});

describe("project navigation", () => {
  it("prev and next move the focused project, and the ends clamp instead of wrapping", async () => {
    // Projects live under <vault>/.bnote/projects-manager; the list is the
    // disk's answer, so the fake vault is the fixture and the traversal is the
    // real one.
    fakeVault.seed({ ".bnote/projects-manager/a.md": "", ".bnote/projects-manager/b.md": "" });
    await loadProjects("/fake/vault");
    try {
      setFocusedProject(null);
      runCommand("project.next");
      expect(focusedProjectPath()).toBe("/fake/vault/.bnote/projects-manager/a.md");

      runCommand("project.next");
      runCommand("project.next");
      expect(focusedProjectPath()).toBe("/fake/vault/.bnote/projects-manager/b.md");

      // The end of the list is a stop, not a wrap-around: pressing again must
      // not teleport back to the first card.
      runCommand("project.prev");
      runCommand("project.prev");
      expect(focusedProjectPath()).toBe("/fake/vault/.bnote/projects-manager/a.md");
    } finally {
      fakeVault.seed({});
      await loadProjects("/fake/vault");
      setFocusedProject(null);
    }
  });
});

describe("backend commands reach the fake boundary", () => {
  it("the quick-add command carries the modal, not a write: the dialog collects the folder first", () => {
    runCommand("workspace.quick-add");
    expect(useAppStore.getState().modal).toBe("quickadd");
    expect(useAppStore.getState().currentFile).toBeNull();
  });

  it("the load-bearing commands are all reachable by id, so a palette row is never dead", () => {
    const ids = [
      "workspace.new-note",
      "workspace.open-daily",
      "workspace.save-note",
      "nav.quick-switcher",
      "nav.command-palette",
      "edit.toggle-bold",
      "view.zoom-in",
    ];
    for (const id of ids) expect(getCommand(id), id).toBeDefined();
  });
});
