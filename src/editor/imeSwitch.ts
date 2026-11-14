import { EditorView } from "@codemirror/view";
import type { Extension, EditorState } from "@codemirror/state";
import { currentVimMode } from "./vim/vim";
import { caretInMathBody, insideFencedCode, mathRegions } from "./context";
import { getView } from "./api";
import { api } from "@/lib/tauri";
import { useAppStore, type ModalKind, type Settings } from "@/state/appStore";
import { perfEnd, perfFields, perfStart } from "@/perf/trace";

/**
 * IME follow: switch the macOS input source on vim mode changes —
 * insert → Chinese, normal/visual → English — without leaving insert-time
 * typing on the critical path. The switch itself runs in a helper process
 * (ime_daemon.rs: TIS asserts Apple's main queue, which in this process is
 * the UI thread, so the select is moved out of the process entirely — measured
 * 0.01 ms per round trip) and is skipped entirely when the requested source is
 * already active.
 *
 * The out-of-process architecture has a second half: the web input context is
 * created at focus time and captures the source active then. A select made in
 * another process does not propagate into it — the menu bar follows the
 * system-wide change notification, WebKit keeps typing with the old source.
 * After every confirmed real switch the focused editor's context is therefore
 * re-created (refreshWebInputContext); that is part of the switch contract,
 * not a patch.
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
/** Whether bnote really forced the input source during this focus session —
 *  blur uses it to decide whether to hand the source back (a deferred intent
 *  that has not been sent out does not count as "switched"). */
let forcedThisSession = false;
/** Focus-session counter — invalidates in-flight baseline captures. */
let focusSeq = 0;

/** At most one setInputSource in flight; a burst of flips collapses into the
 *  one trailing call that matches the final intent. Each switch occupies the
 *  app main thread for the duration of the TIS call (2–10 ms warm, up to
 *  ~170 ms while the input method activates), so overlapping switches would
 *  queue behind each other — exactly what rapid cursor moves across math
 *  boundaries felt like. */
let switching = false;
let queued: string | null = null;
let launchScheduled = false;

/** One-shot timer that re-checks the input source after the focus settles (see scheduleFocusVerify). */
let focusVerifyTimer: ReturnType<typeof setTimeout> | null = null;
/** Check generation: a new intent / leaving the field / handing the source back all invalidate the in-flight check callback. */
let focusVerifySeq = 0;
/** A run loop separates the completed focus switch from the context input source restore, so 120ms is enough to settle. */
const FOCUS_VERIFY_DELAY_MS = 120;

function cancelFocusVerify(): void {
  focusVerifySeq++;
  if (focusVerifyTimer !== null) {
    clearTimeout(focusVerifyTimer);
    focusVerifyTimer = null;
  }
}

/** Defers the switch to the end of the key's task and collapses consecutive
 *  flips into the one trailing switch: `desired` is the single source of
 *  intent, read when the timer fires. A burst of cursor moves across math
 *  boundaries then costs one switch instead of one per move. */
function scheduleLaunch(): void {
  if (launchScheduled) return;
  launchScheduled = true;
  setTimeout(() => {
    launchScheduled = false;
    const target = desired;
    if (target === null || suspended) return; // the user's IME was handed back (blur / suspended)
    if (switching) {
      queued = target;
      return;
    }
    launchSwitch(target);
  }, 0);
}

/* The span's own `ms` is the whole round trip: IPC plus the backend's TIS call.
 * The backend returns that call's own duration (`tisMs`); the remainder is the
 * bridge. Two field slots is what is worth reading here. */
const IME_FIELDS = perfFields("target", "tisMs");
const IME_FAILED_FIELDS = perfFields("target");

function launchSwitch(target: string): void {
  switching = true;
  forcedThisSession = true;
  const seq = focusSeq;
  // End-to-end cost of the switch (IPC + the helper's TIS select). This is
  // the leg that made "leave a formula, type the next key" feel slow when the
  // input source was being engaged.
  const t = perfStart();
  if (baseline === null) {
    void api
      .getCurrentInputSource()
      .then((id) => {
        if (seq === focusSeq && id !== target) baseline = id;
      })
      .catch(() => {});
  }
  // Fire-and-forget: the helper dedups against the live input source and
  // returns the TIS call's own duration, so a slow switch names the input
  // method's activation instead of leaving one opaque number.
  void api
    .setInputSource(target)
    .then((outcome) => {
      perfEnd(t, "ime.switch", IME_FIELDS, target, outcome.tisMs);
      if (outcome.switched) refreshWebInputContext();
    })
    .catch((e) => {
      console.warn("[bnote] set input source failed", e);
      lastEditorTarget = null; // allow retry on the next transition
      perfEnd(t, "ime.switch", IME_FAILED_FIELDS, target);
    })
    .finally(() => {
      switching = false;
      const next = queued;
      queued = null;
      // No re-send after suspending (blur / hand-back): the user's original
      // input source has just been returned to them.
      if (next !== null && next !== target && !suspended) launchSwitch(next);
    });
}

/**
 * Re-creates the focused editor's web input context after a confirmed real
 * switch. The context is created when the editor gains focus and captures the
 * source active at that moment; a select made in the helper process does not
 * propagate into it (the menu bar follows the system-wide change notification,
 * WebKit keeps typing with the source captured at focus). Tearing it down and
 * re-creating it in the same frame (blur + focus on contentDOM) re-captures
 * the new source. Guarded to exactly the typing surface the switch was for:
 * the registered editor view, focused, not mid-composition (a re-mount would
 * abort the IME session mid-word).
 *
 * `preventScroll` is part of the contract: focus() by default scrolls the
 * focused element into view, and contentDOM spans the whole document —
 * without it every real switch would scroll the notes page to its top.
 */
function refreshWebInputContext(): void {
  if (typeof document === "undefined") return;
  const view = getView();
  if (!view || view.composing) return;
  const dom = view.contentDOM;
  if (!dom.isConnected || document.activeElement !== dom) return;
  dom.blur();
  dom.focus({ preventScroll: true });
}

/**
 * Force a target input source, remembering what to restore on window blur.
 * No-op when `target` is already what bnote wants (unless suspended by blur).
 */
export function imeApply(target: string): void {
  const { settings } = useAppStore.getState();
  if (!settings.ime.enabled) return;
  if (desired === target && !suspended) return;
  cancelFocusVerify();
  desired = target;
  suspended = false;
  scheduleLaunch();
}

/**
 * A Chinese writing field (annotation card / agent dialog) gained focus: switch
 * straight to the insert source. These fields only take Chinese, so focus is
 * the intent; the editor's vim mode does not take part.
 *
 * `force` = the user explicitly entered the field (mouse click / keyboard
 * focus): after switching back to English with Ctrl+Space inside the field,
 * clicking back in leaves `desired` still on Chinese and the ordinary dedup
 * considers it "already Chinese" and does nothing. The forced path bypasses
 * that dedup and re-sends the intent once; on the Rust side `tis::select` is a
 * cheap no-op for "already on the target source" and does not retrigger the
 * CJK verification chain.
 */
export function imeOnChineseFocus(force = false): void {
  const { settings } = useAppStore.getState();
  if (!settings.ime.enabled || !settings.ime.chineseFields) return;
  if (!force) {
    imeApply(settings.ime.insertSource);
    return;
  }
  desired = settings.ime.insertSource;
  suspended = false;
  // The queued older intent (blur hand-back, the previous field) is voided:
  // the user just explicitly entered a field, so Chinese is the final intent.
  // Once the in-flight call settles, launchSwitch's trailing step re-sends it.
  queued = null;
  scheduleLaunch();
  scheduleFocusVerify(settings.ime.insertSource);
}

/**
 * Re-checks the system input source once the focus has settled.
 *
 * With "remember input source per context" enabled
 * (`TextInputGlobalPropertyPerContextInput = 1`), AppKit restores the input
 * source remembered for the context once a new text context becomes active.
 * A switch that happens during the focus change is overwritten by that
 * restore — the visible symptom is the Sogou icon flashing and English coming
 * back. Reading the system source once after the focus settles and re-sending
 * it when it disagrees with the intent fixes that (one re-send only, no
 * loop); leaving the field or changing the intent in the meantime voids the
 * check automatically.
 */
function scheduleFocusVerify(target: string): void {
  cancelFocusVerify();
  const seq = focusVerifySeq;
  focusVerifyTimer = setTimeout(() => {
    focusVerifyTimer = null;
    if (seq !== focusVerifySeq) return;
    const { settings } = useAppStore.getState();
    if (!settings.ime.enabled || !settings.ime.chineseFields) return;
    if (desired !== target || suspended || !focusInChineseField()) return;
    void api
      .getCurrentInputSource()
      .then((current) => {
        if (seq !== focusVerifySeq) return;
        if (desired !== target || suspended || !focusInChineseField()) return;
        if (current === target) return;
        desired = target;
        queued = null;
        scheduleLaunch();
      })
      .catch(() => {});
  }, FOCUS_VERIFY_DELAY_MS);
}

/**
 * A temporary Chinese input scope: the lifetime of one popup (quick todo).
 *
 * On open, **read the user's current input source first, then switch to
 * Chinese** — switching first and reading later would mistake the Chinese
 * source for "the original one". On close the original source is handed back
 * through the single intent channel (the in-flight Chinese switch is
 * overwritten by that trailing step, so there is never a "hand-back followed
 * by a late switch back to Chinese"). If the popup closes before the capture
 * returns, that capture finishes the teardown itself and leaves no half state
 * behind.
 */
interface TransientScope {
  /** The source the user had at the moment of opening (null while the capture has not returned). */
  source: string | null;
  /** Closed before the capture returned. */
  closed: boolean;
  /** A Chinese switch intent was really sent — without one there is nothing to "hand back". */
  applied: boolean;
}

let transient: TransientScope | null = null;

export function imeBeginTransientChinese(): void {
  const { settings } = useAppStore.getState();
  if (!settings.ime.enabled || !settings.ime.chineseFields) return;
  if (transient) return; // re-entering the same scope (a re-render) must not overwrite the original source
  const scope: TransientScope = { source: null, closed: false, applied: false };
  transient = scope;
  const start = () => {
    scope.applied = true;
    imeApply(settings.ime.insertSource);
  };
  void api
    .getCurrentInputSource()
    .then((id) => {
      if (transient !== scope) return;
      scope.source = id;
      if (scope.closed) {
        transient = null;
        if (scope.applied) restoreSource(id);
        return;
      }
      start();
    })
    .catch(() => {
      if (transient !== scope || scope.closed) return;
      start();
    });
}

export function imeEndTransientChinese(): void {
  const scope = transient;
  if (!scope) return;
  if (scope.source === null) {
    scope.closed = true; // the capture has not returned: begin's callback finishes the teardown
    return;
  }
  transient = null;
  if (scope.applied) restoreSource(scope.source);
}

/** Hands the user's original source back: through the single intent channel, so the queued Chinese switch is overwritten by this one. */
function restoreSource(source: string): void {
  cancelFocusVerify();
  desired = source;
  suspended = false;
  queued = null;
  scheduleLaunch();
}

/** Warms up the IME pipeline: enumerates the input sources once in the
 *  background after startup. The first helper request pays process spawn plus
 *  TIS initialization (measured ~170 ms cold on this machine) — paying it at
 *  startup keeps the user's first mode change off that cold path. This call
 *  also fills the helper's input source reference cache, so every later
 *  switch is reduced to "read the current source + select". */
export function imeWarmUp(): void {
  const { settings } = useAppStore.getState();
  if (!settings.ime.enabled) return;
  void api.listInputSources().catch(() => {});
}

/** Drop bnote's forced source and restore what the user had before it. The
 *  hand-back goes through the single intent channel (`restoreSource`), like
 *  every other switch: a rapid field enter/leave burst then collapses into the
 *  one trailing call instead of firing one concurrent restore per event. */
export function imeYield(): void {
  const restore = baseline;
  cancelFocusVerify();
  desired = null;
  suspended = false;
  queued = null;
  forcedThisSession = false;
  transient = null; // control is handed back: no popup's "original source" is remembered any more
  baseline = null; // consumed: handing it back twice would re-send the same source
  if (restore) restoreSource(restore);
}

/**
 * The DOM marker carried by Chinese writing fields (annotation card / agent
 * dialog). When focus lands on a marked element, the input source intent
 * belongs to it: imeSyncToEditor must not overwrite it with the editor
 * context — otherwise, after focusing the agent field and switching to
 * Chinese, a Cmd-Tab away and back makes the window focus switch back to
 * English on the editor's normal mode, and the user types raw ASCII.
 */
const CHINESE_FIELD_ATTR = "data-ime-chinese";

function focusInChineseField(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement as Element | null;
  return typeof active?.hasAttribute === "function" && active.hasAttribute(CHINESE_FIELD_ATTR);
}

/** Switch to whatever the current UI context wants (modal or editor vim mode). */
export function imeSyncToEditor(): void {
  const { settings, modal } = useAppStore.getState();
  if (!settings.ime.enabled) {
    if (desired) imeYield();
    return;
  }
  if (focusInChineseField()) {
    // The intent belongs to a Chinese writing field: imeOnChineseFocus already
    // switched; in the suspended state (after a blur hand-back) imeApply's
    // dedup lets it through, so the Chinese source is sent once more. Window
    // re-activation goes through here too and needs the same check (the
    // context restore may overwrite the source after activation).
    const target = settings.ime.insertSource;
    imeApply(target);
    scheduleFocusVerify(target);
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
    if (insertRegionWantsEnglish(settings, view)) return settings.ime.normalSource;
    return settings.ime.insertSource;
  }
  return settings.ime.normalSource;
}

/**
 * In insert mode, should the caret position "keep English": the next
 * character will be written into a formula (ASCII) or a fenced code block
 * (ASCII). The decision looks at the **body** only: when the caret rests
 * after a formula's closing delimiter or before its opening one, the next
 * character lands outside the formula and the Chinese source applies
 * (see caretInMathBody in context.ts).
 *
 * A pure function (holds no view), shared by the imeDesiredSource and the
 * updateListener paths, and asserted directly by the gates.
 */
export function insertRegionWantsEnglishAt(
  settings: Settings,
  state: EditorState,
  head: number,
): boolean {
  if (settings.ime.mathKeepsEnglish && mathRegions(state).some((r) => caretInMathBody(r, head))) {
    return true;
  }
  if (settings.ime.codeKeepsEnglish && insideFencedCode(state, head)) {
    return true;
  }
  return false;
}

function insertRegionWantsEnglish(settings: Settings, view: EditorView): boolean {
  return insertRegionWantsEnglishAt(settings, view.state, view.state.selection.main.head);
}

/** Window deactivated: hand the user's original source back to the system. */
export function imeOnWindowBlur(): void {
  focusSeq++;
  queued = null;
  cancelFocusVerify();
  // Only a real forced switch needs to be handed back. While the switch is
  // still deferred (the intent has not been sent out) this must not fire a
  // main-thread TIS call to "switch" a source that is already active — that
  // call would occupy the main thread just the same.
  if (forcedThisSession && desired !== null && baseline !== null) {
    void api.setInputSource(baseline).catch(() => {});
  }
  forcedThisSession = false;
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
    if (mode === "insert" && insertRegionWantsEnglish(settings, view)) {
      target = ime.normalSource;
    }

    if (target === lastEditorTarget) return;
    lastEditorTarget = target;
    imeApply(target);
  });
}
