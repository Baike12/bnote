/**
 * Key routing of the agent composer, kept out of the component so the rules —
 * not only the wiring — are testable.
 *
 * The composer is a real editor (CodeMirror + the notes area's vim engine), so
 * every key it does not take belongs to the editor: vim motions in
 * normal/visual mode, typing and the editing keymap in insert mode. Only four
 * things are the panel's own:
 *
 *  - Enter sends (vim's own normal-mode Enter is a motion; ZCode's message
 *    editor binds Enter → send for every mode, and bnote's box has always
 *    sent on Enter);
 *  - the completion popup owns the arrows, Enter/Tab and Escape while it is
 *    open, exactly as the textarea's handler did;
 *  - ↑ on an empty box walks the prompt history (a bnote affordance from
 *    before vim; in normal mode ↑ is vim's k and must stay vim's).
 *
 * IME keys are never taken: Enter confirming a composition is the IME's.
 */

export type ComposerKeyAction =
  | "pass"
  | "send"
  | "suggest-next"
  | "suggest-prev"
  | "suggest-pick"
  | "suggest-close"
  | "history-up"
  | "history-down";

export interface ComposerKeyState {
  /** `KeyboardEvent.key`. */
  key: string;
  shift: boolean;
  /** The key is the IME's own (composing, or Enter confirming a composition). */
  ime: boolean;
  /** A completion popup is showing. */
  suggestOpen: boolean;
  /** The history walk is somewhere inside the list (index ≥ 0). */
  historyActive: boolean;
  /** The box holds no text. */
  empty: boolean;
  /**
   * The editor may take editing keys: vim is off, or it is in insert mode
   * (normal/visual keep ↑/↓ for motions).
   */
  edits: boolean;
}

export function composerKeyAction(state: ComposerKeyState): ComposerKeyAction {
  if (state.ime) return "pass";

  if (state.suggestOpen) {
    if (state.key === "ArrowDown") return "suggest-next";
    if (state.key === "ArrowUp") return "suggest-prev";
    if (state.key === "Escape") return "suggest-close";
    if ((state.key === "Tab" || state.key === "Enter") && !state.shift) return "suggest-pick";
    return "pass";
  }

  // Enter sends in every mode: the composer's Enter has never been a motion,
  // and vim's normal-mode Enter (line start) is the one binding it replaces.
  if (state.key === "Enter" && !state.shift) return "send";

  if (!state.edits) return "pass";
  if (state.key === "ArrowUp" && state.empty) return "history-up";
  if (state.key === "ArrowDown" && state.historyActive) return "history-down";
  return "pass";
}
