import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { currentVimMode } from "./vim/vim";
import { mathRegions } from "./context";
import { getView } from "./api";
import { api } from "@/lib/tauri";
import { useAppStore, type ModalKind, type Settings } from "@/state/appStore";

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
 *
 * TIS selection is system-global, so every forced switch is scoped to bnote:
 * the source active before bnote's first forced switch of a focus session is
 * remembered (`baseline`) and restored as soon as the window loses focus, and
 * re-applied (with a fresh baseline) when it regains focus. ASCII-search
 * modals (quick switcher / quick add pick stage) route their switches through
 * the same scope via imeApply()/imeSyncToEditor().
 */

/** What bnote currently wants active — editor vim mode or an open modal. */
let desired: string | null = null;
/** Editor-side dedup: only real vim-mode transitions call imeApply. */
let lastEditorTarget: string | null = null;
/** Source active before bnote's first forced switch of this focus session. */
let baseline: string | null = null;
/** True while bnote is unfocused and baseline has been handed back. */
let suspended = false;
/** Focus-session counter — invalidates in-flight baseline captures. */
let focusSeq = 0;

/** At most one setInputSource in flight; a burst of flips collapses into the
 *  one trailing call that matches the final intent. Each switch costs the
 *  backend 1-3 main-thread TIS round trips (and a macism fallback on the
 *  macOS 26 race), so overlapping switches stall the whole UI — exactly what
 *  rapid cursor moves across math boundaries felt like. */
let switching = false;
let queued: string | null = null;

function launchSwitch(target: string): void {
  switching = true;
  const seq = focusSeq;
  if (baseline === null) {
    void api
      .getCurrentInputSource()
      .then((id) => {
        if (seq === focusSeq && id !== target) baseline = id;
      })
      .catch(() => {});
  }
  // Fire-and-forget: the backend dedups against the live input source,
  // verifies CJK switches and falls back to macism when needed.
  void api
    .setInputSource(target)
    .catch((e) => {
      console.warn("[bnote] set input source failed", e);
      lastEditorTarget = null; // allow retry on the next transition
    })
    .finally(() => {
      switching = false;
      const next = queued;
      queued = null;
      // 挂起（失焦/交还）后不再补发：用户的原始输入源刚被还回去。
      if (next !== null && next !== target && !suspended) launchSwitch(next);
    });
}

/**
 * Force a target input source, remembering what to restore on window blur.
 * No-op when `target` is already what bnote wants (unless suspended by blur).
 */
export function imeApply(target: string): void {
  const { settings } = useAppStore.getState();
  if (!settings.ime.enabled) return;
  if (desired === target && !suspended) return;
  desired = target;
  suspended = false;
  if (switching) {
    queued = target;
    return;
  }
  launchSwitch(target);
}

/** Drop bnote's forced source and restore what the user had before it. */
export function imeYield(): void {
  const restore = baseline;
  desired = null;
  suspended = false;
  queued = null;
  if (restore) void api.setInputSource(restore).catch(() => {});
}

/** Switch to whatever the current UI context wants (modal or editor vim mode). */
export function imeSyncToEditor(): void {
  const { settings, modal } = useAppStore.getState();
  if (!settings.ime.enabled) {
    if (desired) imeYield();
    return;
  }
  const target = imeDesiredSource(settings, modal);
  if (target) imeApply(target);
  else if (desired) imeYield();
}

/** The input source the current UI context wants, or null for "leave it". */
function imeDesiredSource(settings: Settings, modal: ModalKind): string | null {
  if (modal === "switcher") return settings.ime.normalSource;
  if (modal) return null; // e.g. quick-add naming wants the user's own source
  if (!settings.vim) return null;
  const view = getView();
  if (!view) return null;
  const mode = currentVimMode(view);
  if (!mode) return null;
  if (mode === "insert") {
    if (settings.ime.mathKeepsEnglish) {
      const head = view.state.selection.main.head;
      if (mathRegions(view.state).some((r) => head >= r.from && head <= r.to)) {
        return settings.ime.normalSource;
      }
    }
    return settings.ime.insertSource;
  }
  return settings.ime.normalSource;
}

/** Window deactivated: hand the user's original source back to the system. */
export function imeOnWindowBlur(): void {
  focusSeq++;
  queued = null;
  if (desired !== null && baseline !== null) {
    void api.setInputSource(baseline).catch(() => {});
  }
  baseline = null;
  suspended = true;
}

/** Window activated: re-apply what bnote wants, with a fresh baseline.
 *  `suspended` stays true until imeApply/imeYield run, so the dedup guard
 *  knows the source must actually be (re)applied after the blur restore. */
export function imeOnWindowFocus(): void {
  focusSeq++;
  if (suspended) baseline = null; // fresh session after a real blur; duplicate focus events keep it
  imeSyncToEditor();
}

export function imeSwitchExtension(): Extension {
  return EditorView.updateListener.of((u) => {
    const view = u.view;
    const { settings } = useAppStore.getState();
    const ime = settings.ime;

    const gated = settings.vim && ime.enabled;
    const mode = gated ? currentVimMode(view) : null;
    if (!gated || !mode) {
      // Reset so re-enabling fires a fresh switch instead of a stale no-op.
      lastEditorTarget = null;
      return;
    }

    let target = mode === "insert" ? ime.insertSource : ime.normalSource;
    if (mode === "insert" && ime.mathKeepsEnglish) {
      const head = view.state.selection.main.head;
      const inMath = mathRegions(view.state).some((r) => head >= r.from && head <= r.to);
      if (inMath) target = ime.normalSource;
    }

    if (target === lastEditorTarget) return;
    lastEditorTarget = target;
    imeApply(target);
  });
}
