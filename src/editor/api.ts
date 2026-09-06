import type { EditorView } from "@codemirror/view";

/** Process-wide handle on the single editor instance. Kept out of React state
 *  so commands can access the view without re-render plumbing. */
export const editorApi: { view: EditorView | null } = {
  view: null,
};

export function getView(): EditorView | null {
  return editorApi.view;
}
