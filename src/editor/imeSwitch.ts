import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { currentVimMode } from "./vim/vim";
import { mathRegions } from "./context";
import { api } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";

/**
 * IME follow: switch the macOS input source on vim mode changes —
 * insert → Chinese, normal/visual → English — without leaving insert-time
 * typing on the critical path. The switch itself is an in-process TIS call
 * (~1–5 ms, background thread) and is skipped entirely when the requested
 * source is already active.
 *
 * Mirrors the behavior of the user's patched obsidian-vim-input-auto-switch:
 * entering insert inside a math region keeps the English source (formulas are
 * ASCII, the IME would only get in the way).
 */

/** Last target source per view, so we only invoke on real transitions. */
const lastTarget = new WeakMap<EditorView, string>();

export function imeSwitchExtension(): Extension {
  return EditorView.updateListener.of((u) => {
    const view = u.view;
    const { settings } = useAppStore.getState();
    const ime = settings.ime;

    const gated = settings.vim && ime.enabled;
    const mode = gated ? currentVimMode(view) : null;
    if (!gated || !mode) {
      // Reset so re-enabling fires a fresh switch instead of a stale no-op.
      lastTarget.delete(view);
      return;
    }

    let target = mode === "insert" ? ime.insertSource : ime.normalSource;
    if (mode === "insert" && ime.mathKeepsEnglish) {
      const head = view.state.selection.main.head;
      const inMath = mathRegions(view.state).some((r) => head >= r.from && head <= r.to);
      if (inMath) target = ime.normalSource;
    }

    if (target === lastTarget.get(view)) return;
    lastTarget.set(view, target);

    // Fire-and-forget: the backend dedups against the live input source,
    // verifies CJK switches and falls back to macism when needed.
    api.setInputSource(target).catch((e) => {
      console.warn("[bnote] set input source failed", e);
      lastTarget.set(view, ""); // allow retry on the next transition
    });
  });
}
