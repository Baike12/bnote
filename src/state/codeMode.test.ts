import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BINDINGS,
  applyOverrides,
  commandsForKey,
  defaultRegionOf,
} from "@/commands/keys";
import { getConfigSnapshot, toggleCodeMode, useAppStore } from "@/state/appStore";
import { codeSessionIdentity, codeSessionPath } from "@/code/sessionScope";

/**
 * Gate for "code mode is its own mode".
 *
 * A local vault and a code repository are unrelated: code mode may not be a
 * study material, so the three full-screen shapes (study / code / projects)
 * must stay mutually exclusive, the project must survive a restart, the mode
 * toggle must not steal ⌘⇧C (that key is "insert code block"), and a coding
 * transcript must live in the agent home, never in the vault.
 */

const state = () => useAppStore.getState();

afterEach(() => {
  applyOverrides({});
  useAppStore.setState({
    studyMode: false,
    codeMode: false,
    projectsMode: false,
    sidebarOpen: true,
  });
});

describe("the main area has exactly one shape", () => {
  it("entering code mode leaves study and the project view", () => {
    state().setStudyMode(true);
    state().setCodeMode(true);
    expect(state().codeMode).toBe(true);
    expect(state().studyMode).toBe(false);
    expect(state().projectsMode).toBe(false);
    // The sidebar collapses like in the other two full-screen modes.
    expect(state().sidebarOpen).toBe(false);
  });

  it("entering study mode or the project view leaves code mode", () => {
    state().setCodeMode(true);
    state().setStudyMode(true);
    expect(state().codeMode).toBe(false);
    expect(state().studyMode).toBe(true);

    state().setCodeMode(true);
    state().setProjectsMode(true);
    expect(state().codeMode).toBe(false);
    expect(state().projectsMode).toBe(true);
  });

  it("the toggle command enters code mode from any other shape", () => {
    state().setProjectsMode(true);
    toggleCodeMode();
    expect(state().codeMode).toBe(true);
    expect(state().projectsMode).toBe(false);
    toggleCodeMode();
    expect(state().codeMode).toBe(false);
  });
});

describe("the code project is remembered", () => {
  it("setCodeProject writes the project into the persisted config", () => {
    // Fake timers: the debounced disk write must not run in this test; the
    // synchronous config snapshot is the contract under test.
    vi.useFakeTimers();
    try {
      state().setCodeProject({ path: "/Users/me/repo", title: "repo" });
      expect(state().codeProject).toEqual({ path: "/Users/me/repo", title: "repo" });
      expect(getConfigSnapshot().codeProject).toEqual({
        path: "/Users/me/repo",
        title: "repo",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the code mode toggle has no default key", () => {
  it("⌘⇧C stays with insert-code-block", () => {
    expect(DEFAULT_BINDINGS["view.toggle-code-mode"]).toBeUndefined();
    expect(DEFAULT_BINDINGS["edit.insert-code-block"]).toBe("Mod-Shift-c");
    expect(defaultRegionOf("view.toggle-code-mode")).toBe("global");
  });

  it("a user-assigned key still works inside the code region", () => {
    // The code region only inherits a whitelist of global commands; the mode
    // toggle is on it, otherwise the code editor could only leave through the
    // palette.
    applyOverrides({ global: { "view.toggle-code-mode": "Mod-Shift-c" } });
    expect(commandsForKey("Mod-Shift-c", "code")).toContain("view.toggle-code-mode");
  });
});

describe("a coding transcript lives in the agent home", () => {
  it("the path is the home directory plus the session id, never the vault", () => {
    expect(codeSessionPath("/Users/me/.bnote/projects/x", "s1")).toBe(
      "/Users/me/.bnote/projects/x/s1.jsonl",
    );
    // A trailing slash from the backend does not produce a double slash.
    expect(codeSessionPath("/Users/me/.bnote/projects/x/", "s1")).toBe(
      "/Users/me/.bnote/projects/x/s1.jsonl",
    );
    // Unresolved home directory: the session simply is not persisted.
    expect(codeSessionPath(null, "s1")).toBeNull();
  });

  it("identity follows the project, and no project has its own identity", () => {
    expect(codeSessionIdentity("/Users/me/repo")).toBe("code|/Users/me/repo");
    expect(codeSessionIdentity("/Users/me/other")).not.toBe(
      codeSessionIdentity("/Users/me/repo"),
    );
    expect(codeSessionIdentity(null)).toBe("code|none");
  });
});
