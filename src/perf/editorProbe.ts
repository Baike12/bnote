/**
 * Key-latency probe: what the user actually feels is keydown → the frame that
 * shows the result. The tracer's phase spans answer *which* phase was slow;
 * this probe supplies the end-to-end number and the doc context of the key.
 *
 * The measurement is taken with a capture-phase keydown listener (it runs
 * before CodeMirror's own handlers) and a rAF + setTimeout callback that fires
 * after the frame is presented. A main-thread block anywhere in between — a
 * forced layout, KaTeX, an IME/TIS call — is therefore part of the number,
 * which is the point: a phase that is not instrumented still shows up in the
 * total, and the recent spans name the suspects.
 */
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { perfLevel, recordPerfEvent, round, SLOW_KEY_MS } from "./trace";

interface PendingKey {
  key: string;
  start: number;
  ts: number;
  composing: boolean;
  docLines: number;
  docBytes: number;
  updateMs: number | null;
  transactions: number;
}

const pendingByView = new WeakMap<EditorView, PendingKey>();

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"]);

export function editorPerfProbe(): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      private readonly view: EditorView;
      private composing = false;

      private readonly onKeyDown = (event: KeyboardEvent): void => {
        // Off means no clocks and no allocations on the input path; the
        // listener stays installed so the level can be raised at runtime.
        if (perfLevel() === "off") return;
        // Keys consumed by an active IME composition are not editor input:
        // the composition events are the observable boundary.
        if (event.isComposing || event.keyCode === 229) return;
        if (MODIFIER_KEYS.has(event.key)) return;
        const view = this.view;
        const pending: PendingKey = {
          key: event.key,
          start: performance.now(),
          ts: Date.now(),
          composing: this.composing,
          docLines: view.state.doc.lines,
          docBytes: view.state.doc.length,
          updateMs: null,
          transactions: 0,
        };
        pendingByView.set(view, pending);
        // One probe per key: the callback reads its own pending object, so a
        // second key in the same frame cannot steal the first measurement.
        requestAnimationFrame(() => {
          setTimeout(() => {
            if (pendingByView.get(view) === pending) pendingByView.delete(view);
            const ms = performance.now() - pending.start;
            if (ms < SLOW_KEY_MS && perfLevel() !== "full") return;
            recordPerfEvent(
              "key",
              pending.key,
              ms,
              {
                ts: pending.ts,
                updateMs: pending.updateMs === null ? null : round(pending.updateMs),
                composing: pending.composing,
                docLines: pending.docLines,
                docBytes: pending.docBytes,
                transactions: pending.transactions,
              },
              pending.start,
            );
          }, 0);
        });
      };

      private readonly onCompositionStart = (): void => {
        this.composing = true;
      };
      private readonly onCompositionEnd = (): void => {
        this.composing = false;
      };

      constructor(view: EditorView) {
        this.view = view;
        view.contentDOM.addEventListener("keydown", this.onKeyDown, true);
        view.contentDOM.addEventListener("compositionstart", this.onCompositionStart, true);
        view.contentDOM.addEventListener("compositionend", this.onCompositionEnd, true);
      }

      destroy(): void {
        this.view.contentDOM.removeEventListener("keydown", this.onKeyDown, true);
        this.view.contentDOM.removeEventListener("compositionstart", this.onCompositionStart, true);
        this.view.contentDOM.removeEventListener("compositionend", this.onCompositionEnd, true);
      }
    },
  );

  const listener = EditorView.updateListener.of((u: ViewUpdate) => {
    const pending = pendingByView.get(u.view);
    if (!pending || pending.updateMs !== null) return;
    if (!u.docChanged && !u.selectionSet) return;
    pending.updateMs = performance.now() - pending.start;
    pending.transactions = u.transactions.length;
  });

  return [plugin, listener];
}
