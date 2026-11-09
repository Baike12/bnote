import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// The change list is a projection of the git status; the pane's own store
// transitions (diff mode vs file, the revision a save bumps) only need the
// IPC surface stubbed.
vi.mock("./api", () => ({
  codeApi: {
    openProject: vi.fn(async (root: string) => ({
      root,
      name: root.split("/").pop() ?? root,
      isGit: true,
      gitRoot: root,
      branch: "main",
      tree: { entries: [], truncated: false },
    })),
    readFile: vi.fn(async (_root: string, path: string) => ({
      path,
      content: "x\n",
      saved: "x\n",
      binary: false,
      languageId: "plaintext",
    })),
    gitStatus: vi.fn(async () => ({
      isRepo: true,
      root: "/tmp/repo",
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
    })),
    lspClose: vi.fn(async () => {}),
    lspStop: vi.fn(async () => {}),
    lspSync: vi.fn(async () => {}),
  },
  termApi: {
    closeAll: vi.fn(async () => {}),
  },
}));

import { changeDir, changeName, changeTotals, changesForSource, patchKey } from "./changes";
import { useCodeStore } from "./store";
import type { GitFileState, GitStatus } from "./types";

function file(over: Partial<GitFileState> & { path: string }): GitFileState {
  return {
    origPath: null,
    index: " ",
    worktree: " ",
    added: 0,
    removed: 0,
    stagedAdded: 0,
    stagedRemoved: 0,
    ...over,
  };
}

function git(files: GitFileState[]): GitStatus {
  return {
    isRepo: true,
    root: "/tmp/repo",
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    files,
  };
}

describe("the change list of one side", () => {
  const status = git([
    // Modified in the worktree only.
    file({ path: "src/a.ts", worktree: "M", added: 3, removed: 1 }),
    // Staged addition, untouched afterwards.
    file({ path: "src/b.ts", index: "A", stagedAdded: 10 }),
    // Staged modification, modified again in the worktree: both sides list it
    // with their own counts.
    file({
      path: "src/c.ts",
      index: "M",
      worktree: "M",
      added: 1,
      removed: 1,
      stagedAdded: 2,
      stagedRemoved: 0,
    }),
    // Staged deletion.
    file({ path: "src/d.ts", index: "D", stagedRemoved: 4 }),
    // Rename.
    file({ path: "src/e2.ts", origPath: "src/e.ts", index: "R", stagedAdded: 0, stagedRemoved: 0 }),
    // Untracked.
    file({ path: "notes.txt", index: "?", worktree: "?", added: 7 }),
    // Unmerged.
    file({ path: "src/u.ts", index: "U", worktree: "U" }),
    // Untouched (only the stat fields differ, no state letter).
    file({ path: "src/clean.ts", added: 0 }),
  ]);

  it("the worktree side lists what git reports for the worktree, with those counts", () => {
    const changes = changesForSource(status, "worktree");
    expect(changes.map((c) => [c.path, c.kind])).toEqual([
      ["src/a.ts", "modified"],
      ["src/c.ts", "modified"],
      ["notes.txt", "added"],
      ["src/u.ts", "conflicted"],
    ]);
    const a = changes.find((c) => c.path === "src/a.ts");
    expect([a?.added, a?.removed]).toEqual([3, 1]);
    const c = changes.find((c) => c.path === "src/c.ts");
    expect([c?.added, c?.removed]).toEqual([1, 1]);
  });

  it("the staged side lists the index and never claims an untracked file", () => {
    const changes = changesForSource(status, "staged");
    expect(changes.map((c) => [c.path, c.kind])).toEqual([
      ["src/b.ts", "added"],
      ["src/c.ts", "modified"],
      ["src/d.ts", "deleted"],
      ["src/e2.ts", "renamed"],
      ["src/u.ts", "conflicted"],
    ]);
    const c = changes.find((c) => c.path === "src/c.ts");
    expect([c?.added, c?.removed]).toEqual([2, 0]);
    expect(changes.find((c) => c.path === "src/e2.ts")?.origPath).toBe("src/e.ts");
  });

  it("a non-repository has no changes, and the totals add both directions", () => {
    expect(changesForSource(null, "worktree")).toEqual([]);
    expect(changesForSource({ ...status, isRepo: false }, "worktree")).toEqual([]);
    expect(changeTotals(changesForSource(status, "worktree"))).toEqual({ added: 11, removed: 2 });
  });

  it("splits a path into the row's name and directory", () => {
    expect(changeName("src/code/store.ts")).toBe("store.ts");
    expect(changeDir("src/code/store.ts")).toBe("src/code");
    expect(changeName("README.md")).toBe("README.md");
    expect(changeDir("README.md")).toBe("");
  });

  it("the patch key separates the two sides of the same path", () => {
    expect(patchKey("src/a.ts", false)).not.toBe(patchKey("src/a.ts", true));
    expect(patchKey("src/a.ts", false)).toBe(patchKey("src/a.ts", false));
  });
});

/**
 * The open row's patch is read by an effect. Its inputs must be read-only
 * values only (which file, which side, which revision): when the state the
 * effect writes was itself a dependency, every progress write cancelled the
 * request it had just started, and the row stayed on “读取改动…” forever
 * (observed on a 318-line untracked file — the backend answered in 28ms).
 */
describe("the patch request depends on its inputs, never on its own result", () => {
  const view = readFileSync("src/code/components/DiffView.tsx", "utf8");

  const dependencyArrays = [...view.matchAll(/\},\s*\[([^\]]*)\],?\s*\)/g)].map((m) => m[1]);

  it("no effect lists the patch state it writes as a dependency", () => {
    expect(dependencyArrays.length).toBeGreaterThan(0);
    expect(dependencyArrays.filter((deps) => /\bpatch(es)?\b/.test(deps))).toEqual([]);
  });

  it("the request is re-issued when the revision moves, so a save shows its new diff", () => {
    expect(dependencyArrays).toContain("expanded, root, staged, gitRev");
  });
});

describe("diff mode is left by choosing a file", () => {
  beforeEach(async () => {
    await useCodeStore.getState().openProject("/tmp/repo");
    useCodeStore.setState({ diffOpen: true });
  });

  it("switching tabs returns to the editor, even for the tab already active", () => {
    // The old rule returned early when the path was unchanged, which is
    // exactly the case of "I closed the diff, show me this file".
    useCodeStore.setState({ activePath: "src/a.ts" });
    useCodeStore.getState().setActiveTab("src/a.ts");
    expect(useCodeStore.getState().diffOpen).toBe(false);
  });

  it("opening a file from the tree returns to the editor", async () => {
    await useCodeStore.getState().openFile("src/b.ts");
    expect(useCodeStore.getState().activePath).toBe("src/b.ts");
    expect(useCodeStore.getState().diffOpen).toBe(false);
  });

  it("每读一次 git 状态，改动缓存的版本号就前进一格（保存后差异必须重新取）", async () => {
    const before = useCodeStore.getState().gitRev;
    await useCodeStore.getState().refreshGit();
    await useCodeStore.getState().refreshGit();
    expect(useCodeStore.getState().gitRev).toBe(before + 2);
  });
});
