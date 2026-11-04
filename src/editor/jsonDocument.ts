import type { EditorView } from "@codemirror/view";

/**
 * The mounted JSON editor: its view plus its serialized save.
 *
 * At most one exists: the content pane renders either the note editor or the
 * JSON editor for `currentFile`, never both. The command layer's `saveNote`
 * calls `saveJsonFile` so ⌘S and the debounced autosave go through the same
 * write queue — two writers to one file could otherwise commit out of order.
 */
type JsonEditor = {
  view: EditorView;
  save: () => Promise<void>;
};

let active: JsonEditor | null = null;

export function registerJsonView(editor: JsonEditor): void {
  active = editor;
}

export function unregisterJsonView(view: EditorView): void {
  if (active?.view === view) active = null;
}

export function saveJsonFile(): Promise<void> {
  return active?.save() ?? Promise.resolve();
}

/** The mounted JSON view; null when the note editor owns the content pane. */
export function getJsonView(): EditorView | null {
  return active?.view ?? null;
}
