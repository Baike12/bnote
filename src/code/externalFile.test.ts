import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A file the language server points at may live outside the project (a type
 * declaration under `node_modules` or the TypeScript cache). It opens — Zed and
 * VSCode both land there — but it is **read-only**: the backend's write path
 * stays inside the project root, so a save must never be attempted.
 */

const EXTERNAL = "/Users/me/Library/Caches/typescript/5.9/node_modules/@types/node/url.d.ts";

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
    readFile: vi.fn(async (_root: string, path: string) => ({
      path,
      content: "declare class URL {}\n",
      binary: false,
      languageId: "typescript",
      size: 21,
      external: path.startsWith("/"),
    })),
    writeFile: vi.fn(async () => {}),
    gitStatus: vi.fn(async () => ({
      isRepo: false,
      root: null,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
    })),
    lspStart: vi.fn(async () => ({ language: "typescript", state: "running" })),
    lspSync: vi.fn(async () => true),
    lspClose: vi.fn(async () => {}),
    lspStop: vi.fn(async () => {}),
  },
  termApi: {
    closeAll: vi.fn(async () => {}),
  },
}));

import { codeApi } from "./api";
import { useCodeStore } from "./store";

describe("an external file is readable but never writable", () => {
  beforeEach(async () => {
    await useCodeStore.getState().openProject("/tmp/repo");
  });

  it("marks the buffer as external", async () => {
    await useCodeStore.getState().openFile(EXTERNAL);
    const file = useCodeStore.getState().files[EXTERNAL];
    expect(file?.external).toBe(true);
    expect(useCodeStore.getState().tabs).toContain(EXTERNAL);
    expect(useCodeStore.getState().activePath).toBe(EXTERNAL);
  });

  it("saving an external file writes nothing", async () => {
    await useCodeStore.getState().openFile(EXTERNAL);
    await useCodeStore.getState().saveFile(EXTERNAL);
    expect(codeApi.writeFile).not.toHaveBeenCalled();
  });

  it("saves a project file as before", async () => {
    await useCodeStore.getState().openFile("src/a.ts");
    await useCodeStore.getState().saveFile("src/a.ts");
    expect(codeApi.writeFile).toHaveBeenCalledWith(
      "/tmp/repo",
      "src/a.ts",
      "declare class URL {}\n",
    );
  });
});
