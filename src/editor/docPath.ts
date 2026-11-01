import { StateEffect, StateField } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";

/**
 * Which file this editor currently holds (absolute path, null = empty document).
 *
 * Relative image paths need a base directory, and the same page can host two
 * editors at once (the center and right columns of study mode), where
 * `![](assets/x.svg)` refers to different files — so the base must follow the
 * document instead of reading a global currentFile. It lives in the state
 * rather than being tracked per view: swapping the file is a `setState` (the
 * field is rebuilt), and the value is then rewritten by one effect transaction,
 * which also triggers the decoration rebuild.
 *
 * A separate module so that setup.ts (installing the extension) and
 * livePreview.ts (reading the path) can share it without importing each other
 * in a cycle.
 */
export const setDocPath = StateEffect.define<string | null>();

export const docPathField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDocPath)) return e.value;
    return value;
  },
});

/** The absolute path of the document in the current editor; null when no file is open. */
export function documentPath(state: EditorState): string | null {
  return state.field(docPathField, false) ?? null;
}
