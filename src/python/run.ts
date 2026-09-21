/**
 * 运行面板的状态与动作:一篇笔记的全部 python 块按「一个 py 文件」运行,
 * stdout/stderr 经后端事件流式进面板;uv 环境创建的日志也复用这个面板展示。
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

/** 单面板输出上限:超限从头部截断,防 print 死循环把内存吃满。 */
const MAX_LINES = 4000;
const TRIM_TO = 2000;

interface PythonRunState {
  open: boolean;
  /** 当前面板展示的运行;面板只认这个 runId 的事件。 */
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

/** python.run-note:把当前笔记当做一个 py 文件运行。 */
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

/** python.create-uv-env:当前笔记所在一级目录创建 uv 环境,日志进运行面板。 */
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
// 后端事件 → 面板
// ---------------------------------------------------------------------------
// 注意:不能在模块求值期 listen —— 静态导入先于 main.tsx 的
// installBrowserMode() 执行,浏览器调试模式下 mock IPC 还没装上,注册会
// 静默失败。挂到运行时入口上惰性安装。
let installed = false;
async function installListeners() {
  if (installed) return;
  installed = true;
  try {
    await listen<PythonRunOutputEvent>("python-run-output", (e) => {
      const s = usePythonRun.getState();
      if (!s.running || e.payload?.runId !== s.runId) return; // 不是当前这次运行的输出
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
