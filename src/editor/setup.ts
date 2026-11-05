import { Compartment, EditorSelection, EditorState, Prec } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { setDocPath, docPathField } from "./docPath";
import { setActiveEditor } from "./api";
import { EditorView, keymap, drawSelection } from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
} from "@codemirror/commands";
import { search, highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdownExtensions, codeHighlighting } from "./markdown";
import { insertNewlineContinueMarkup, deleteMarkupBackward } from "@codemirror/lang-markdown";
import { livePreviewExtension, configureLivePreview, selectionAffectsDecos } from "./livePreview";
import { emphasisMarksExtension } from "./emphasisMarks";
import { typewriterExtension } from "./typewriter";
import { imeSwitchExtension } from "./imeSwitch";
import { pythonLspExtension } from "@/python/lsp";
import { dailySyncExtension } from "@/daily/extension";
import { dailyMarksExtension } from "@/daily/marks";
import { footprintZoneExtension, footprintMarksExtension } from "@/footprint/extension";
import { snippetsExtension, deleteDollarPair, deleteScriptBraces } from "./snippets/extension";
import { matrixEnter } from "./snippets/matrix";
import { configureLatexSuite } from "./snippets/config";
import { installMathMotionClamp } from "./motionClamp";
import { renumberHeadings } from "./numbering";
import {
  vimModeExtension,
  vimKeyCaptureExtension,
  commandMappingKeymap,
  vimVisualHighlight,
  currentVimMode,
  vimDrawsBlockCursor,
  vimActiveLine,
} from "./vim/vim";
import { cutSelection, copySelection, pasteClipboard } from "./ops";
import { useAppStore } from "@/state/appStore";
import { enterContinueListItem } from "./ops";
import type { VimMapping } from "./vim/vimrc";

export interface EditorCallbacks {
  /** Fired on any document change (autosave hook). */
  onDocChanged: () => void;
  /** Fired on cursor/selection moves (status bar). */
  onCursorMoved: () => void;
}

/**
 * In vim's normal/visual modes Backspace/Enter *move* instead of editing, so
 * the LaTeX Suite key enhancements must pass through untouched. The gate lives
 * at the binding site (setup) rather than in the feature module, so snippets
 * never depend on the vim engine.
 */
function vimAllowsEdit(view: EditorView): boolean {
  return !useAppStore.getState().settings.vim || currentVimMode(view) === "insert";
}

/** Backspace: LaTeX Suite's autoDelete$ goes first (it drops both `$` when
 *  the caret sits between them in a formula); the same applies to the empty
 *  braces bnote appends for sub/superscripts (`_{|}`/`^{|}` deletes `_`/`^`
 *  with them). Everything else falls back to the markdown delete logic below. */
function backspace(view: EditorView): boolean {
  if (!vimAllowsEdit(view)) return false;
  return deleteDollarPair(view) || deleteScriptBraces(view);
}

/** Enter inside a matrix environment inserts a ` \\` line break (Shift+Enter
 *  only moves the caret). */
function enterInMatrix(view: EditorView, shift: boolean): boolean {
  if (!vimAllowsEdit(view)) return false;
  return matrixEnter(view, shift);
}

const vimCompartment = new Compartment();
const typewriterCompartment = new Compartment();
const livePreviewCompartment = new Compartment();
const vimCommandMapCompartment = new Compartment();

export interface EditorCreateOptions {
  /**
   * The "auto send" switch of todo sync: on for normal notes (typing a todo
   * sends it into today's daily note), off for project cards — project todos
   * only travel when dragged into the daily note or sent with the send
   * shortcut.
   */
  allowAutoSend?: boolean;
  /** Extra extensions for this instance (the project card's drag handles, etc.),
   *  registered in the same batch as the base extensions. */
  extraExtensions?: Extension[];
}

export function baseExtensions(
  callbacks: EditorCallbacks,
  options: EditorCreateOptions = {},
): Extension[] {
  return [
    // Snippet Tab handling takes precedence over everything else.
    snippetsExtension(),

    // Multi-range selections: vim's blockwise mode (Ctrl-V) is "one range per
    // line" inside the engine — y/d/c/p run per range (Vim.forEachSelection →
    // cm.listSelections()), and per-line edits inside a block rely on it too.
    // CM6 disables that facet by default, so any multi-range selection is
    // squashed into the main range by tr.newSelection.asSingle() when the
    // transaction lands: selecting three lines and pressing y copies only one
    // line (while the drawing shows the full block — the two disagree). With
    // it enabled the engine's per-line ranges reach the state unchanged, so
    // drawing and copy/delete see the same geometry.
    EditorState.allowMultipleSelections.of(true),

    // lang-markdown ships its own Enter/Backspace in a Prec.high keymap
    // (insertNewlineContinueMarkup / deleteMarkupBackward). Without a higher
    // precedence its Enter wins outright, and the list-specific behavior in
    // ops.ts never runs — tab indentation gets expanded to spaces and an empty
    // nested item grows a blank line instead of moving up a level. Prec.highest
    // keeps the list Enter in charge; every non-list line still falls through
    // to lang-markdown below.
    // Enter inside a matrix environment is bound before list continuation: in
    // \begin{pmatrix}…\end{pmatrix} the Enter that inserts a ` \\` line
    // break is the wanted one (Tab inserting ` & ` works the same way, see
    // the snippet key table).
    Prec.highest(
      keymap.of([
        { key: "Enter", run: (view) => enterInMatrix(view, false) },
        { key: "Shift-Enter", run: (view) => enterInMatrix(view, true) },
        { key: "Enter", run: enterContinueListItem },
      ]),
    ),

    markdownExtensions(),
    codeHighlighting(),
    // Styling for emphasis (italic/bold/strikethrough): the syntax highlight
    // tags color by node range, and when lezer misreads a `_` subscript in a
    // formula as Emphasis it paints the whole prose in between, so this
    // math-aware decoration has to draw it (see emphasisMarks.ts).
    emphasisMarksExtension(),

    docPathField,
    // The focused instance is the one the command layer acts on (getView). The
    // project view holds both a project card and a daily note editor, so
    // "the last one mounted" points at the wrong target after the user clicks
    // back and forth.
    EditorView.domEventHandlers({
      focusin: (_event, view) => {
        setActiveEditor(view);
        return false;
      },
    }),
    livePreviewCompartment.of(livePreviewExtension()),
    typewriterCompartment.of([]),
    vimCompartment.of([]),
    vimCommandMapCompartment.of([]),
    // IME follow (self-gates on settings.vim + settings.ime.enabled).
    imeSwitchExtension(),

    // ty LSP: debounced document changes are synced into a line-aligned
    // virtual python file, and diagnostics are attached back to the document.
    // It gates itself (no docPath, no python fence, project LSP off all pass
    // straight through).
    pythonLspExtension(),

    // Cross-file todo sync: checks, subtodos and renames are mirrored into
    // the daily note (it passes straight through until the link index is
    // loaded).
    dailySyncExtension({ allowAutoSend: options.allowAutoSend }),
    // Visual marker for linked todos (an in-viewport line decoration, an
    // absolutely positioned pseudo-element that occupies only the marker
    // slot).
    dailyMarksExtension(),
    // Today's footprint: the end of today's daily note aggregates the blocks
    // other files recorded today (referenced, read-only); the collected lines
    // on the source side get a pip. It gates itself: not today's daily note
    // or an empty index passes straight through.
    footprintZoneExtension(),
    footprintMarksExtension(),

    history(),
    search({
      top: true,
    }),
    highlightSelectionMatches(),

    keymap.of([
      // Mod-c/Mod-x/Mod-v must be implemented explicitly here: wry's
      // WKWebView claims Mod chords at the view layer and delivers them to
      // the page as plain keydown events, so the AppKit Edit menu roles never
      // receive the events and WebKit does not perform the clipboard action on
      // keydown either (Mod-a only works because defaultKeymap has a
      // Mod-a → selectAll JS binding). The clipboard payload itself goes
      // through lib/clipboard.
      { key: "Mod-c", run: copySelection },
      { key: "Mod-x", run: cutSelection },
      { key: "Mod-v", run: pasteClipboard },
      // Markdown-aware Enter/Backspace fallback: continue lists, but do NOT
      // carry indentation into code fences (a plain newline keeps fences
      // closable). List lines never get here — the Prec.highest binding above
      // takes them.
      { key: "Enter", run: insertNewlineContinueMarkup },
      // LaTeX Suite's autoDelete$ runs before the markdown delete logic; in
      // vim's normal/visual modes Backspace is "move left", so it has to be
      // handed back to the engine untouched.
      { key: "Backspace", run: backspace },
      { key: "Backspace", run: deleteMarkupBackward },
      ...searchKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      { key: "Tab", run: indentMore, shift: indentLess },
    ]),

    EditorView.lineWrapping,
    // The single writer of cursor geometry: the timing of the native caret's
    // painting is decided inside WebKit — during the DOM rebuild caused by a
    // list marker slot / indent it paints one frame with the old inline offset
    // (the user sees the "caret flash to the line start"), and correct
    // JS-side selection state cannot constrain it. drawSelection replaces the
    // caret with CM6's measured .cm-cursor, positioned from that frame's
    // measure (the updateListener below flushes it into the same frame when
    // vim is on), so the DOM rebuild has no visible window.
    // Normal/visual modes are unaffected: the shim's .cm-vimMode rule keeps
    // hiding the CM6 cursor layer and shows only the engine's block cursor.
    // Steady cursor: the blink animation is turned off globally by
    // `.cm-cursorLayer { animation: none }` in global.css (the normal cursor
    // layer and the vim block cursor layer share that class), so the blink
    // rhythm is not configured here.
    drawSelection(),
    EditorView.theme({
      "&": { height: "100%" },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
      },
      "&.cm-focused": { outline: "none" },
      // CM6's baseTheme gives the gutter a light gray background (for the
      // light scenario), which under a dark theme becomes a white column
      // inserted into the editor. The gutter only appears on the project board
      // (drag handles); theming it uniformly also keeps future gutters from
      // hitting the same spot.
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: "var(--text-faint, #67676d)",
        border: "none",
      },
      ".cm-content": { caretColor: "var(--accent, #f5a83c)" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent, #f5a83c)" },
    }),
    // Suppress the macOS inline predictive-text / autocorrect popup while
    // typing English in the note body.
    EditorView.contentAttributes.of({
      autocorrect: "off",
      autocapitalize: "off",
      autocomplete: "off",
      spellcheck: "false",
    }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) callbacks.onDocChanged();
      if (u.selectionSet || u.docChanged) callbacks.onCursorMoved();
      // Auto heading numbering: renumber once after a document change (an
      // input.bnote-renumber transaction no longer triggers, which prevents a
      // loop). Dispatching directly inside updateListener is forbidden, so it
      // goes into a microtask — it still completes before this frame paints,
      // and undo groups it with the original edit.
      // Undo/redo never triggers it: otherwise the numbering would be undone
      // and immediately restored, so undo could never fully revert it.
      if (
        u.docChanged &&
        !u.transactions.some(
          (t) =>
            t.isUserEvent("input.bnote-renumber") || t.isUserEvent("undo") || t.isUserEvent("redo"),
        ) &&
        useAppStore.getState().settings.autoNumberHeadings
      ) {
        const view = u.view;
        queueMicrotask(() => {
          // isConnected: the view may already be destroyed before the
          // microtask runs (file switch / window closed).
          if (useAppStore.getState().settings.autoNumberHeadings && view.dom.isConnected) {
            renumberHeadings(view);
          }
        });
      }
    }),
    // The vim block cursor is not the native cursor: the plugin draws it into
    // .cm-vimCursorLayer itself, and its position is written one frame later
    // through view.requestMeasure (@replit/codemirror-vim's
    // BlockCursorPlugin.update → requestMeasure → rAF), while the DOM
    // updates of lines and decorations are synchronous. A list indent shifts
    // the whole line 28px to the right, and in the frame right after the
    // indent the cursor still sits at the old x — exactly on top of the new
    // bullet, and only on the next frame does it jump behind the bullet.
    // Reading the cursor coordinates once here flushes the pending measure so
    // the cursor lands in the same frame as the text. Pure cursor moves
    // (vim's j/k, h/l) are one frame late too, so they are flushed as well.
    //
    // Timing contract of the flush: it is queued as a **microtask** instead
    // of running synchronously inside updateListener. The engine's mode class
    // flip (vim-mode-change → updateClass flips .cm-vimMode on the
    // scrollDOM) happens after dispatch returns, within the same key task —
    // reading the coordinates synchronously computes a layout round with the
    // "pre-flip" styles, the class flip that follows invalidates that
    // result, and the rAF measure computes another round: one Esc, two
    // layout rounds. The microtask still runs inside this key task, before
    // rendering (rAF / paint), so the block cursor still lands in the same
    // frame; but it comes after every synchronous change of the task
    // (including the class flip), so a single measure round sees the final
    // styles — two rounds collapse into one. Later microtask transactions of
    // the same task (such as the heading renumbering) are covered by this
    // flush as well and no longer pay a round each.
    //
    // Cost and gate: coordsAtPos **synchronously** runs a full measure round
    // (block cursor + selection layer + typewriter centering) and forces a
    // style recalculation + layout. Measured: 2.0ms per doc/selection
    // transaction, 4.3ms inside a formula block (real app). What it buys is
    // only the "cursor layer lands in the same frame", so it is paid only
    // when **a layer really moves**:
    //   - the document changed: the DOM of lines/decorations may be rebuilt
    //     and the insert-mode anchor paints one frame with the old offset;
    //   - or the engine is drawing the block cursor (normal/visual/replace) —
    //     under measureCursor's criterion the block cursor layer is empty in
    //     insert mode, so the flush has no target;
    //   - or this selection change can affect decorations (crossing a marker
    //     slot, hitting an inline trigger), so the line box may shift
    //     (selectionAffectsDecos is that upper bound).
    // When none of the three holds (idle transitions such as normal→insert,
    // an insert-mode cursor move inside the text) the flush buys no
    // same-frame gain and only costs a full forced layout.
    EditorView.updateListener.of((u) => {
      if (!useAppStore.getState().settings.vim) return;
      if (!u.docChanged && !u.selectionSet) return;
      if (!vimCursorNeedsFlush(u.startState, u.state, vimDrawsBlockCursor(u.view), u.docChanged)) {
        return;
      }
      scheduleVimCursorFlush(u.view);
    }),

    // This instance's own extensions (the project card's drag handles) come
    // after the base extensions: they do not change the existing precedence,
    // they only add another layer of decorations/gutters.
    ...(options.extraExtensions ?? []),
  ];
}

/** The minimal view surface of the flush: it is exported as a pure structure
 *  so the timing contract ("runs inside a microtask, gives up when the view
 *  is gone") can be locked in a DOM-free gate. */
export interface FlushableView {
  dom: { isConnected: boolean };
  state: { selection: { main: { head: number } } };
  coordsAtPos(pos: number): unknown;
}

/**
 * Queues the cursor flush into a microtask (reason: see the timing contract
 * above the updateListener). If the view is destroyed before the microtask
 * runs (file switch / window closed) the flush is abandoned — an async
 * callback must prove it is still current instead of writing blindly.
 */
export function scheduleVimCursorFlush(view: FlushableView): void {
  queueMicrotask(() => {
    if (!view.dom.isConnected) return;
    view.coordsAtPos(view.state.selection.main.head);
  });
}

/**
 * The criterion for the cursor flush (reason: see the comment block above).
 * The three sources of "a layer really moves":
 *   - the document changed: the DOM of lines/decorations may be rebuilt and
 *     the native anchor in insert mode paints one frame with the old offset;
 *   - the engine is drawing the block cursor (normal/visual/replace): the
 *     block cursor layer only has geometry after a measure;
 *   - this selection change can affect decorations (crossing a marker slot,
 *     hitting an inline trigger): the line box may shift.
 * When none holds (idle transitions such as normal→insert, an insert-mode
 * cursor move inside the text) the flush buys no same-frame gain and only
 * costs a full forced layout — it is exported so the gate can lock this
 * model, which is the root cause of the mode-switch stutter.
 */
export function vimCursorNeedsFlush(
  start: EditorState,
  state: EditorState,
  drawsBlockCursor: boolean,
  docChanged: boolean,
): boolean {
  if (docChanged) return true;
  if (drawsBlockCursor) return true;
  if (start.selection.eq(state.selection)) return false;
  return selectionAffectsDecos(start, state);
}

/**
 * The base extensions of each editor instance. Deliberately kept per view
 * instead of in one global variable: study mode's middle content editor and
 * the right-hand notes editor each build an instance, and loadDocument
 * replaces the whole state's extensions — a global would let the later
 * instance push its own extensions (including its updateListener callback)
 * into the earlier instance's state, so typing in the middle column would
 * trigger the notes editor's autosave and overwrite the notes file with what
 * the notes pane held at that moment.
 */
const extensionsByView = new WeakMap<EditorView, Extension[]>();

/** This instance's own extensions; returns null for instances not created by
 *  createEditor, and loadDocument leaves them untouched. */
function ownExtensions(view: EditorView): Extension[] | null {
  return extensionsByView.get(view) ?? null;
}

export function createEditor(
  parent: HTMLElement,
  doc: string,
  callbacks: EditorCallbacks,
  options: EditorCreateOptions = {},
): EditorView {
  const extensions = baseExtensions(callbacks, options);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions }),
    parent,
  });
  extensionsByView.set(view, extensions);
  installMathMotionClamp(view);
  return view;
}

/**
 * After setState the syntax tree is an empty shell (the background parse has
 * not started yet), so decorations are drawn against the empty tree — the
 * root cause of "switching files renders nothing until the cursor moves".
 * Push the parse synchronously within the budget, then dispatch an empty
 * transaction so the decoration field/plugin rebuild against the new tree,
 * guaranteeing the first frame is already the rendered state. For big
 * documents the part that did not finish keeps rebuilding as the background
 * parse advances the tree.
 */
function primeSyntaxTree(view: EditorView) {
  ensureSyntaxTree(view.state, view.state.doc.length, 50);
  view.dispatch({});
}

/**
 * setState clears every compartment (vim/typewriter/livePreview all stop
 * working), while the applySettingsToEditor that restores them is async
 * (vimrc arrives over IPC) — during that window vim does not exist, so gg/G
 * in normal mode would be typed into the document as ordinary input. The
 * cached mappings restore it synchronously, so the window stays zero-width;
 * the async path then aligns once more with the latest vimrc.
 */
function restoreCompartments(view: EditorView) {
  const { settings } = useAppStore.getState();
  configureLivePreview({ mathPreview: settings.mathPreview });
  configureLatexSuite(settings.latex);
  reconfigureVim(view, settings.vim, lastVimMappings);
  reconfigureTypewriter(view, settings.typewriter);
  reconfigureLivePreview(view, settings.livePreview);
}

/**
 * Replaces the document (file switch) while keeping extension config.
 * `docPath` is the file the doc came from — image references resolve against
 * its directory (see livePreview.ts).
 */
export function loadDocument(view: EditorView, doc: string, docPath: string | null = null) {
  const extensions = ownExtensions(view);
  if (!extensions) return;
  view.setState(EditorState.create({ doc, extensions }));
  restoreCompartments(view);
  primeSyntaxTree(view);
  view.dispatch({ effects: setDocPath.of(docPath) });
}

/** Reloads fresh disk content (external edit) while keeping the cursor and
 *  scroll position as far as the new document allows. Callers must re-apply
 *  settings afterwards — setState() resets the extension compartments. */
export function reloadDocument(view: EditorView, doc: string, docPath: string | null = null) {
  const extensions = ownExtensions(view);
  if (!extensions) return;
  const ranges = view.state.selection.ranges;
  const scrollTop = view.scrollDOM.scrollTop;
  view.setState(EditorState.create({ doc, extensions }));
  restoreCompartments(view);
  primeSyntaxTree(view);
  view.dispatch({ effects: setDocPath.of(docPath) });
  const max = view.state.doc.length;
  view.dispatch({
    selection: EditorSelection.create(
      ranges.map((r) => EditorSelection.range(Math.min(r.anchor, max), Math.min(r.head, max))),
    ),
  });
  view.scrollDOM.scrollTop = Math.min(scrollTop, view.scrollDOM.scrollHeight);
}

let lastVimMappings: VimMapping[] = [];

export function reconfigureVim(view: EditorView, enabled: boolean, mappings: VimMapping[]) {
  lastVimMappings = mappings;
  view.dispatch({
    effects: [
      // The current-line shade is mounted together with vim: vimActiveLine
      // draws cm-activeLine with the decoration model, and its visibility
      // criterion is literally the engine's cm-vimMode class (the block cursor
      // criterion) — so it does not rely on an ancestor class selector and a
      // stale style cannot cover the whole viewport on Esc/i.
      // vimKeyCaptureExtension: in normal/visual mode the engine sees the key
      // before the whole keymap chain (root cause and contract: see the
      // capture dispatch comment block in vim.ts).
      vimCompartment.reconfigure(
        enabled
          ? [vimModeExtension(), vimKeyCaptureExtension(), vimActiveLine(), vimVisualHighlight()]
          : [],
      ),
      vimCommandMapCompartment.reconfigure(enabled ? commandMappingKeymap(mappings) : []),
    ],
  });
}

export function reconfigureTypewriter(view: EditorView, enabled: boolean) {
  // Position and toggle come from the same setting: the plugin computes the
  // top/bottom whitespace proportionally, so a position change must rebuild
  // the extension (the compartment rebuild re-lays the whitespace and pushes
  // the caret back to the new height at once, so dragging the slider previews
  // it live).
  const position = useAppStore.getState().settings.typewriterPosition;
  view.dispatch({
    effects: typewriterCompartment.reconfigure(enabled ? typewriterExtension(position) : []),
  });
}

export function reconfigureLivePreview(view: EditorView, enabled: boolean) {
  view.dispatch({
    effects: livePreviewCompartment.reconfigure(enabled ? livePreviewExtension() : []),
  });
}
