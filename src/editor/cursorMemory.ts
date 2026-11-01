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
/**
 * `doc` is the document reference captured when the save was queued:
 * saveNow uses it to prove "this is still about that document". In the window
 * where openNote swaps the document, an event carrying the old file's path is
 * queued and by the time it lands the document is already a new one — without
 * the comparison the new document's position is written under the old path,
 * polluting another file's memory.
 */
let pending: { path: string; view: EditorView; doc: object } | null = null;

function saveNow() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const p = pending;
  pending = null;
  if (!p) return;
  if (p.view.state.doc !== p.doc) return;
  const pos = p.view.state.selection.main.head;
  const scroll = Math.round(p.view.scrollDOM.scrollTop);
  rememberCursorPosition(p.path, pos, scroll);
}

/** Debounced save of the current position in `path`. */
export function scheduleCursorSave(path: string, view: EditorView) {
  pending = { path, view, doc: view.state.doc };
  if (timer) clearTimeout(timer);
  timer = setTimeout(saveNow, SAVE_DELAY);
}

/**
 * Pure scrolling counts as "how far I read". Wheel/trackpad scrolling is just
 * a DOM scroll of scrollDOM and produces no CodeMirror transaction at all, so
 * hooking the save only to selectionSet/docChanged would miss the entire
 * read-only session — that is precisely the root cause of "the reading
 * position is lost". The scroll event goes through the same debounced save:
 * every frame of continuous scrolling merely re-arms the timer (O(1), no
 * layout read), and only 300ms after the scrolling stops is the position read
 * once and written. Returns the teardown function.
 */
export function observeScrollSave(
  view: EditorView,
  getPath: () => string | null,
): () => void {
  const onScroll = () => {
    const path = getPath();
    if (path) scheduleCursorSave(path, view);
  };
  view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
  return () => view.scrollDOM.removeEventListener("scroll", onScroll);
}

/** Save immediately (file switch, window blur, editor teardown). */
export function flushCursorSave() {
  saveNow();
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
  // scrollTop must be written in the write phase of the CM measurement cycle
  // (same convention as typewriter.ts and the line jump in openNote). Right
  // after loadDocument's setState the height table is still estimated, so a
  // direct write lands in the estimated coordinate system; when the first
  // measure right after it corrects the heights to real values, CM's scroll
  // anchoring compensation shifts the position by the estimation error again
  // (the deeper the restore point, the larger the error). The scroll save
  // (the scroll event) then records that compensation as the reading
  // position, so every reopen drifts further down (measured ratchet:
  // 1000 -> 1369 -> 1921 -> ...). requestMeasure's write runs after the real
  // geometry is established, so the compensation term is ~0 and the restore
  // lands exactly on the saved value.
  view.requestMeasure({
    read: () => null,
    write: () => {
      const dom = view.scrollDOM;
      dom.scrollTop = Math.max(0, Math.min(saved.scroll, dom.scrollHeight));
    },
  });
}
