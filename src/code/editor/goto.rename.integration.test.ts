import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";

/**
 * Rename applies a WorkspaceEdit to the files it names. Two rules decide
 * whether the user's work survives:
 *
 *   1. **the buffer is the base** — an open file may carry unsaved changes, so
 *      the new text is computed from the buffer, never from the old bytes on
 *      disk (those would silently erase the edits);
 *   2. **compute everything before writing** — a file that cannot be read must
 *      stop the whole rename, not leave half of the project renamed.
 *
 * Also locked: a file outside the project is skipped and counted (read-only),
 * a binary file is never rewritten from an empty text, and the buffer of an
 * open file is refreshed with what was written so the next save cannot undo
 * the rename.
 */

const mocks = vi.hoisted(() => ({
  lspRequest: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  refreshGit: vi.fn(async () => {}),
  replaceContent: vi.fn(),
  navigateTo: vi.fn(async () => {}),
  setReferences: vi.fn(),
  toast: vi.fn(),
  active: vi.fn(),
  files: {} as Record<string, { content: string; external: boolean }>,
}));

vi.mock("../api", () => ({
  codeApi: {
    lspRequest: mocks.lspRequest,
    readFile: mocks.readFile,
    writeFile: mocks.writeFile,
  },
}));
vi.mock("../store", () => ({
  useCodeStore: {
    getState: () => ({
      files: mocks.files,
      refreshGit: mocks.refreshGit,
      replaceContent: mocks.replaceContent,
      navigateTo: mocks.navigateTo,
      setReferences: mocks.setReferences,
    }),
  },
}));
vi.mock("@/state/appStore", () => ({
  useAppStore: { getState: () => ({ showToast: mocks.toast }) },
}));
vi.mock("./registry", () => ({ activeCodeEditor: mocks.active }));

import { gotoDefinition, renameSymbol } from "./goto";

function handle(root = "/proj", path = "src/a.ts", doc = "const old = 1\n") {
  return {
    root,
    language: "typescript",
    path,
    view: { state: EditorState.create({ doc }) },
  };
}

const RANGE = {
  start: { line: 0, character: 6 },
  end: { line: 0, character: 9 },
};

function editOf(uri: string, newText = "renamed", range = RANGE) {
  return { uri, edits: [{ range, newText }] };
}

function workspaceEdit(...files: ReturnType<typeof editOf>[]) {
  return {
    documentChanges: files.map((f) => ({
      textDocument: { uri: f.uri },
      edits: f.edits,
    })),
  };
}

beforeEach(() => {
  mocks.lspRequest.mockReset();
  mocks.readFile.mockReset();
  mocks.writeFile.mockReset();
  mocks.refreshGit.mockClear();
  mocks.replaceContent.mockClear();
  mocks.toast.mockClear();
  mocks.active.mockReset();
  mocks.active.mockReturnValue(handle());
  mocks.files = {};
  mocks.readFile.mockImplementation(async (_root: string, path: string) => ({
    path,
    content: "const old = 1\n",
    binary: false,
    languageId: "typescript",
    size: 14,
    external: false,
  }));
  mocks.writeFile.mockResolvedValue(undefined);
});

describe("renameSymbol", () => {
  it("applies the server's edit to the file it names and reports success", async () => {
    mocks.lspRequest
      .mockResolvedValueOnce({ range: RANGE, placeholder: "old" })
      .mockResolvedValueOnce(workspaceEdit(editOf("file:///proj/src/a.ts")));
    expect(await renameSymbol("renamed")).toBe(true);
    expect(mocks.lspRequest).toHaveBeenNthCalledWith(
      1,
      "/proj",
      "typescript",
      "textDocument/prepareRename",
      "src/a.ts",
      { position: { line: 0, character: 0 } },
    );
    expect(mocks.lspRequest).toHaveBeenNthCalledWith(
      2,
      "/proj",
      "typescript",
      "textDocument/rename",
      "src/a.ts",
      { position: { line: 0, character: 0 }, newName: "renamed" },
    );
    expect(mocks.writeFile).toHaveBeenCalledWith("/proj", "src/a.ts", "const renamed = 1\n");
    expect(mocks.refreshGit).toHaveBeenCalledTimes(1);
  });

  it("an open buffer is the base, so unsaved edits survive the rename", async () => {
    mocks.files = { "src/a.ts": { content: "const old = 2 // local edit\n", external: false } };
    mocks.lspRequest
      .mockResolvedValueOnce({ range: RANGE })
      .mockResolvedValueOnce(workspaceEdit(editOf("file:///proj/src/a.ts")));
    await renameSymbol("renamed");
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/proj",
      "src/a.ts",
      "const renamed = 2 // local edit\n",
    );
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it("the open buffer is refreshed with what was written", async () => {
    mocks.files = { "src/a.ts": { content: "const old = 1\n", external: false } };
    mocks.lspRequest
      .mockResolvedValueOnce({ range: RANGE })
      .mockResolvedValueOnce(workspaceEdit(editOf("file:///proj/src/a.ts")));
    await renameSymbol("renamed");
    expect(mocks.replaceContent).toHaveBeenCalledWith("src/a.ts", "const renamed = 1\n");
  });

  it("a file that is not open is read from disk and rewritten", async () => {
    mocks.lspRequest
      .mockResolvedValueOnce({ range: RANGE })
      .mockResolvedValueOnce(workspaceEdit(editOf("file:///proj/src/b.ts")));
    await renameSymbol("renamed");
    expect(mocks.readFile).toHaveBeenCalledWith("/proj", "src/b.ts");
    expect(mocks.writeFile).toHaveBeenCalledWith("/proj", "src/b.ts", "const renamed = 1\n");
    expect(mocks.replaceContent).not.toHaveBeenCalled();
  });

  it("every edit of a file is applied back to front", async () => {
    mocks.lspRequest.mockResolvedValueOnce({ range: RANGE }).mockResolvedValueOnce({
      changes: {
        "file:///proj/src/a.ts": [
          {
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
            newText: "one",
          },
          {
            range: { start: { line: 0, character: 12 }, end: { line: 0, character: 13 } },
            newText: "2",
          },
        ],
      },
    });
    await renameSymbol("renamed");
    expect(mocks.writeFile).toHaveBeenCalledWith("/proj", "src/a.ts", "const one = 2\n");
  });

  it("a file outside the project is skipped and counted, never written", async () => {
    mocks.lspRequest
      .mockResolvedValueOnce({ range: RANGE })
      .mockResolvedValueOnce(
        workspaceEdit(
          editOf("file:///deps/node_modules/lib.d.ts"),
          editOf("file:///proj/src/a.ts"),
        ),
      );
    await renameSymbol("renamed");
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).toHaveBeenCalledWith("/proj", "src/a.ts", "const renamed = 1\n");
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("1 处改动在项目外"));
  });

  it("an edit made only of external files changes nothing", async () => {
    mocks.lspRequest
      .mockResolvedValueOnce({ range: RANGE })
      .mockResolvedValueOnce(workspaceEdit(editOf("file:///deps/lib.d.ts")));
    expect(await renameSymbol("renamed")).toBe(false);
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.refreshGit).not.toHaveBeenCalled();
  });

  it("a binary file is left alone instead of being rewritten as empty text", async () => {
    mocks.readFile.mockResolvedValueOnce({
      path: "src/logo.png",
      content: "",
      binary: true,
      languageId: "plaintext",
      size: 0,
      external: false,
    });
    mocks.lspRequest
      .mockResolvedValueOnce({ range: RANGE })
      .mockResolvedValueOnce(workspaceEdit(editOf("file:///proj/src/logo.png")));
    expect(await renameSymbol("renamed")).toBe(false);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("prepareRename refusing the request stops before asking for the edit", async () => {
    mocks.lspRequest.mockResolvedValueOnce(null);
    expect(await renameSymbol("renamed")).toBe(false);
    expect(mocks.lspRequest).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("a failed rename request reports failure without writing", async () => {
    mocks.lspRequest.mockResolvedValueOnce({ range: RANGE }).mockRejectedValueOnce(new Error("x"));
    expect(await renameSymbol("renamed")).toBe(false);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("an empty WorkspaceEdit is a failure, not a silent success", async () => {
    mocks.lspRequest.mockResolvedValueOnce({ range: RANGE }).mockResolvedValueOnce({});
    expect(await renameSymbol("renamed")).toBe(false);
    expect(mocks.refreshGit).not.toHaveBeenCalled();
  });

  it("a write failure is reported and stops the remaining writes", async () => {
    mocks.writeFile.mockRejectedValueOnce(new Error("EACCES"));
    mocks.lspRequest
      .mockResolvedValueOnce({ range: RANGE })
      .mockResolvedValueOnce(
        workspaceEdit(editOf("file:///proj/src/a.ts"), editOf("file:///proj/src/b.ts")),
      );
    expect(await renameSymbol("renamed")).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.refreshGit).not.toHaveBeenCalled();
  });

  it("a read-only external document cannot be renamed at all", async () => {
    mocks.active.mockReturnValue(handle("/proj", "/deps/lib.ts"));
    mocks.files = { "/deps/lib.ts": { content: "x", external: true } };
    expect(await renameSymbol("renamed")).toBe(false);
    expect(mocks.lspRequest).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("只读"));
  });

  it("no active editor means no rename", async () => {
    mocks.active.mockReturnValue(null);
    expect(await renameSymbol("renamed")).toBe(false);
    expect(mocks.lspRequest).not.toHaveBeenCalled();
  });

  it("a root with a trailing slash still yields a project-relative path", async () => {
    mocks.active.mockReturnValue(handle("/proj/"));
    mocks.lspRequest
      .mockResolvedValueOnce({ range: RANGE })
      .mockResolvedValueOnce(workspaceEdit(editOf("file:///proj/src/a.ts")));
    await renameSymbol("renamed");
    expect(mocks.writeFile).toHaveBeenCalledWith("/proj/", "src/a.ts", "const renamed = 1\n");
  });
});

/**
 * The shapes a server is allowed to answer a jump request with: a single
 * Location, a LocationLink (`targetUri` + `targetSelectionRange`), and an array
 * mixing both. Only a usable start position becomes a jump — everything else is
 * "no definition", never an offset the editor would crash on.
 */
describe("the answer shapes of a jump request", () => {
  const location = (uri: string, line = 0, character = 0) => ({
    uri,
    range: { start: { line, character }, end: { line, character: character + 1 } },
  });

  it("a single Location object is accepted", async () => {
    mocks.lspRequest.mockResolvedValue(location("file:///proj/src/b.ts", 3, 1));
    await gotoDefinition();
    expect(mocks.navigateTo).toHaveBeenCalledWith("src/b.ts", { line: 3, character: 1 });
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("a LocationLink uses targetUri and targetSelectionRange", async () => {
    mocks.lspRequest.mockResolvedValue([
      {
        targetUri: "file:///proj/src/link.ts",
        targetRange: { start: { line: 0, character: 0 }, end: { line: 9, character: 0 } },
        targetSelectionRange: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } },
      },
    ]);
    await gotoDefinition();
    expect(mocks.navigateTo).toHaveBeenCalledWith("src/link.ts", { line: 4, character: 2 });
  });

  it("a LocationLink without a selection range falls back to the target range", async () => {
    mocks.lspRequest.mockResolvedValue([
      {
        targetUri: "file:///proj/src/link.ts",
        targetRange: { start: { line: 2, character: 3 }, end: { line: 9, character: 0 } },
      },
    ]);
    await gotoDefinition();
    expect(mocks.navigateTo).toHaveBeenCalledWith("src/link.ts", { line: 2, character: 3 });
  });

  it("a root with a trailing slash still matches in-project locations", async () => {
    mocks.active.mockReturnValue(handle("/proj/"));
    mocks.lspRequest.mockResolvedValue(location("file:///proj/src/b.ts", 1, 0));
    await gotoDefinition();
    expect(mocks.navigateTo).toHaveBeenCalledWith("src/b.ts", { line: 1, character: 0 });
  });
});

describe("the answers that are not locations", () => {
  it("a primitive answer is treated as no location instead of being indexed", async () => {
    mocks.lspRequest.mockResolvedValue("nope");
    await gotoDefinition();
    expect(mocks.navigateTo).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("当前位置没有可跳转的定义");
  });

  it("a prepareRename that fails skips the rename instead of forcing it", async () => {
    mocks.lspRequest.mockRejectedValueOnce(new Error("LSP_UNREACHABLE"));
    expect(await renameSymbol("renamed")).toBe(false);
    expect(mocks.lspRequest).toHaveBeenCalledTimes(1);
  });
});
