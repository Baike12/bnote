import App from "./App";
import "katex/dist/katex.min.css";
import "./styles/global.css";
import { createRoot } from "react-dom/client";
import { editorApi } from "@/editor/api";
import { mathRegions, getContextAt } from "@/editor/context";
import { blockDecorationsField } from "@/editor/livePreview";
import { findSnippet } from "@/editor/snippets/engine";
import { getSession } from "@/editor/snippets/extension";
import { useAppStore } from "@/state/appStore";

// No StrictMode: double-mounting would rebuild the single CodeMirror
// instance and re-run async bootstrap during development.
createRoot(document.getElementById("root") as HTMLElement).render(<App />);

// Dev diagnostics hook (harmless in production).
declare global {
  interface Window {
    __bnote?: unknown;
  }
}
window.__bnote = {
  view: () => editorApi.view,
  store: useAppStore,
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
    v.state.field(blockDecorationsField).between(0, 1e9, (from, to) => {
      iter.push([from, to]);
    });
    return iter;
  },
};
