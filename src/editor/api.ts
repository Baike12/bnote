import type { EditorView } from "@codemirror/view";
import { documentPath } from "./docPath";

/**
 * Editor instance registry.
 *
 * Study mode and the project management view both run two editors at once
 * (center content / right-hand note, or project card / daily note), yet the
 * command layer (edit.*, save, vim mappings) must only ever act on **the one
 * the user is looking at**. Hence two levels:
 *
 *  - `live`: every live instance (swapping documents via setState does not
 *    change the instance itself), so setting changes can be applied to each
 *    one (reconfigureVim/livePreview are both per-view).
 *  - `editorApi.view`: the most recently focused instance, which `getView()`
 *    reads — command semantics stay as they were in the single-editor era,
 *    only "that editor" became "the focused one".
 */
export const editorApi: { view: EditorView | null } = {
  view: null,
};

const live = new Set<EditorView>();

/** A new instance registers and becomes the active editor (the freshly mounted instance is the one the user just saw). */
export function registerEditorView(view: EditorView): void {
  live.add(view);
  editorApi.view = view;
}

export function unregisterEditorView(view: EditorView): void {
  live.delete(view);
  if (editorApi.view === view) editorApi.view = null;
}

/** Every instance still connected to the DOM; setting changes apply to each one. */
export function activeEditors(): EditorView[] {
  return [...live].filter((v) => v.dom.isConnected);
}

/** Called when focus enters an instance; switches the command target to it. */
export function setActiveEditor(view: EditorView): void {
  if (live.has(view)) editorApi.view = view;
}

/** The instance holding a given file (used to patch it in memory before writing the daily note). */
export function findEditorFor(path: string): EditorView | null {
  for (const v of activeEditors()) {
    if (documentPath(v.state) === path) return v;
  }
  return null;
}

export function getView(): EditorView | null {
  return editorApi.view;
}

/**
 * Give focus to the editor without letting the browser scroll its ancestors.
 *
 * The project board owns its own horizontal position (`--board-edge-pad` plus
 * centered scrolling); a plain `view.focus()` makes the browser scroll the
 * editor into view and pushes away the position just computed (measured:
 * scrollLeft jumps from 0 to 237). Focus should only change focus, not scroll.
 */
export function focusEditor(view: EditorView | null): void {
  view?.contentDOM.focus({ preventScroll: true });
}
