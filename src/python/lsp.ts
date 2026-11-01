/**
 * The frontend half of the ty LSP: a debounce syncs the "line-aligned virtual file" to the backend, and the diagnostics that
 * come back are mapped to CM lint diagnostics and pasted onto the current document; completion and hover take the same route --
 * the caret position is converted into an LSP position in the virtual file, forwarded to ty, and the result is mapped back to markdown offsets.
 *
 * Discipline (see "no races" in AGENTS.md):
 * - Each 500ms tick takes the view state as of that tick; when the async result comes back it must prove it is still current
 *   (mdPath unchanged) before the diagnostics are pasted, and stale results are dropped -- ty republishes on the next didChange,
 *   so an old result needs no lifetime.
 * - When the virtual file is unchanged (typing only in prose) the server is not disturbed; before a completion/hover request the
 *   current virtual text is pushed first (skipped when unchanged), so the document ty sees always matches the position the request is about.
 * - A spawn/sync failure enters a 30s backoff, so errors are not logged on every tick.
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

/** mdPath -> the virtual file text already sent to the server (dedupe: unchanged text is not sent again). */
const lastSentText = new Map<string, string>();
/** mdPath -> the raw diagnostics ty published last (mapped against the current document when pasted back). */
const rawDiags = new Map<string, RawLspDiagnostic[]>();
/** mdPath -> the most recent extraction (shared by the sync tick, completion and hover, so one document version is scanned only once). */
const extractCache = new Map<string, { text: string; eff: PythonExtract }>();
/** Note paths whose project LSP is off (or was never opened), so the backend is not called for nothing on every tick. */
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

/** Install the backend event listeners (once per module); failures are silent -- a test shell without Tauri has no events. */
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

/** The completion and hover cards share the editor theme: the app variables override CM's light baseTheme directly. */
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
 * The editor extension: after a document change the virtual file is synced on a debounce; completion and hover work inside python
 * fences. It only acts in note editors that have an absolute path (the study mode middle editor has no docPath and is skipped).
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
    // Only consume a key when a completion panel is open or the request was explicit; everything else falls
    // through (snippet Tab and vim Esc keep their own semantics on top of this).
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

/** Sync once immediately (quick feedback after the LSP is enabled or the file changes). */
export function syncNow(view: EditorView) {
  void syncFromView(view);
}

/** After a config switch, drop that note's sync cache and immediately clear the diagnostics already pasted on the document. */
export function resetLspStateForPath(mdPath: string) {
  lspOffPaths.delete(mdPath);
  lastSentText.delete(mdPath);
  extractCache.delete(mdPath);
  lastAppliedPath = null;
  rawDiags.delete(mdPath);
  applyDiagnosticsToView(mdPath);
  void api.pythonLspClose(mdPath).catch(() => {
    // A harmless no-op when the project LSP was never on.
  });
}

type SyncOutcome = "ok" | "disabled" | "error";

/**
 * Push the virtual text to ty (dedupe discipline: the send is recorded first, a concurrent later caller that sees the same
 * text skips it; on failure the record is rolled back). The backoff and the user-facing hint are handled here.
 */
async function pushVirtualText(mdPath: string, eff: PythonExtract): Promise<SyncOutcome> {
  lastSentText.set(mdPath, eff.effectiveText);
  try {
    const res = await api.pythonLspSync(mdPath, eff.effectiveText);
    if (res.enabled) {
      backoffUntil = 0;
      return "ok";
    }
    // The project LSP is off: add the path to the do-not-disturb list until a toggle calls resetLspStateForPath.
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

  // The file changed: paste the stored diagnostics onto the new document (paste them if there are any, clear them if not).
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
    // Closing is a harmless no-op when the LSP was never on.
  }
}

// ---------------------------------------------------------------------------
// Completion / hover: caret position -> LSP position -> ty -> the result mapped back to markdown offsets
// ---------------------------------------------------------------------------

/**
 * The shared preamble of an interactive request: document extraction (cached) plus pushing the virtual text first when needed.
 * Returns the document snapshot the request must be based on; if the document changed while the text was being pushed (or the server is unavailable) it returns null.
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

  // Three entry points: continuing a word, completing a property after a dot, and an explicit Ctrl-Space. A CJK keystroke
  // in prose leaves at the first gate, without any full-text extraction.
  const word = context.matchBefore(/[A-Za-z0-9_]+/);
  const dot = word ? null : context.matchBefore(/\./);
  if (!word && !dot && !context.explicit) return null;

  const prepared = await prepareLsp(view, mdPath);
  if (!prepared) return null;
  const { doc, eff } = prepared;
  const position = mdPosToLspPosition(doc, context.pos, eff);
  if (!position) return null;

  // Staleness proof: the document or file changed while waiting, so the completion is meaningless for the current state.
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
    // Continuing with word characters filters the existing results locally, without disturbing the server; a dot breaks that.
    validFor: /^[A-Za-z0-9_]*$/,
  };
}

async function pythonHoverSource(view: EditorView, pos: number, side: -1 | 1) {
  const mdPath = documentPath(view.state);
  if (!mdPath || !isNotePath(mdPath) || lspOffPaths.has(mdPath)) return null;

  const prepared = await prepareLsp(view, mdPath);
  if (!prepared) return null;
  const { doc, eff } = prepared;
  // When the pointer rests on the left edge of a character (side=-1), look up the character before it.
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
  // Note: hoverTooltip merges several sources into a cm-tooltip-hover host and the class field of a source is not
  // passed through -- a theme can only select the host (.cm-tooltip.cm-tooltip-hover) and this inner dom, so do not
  // expect a custom class on the container.
  return { pos, create: () => ({ dom: hoverDom(info) }) };
}

function hoverDom(text: string): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-python-hover";
  dom.textContent = text;
  return dom;
}

/** Paste the diagnostics of a path onto the current view; the document is only touched while the view still shows that note. */
function applyDiagnosticsToView(mdPath: string) {
  const view = editorApi.view;
  if (!view) return;
  if (documentPath(view.state) !== mdPath) return; // stale result, dropped
  const doc = view.state.doc;
  const mapped: Diagnostic[] = mapLspDiagnostics(doc, rawDiags.get(mdPath) ?? []);
  view.dispatch(setDiagnostics(view.state, mapped));
}
