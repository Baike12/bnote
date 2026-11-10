import { EditorState, type Extension } from "@codemirror/state";

/**
 * The editor extensions of a file that must not be written (see
 * `OpenFile.external`: a jump target outside the project).
 *
 * Two pieces, and **no `EditorView.editable(false)`**:
 *
 * - `EditorState.readOnly` is the advisory flag every input handler, the vim
 *   plugin and CodeMirror's own commands consult, and it keeps the content DOM
 *   focusable — the caret still exists, so motions, scrolling and selections
 *   work. `EditorView.editable(false)` sets `contenteditable="false"`, which
 *   also makes the document unfocusable: the file became unreadable because the
 *   cursor could not move at all.
 * - the transaction filter is the guarantee: a command that forgets to check
 *   `readOnly` still cannot change the document. It only drops transactions
 *   that change the doc, so selection and scrolling pass through.
 */
export function readOnlyExtensions(external: boolean): Extension[] {
  if (!external) return [];
  return [
    EditorState.readOnly.of(true),
    EditorState.transactionFilter.of((tr) => (tr.docChanged ? [] : tr)),
  ];
}
