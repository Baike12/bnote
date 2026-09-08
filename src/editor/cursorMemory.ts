import type { EditorView } from "@codemirror/view";
import { getConfigSnapshot, rememberCursorPosition } from "@/state/appStore";

/**
 * Remember-cursor-position: records where the user left off in each note
 * (cursor offset + scroll top) and replays it when the note reopens. Saves
 * are debounced while editing; openNote() flushes before switching away so a
 * quick file switch never loses the last position.
 */

const SAVE_DELAY = 300;

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: { path: string; view: EditorView } | null = null;

function saveNow() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const p = pending;
  pending = null;
  if (!p) return;
  const pos = p.view.state.selection.main.head;
  const scroll = Math.round(p.view.scrollDOM.scrollTop);
  rememberCursorPosition(p.path, pos, scroll);
}

/** Debounced save of the current position in `path`. */
export function scheduleCursorSave(path: string, view: EditorView) {
  pending = { path, view };
  if (timer) clearTimeout(timer);
  timer = setTimeout(saveNow, SAVE_DELAY);
}

/** Save immediately (file switch, window blur, teardown). */
export function flushCursorSave() {
  saveNow();
}

/** Drops a pending save without writing (e.g. the file was closed). */
export function cancelCursorSave() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pending = null;
}

/** True while a debounced save has not been written yet (flush before quit). */
export function hasPendingCursorSave() {
  return pending !== null;
}

/** Re-applies the remembered position/scroll for `path`, if any. */
export function restoreSavedCursor(view: EditorView, path: string) {
  const saved = getConfigSnapshot().cursorPositions?.[path];
  if (!saved) return;
  const pos = Math.min(saved.pos, view.state.doc.length);
  view.dispatch({ selection: { anchor: pos } });
  // CM syncs the DOM synchronously for this dispatch, so scrollHeight is
  // already valid here (no rAF — it never fires in an unfocused webview).
  view.scrollDOM.scrollTop = Math.max(0, Math.min(saved.scroll, view.scrollDOM.scrollHeight));
}
