/** Tracks which file is currently loaded in the editor, so the EditorPane
 *  effect and the open-note action don't double-load the same document. */
export const loadedFile: { current: string | null } = { current: null };
