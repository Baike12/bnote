import { EditorView } from "@codemirror/view";
import type { Extension, EditorState } from "@codemirror/state";
import { currentVimMode } from "./vim/vim";
import { focusedVimSurface } from "./vim/surfaces";
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
 * The out-of-process architecture has a second half: the web view's input
 * method session keeps the source it was typing with — a select made in
 * another process reaches the menu bar but not that session. `set_input_source`
 * therefore carries both halves in one round trip, in the only useful order:
 * the app's main thread first hands the source to its own input context, then
 * the helper selects the system source. The context is the authority for
 * typing and is ready before the menu bar can advertise the change. The
 * backend keeps a missed context as a generation-stamped pending intent; the
 * first AppKit window update that exposes a real context asks the focused
 * editor to settle it, without a timer that can race the first typed character.
 *
 * "The system source did not change" does not mean "the context is right":
 * after one hand-off that ran with no context (the window was still
 * activating), WebKit keeps the old IME while the menu bar already shows the
 * target, and every normal-mode key then pays that IME's keystroke round trip
 * — the lag one feels on j/k, invisible to the JS key probe because it happens
 * before the DOM keydown. The backend owns that state: the pending intent is
 * generation-stamped, an older completion cannot clear a newer request, and a
 * context-ready event retries it while the editor still owns focus.
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
 *  one trailing call that matches the final intent. The helper keeps TIS off
 *  the app's thread, but the context hand-off and system source still need a
 *  serialized order, so overlapping commands must not invent their own. */
let switching = false;
let queued: { target: string; resendSame: boolean; handback: boolean } | null = null;
let launchScheduled = false;
let desiredResendSame = false;
let launchHandback = false;

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

/** Collapses flips that happen in the same JavaScript task, then launches
 *  before the next input event. The helper keeps TIS off the app's main
 *  thread, so waiting for a macrotask only widened the window in which the
 *  editor was insert but its WebView input context had not been prepared. */
function scheduleLaunch(): void {
  if (launchScheduled) return;
  launchScheduled = true;
  queueMicrotask(() => {
    launchScheduled = false;
    const target = desired;
    const resendSame = desiredResendSame;
    const handback = launchHandback;
    desiredResendSame = false;
    launchHandback = false;
    if (target === null || (suspended && !handback)) return;
    if (switching) {
      queued = { target, resendSame, handback };
      return;
    }
    launchSwitch(target, handback);
  });
}

/* The span's own `ms` is the whole round trip: IPC plus the context-first
 * AppKit hand-off and the backend's system TIS call. The backend returns both
 * legs (`tisMs`, `contextMs`); the remainder is the bridge. `ctx` is 1 when
 * the app context accepted the source, 0 when the transition failed, and -1
 * when no context existed yet. `switched` tells whether the system source
 * moved; a miss leaves it unchanged (deferred), so the menu bar never
 * advertises a switch the WebView did not take. */
const IME_FIELDS = perfFields("tisMs", "ctxMs", "ctx", "switched");
const IME_FAILED_FIELDS = perfFields("target");

function launchSwitch(target: string, handback = false): void {
  switching = true;
  if (!handback) forcedThisSession = true;
  const seq = focusSeq;
  // End-to-end cost of the switch: IPC + the main-thread context hand-off +
  // the helper's system select. The context comes first, so the next key can
  // never arrive while the WebView still has the previous session.
  const t = perfStart();
  if (!handback && baseline === null) {
    void api
      .getCurrentInputSource()
      .then((id) => {
        if (seq === focusSeq && id !== target) baseline = id;
      })
      .catch(() => {});
  }
  // Fire-and-forget: one command carries both halves in context-first order —
  // the main thread prepares WebKit's input context, then the helper updates
  // the system source. A newer intent invalidates an older pending one.
  void api
    .setInputSource(target)
    .then((outcome) => {
      const ctx = outcome.contextApplied === null ? -1 : Number(outcome.contextApplied);
      perfEnd(t, "ime.switch", IME_FIELDS, outcome.tisMs, outcome.contextMs, ctx, outcome.switched);
      if (outcome.contextApplied === false) {
        // The context rejected the source. The backend keeps the intent pending
        // for the next context-ready update; the source it reports is the one
        // detail the Rust log lacks.
        console.warn("[bnote] input context hand-off missed", target, outcome.contextSource);
      }
      // `contextApplied === null` means "no input context at that instant"
      // (the window was still activating). The intent stays pending until the
      // native context-ready watcher proves a context exists.
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
      // input source has just been returned to them. A queued hand-back is the
      // one exception: it is the final intent of the focus session.
      if (
        next !== null &&
        (next.target !== target || next.resendSame) &&
        (!suspended || next.handback)
      ) {
        launchSwitch(next.target, next.handback);
      }
    });
}

function requestTarget(target: string, force: boolean): void {
  const { settings } = useAppStore.getState();
  if (!settings.ime.enabled) return;
  if (!force && desired === target && !suspended) return;
  cancelFocusVerify();
  desired = target;
  desiredResendSame = force;
  launchHandback = false;
  suspended = false;
  scheduleLaunch();
}

/**
 * Force a target input source, remembering what to restore on window blur.
 * No-op when `target` is already what bnote wants (unless suspended by blur).
 */
export function imeApply(target: string): void {
  requestTarget(target, false);
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
  // The latest explicit focus intent replaces whatever was queued. The single
  // in-flight command settles before this one is sent, so it cannot race it.
  requestTarget(settings.ime.insertSource, true);
  scheduleFocusVerify(settings.ime.insertSource);
}

/**
 * The agent composer gained focus (click, shortcut, programmatic focus).
 *
 * With vim on the composer is a vim surface like the note editor: the mode,
 * read from the focused surface, decides (insert → Chinese, normal/visual →
 * English). With vim off it is the plain Chinese writing field it always was,
 * and the forced path re-sends the intent (the dedup would otherwise treat a
 * second click as "already Chinese" after the user switched to English inside
 * the box).
 */
export function imeOnComposerFocus(force = false): void {
  if (useAppStore.getState().settings.vim) {
    imeSyncToEditor(force);
    return;
  }
  imeOnChineseFocus(force);
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
  desiredResendSame = false;
  launchHandback = false;
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
  desiredResendSame = false;
  launchHandback = false;
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
export function imeSyncToEditor(force = false): void {
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
    requestTarget(target, force);
    scheduleFocusVerify(target);
    return;
  }
  const target = imeDesiredSource(settings, modal);
  if (target) requestTarget(target, force);
  else if (desired) imeYield();
}

/** The input source the current UI context wants, or null for "leave it". */
function imeDesiredSource(settings: Settings, modal: ModalKind): string | null {
  if (modal === "switcher") return settings.ime.normalSource;
  if (modal) return null; // e.g. quick-add naming wants the user's own source
  if (!settings.vim) return null;
  // The vim mode that counts is the one of the editor holding the text focus
  // (notes editor or agent composer). `getView()` is the command target, which
  // stays the notes editor even while the composer is being typed in.
  const view = focusedVimSurface() ?? getView();
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
  const restore = forcedThisSession && desired !== null && baseline !== null ? baseline : null;
  focusSeq++;
  queued = null;
  cancelFocusVerify();
  forcedThisSession = false;
  baseline = null;
  suspended = true;
  // The hand-back goes through the same latest-wins queue. Sending it beside
  // an in-flight mode switch would allow their context/system halves to
  // interleave even though the backend's generation is newer.
  if (restore !== null) {
    desired = restore;
    desiredResendSame = true;
    launchHandback = true;
    scheduleLaunch();
  }
}

/** The editor became the active text surface. Reconcile even when the target
 *  did not change: the previous native hand-off may have run before this
 *  context existed, and the backend retries that pending intent here. */
export function imeOnEditorFocus(): void {
  imeSyncToEditor(true);
}

/** AppKit exposed the input context after a deferred switch. Retry only when a
 *  text surface still owns focus (the notes editor or the agent composer); a
 *  context created for an overlay must not consume the pending intent. */
export function imeOnContextReady(): void {
  const view = focusedVimSurface() ?? getView();
  const active = typeof document === "undefined" ? null : document.activeElement;
  const { modal } = useAppStore.getState();
  if (
    modal !== null ||
    !view ||
    view.composing ||
    !document.hasFocus() ||
    !active ||
    !view.contentDOM.contains(active)
  ) {
    return;
  }
  imeSyncToEditor(true);
}

/** Window activated: re-apply what bnote wants, with a fresh baseline.
 *  Forcing the request also lets the backend settle an intent that missed the
 *  context while the window was still activating. */
export function imeOnWindowFocus(): void {
  focusSeq++;
  if (suspended) baseline = null; // fresh session after a real blur; duplicate focus events keep it
  imeSyncToEditor(true);
}

/**
 * Every vim surface carries this listener: the notes editors in their base
 * extensions, the agent composer in its own. The target is resolved by the
 * same rule focus and window events use (`imeDesiredSource`, which reads the
 * surface that holds the focus), not from the view that happened to update —
 * otherwise an update of one editor applies its mode to the whole app.
 */
export function imeSwitchExtension(): Extension {
  return EditorView.updateListener.of(() => {
    const { settings, modal } = useAppStore.getState();
    if (!settings.vim || !settings.ime.enabled) {
      // Reset so re-enabling fires a fresh switch instead of a stale no-op.
      lastEditorTarget = null;
      return;
    }
    const target = imeDesiredSource(settings, modal);
    if (!target) {
      lastEditorTarget = null;
      return;
    }
    if (target === lastEditorTarget) return;
    lastEditorTarget = target;
    imeApply(target);
  });
}
