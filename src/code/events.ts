import { listen } from "@tauri-apps/api/event";
import { useCodeStore } from "./store";
import { activeCodeEditor } from "./editor/registry";
import { refreshDiagnostics } from "./editor/lsp";
import type { LspDiagnostic } from "./types";

/**
 * 语言服务器的事件订阅。
 *
 * 后端把诊断、服务器状态、日志推回来,这里落进 store:
 * - 诊断按文件路径存(编辑器从 store 读,画成行内的标记);
 * - 服务器状态按语言存(状态栏显示 LSP 是否活着);
 * - 日志留最近若干条(出问题时能看服务器说了什么)。
 *
 * 订阅是**应用级**的,不是组件级:语言服务器在项目打开期间一直活着,面板
 * 换了几轮它也照旧推事件。
 */
export async function installCodeEvents(): Promise<() => void> {
  const offs: Array<() => void> = [];

  const add = async (
    event: string,
    handler: (payload: unknown) => void,
  ): Promise<void> => {
    try {
      const off = await listen(event, (e) => handler(e.payload));
      offs.push(off);
    } catch {
      // 不在 Tauri 里(浏览器 harness):没有事件源,安静跳过。
    }
  };

  await add("code-lsp-diagnostics", (payload) => {
    const data = payload as { path?: unknown; diagnostics?: unknown } | null;
    if (!data || typeof data.path !== "string") return;
    const diagnostics = Array.isArray(data.diagnostics)
      ? (data.diagnostics as LspDiagnostic[])
      : [];
    useCodeStore.getState().setDiagnostics(data.path, diagnostics);
    // 诊断是推来的,编辑器不会自己知道它们变了——显式让它重画一遍。
    const handle = activeCodeEditor();
    if (handle && handle.path === data.path) refreshDiagnostics(handle.view);
  });

  await add("code-lsp-status", (payload) => {
    const data = payload as { language?: unknown; state?: unknown } | null;
    if (!data || typeof data.language !== "string") return;
    useCodeStore
      .getState()
      .setLspState(data.language, typeof data.state === "string" ? data.state : "unknown");
  });

  await add("code-lsp-log", (payload) => {
    const data = payload as { language?: unknown; level?: unknown; message?: unknown } | null;
    if (!data) return;
    useCodeStore
      .getState()
      .appendLspLog(
        typeof data.language === "string" ? data.language : "?",
        typeof data.level === "number" ? data.level : 3,
        typeof data.message === "string" ? data.message : "",
      );
  });

  return () => {
    for (const off of offs) off();
    offs.length = 0;
  };
}
