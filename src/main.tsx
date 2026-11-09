import App from "./App";
import "katex/dist/katex.min.css";
import "./styles/global.css";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { installBrowserMode } from "@/dev/browserMode";
import { editorApi } from "@/editor/api";
import { mathRegions, getContextAt } from "@/editor/context";
import { blockDecorationsField } from "@/editor/livePreview";
import { findSnippet } from "@/editor/snippets/engine";
import { getSession } from "@/editor/snippets/extension";
import { useAppStore } from "@/state/appStore";

// Browser tab instead of the Tauri window? Route IPC to the debug bridge
// before anything mounts (no-op inside the app and in production builds).
installBrowserMode();

// No StrictMode: double-mounting would rebuild the single CodeMirror
// instance and re-run async bootstrap during development.
//
// The root boundary is the last line of defense: React unmounts the entire
// root when an uncaught render/effect error has no boundary above it, which
// leaves a blank white window with a live, idle webview (indistinguishable
// from a hang). Any throw now lands here with a readable message and a way
// back, while the actual defect stays visible instead of hiding as "白屏".
createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary
    fallback={(error, reset) => (
      <div className="app-crash">
        <p className="app-crash-title">界面出错了</p>
        <p className="app-crash-msg">{error.message}</p>
        <div className="app-crash-actions">
          <button className="btn" onClick={reset}>
            重试
          </button>
          <button className="btn primary" onClick={() => window.location.reload()}>
            重新载入
          </button>
        </div>
      </div>
    )}
  >
    <App />
  </ErrorBoundary>,
);

// Dev diagnostics hook (harmless in production).
declare global {
  interface Window {
    __bnote?: unknown;
  }
}
window.__bnote = {
  view: () => editorApi.view,
  store: useAppStore,
  blockField: blockDecorationsField,
  math: () => (editorApi.view ? mathRegions(editorApi.view.state) : null),
  context: (pos?: number) => {
    const v = editorApi.view;
    if (!v) return null;
    return getContextAt(v.state, pos ?? v.state.selection.main.head);
  },
  findSnippet: (key: string | null, auto = true) => {
    const v = editorApi.view;
    if (!v) return null;
    const cur = v.state.selection.main.to;
    const m = findSnippet(v.state, cur, key, { auto, visualText: null });
    return m
      ? { trigger: m.snippet.displayTrigger, start: m.start, end: m.end, text: m.replacement.text }
      : null;
  },
  session: () => {
    const v = editorApi.view;
    const s = v ? getSession(v) : null;
    if (!s) return null;
    return { ...s, stops: [...s.stops.entries()] };
  },
  blockDeco: () => {
    const v = editorApi.view;
    if (!v) return null;
    const iter: number[][] = [];
    v.state.field(blockDecorationsField).decos.between(0, 1e9, (from: number, to: number) => {
      iter.push([from, to]);
    });
    return iter;
  },
};
