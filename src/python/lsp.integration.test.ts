import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, type Transaction, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * The ty LSP bridge is all ordering: a 500ms debounce pushes the aligned
 * virtual file, the same text is never pushed twice, a disabled project stops
 * the calls, and diagnostics are pasted only while the view still shows the
 * path they belong to. Those are the races the module's header promises to
 * close; the pure mapping functions are covered in `extract.test.ts`.
 */

const apiMock = vi.hoisted(() => ({
  pythonLspSync: vi.fn(),
  pythonLspClose: vi.fn(),
  pythonLspRequest: vi.fn(),
}));
const app = vi.hoisted(() => ({ toast: vi.fn() }));
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const listenMock = vi.hoisted(() =>
  vi.fn(async (channel: string, callback: (event: { payload: unknown }) => void) => {
    listeners.set(channel, callback);
    return () => {};
  }),
);

vi.mock("@/lib/tauri", () => ({ api: apiMock }));
vi.mock("@/state/appStore", () => ({
  useAppStore: { getState: () => ({ showToast: app.toast }) },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { editorApi } from "@/editor/api";
import { docPathField, setDocPath } from "@/editor/docPath";
import { pythonLspExtension, resetLspStateForPath, syncNow } from "./lsp";

const DOC = "# note\n\n```python\nprint(1)\n```\n";

class FakeView {
  state: EditorState;
  readonly dom = { isConnected: true };
  readonly dispatches: Transaction[] = [];

  constructor(doc: string, mdPath: string) {
    let state = EditorState.create({ doc, extensions: [docPathField] });
    state = state.update({ effects: setDocPath.of(mdPath) }).state;
    this.state = state;
  }

  dispatch(spec: Transaction | TransactionSpec): void {
    // EditorView.dispatch accepts both a Transaction and a TransactionSpec;
    // setDiagnostics() returns the latter, so a fake that only reads `.state`
    // would corrupt the view state.
    const transaction = "state" in spec ? spec : this.state.update(spec);
    this.dispatches.push(transaction);
    this.state = transaction.state;
  }
}

function installView(doc: string, mdPath: string): FakeView {
  const view = new FakeView(doc, mdPath);
  editorApi.view = view as unknown as EditorView;
  return view;
}

async function sync(view: FakeView): Promise<void> {
  syncNow(view as unknown as EditorView);
  await vi.waitFor(() => expect(apiMock.pythonLspSync).toHaveBeenCalled());
}

beforeAll(async () => {
  // Install the backend event listeners once per module; the extension factory
  // is the same entry point the editor setup uses.
  pythonLspExtension();
  await vi.waitFor(() => expect(listeners.has("python-lsp-diagnostics")).toBe(true));
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.pythonLspSync.mockResolvedValue({ enabled: true });
  apiMock.pythonLspClose.mockResolvedValue(undefined);
  app.toast.mockReset();
  editorApi.view = null;
});

describe("virtual text sync", () => {
  it("pushes the line-aligned extraction and skips an unchanged document", async () => {
    const path = "/vault/sync.md";
    const view = installView(DOC, path);

    await sync(view);
    expect(apiMock.pythonLspSync).toHaveBeenCalledTimes(1);
    expect(apiMock.pythonLspSync).toHaveBeenCalledWith(path, "\n\n\nprint(1)\n\n");

    // Same text on the next tick: the dedupe map must keep the server quiet.
    syncNow(view as unknown as EditorView);
    await Promise.resolve();
    await Promise.resolve();
    expect(apiMock.pythonLspSync).toHaveBeenCalledTimes(1);
  });

  it("pushes again after the python source changes, and closes when it disappears", async () => {
    const path = "/vault/edit.md";
    const view = installView(DOC, path);
    await sync(view);

    view.state = view.state.update({
      changes: { from: view.state.doc.length, insert: "\n" },
    }).state;
    syncNow(view as unknown as EditorView);
    await vi.waitFor(() => expect(apiMock.pythonLspSync).toHaveBeenCalledTimes(2));
    expect(apiMock.pythonLspSync.mock.calls[1]?.[1]).toContain("print(1)");

    // Removing the last python fence turns the note into prose: the backend is
    // told to close the virtual file instead of keeping a stale one.
    view.state = view.state.update({ changes: { from: 0, to: view.state.doc.length } }).state;
    syncNow(view as unknown as EditorView);
    await vi.waitFor(() => expect(apiMock.pythonLspClose).toHaveBeenCalledWith(path));
  });

  it("stops calling the server after the project reports the LSP disabled", async () => {
    const path = "/vault/off.md";
    apiMock.pythonLspSync.mockResolvedValue({ enabled: false });
    const view = installView(DOC, path);

    await sync(view);
    expect(apiMock.pythonLspSync).toHaveBeenCalledTimes(1);

    syncNow(view as unknown as EditorView);
    await Promise.resolve();
    await Promise.resolve();
    expect(apiMock.pythonLspSync).toHaveBeenCalledTimes(1);
  });

  it("reports one toast per 30s backoff window when the server cannot start", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const path = "/vault/fail.md";
      apiMock.pythonLspSync.mockRejectedValue("ty not found");
      const view = installView(DOC, path);

      syncNow(view as unknown as EditorView);
      await vi.waitFor(() => expect(app.toast).toHaveBeenCalledTimes(1));
      expect(app.toast).toHaveBeenCalledWith("ty 类型检查启动失败: ty not found");

      now.mockReturnValue(1_001_000);
      syncNow(view as unknown as EditorView);
      await vi.waitFor(() => expect(apiMock.pythonLspSync).toHaveBeenCalledTimes(2));
      expect(app.toast).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  it("ignores a note path that is not markdown", async () => {
    const view = installView(DOC, "/vault/data.json");
    syncNow(view as unknown as EditorView);
    await Promise.resolve();
    expect(apiMock.pythonLspSync).not.toHaveBeenCalled();
  });

  it("an empty python fence still syncs (the virtual file stays line-aligned)", async () => {
    const path = "/vault/empty-fence.md";
    const view = installView("```python\n```\n", path);
    syncNow(view as unknown as EditorView);
    await vi.waitFor(() => expect(apiMock.pythonLspSync).toHaveBeenCalledWith(path, "\n\n"));
  });

  it("a note that never had a python block is not closed on the backend", async () => {
    const view = installView("# prose only\n", "/vault/pure-prose.md");
    syncNow(view as unknown as EditorView);
    await Promise.resolve();
    expect(apiMock.pythonLspClose).not.toHaveBeenCalled();
  });

  it("a rejected close does not escape (the LSP may never have started)", async () => {
    const path = "/vault/close-fails.md";
    apiMock.pythonLspClose.mockRejectedValue("no session");
    const view = installView(DOC, path);
    await sync(view);

    view.state = view.state.update({ changes: { from: 0, to: view.state.doc.length } }).state;
    syncNow(view as unknown as EditorView);

    await vi.waitFor(() => expect(apiMock.pythonLspClose).toHaveBeenCalledWith(path));
    await expect(Promise.resolve()).resolves.toBeUndefined();
  });
});

describe("switching between notes", () => {
  it("re-pastes the stored diagnostics when a note comes back into the editor", async () => {
    const path = "/vault/switch.md";
    const handler = listeners.get("python-lsp-diagnostics");
    const view = installView(DOC, path);

    handler?.({
      payload: {
        mdPath: path,
        diagnostics: [
          {
            range: { start: { line: 3, character: 0 }, end: { line: 3, character: 3 } },
            message: "stored",
            severity: 1,
          },
        ],
      },
    });
    const afterEvent = view.dispatches.length;
    expect(afterEvent).toBeGreaterThan(0);

    // Another note takes the editor, then this one comes back: the stored
    // diagnostics have to be pasted onto the rebuilt document.
    const other = installView(DOC, "/vault/switch-other.md");
    syncNow(other as unknown as EditorView);
    await vi.waitFor(() => expect(apiMock.pythonLspSync).toHaveBeenCalled());

    editorApi.view = view as unknown as EditorView;
    syncNow(view as unknown as EditorView);
    await vi.waitFor(() => expect(view.dispatches.length).toBeGreaterThan(afterEvent));
  });
});

describe("diagnostics paste", () => {
  it("applies only the diagnostics of the note currently in the editor", async () => {
    const path = "/vault/diag.md";
    const view = installView(DOC, path);
    const diagnostics = [
      {
        range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } },
        message: "undefined name",
        severity: 1,
      },
    ];
    const handler = listeners.get("python-lsp-diagnostics");
    expect(handler).toBeDefined();

    handler?.({ payload: { mdPath: "/vault/other.md", diagnostics } });
    expect(view.dispatches).toHaveLength(0);

    handler?.({ payload: { mdPath: path, diagnostics } });
    expect(view.dispatches).toHaveLength(1);
  });

  it("reset clears the path's diagnostics and closes the backend file", async () => {
    const path = "/vault/reset.md";
    const view = installView(DOC, path);
    const handler = listeners.get("python-lsp-diagnostics");
    handler?.({
      payload: {
        mdPath: path,
        diagnostics: [
          {
            range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } },
            message: "x",
            severity: 1,
          },
        ],
      },
    });
    expect(view.dispatches).toHaveLength(1);

    resetLspStateForPath(path);
    // One dispatch clears the pasted diagnostics, and the backend session is closed.
    expect(view.dispatches).toHaveLength(2);
    expect(apiMock.pythonLspClose).toHaveBeenCalledWith(path);
  });
});
