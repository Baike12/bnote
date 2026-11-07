import { beforeEach, describe, expect, it, vi } from "vitest";

// The code store talks to the backend over IPC; this test only exercises the
// state transitions around open/close, so the api layer is a stub.
vi.mock("./api", () => ({
  codeApi: {
    openProject: vi.fn(async (root: string) => ({
      root,
      name: root.split("/").pop() ?? root,
      isGit: false,
      gitRoot: null,
      branch: null,
      tree: { entries: [], truncated: false },
    })),
    lspStop: vi.fn(async () => {}),
    gitStatus: vi.fn(async () => null),
  },
  termApi: {
    closeAll: vi.fn(async () => {}),
  },
}));

import { useAppStore } from "@/state/appStore";
import { useCodeStore } from "./store";

describe("the code store owns the project ref the rest of the app reads", () => {
  beforeEach(() => {
    useAppStore.setState({ codeProject: null });
  });

  it("openProject writes the appStore ref (the agent panel's scope)", async () => {
    await useCodeStore.getState().openProject("/tmp/repo-a");
    expect(useCodeStore.getState().project?.root).toBe("/tmp/repo-a");
    expect(useAppStore.getState().codeProject).toEqual({
      path: "/tmp/repo-a",
      title: "repo-a",
    });
  });

  it("a startup restore through openProject repairs a stale null ref", async () => {
    // App.tsx restores the pane without touching the ref; the mutator is the
    // one place that closes that gap.
    useAppStore.setState({ codeProject: null });
    await useCodeStore.getState().openProject("/tmp/repo-b");
    expect(useAppStore.getState().codeProject?.path).toBe("/tmp/repo-b");
  });

  it("closeProject clears the ref instead of leaving it stale", async () => {
    await useCodeStore.getState().openProject("/tmp/repo-a");
    await useCodeStore.getState().closeProject();
    expect(useCodeStore.getState().project).toBeNull();
    expect(useAppStore.getState().codeProject).toBeNull();
  });

  it("switching projects moves the ref with the pane", async () => {
    await useCodeStore.getState().openProject("/tmp/repo-a");
    await useCodeStore.getState().openProject("/tmp/repo-b");
    expect(useAppStore.getState().codeProject?.path).toBe("/tmp/repo-b");
  });
});
