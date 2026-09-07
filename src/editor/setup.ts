import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { search, highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { markdownExtensions, codeHighlighting } from "./markdown";
import { insertNewlineContinueMarkup, deleteMarkupBackward } from "@codemirror/lang-markdown";
import { livePreviewExtension } from "./livePreview";
import { typewriterExtension } from "./typewriter";
import { imeSwitchExtension } from "./imeSwitch";
import { snippetsExtension } from "./snippets/extension";
import { installMathMotionClamp } from "./motionClamp";
import { vimModeExtension, commandMappingKeymap } from "./vim/vim";
import { adjustHeadingLevel } from "./ops";
import type { VimMapping } from "./vim/vimrc";

export interface EditorCallbacks {
  /** Fired on any document change (autosave hook). */
  onDocChanged: () => void;
  /** Fired on cursor/selection moves (status bar). */
  onCursorMoved: () => void;
}

const vimCompartment = new Compartment();
const typewriterCompartment = new Compartment();
const livePreviewCompartment = new Compartment();
const vimCommandMapCompartment = new Compartment();

export function baseExtensions(callbacks: EditorCallbacks): Extension[] {
  return [
    // Snippet Tab handling takes precedence over everything else.
    snippetsExtension(),

    // Heading lines own Tab / Shift-Tab (level up / down, see ops.ts); any
    // non-heading cursor falls through to the usual indent bindings below.
    keymap.of([
      { key: "Tab", run: (v) => adjustHeadingLevel(v, 1), shift: (v) => adjustHeadingLevel(v, -1) },
    ]),

    markdownExtensions(),
    codeHighlighting(),

    livePreviewCompartment.of(livePreviewExtension()),
    typewriterCompartment.of([]),
    vimCompartment.of([]),
    vimCommandMapCompartment.of([]),
    // IME follow (self-gates on settings.vim + settings.ime.enabled).
    imeSwitchExtension(),

    history(),
    search({
      top: true,
    }),
    highlightSelectionMatches(),

    keymap.of([
      // Markdown-aware Enter/Backspace: continue lists, but do NOT carry
      // indentation into code fences (a plain newline keeps fences closable).
      { key: "Enter", run: insertNewlineContinueMarkup },
      { key: "Backspace", run: deleteMarkupBackward },
      ...searchKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      { key: "Tab", run: indentMore, shift: indentLess },
    ]),

    EditorView.lineWrapping,
    EditorView.theme({
      "&": { height: "100%" },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-content": { caretColor: "var(--accent, #f5a83c)" },
    }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) callbacks.onDocChanged();
      if (u.selectionSet || u.docChanged) callbacks.onCursorMoved();
    }),
  ];
}

let savedExtensions: Extension[] | null = null;

export function createEditor(parent: HTMLElement, doc: string, callbacks: EditorCallbacks): EditorView {
  savedExtensions = baseExtensions(callbacks);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: savedExtensions }),
    parent,
  });
  installMathMotionClamp(view);
  return view;
}

/** Replaces the document (file switch) while keeping extension config. */
export function loadDocument(view: EditorView, doc: string) {
  if (!savedExtensions) return;
  view.setState(EditorState.create({ doc, extensions: savedExtensions }));
}

/** Reloads fresh disk content (external edit) while keeping the cursor and
 *  scroll position as far as the new document allows. Callers must re-apply
 *  settings afterwards — setState() resets the extension compartments. */
export function reloadDocument(view: EditorView, doc: string) {
  if (!savedExtensions) return;
  const ranges = view.state.selection.ranges;
  const scrollTop = view.scrollDOM.scrollTop;
  view.setState(EditorState.create({ doc, extensions: savedExtensions }));
  const max = view.state.doc.length;
  view.dispatch({
    selection: EditorSelection.create(
      ranges.map((r) => EditorSelection.range(Math.min(r.anchor, max), Math.min(r.head, max))),
    ),
  });
  view.scrollDOM.scrollTop = Math.min(scrollTop, view.scrollDOM.scrollHeight);
}

export function reconfigureVim(view: EditorView, enabled: boolean, mappings: VimMapping[]) {
  view.dispatch({
    effects: [
      // highlightActiveLine rides along with vim: CSS shows the shade only
      // while the vim plugin tags the scroller `.cm-vimMode` (normal/visual).
      vimCompartment.reconfigure(enabled ? [vimModeExtension(), highlightActiveLine()] : []),
      vimCommandMapCompartment.reconfigure(enabled ? commandMappingKeymap(mappings) : []),
    ],
  });
}

export function reconfigureTypewriter(view: EditorView, enabled: boolean) {
  view.dispatch({
    effects: typewriterCompartment.reconfigure(enabled ? typewriterExtension() : []),
  });
}

export function reconfigureLivePreview(view: EditorView, enabled: boolean) {
  view.dispatch({
    effects: livePreviewCompartment.reconfigure(enabled ? livePreviewExtension() : []),
  });
}
