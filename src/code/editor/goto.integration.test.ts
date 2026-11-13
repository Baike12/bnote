import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";

/**
 * The jump actions are the bridge between an LSP answer and the code store.
 * `gotoPlan.test.ts` locks the pure choice (in-project wins); this test locks
 * the whole path: request → URI decoding → project-relative/external target →
 * navigate or show an honest error.
 *
 * Every outcome is visible: the old flow returned silently for "server down",
 * "no definition" and "not bound", so a dead language server looked exactly
 * like a keybinding that never fired.
 */

const mocks = vi.hoisted(() => ({
  lspRequest: vi.fn(),
  navigateTo: vi.fn(async () => {}),
  setReferences: vi.fn(),
  toast: vi.fn(),
  active: vi.fn(),
}));

vi.mock("../api", () => ({ codeApi: { lspRequest: mocks.lspRequest } }));
vi.mock("../store", () => ({
  useCodeStore: {
    getState: () => ({
      navigateTo: mocks.navigateTo,
      setReferences: mocks.setReferences,
      files: {},
    }),
  },
}));
vi.mock("@/state/appStore", () => ({
  useAppStore: { getState: () => ({ showToast: mocks.toast }) },
}));
vi.mock("./registry", () => ({ activeCodeEditor: mocks.active }));

import { findReferences, gotoDefinition } from "./goto";

function handle() {
  return {
    root: "/proj",
    language: "typescript",
    path: "src/a.ts",
    view: { state: EditorState.create({ doc: "const x = 1\n" }) },
  };
}

function location(path: string, line = 0, character = 0) {
  return {
    uri: `file://${path}`,
    range: { start: { line, character }, end: { line, character: character + 1 } },
  };
}

beforeEach(() => {
  mocks.lspRequest.mockReset();
  mocks.navigateTo.mockClear();
  mocks.setReferences.mockClear();
  mocks.toast.mockClear();
  mocks.active.mockReset();
  mocks.active.mockReturnValue(handle());
});

describe("gotoDefinition", () => {
  it("jumps to an in-project target (relative path)", async () => {
    mocks.lspRequest.mockResolvedValue([location("/proj/src/b.ts", 4, 2)]);
    await gotoDefinition();
    expect(mocks.lspRequest).toHaveBeenCalledWith(
      "/proj",
      "typescript",
      "textDocument/definition",
      "src/a.ts",
      {
        position: { line: 0, character: 0 },
      },
    );
    expect(mocks.navigateTo).toHaveBeenCalledWith("src/b.ts", { line: 4, character: 2 });
  });

  it("prefers an in-project target over a stub from a dependency", async () => {
    mocks.lspRequest.mockResolvedValue([
      location("/deps/typeshed/builtins.pyi"),
      location("/proj/src/real.ts"),
    ]);
    await gotoDefinition();
    expect(mocks.navigateTo).toHaveBeenCalledWith("src/real.ts", { line: 0, character: 0 });
  });

  it("opens an external target read-only instead of pretending there is no definition", async () => {
    mocks.lspRequest.mockResolvedValue([location("/deps/lib.ts", 7, 1)]);
    await gotoDefinition();
    expect(mocks.navigateTo).toHaveBeenCalledWith("/deps/lib.ts", { line: 7, character: 1 });
  });

  it("reports a dead server with the actionable hint", async () => {
    mocks.lspRequest.mockRejectedValue(new Error("LSP_NOT_RUNNING: no server"));
    await gotoDefinition();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("没在运行"));
    expect(mocks.navigateTo).not.toHaveBeenCalled();
  });

  it("reports an unreachable server", async () => {
    mocks.lspRequest.mockRejectedValue(new Error("LSP_UNREACHABLE: timeout"));
    await gotoDefinition();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("没有响应"));
  });

  it("reports a failed request verbatim", async () => {
    mocks.lspRequest.mockRejectedValue(new Error("broken pipe"));
    await gotoDefinition();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("broken pipe"));
  });

  it("a null answer means the server found nothing (not a dead server)", async () => {
    mocks.lspRequest.mockResolvedValue(null);
    await gotoDefinition();
    expect(mocks.toast).toHaveBeenCalledWith("当前位置没有可跳转的定义");
  });

  it("drops malformed locations instead of issuing an invalid jump", async () => {
    mocks.lspRequest.mockResolvedValue([
      { uri: "file:///proj/src/b.ts" }, // no range
      { uri: "http://example.com/x", range: { start: { line: 0, character: 0 } } },
    ]);
    await gotoDefinition();
    expect(mocks.toast).toHaveBeenCalledWith("当前位置没有可跳转的定义");
    expect(mocks.navigateTo).not.toHaveBeenCalled();
  });

  it("does nothing without an active editor", async () => {
    mocks.active.mockReturnValue(null);
    await gotoDefinition();
    expect(mocks.lspRequest).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});

describe("findReferences", () => {
  it("puts every normalized location into the references panel", async () => {
    mocks.lspRequest.mockResolvedValue([
      location("/proj/src/a.ts", 1, 2),
      location("/deps/lib.ts", 3, 4),
    ]);
    await findReferences();
    expect(mocks.lspRequest).toHaveBeenCalledWith(
      "/proj",
      "typescript",
      "textDocument/references",
      "src/a.ts",
      { position: { line: 0, character: 0 }, context: { includeDeclaration: true } },
    );
    expect(mocks.setReferences).toHaveBeenCalledWith([
      { path: "src/a.ts", position: { line: 1, character: 2 }, external: false },
      { path: "/deps/lib.ts", position: { line: 3, character: 4 }, external: true },
    ]);
  });

  it("reports an unavailable server instead of showing an empty panel", async () => {
    mocks.lspRequest.mockRejectedValue(new Error("LSP_NOT_RUNNING"));
    await findReferences();
    expect(mocks.setReferences).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("没在运行"));
  });
});
