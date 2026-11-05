/**
 * "Open this note" as a signal, so a leaf module can navigate without importing
 * the app layer.
 *
 * `footprint/extension.ts` (a CodeMirror extension) reacts to a click on a
 * footprint row, and the only thing it needs from `app/actions.ts` is "open this
 * path". Importing it directly made the chain
 * `footprint → app/actions → editor/setup → footprint` circular. The app
 * registers its opener once; the editor side calls the signal.
 */

/** Signature of the app's note opener (`app/actions.ts` `openNote`). */
export type NoteOpener = (path: string, line?: number) => void;

let opener: NoteOpener | null = null;

/** Called once by the app layer when `openNote` is available. */
export function registerNoteOpener(fn: NoteOpener): void {
  opener = fn;
}

/** Best effort: with nothing registered (a bare editor in a test) the click is a no-op. */
export function openNoteByPath(path: string, line?: number): void {
  opener?.(path, line);
}
