import type { EditorView } from "@codemirror/view";

/**
 * Registry of the code editor instances.
 *
 * The command layer (go to definition, go to reference, save, …) must always
 * act on **the code editor the user is currently using**, so this keeps a
 * record of "the focused instance + the file it belongs to".
 *
 * It is a separate registry from the one of the notes editor
 * (`src/editor/api.ts`): the notes area and the code area are two
 * independent editing contexts, and each set of commands finds its own
 * target.
 */

/** The context of one code editor instance. */
export interface CodeEditorHandle {
  /** Absolute path of the project root. */
  root: string;
  /** Project-relative path. */
  path: string;
  /** The languageId (decided by the backend from the extension). */
  language: string;
  view: EditorView;
}

const live = new Set<CodeEditorHandle>();

let active: CodeEditorHandle | null = null;

/** Register a new instance; it also becomes the active editor. */
export function registerCodeEditor(handle: CodeEditorHandle): void {
  live.add(handle);
  active = handle;
}

export function unregisterCodeEditor(handle: CodeEditorHandle): void {
  live.delete(handle);
  if (active === handle) {
    active = null;
    // Fall back to one that is still alive (closing the current tab of a
    // multi-tab session must not lose the focus entirely).
    for (const h of live) {
      if (h.view.dom.isConnected) {
        active = h;
        break;
      }
    }
  }
}

/** Called when the focus enters an instance, to switch the command target to it. */
export function setActiveCodeEditor(handle: CodeEditorHandle | null): void {
  if (!handle) return;
  if (live.has(handle)) active = handle;
}

/** The handle of a given view (used by logic that runs per view, such as diagnostics — do not use "the focused one": that depends on the focus and picks the wrong file when the focus is not on the editor). */
export function handleForView(view: EditorView): CodeEditorHandle | null {
  for (const h of live) {
    if (h.view === view) return h;
  }
  return null;
}

/** The focused code editor; null if there is none. */
export function activeCodeEditor(): CodeEditorHandle | null {
  if (active && live.has(active) && active.view.dom.isConnected) return active;
  for (const h of live) {
    if (h.view.dom.isConnected) return h;
  }
  return null;
}
