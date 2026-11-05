import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BINDINGS, applyOverrides, commandsForKey, defaultRegionOf } from "@/commands/keys";
import { getConfigSnapshot, toggleCodeMode, useAppStore } from "@/state/appStore";
import { codeSessionIdentity, codeSessionPath } from "@/code/sessionScope";

/**
 * Gate for "code mode is its own mode".
 *
 * A local vault and a code repository are unrelated: code mode may not be a
 * study material. The main area has exactly one shape at a time, which the
 * store expresses as a single `mode` union — so these tests exercise the
 * transitions rather than checking three booleans for disagreement. Creative
 * mode is a different axis (the agent definition) and must not move the shape.
 * The project must survive a restart, the mode toggle must not steal ⌘⇧C
 * (that key is "insert code block"), and a coding transcript must live in the
 * agent home, never in the vault.
 */

const state = () => useAppStore.getState();

afterEach(() => {
  applyOverrides({});
  useAppStore.setState({ mode: "notes", creativeMode: false, sidebarOpen: true });
});

describe("the main area has exactly one shape", () => {
  it("entering a shape replaces the previous one", () => {
    state().setMode("study");
    state().setMode("code");
    expect(state().mode).toBe("code");
    state().setMode("projects");
    expect(state().mode).toBe("projects");
  });

  it("entering a full-screen shape collapses the sidebar, leaving does not expand it", () => {
    expect(state().sidebarOpen).toBe(true);
    state().setMode("code");
    expect(state().sidebarOpen).toBe(false);
    state().setMode("notes");
    expect(state().mode).toBe("notes");
    // The user can expand it inside the mode; leaving must not fight that.
    expect(state().sidebarOpen).toBe(false);
  });

  it("the toggle command enters the target shape from any other shape", () => {
    state().setMode("projects");
    toggleCodeMode();
    expect(state().mode).toBe("code");
    toggleCodeMode();
    expect(state().mode).toBe("notes");
  });

  it("creative mode is the agent definition, not a shape", () => {
    state().setMode("study");
    state().setCreativeMode(true);
    expect(state().mode).toBe("study");
    expect(state().creativeMode).toBe(true);
    state().setCreativeMode(false);
    expect(state().mode).toBe("study");
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
    expect(codeSessionIdentity("/Users/me/other")).not.toBe(codeSessionIdentity("/Users/me/repo"));
    expect(codeSessionIdentity(null)).toBe("code|none");
  });
});
