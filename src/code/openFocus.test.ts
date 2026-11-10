import { beforeEach, describe, expect, it, vi } from "vitest";

// Opening a file only needs the IPC surface: the read result feeds the buffer
// table, the git status is refreshed by openProject.
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
      content: "one\ntwo\nthree\n",
      saved: "one\ntwo\nthree\n",
      binary: false,
      languageId: "plaintext",
      size: 14,
      external: false,
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

import { useCodeStore } from "./store";

/**
 * `editorFocus` is how an *explicit* open (Enter in the file tree,
 * double-click, quick open) asks the editor to take the keyboard. It is a
 * request and not a direct `view.focus()` because the caret lives in a
 * per-file `EditorState` that is swapped in by an effect, and an image tab has
 * no editor at all: only the editor knows when there is something to focus.
 */
describe("explicit open asks the editor for the keyboard", () => {
  beforeEach(async () => {
    await useCodeStore.getState().openProject("/tmp/repo");
    useCodeStore.setState({ editorFocus: 0 });
  });

  it("a plain open (previewing with the arrows) leaves the keys where they are", async () => {
    await useCodeStore.getState().openFile("src/a.ts");
    expect(useCodeStore.getState().activePath).toBe("src/a.ts");
    expect(useCodeStore.getState().editorFocus).toBe(0);
  });

  it("an explicit open bumps the request once the file is in place", async () => {
    await useCodeStore.getState().openFile("src/a.ts", { focus: true });
    expect(useCodeStore.getState().editorFocus).toBe(1);
    expect(useCodeStore.getState().activePath).toBe("src/a.ts");
  });

  it("an already open file (no disk read) is focused as well", async () => {
    await useCodeStore.getState().openFile("src/a.ts");
    await useCodeStore.getState().openFile("src/other.ts");
    await useCodeStore.getState().openFile("src/a.ts", { focus: true });
    expect(useCodeStore.getState().activePath).toBe("src/a.ts");
    expect(useCodeStore.getState().editorFocus).toBe(1);
  });

  it("every explicit open counts, even for the file already on screen", async () => {
    await useCodeStore.getState().openFile("src/a.ts", { focus: true });
    await useCodeStore.getState().openFile("src/a.ts", { focus: true });
    expect(useCodeStore.getState().editorFocus).toBe(2);
  });

  it("closing the project drops the request with everything else", async () => {
    await useCodeStore.getState().openFile("src/a.ts", { focus: true });
    await useCodeStore.getState().closeProject();
    expect(useCodeStore.getState().editorFocus).toBe(0);
  });
});
