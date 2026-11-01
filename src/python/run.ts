/**
 * State and actions of the run panel: all python blocks of a note are run as "one py file", and stdout/stderr stream into
 * the panel through backend events; the log of a uv environment creation reuses the same panel.
 */
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { editorApi } from "@/editor/api";
import {
  api,
  type PythonRunExitEvent,
  type PythonRunOutputEvent,
  type PythonRunStarted,
} from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { extractPython } from "./extract";

export interface RunLine {
  stream: "stdout" | "stderr" | "system";
  text: string;
}

/** Output cap of a single panel: past the cap the head is trimmed, so a runaway print loop cannot eat all the memory. */
const MAX_LINES = 4000;
const TRIM_TO = 2000;

interface PythonRunState {
  open: boolean;
  /** The run the panel currently shows; the panel only accepts the events of this runId. */
  runId: number | null;
  mdPath: string | null;
  command: string;
  lines: RunLine[];
  running: boolean;
  exitCode: number | null;
  cancelled: boolean;
  timedOut: boolean;
  durationMs: number | null;

  beginRun: (started: PythonRunStarted, mdPath: string) => void;
  beginSystem: (command: string) => void;
  append: (stream: RunLine["stream"], text: string) => void;
  finish: (exit: PythonRunExitEvent) => void;
  finishSystem: (ok: boolean) => void;
  clear: () => void;
  close: () => void;
}

export const usePythonRun = create<PythonRunState>((set) => ({
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

  beginRun: (started, mdPath) =>
    set({
      open: true,
      runId: started.runId,
      mdPath,
      command: started.command,
      lines: [],
      running: true,
      exitCode: null,
      cancelled: false,
      timedOut: false,
      durationMs: null,
    }),
  beginSystem: (command) =>
    set({
      open: true,
      runId: null,
      mdPath: null,
      command,
      lines: [],
      running: true,
      exitCode: null,
      cancelled: false,
      timedOut: false,
      durationMs: null,
    }),
  append: (stream, text) =>
    set((s) => {
      let lines = s.lines.concat({ stream, text });
      if (lines.length > MAX_LINES) lines = lines.slice(lines.length - TRIM_TO);
      return { lines };
    }),
  finish: (exit) =>
    set((s) =>
      exit.runId !== s.runId
        ? s
        : {
            running: false,
            exitCode: exit.exitCode,
            cancelled: exit.cancelled,
            timedOut: exit.timedOut,
            durationMs: exit.durationMs,
          },
    ),
  finishSystem: (ok) => set({ running: false, exitCode: ok ? 0 : 1 }),
  clear: () => set({ lines: [] }),
  close: () => set({ open: false }),
}));

function toast(msg: string) {
  useAppStore.getState().showToast(msg);
}

/** python.run-note: run the current note as one py file. */
export async function runCurrentNote() {
  const view = editorApi.view;
  const mdPath = useAppStore.getState().currentFile;
  if (!view || !mdPath) {
    toast("没有打开的笔记");
    return;
  }
  const eff = extractPython(view.state.doc.toString());
  if (!eff.blocks.length) {
    toast("这篇笔记没有 python 代码块(```python 围栏)");
    return;
  }
  await ensureListeners();
  try {
    const started = await api.pythonRun(mdPath, eff.effectiveText);
    usePythonRun.getState().beginRun(started, mdPath);
  } catch (e) {
    toast(`运行失败: ${String(e)}`);
  }
}

export async function stopRun() {
  const { mdPath } = usePythonRun.getState();
  if (!mdPath) return;
  try {
    await api.pythonRunCancel(mdPath);
  } catch (e) {
    toast(`停止失败: ${String(e)}`);
  }
}

/** python.create-uv-env: create a uv environment in the directory of the current note, with the log going to the run panel. */
export async function createUvEnvForCurrentProject() {
  const mdPath = useAppStore.getState().currentFile;
  if (!mdPath) {
    toast("没有打开的笔记");
    return;
  }
  const store = usePythonRun.getState();
  store.beginSystem("$ uv init --bare && uv sync");
  try {
    const outcome = await api.pythonUvCreate(mdPath);
    const s = usePythonRun.getState();
    s.append("system", outcome.log);
    s.finishSystem(true);
    toast(outcome.ranInit ? "uv 环境已创建(pyproject.toml + .venv)" : "uv 环境已同步(.venv)");
  } catch (e) {
    const s = usePythonRun.getState();
    s.append("stderr", String(e));
    s.finishSystem(false);
    toast("uv 环境创建失败,详见运行面板");
  }
}

// ---------------------------------------------------------------------------
// Backend events -> the panel
// ---------------------------------------------------------------------------
// Note: listen must not run while the module is evaluated -- the static import happens before main.tsx calls
// installBrowserMode(), so in browser debug mode the mock IPC is not installed yet and the registration would fail
// silently. Install it lazily from the runtime entry points.
let installed = false;
async function installListeners() {
  if (installed) return;
  installed = true;
  try {
    await listen<PythonRunOutputEvent>("python-run-output", (e) => {
      const s = usePythonRun.getState();
      if (!s.running || e.payload?.runId !== s.runId) return; // not the output of the current run
      s.append(e.payload.stream === "stderr" ? "stderr" : "stdout", e.payload.text);
    });
    await listen<PythonRunExitEvent>("python-run-exit", (e) => {
      usePythonRun.getState().finish(e.payload);
    });
  } catch (e) {
    installed = false;
    console.warn("[python-run] 事件监听不可用", e);
  }
}
async function ensureListeners() {
  await installListeners();
}
