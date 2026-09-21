/**
 * ty LSP 的前端侧:防抖把「行对齐虚拟文件」同步给后端,收到的诊断映射成
 * CM lint 诊断贴回当前文档。
 *
 * 纪律(见 CLAUDE.md「不许竞争」):
 * - 每个 500ms tick 拿到的是 tick 当刻的 view 状态,异步回来后先自证
 *   (mdPath 没变)才贴诊断,过期结果直接丢弃 —— ty 随后一次 didChange 会
 *   重新发布,不需要旧结果的续命。
 * - 虚拟文件没变(只在散文里打字)时不打扰服务器。
 * - spawn/同步失败进入 30s 退避,不每 tick 打错误。
 */
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { listen } from "@tauri-apps/api/event";
import { documentPath } from "@/editor/docPath";
import { editorApi } from "@/editor/api";
import { api, type PythonLspDiagnosticEvent } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { extractPython, hasPythonFenceHint, mapLspDiagnostics, type RawLspDiagnostic } from "./extract";

const SYNC_DEBOUNCE_MS = 500;
const SYNC_FAILURE_BACKOFF_MS = 30_000;

/** mdPath → 已发送给服务器的虚拟文件文本(去重:没变就不发)。 */
const lastSentText = new Map<string, string>();
/** mdPath → ty 最近一次发布的原始诊断(贴回文档时按当前文档现映射)。 */
const rawDiags = new Map<string, RawLspDiagnostic[]>();
/** 项目 LSP 被关掉(或从未打开)的笔记路径,不再每 tick 白调后端。 */
const lspOffPaths = new Set<string>();
let lastAppliedPath: string | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncView: WeakRef<EditorView> | null = null;
let backoffUntil = 0;
let listenersInstalled = false;

function isNotePath(mdPath: string): boolean {
  return /\.(md|markdown|txt)$/i.test(mdPath);
}

/** 安装后端事件监听(模块级一次);失败静默 —— 无 Tauri 环境的测试壳里没有事件。 */
async function installListeners() {
  if (listenersInstalled) return;
  listenersInstalled = true;
  try {
    await listen<PythonLspDiagnosticEvent>("python-lsp-diagnostics", (e) => {
      const { mdPath, diagnostics } = e.payload ?? {};
      if (typeof mdPath !== "string") return;
      rawDiags.set(mdPath, Array.isArray(diagnostics) ? (diagnostics as RawLspDiagnostic[]) : []);
      applyDiagnosticsToView(mdPath);
    });
    await listen<{ project: string; state: string }>("python-lsp-status", (e) => {
      console.info("[python-lsp]", e.payload?.project, e.payload?.state);
    });
  } catch (e) {
    console.warn("[python-lsp] 事件监听不可用", e);
  }
}

/**
 * 编辑器扩展:文档变更后防抖同步虚拟文件。只在有绝对路径的笔记编辑器里
 * 干活(学习模式中栏编辑器没有 docPath,自动跳过)。
 */
export function pythonLspExtension(): Extension {
  void installListeners();
  return [
    EditorView.updateListener.of((u) => {
      if (u.docChanged) scheduleSync(u.view, SYNC_DEBOUNCE_MS);
    }),
  ];
}

function scheduleSync(view: EditorView, ms: number) {
  syncView = new WeakRef(view);
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    const v = syncView?.deref();
    if (!v || !v.dom.isConnected) return;
    void syncFromView(v);
  }, ms);
}

/** 立即同步一次(开 LSP、文件切换后的快速反馈)。 */
export function syncNow(view: EditorView) {
  void syncFromView(view);
}

/** 配置切换后清掉该笔记的同步缓存,并立即清空文档上已贴的诊断。 */
export function resetLspStateForPath(mdPath: string) {
  lspOffPaths.delete(mdPath);
  lastSentText.delete(mdPath);
  lastAppliedPath = null;
  rawDiags.delete(mdPath);
  applyDiagnosticsToView(mdPath);
  void api.pythonLspClose(mdPath).catch(() => {
    // 项目 LSP 本来就没开时是无害 no-op。
  });
}

async function syncFromView(view: EditorView) {
  const mdPath = documentPath(view.state);
  if (!mdPath || !isNotePath(mdPath)) return;

  // 换了文件:把存着的诊断贴上新文档(有则贴,无则清)。
  if (mdPath !== lastAppliedPath) {
    lastAppliedPath = mdPath;
    applyDiagnosticsToView(mdPath);
  }

  if (lspOffPaths.has(mdPath)) return;

  const doc = view.state.doc;
  const text = doc.toString();
  if (!hasPythonFenceHint(text)) {
    void clearPath(mdPath);
    return;
  }
  const eff = extractPython(text);
  if (!eff.blocks.length) {
    void clearPath(mdPath);
    return;
  }
  if (lastSentText.get(mdPath) === eff.effectiveText) return;
  lastSentText.set(mdPath, eff.effectiveText);
  try {
    const res = await api.pythonLspSync(mdPath, eff.effectiveText);
    if (res.enabled) {
      backoffUntil = 0;
    } else {
      // 项目 LSP 没开:加入免打扰名单,等 toggle 时 resetLspStateForPath。
      lspOffPaths.add(mdPath);
      lastSentText.delete(mdPath);
      rawDiags.delete(mdPath);
      applyDiagnosticsToView(mdPath);
    }
  } catch (e) {
    lastSentText.delete(mdPath);
    if (Date.now() > backoffUntil) {
      backoffUntil = Date.now() + SYNC_FAILURE_BACKOFF_MS;
      console.warn("[python-lsp] 同步失败,30s 内不再重试:", e);
      useAppStore.getState().showToast(`ty 类型检查启动失败: ${String(e)}`);
    }
  }
}

async function clearPath(mdPath: string) {
  if (!lastSentText.has(mdPath) && !rawDiags.has(mdPath)) return;
  lastSentText.delete(mdPath);
  rawDiags.delete(mdPath);
  applyDiagnosticsToView(mdPath);
  try {
    await api.pythonLspClose(mdPath);
  } catch {
    // 没开 LSP 时 close 是无害 no-op。
  }
}

/** 把某路径的诊断贴到当前视图;只在视图还显示这篇笔记时动文档。 */
function applyDiagnosticsToView(mdPath: string) {
  const view = editorApi.view;
  if (!view) return;
  if (documentPath(view.state) !== mdPath) return; // 过期结果,丢弃
  const doc = view.state.doc;
  const mapped: Diagnostic[] = mapLspDiagnostics(doc, rawDiags.get(mdPath) ?? []);
  view.dispatch(setDiagnostics(view.state, mapped));
}
