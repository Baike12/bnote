import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The run panel is a single-writer state machine fed by backend events. Two
 * invariants keep it honest:
 *
 *   - only the current run's output may enter the panel (a slow cancel/exit
 *     event from the previous run must not paint the next one);
 *   - the log is bounded (a runaway print loop must not eat the renderer).
 *
 * The tests drive the real store and the real `runCurrentNote` path; only the
 * IPC boundary, the editor view and the toast sink are faked.
 */

const app = vi.hoisted(() => ({
  currentFile: "C:/vault/note.md" as string | null,
  toast: vi.fn(),
}));
const editor = vi.hoisted(() => ({ view: null as unknown }));
const apiMock = vi.hoisted(() => ({
  pythonRun: vi.fn(),
  pythonRunCancel: vi.fn(),
  pythonUvCreate: vi.fn(),
}));
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const listenMock = vi.hoisted(() =>
  vi.fn(async (channel: string, callback: (event: { payload: unknown }) => void) => {
    listeners.set(channel, callback);
    return () => {};
  }),
);

vi.mock("@/state/appStore", () => ({
  useAppStore: {
    getState: () => ({ currentFile: app.currentFile, showToast: app.toast }),
  },
}));
vi.mock("@/editor/api", () => ({ editorApi: editor }));
vi.mock("@/lib/tauri", () => ({ api: apiMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { usePythonRun, createUvEnvForCurrentProject, runCurrentNote, stopRun } from "./run";

const DOC = "# demo\n\n```python\nprint(1)\n```\n";

function fakeView(text: string) {
  return { state: { doc: { toString: () => text } } };
}

function resetStore() {
  usePythonRun.setState({
    open: false,
    runId: null,
    mdPath: null,
    command: "",
    lines: [],
    running: false,
    exitCode: null,
    cancelled: false,
    timedOut: false,
    durationMs: null,
  });
}

beforeEach(() => {
  resetStore();
  app.currentFile = "C:/vault/note.md";
  app.toast.mockReset();
  editor.view = null;
  apiMock.pythonRun.mockReset();
  apiMock.pythonRunCancel.mockReset();
  apiMock.pythonUvCreate.mockReset();
  vi.clearAllMocks();
});

describe("run panel state", () => {
  it("ignores output and exit events from another run", () => {
    const store = usePythonRun.getState();
    store.beginRun(
      { runId: 7, command: "python3 note.py", envKind: "system", program: "python3", cwd: "/v" },
      "C:/vault/note.md",
    );
    store.append("stdout", "from run 7\n");

    store.finish({
      runId: 6,
      mdPath: "C:/vault/note.md",
      exitCode: 1,
      cancelled: false,
      timedOut: false,
      durationMs: 5,
    });
    expect(usePythonRun.getState().running).toBe(true);
    expect(usePythonRun.getState().exitCode).toBeNull();

    store.finish({
      runId: 7,
      mdPath: "C:/vault/note.md",
      exitCode: 0,
      cancelled: false,
      timedOut: false,
      durationMs: 12,
    });
    expect(usePythonRun.getState()).toMatchObject({
      running: false,
      exitCode: 0,
      durationMs: 12,
    });
  });

  it("caps the log and keeps the newest lines", () => {
    const store = usePythonRun.getState();
    // The trim happens when the log crosses 4000, then the remaining appends
    // continue: 4001 entries -> the newest 2000 -> four more appends.
    for (let i = 0; i < 4005; i++) store.append("stdout", `line ${i}`);
    const { lines } = usePythonRun.getState();
    expect(lines).toHaveLength(2004);
    expect(lines[lines.length - 1]?.text).toBe("line 4004");
    expect(lines[0]?.text).toBe("line 2001");
  });

  it("routes backend events only into the running run", async () => {
    apiMock.pythonRun.mockResolvedValue({
      runId: 11,
      command: "python3 note.py",
      envKind: "system",
      program: "python3",
      cwd: "/v",
    });
    editor.view = fakeView(DOC);
    await runCurrentNote();
    expect(usePythonRun.getState().runId).toBe(11);

    const output = listeners.get("python-run-output");
    expect(output).toBeDefined();
    output?.({
      payload: { runId: 10, mdPath: "C:/vault/note.md", stream: "stdout", text: "stale\n" },
    });
    output?.({
      payload: { runId: 11, mdPath: "C:/vault/note.md", stream: "stdout", text: "fresh\n" },
    });
    expect(usePythonRun.getState().lines.map((line) => line.text)).toEqual(["fresh\n"]);

    output?.({
      payload: { runId: 11, mdPath: "C:/vault/note.md", stream: "stderr", text: "warn\n" },
    });
    expect(usePythonRun.getState().lines.map((line) => line.stream)).toEqual(["stdout", "stderr"]);

    const exit = listeners.get("python-run-exit");
    exit?.({
      payload: {
        runId: 11,
        mdPath: "C:/vault/note.md",
        exitCode: 0,
        cancelled: false,
        timedOut: false,
        durationMs: 9,
      },
    });
    expect(usePythonRun.getState().running).toBe(false);

    output?.({
      payload: { runId: 11, mdPath: "C:/vault/note.md", stream: "stdout", text: "after exit\n" },
    });
    expect(usePythonRun.getState().lines).toHaveLength(2);
  });
});

describe("runCurrentNote", () => {
  it("extracts the python blocks and starts the run", async () => {
    editor.view = fakeView(DOC);
    apiMock.pythonRun.mockResolvedValue({
      runId: 1,
      command: "python3 note.py",
      envKind: "system",
      program: "python3",
      cwd: "/v",
    });

    await runCurrentNote();

    // Non-python lines become blank lines: ty's line numbers stay aligned with
    // the markdown source, which is what the diagnostics mapping relies on.
    expect(apiMock.pythonRun).toHaveBeenCalledWith("C:/vault/note.md", "\n\n\nprint(1)\n\n");
    expect(usePythonRun.getState()).toMatchObject({
      open: true,
      running: true,
      runId: 1,
      mdPath: "C:/vault/note.md",
    });
  });

  it("explains why nothing can run", async () => {
    editor.view = null;
    await runCurrentNote();
    expect(app.toast).toHaveBeenLastCalledWith("没有打开的笔记");

    editor.view = fakeView("# prose only\n");
    await runCurrentNote();
    expect(app.toast).toHaveBeenLastCalledWith("这篇笔记没有 python 代码块(```python 围栏)");
    expect(apiMock.pythonRun).not.toHaveBeenCalled();
  });

  it("surfaces a backend failure as a toast", async () => {
    editor.view = fakeView(DOC);
    apiMock.pythonRun.mockRejectedValue("PYTHON_MISSING: no interpreter");
    await runCurrentNote();
    expect(app.toast).toHaveBeenCalledWith("运行失败: PYTHON_MISSING: no interpreter");
    expect(usePythonRun.getState().running).toBe(false);
  });
});

describe("stopRun and uv env", () => {
  it("cancels the run of the note that started it", async () => {
    usePythonRun.setState({ mdPath: "C:/vault/note.md" });
    apiMock.pythonRunCancel.mockResolvedValue(true);
    await stopRun();
    expect(apiMock.pythonRunCancel).toHaveBeenCalledWith("C:/vault/note.md");
  });

  it("does nothing without a run", async () => {
    await stopRun();
    expect(apiMock.pythonRunCancel).not.toHaveBeenCalled();
  });

  it("a refused cancel reaches the user instead of failing silently", async () => {
    usePythonRun.setState({ mdPath: "C:/vault/note.md" });
    apiMock.pythonRunCancel.mockRejectedValue("RUN_GONE");
    await stopRun();
    expect(app.toast).toHaveBeenCalledWith("停止失败: RUN_GONE");
  });

  it("the uv environment needs an open note", async () => {
    app.currentFile = null;
    await createUvEnvForCurrentProject();
    expect(app.toast).toHaveBeenLastCalledWith("没有打开的笔记");
    expect(apiMock.pythonUvCreate).not.toHaveBeenCalled();
    expect(usePythonRun.getState().open).toBe(false);
  });

  it("a synced (not freshly initialized) environment reports the other hint", async () => {
    app.currentFile = "C:/vault/note.md";
    apiMock.pythonUvCreate.mockResolvedValue({ log: "synced", ranInit: false });
    await createUvEnvForCurrentProject();
    expect(app.toast).toHaveBeenLastCalledWith("uv 环境已同步(.venv)");
  });

  it("the panel is opened before the uv work starts, so the log has a home", async () => {
    app.currentFile = "C:/vault/note.md";
    let openedWhenCalled: boolean | null = null;
    apiMock.pythonUvCreate.mockImplementation(async () => {
      openedWhenCalled = usePythonRun.getState().open;
      return { log: "ok", ranInit: true };
    });
    await createUvEnvForCurrentProject();
    expect(openedWhenCalled).toBe(true);
    expect(usePythonRun.getState().command).toBe("$ uv init --bare && uv sync");
  });

  it("streams the uv log into the panel and reports the outcome", async () => {
    app.currentFile = "C:/vault/note.md";
    apiMock.pythonUvCreate.mockResolvedValue({ log: "created .venv", ranInit: true });
    await createUvEnvForCurrentProject();
    expect(apiMock.pythonUvCreate).toHaveBeenCalledWith("C:/vault/note.md");
    expect(usePythonRun.getState().lines).toEqual([{ stream: "system", text: "created .venv" }]);
    expect(usePythonRun.getState().exitCode).toBe(0);
    expect(app.toast).toHaveBeenLastCalledWith("uv 环境已创建(pyproject.toml + .venv)");
  });

  it("keeps a failed uv run visible in the panel", async () => {
    app.currentFile = "C:/vault/note.md";
    apiMock.pythonUvCreate.mockRejectedValue("uv not found");
    await createUvEnvForCurrentProject();
    expect(usePythonRun.getState().lines).toEqual([{ stream: "stderr", text: "uv not found" }]);
    expect(usePythonRun.getState().exitCode).toBe(1);
    expect(app.toast).toHaveBeenLastCalledWith("uv 环境创建失败,详见运行面板");
  });
});
