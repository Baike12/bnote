/**
 * ty LSP 的前端侧:防抖把「行对齐虚拟文件」同步给后端,收到的诊断映射成
 * CM lint 诊断贴回当前文档;补全与 hover 走同一条路 —— 光标位置换算成虚拟
 * 文件的 LSP position,转发 ty,结果映射回 markdown 偏移。
 *
 * 纪律(见 AGENTS.md「不许竞争」):
 * - 每个 500ms tick 拿到的是 tick 当刻的 view 状态,异步回来后先自证
 *   (mdPath 没变)才贴诊断,过期结果直接丢弃 —— ty 随后一次 didChange 会
 *   重新发布,不需要旧结果的续命。
 * - 虚拟文件没变(只在散文里打字)时不打扰服务器;补全/hover 的请求前先
 *   把当前虚拟文本推上去(没变就跳过),保证 ty 看到的文档与请求位置一致。
 * - spawn/同步失败进入 30s 退避,不每 tick 打错误。
 */
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import {
  autocompletion,
  acceptCompletion,
  closeCompletion,
  startCompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { Prec, type Extension, type Text } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap } from "@codemirror/view";
import { listen } from "@tauri-apps/api/event";
import { documentPath } from "@/editor/docPath";
import { editorApi } from "@/editor/api";
import { api, type PythonLspDiagnosticEvent } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import {
  extractPython,
  hasPythonFenceHint,
  lspHoverText,
  mapLspCompletions,
  mapLspDiagnostics,
  mdPosToLspPosition,
  type PythonExtract,
  type RawLspDiagnostic,
} from "./extract";

const SYNC_DEBOUNCE_MS = 500;
const SYNC_FAILURE_BACKOFF_MS = 30_000;

/** mdPath → 已发送给服务器的虚拟文件文本(去重:没变就不发)。 */
const lastSentText = new Map<string, string>();
/** mdPath → ty 最近一次发布的原始诊断(贴回文档时按当前文档现映射)。 */
const rawDiags = new Map<string, RawLspDiagnostic[]>();
/** mdPath → 最近一次提取结果(同步 tick / 补全 / hover 共享,同一文档版本只扫一遍)。 */
const extractCache = new Map<string, { text: string; eff: PythonExtract }>();
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

function cachedExtract(mdPath: string, text: string): PythonExtract {
  const hit = extractCache.get(mdPath);
  if (hit && hit.text === text) return hit.eff;
  const eff = extractPython(text);
  extractCache.set(mdPath, { text, eff });
  return eff;
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

/** 补全/悬浮卡与编辑器同主题:应用变量直接盖掉 CM 亮色 baseTheme。 */
const lspTooltipTheme = EditorView.theme({
  ".cm-tooltip.cm-tooltip-autocomplete": {
    background: "var(--bg2, #17171a)",
    border: "1px solid var(--border, #27272c)",
    borderRadius: "6px",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-mono, monospace)",
    fontSize: "13px",
    maxHeight: "260px",
    maxWidth: "380px",
  },
  ".cm-tooltip-autocomplete > ul > li": {
    color: "var(--text, #d8d8da)",
    padding: "2px 10px",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    background: "var(--bg3, #212125)",
    color: "var(--accent, #f5a83c)",
  },
  ".cm-tooltip-autocomplete .cm-completionDetail": {
    color: "var(--text-faint, #67676d)",
    fontStyle: "normal",
    marginLeft: "10px",
  },
  ".cm-tooltip.cm-tooltip-hover": {
    background: "var(--bg2, #17171a)",
    border: "1px solid var(--border, #27272c)",
    borderRadius: "6px",
    overflow: "hidden",
  },
  ".cm-tooltip .cm-python-hover": {
    fontFamily: "var(--font-mono, monospace)",
    fontSize: "13px",
    lineHeight: "1.5",
    maxWidth: "520px",
    padding: "6px 10px",
    whiteSpace: "pre-wrap",
  },
});

/**
 * 编辑器扩展:文档变更后防抖同步虚拟文件;python 围栏内的补全与 hover。
 * 只在有绝对路径的笔记编辑器里干活(学习模式中栏编辑器没有 docPath,自动跳过)。
 */
export function pythonLspExtension(): Extension {
  void installListeners();
  return [
    EditorView.updateListener.of((u) => {
      if (u.docChanged) scheduleSync(u.view, SYNC_DEBOUNCE_MS);
    }),
    autocompletion({ override: [pythonCompletionSource] }),
    hoverTooltip(pythonHoverSource, { hoverTime: 450 }),
    lspTooltipTheme,
    // 只在有补全面板/显式触发时消费按键,否则全部放行(snippet Tab、vim Esc
    // 都在这之上按原语义走)。
    Prec.high(
      keymap.of([
        { key: "Tab", run: acceptCompletion },
        { key: "Escape", run: closeCompletion },
        { key: "Ctrl-Space", run: startCompletion },
      ]),
    ),
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
  extractCache.delete(mdPath);
  lastAppliedPath = null;
  rawDiags.delete(mdPath);
  applyDiagnosticsToView(mdPath);
  void api.pythonLspClose(mdPath).catch(() => {
    // 项目 LSP 本来就没开时是无害 no-op。
  });
}

type SyncOutcome = "ok" | "disabled" | "error";

/**
 * 把虚拟文本推给 ty(去重纪律:发之前先记账,并发的后来者看到相同文本
 * 直接跳过;失败把账撤掉)。退避与提示在这里统一管。
 */
async function pushVirtualText(mdPath: string, eff: PythonExtract): Promise<SyncOutcome> {
  lastSentText.set(mdPath, eff.effectiveText);
  try {
    const res = await api.pythonLspSync(mdPath, eff.effectiveText);
    if (res.enabled) {
      backoffUntil = 0;
      return "ok";
    }
    // 项目 LSP 没开:加入免打扰名单,等 toggle 时 resetLspStateForPath。
    lspOffPaths.add(mdPath);
    lastSentText.delete(mdPath);
    return "disabled";
  } catch (e) {
    lastSentText.delete(mdPath);
    if (Date.now() > backoffUntil) {
      backoffUntil = Date.now() + SYNC_FAILURE_BACKOFF_MS;
      console.warn("[python-lsp] 同步失败,30s 内不再重试:", e);
      useAppStore.getState().showToast(`ty 类型检查启动失败: ${String(e)}`);
    }
    return "error";
  }
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
  const eff = cachedExtract(mdPath, text);
  if (!eff.blocks.length) {
    void clearPath(mdPath);
    return;
  }
  if (lastSentText.get(mdPath) === eff.effectiveText) return;
  const outcome = await pushVirtualText(mdPath, eff);
  if (outcome === "disabled") {
    rawDiags.delete(mdPath);
    applyDiagnosticsToView(mdPath);
  }
}

async function clearPath(mdPath: string) {
  extractCache.delete(mdPath);
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

// ---------------------------------------------------------------------------
// 补全 / hover:光标位置 → LSP position → ty → 结果映射回 markdown 偏移
// ---------------------------------------------------------------------------

/**
 * 交互请求的公共前置:文档提取(带缓存)+ 必要时先推虚拟文本。返回发出
 * 请求时应依据的文档快照;推文本期间文档又变了(或服务器不可用)则 null。
 */
async function prepareLsp(
  view: EditorView,
  mdPath: string,
): Promise<{ doc: Text; eff: PythonExtract } | null> {
  if (Date.now() < backoffUntil) return null;
  const doc = view.state.doc;
  const text = doc.toString();
  if (!hasPythonFenceHint(text)) return null;
  const eff = cachedExtract(mdPath, text);
  if (!eff.blocks.length) return null;
  if (lastSentText.get(mdPath) !== eff.effectiveText) {
    if ((await pushVirtualText(mdPath, eff)) !== "ok") return null;
    if (view.state.doc !== doc) return null;
  }
  return { doc, eff };
}

async function pythonCompletionSource(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  const view = context.view;
  const mdPath = view ? documentPath(view.state) : null;
  if (!view || !mdPath || !isNotePath(mdPath) || lspOffPaths.has(mdPath)) return null;

  // 三种入口:词中续打、点号后补属性、显式 Ctrl-Space。散文里的 CJK 击键
  // 在第一个门就出去,不做全文提取。
  const word = context.matchBefore(/[A-Za-z0-9_]+/);
  const dot = word ? null : context.matchBefore(/\./);
  if (!word && !dot && !context.explicit) return null;

  const prepared = await prepareLsp(view, mdPath);
  if (!prepared) return null;
  const { doc, eff } = prepared;
  const position = mdPosToLspPosition(doc, context.pos, eff);
  if (!position) return null;

  // 过期自证:等待期间换了文档/文件,补全对当前状态无意义。
  if (view.state.doc !== doc || documentPath(view.state) !== mdPath) return null;

  let raw: unknown;
  try {
    raw = await api.pythonLspRequest(mdPath, "textDocument/completion", { position });
  } catch {
    return null;
  }
  if (view.state.doc !== doc || documentPath(view.state) !== mdPath) return null;

  const options = mapLspCompletions(raw);
  if (!options.length) return null;
  return {
    from: word ? word.from : context.pos,
    options,
    // 纯词字符续打直接在现有结果里过滤,不打扰服务器;点号会打破它。
    validFor: /^[A-Za-z0-9_]*$/,
  };
}

async function pythonHoverSource(view: EditorView, pos: number, side: -1 | 1) {
  const mdPath = documentPath(view.state);
  if (!mdPath || !isNotePath(mdPath) || lspOffPaths.has(mdPath)) return null;

  const prepared = await prepareLsp(view, mdPath);
  if (!prepared) return null;
  const { doc, eff } = prepared;
  // 指针停在字符左缘(side=-1)时,查它前面的那个字符。
  const anchor = side < 0 && pos > 0 ? pos - 1 : pos;
  const position = mdPosToLspPosition(doc, anchor, eff);
  if (!position) return null;
  if (view.state.doc !== doc || documentPath(view.state) !== mdPath) return null;

  let raw: unknown;
  try {
    raw = await api.pythonLspRequest(mdPath, "textDocument/hover", { position });
  } catch {
    return null;
  }
  if (view.state.doc !== doc || documentPath(view.state) !== mdPath) return null;
  const info = lspHoverText(raw);
  if (!info) return null;
  // 注意:hoverTooltip 会把多个来源合成 cm-tooltip-hover 宿主,来源的
  // class 字段不透传 —— 主题样式只能选中宿主(.cm-tooltip.cm-tooltip-hover)
  // 和这个内层 dom,不能指望容器上出现自定义 class。
  return { pos, create: () => ({ dom: hoverDom(info) }) };
}

function hoverDom(text: string): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-python-hover";
  dom.textContent = text;
  return dom;
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
