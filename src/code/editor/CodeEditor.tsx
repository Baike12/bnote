import { useEffect, useRef } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from "@codemirror/language";
import { lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { codeHighlighting } from "@/editor/markdown";
import {
  vimModeExtension,
  vimKeyCaptureExtension,
  vimActiveLine,
  vimVisualHighlight,
} from "@/editor/vim/vim";
import { getCM } from "@replit/codemirror-vim";
import { useAppStore } from "@/state/appStore";
import { codeVimEnabled } from "@/state/codeVim";
import { typewriterExtension } from "@/editor/typewriter";
import { useCodeStore, type OpenFile } from "../store";
import { codeApi } from "../api";
import { findLanguage } from "./language";
import { lspCompletion, lspDiagnosticsLinter, lspHoverTooltip } from "./lsp";
import { registerCodeEditor, setActiveCodeEditor, unregisterCodeEditor } from "./registry";

/**
 * The code editor itself (CodeMirror 6).
 *
 * **Completely separate** from the notes editor: its own extensions, its own
 * keybindings, its own vim switch (`settings.codeVim`). The notes area and
 * the code area are two editing contexts; the keybindings of the notes never
 * leak into the code and vice versa.
 *
 * ## Where the state lives
 *
 * The document content lives in the store (not in the editor): the editor
 * instance is rebuilt / swapped per tab, so content put in there would be
 * lost. The `EditorState` of each file is cached in the component and swapped
 * back with `setState` — which keeps the undo stack with its own file.
 *
 * ## Single writer
 *
 * The document content is written to the store by the editor only
 * (`updateContent`); the store writes to the editor in exactly one place: the
 * wholesale replacement on an external change (re-reading from disk after a
 * rename). Both sides compare the current content first and do nothing when
 * it is equal — without the comparison there would be a "write it back, which
 * triggers itself" loop.
 */

const languageCompartment = new Compartment();
const vimCompartment = new Compartment();
const wrapCompartment = new Compartment();
const typewriterCompartment = new Compartment();

export interface CodeEditorProps {
  file: OpenFile;
  /** The caret position changed (used by the status bar). */
  onCursor?: (line: number, column: number) => void;
  /** The vim mode changed (the status bar shows NORMAL / INSERT). */
  onMode?: (mode: string) => void;
}

export function CodeEditor({ file, onCursor, onMode }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** The EditorState of each file: swapped back on a tab switch, so the undo stack is kept. */
  const statesRef = useRef(new Map<string, EditorState>());
  const handleRef = useRef<{
    root: string;
    path: string;
    language: string;
    view: EditorView;
  } | null>(null);
  /**
   * The debounced handles that push content to the language server (bucketed
   * per file): pushing every keystroke would flood the server. Bucketing per
   * file is needed because switching files must not cancel the pending push of
   * the old file.
   *
   * The pending root and text are recorded as well: on unmount (switching to a
   * PDF / closing the project) the pending content has to be **pushed before
   * leaving**, otherwise the server never sees what was typed in the last
   * 300ms and the diagnostics stay on the old text.
   */
  const syncTimersRef = useRef(
    new Map<string, { timer: ReturnType<typeof setTimeout>; root: string; text: string }>(),
  );

  const codeVim = useAppStore((s) => codeVimEnabled(s.settings));
  const codeWrap = useAppStore((s) => s.settings.codeWrap);
  // The typewriter mode shares one setting with the notes (including the
  // vertical caret position): the same model, no second set of switches for
  // the code area.
  const typewriter = useAppStore((s) => s.settings.typewriter);
  const typewriterPosition = useAppStore((s) => s.settings.typewriterPosition);
  const jump = useCodeStore((s) => s.jump);
  const content = file.content;

  /**
   * Indentation: guessed once when the file is opened, then fixed.
   *
   * `indentUnit` is **what Enter / Tab really write** (2 spaces, 4 spaces or
   * one tab); `tabSize` only decides how wide a tab draws. Both are needed:
   * with only tabSize, the auto-indent stays at CodeMirror's default of 2
   * spaces and a 4-space project ends up with a mix.
   */
  const indentUnitText = file.indentUnit || "  ";
  const tabSize = file.tabSize || indentUnitText.length;

  // ---- build the view (only once) ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Hold on to this Map: the cleanup needs it, and ref.current may already
    // have been replaced by then.
    const timers = syncTimersRef.current;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "",
        extensions: buildExtensions(),
      }),
    });
    viewRef.current = view;
    return () => {
      // Push the pending content before leaving: clearing the timer would
      // mean the last few keystrokes never reach the server.
      for (const [path, pending] of timers) {
        clearTimeout(pending.timer);
        void codeApi.lspSync(pending.root, path, pending.text).catch(() => {});
      }
      timers.clear();
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Report the caret position and the vim mode to the status bar (used on file switch and state change). */
  function reportCursor(view: EditorView): void {
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    onCursor?.(line.number, pos - line.from + 1);
    onMode?.(vimModeOf(view) ?? "");
  }

  /** Build the extension set (shared by building the view and swapping the file). */
  function buildExtensions(): Extension[] {
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      foldGutter(),
      history(),
      drawSelection(),
      highlightSelectionMatches(),
      EditorState.allowMultipleSelections.of(true),
      EditorState.tabSize.of(tabSize),
      indentUnit.of(indentUnitText),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      search({ top: true }),
      codeHighlighting(),
      autocompletion({ override: [lspCompletion], activateOnTyping: true }),
      lspHoverTooltip,
      lspDiagnosticsLinter,
      keymap.of([
        ...closeBracketsKeymap,
        ...searchKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      languageCompartment.of([]),
      vimCompartment.of([]),
      wrapCompartment.of(codeWrap ? EditorView.lineWrapping : []),
      // The first line of the code area is pinned to the top: when the caret
      // line is a few screens up, the first line is not dragged down to center
      // it — the caret walks up the screen instead (the notes body still keeps
      // its top margin, see typewriter.ts).
      typewriterCompartment.of(
        typewriter ? typewriterExtension(typewriterPosition, { reserveTop: false }) : [],
      ),
      EditorView.theme({
        "&": { height: "100%" },
        ".cm-scroller": {
          overflow: "auto",
          fontFamily:
            "var(--code-font, ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace)",
          fontSize: "var(--code-font-size, 12.5px)",
          lineHeight: "1.55",
        },
        "&.cm-focused": { outline: "none" },
        ".cm-gutters": {
          backgroundColor: "transparent",
          color: "var(--text-faint, #67676d)",
          border: "none",
        },
        ".cm-content": { caretColor: "var(--accent, #f5a83c)" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent, #f5a83c)" },
        ".cm-activeLine": { backgroundColor: "var(--code-active-line, rgba(127,127,127,0.08))" },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
          backgroundColor: "var(--code-selection, rgba(127,127,127,0.22))",
        },
      }),
      EditorView.contentAttributes.of({
        spellcheck: "false",
        autocorrect: "off",
        autocapitalize: "off",
        autocomplete: "off",
      }),
      EditorView.updateListener.of((u) => {
        const handle = handleRef.current;
        if (u.docChanged) {
          if (handle) {
            const text = u.state.doc.toString();
            useCodeStore.getState().updateContent(handle.path, text);
            statesRef.current.set(handle.path, u.state);
            // The language server only knows the content it holds: after a
            // change it has to be pushed to it, otherwise completion and
            // jumps still use the old text. Debounced by 300ms — pushing on
            // every keystroke would flood the server.
            const state = useCodeStore.getState();
            if (state.lspStates[handle.language] === "running") {
              const timers = syncTimersRef.current;
              const pending = timers.get(handle.path);
              if (pending) clearTimeout(pending.timer);
              timers.set(handle.path, {
                root: handle.root,
                text,
                timer: setTimeout(() => {
                  timers.delete(handle.path);
                  void codeApi.lspSync(handle.root, handle.path, text).catch(() => {});
                }, 300),
              });
            }
          }
        }
        if (u.selectionSet || u.docChanged) {
          // The caret is part of "the state of this file" as well: storing
          // only the docChanged version would send the caret back to the
          // position of the last keystroke (or even the start of the document)
          // after a switch away and back, losing "where I left off".
          if (handle) statesRef.current.set(handle.path, u.state);
          const pos = u.state.selection.main.head;
          const line = u.state.doc.lineAt(pos);
          onCursor?.(line.number, pos - line.from + 1);
          const mode = vimModeOf(u.view);
          if (mode) onMode?.(mode);
        }
      }),
    ];
  }

  // ---- swap files: put the state of that file into the view ----
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const root = useCodeStore.getState().project?.root ?? "";
    const language = file.languageId;
    const handle = { root, path: file.path, language, view };
    handleRef.current = handle;
    registerCodeEditor(handle);

    let state = statesRef.current.get(file.path);
    if (!state) {
      state = EditorState.create({
        doc: file.content,
        extensions: buildExtensions(),
      });
      statesRef.current.set(file.path, state);
    }
    view.setState(state);
    // setState already swapped back the caret and the selection of that file.
    // Do not dispatch `anchor: 0` again — that would send the caret back to
    // the start of the document on every tab switch, so the cached
    // EditorState would keep the undo stack but lose "where I left off". The
    // status bar is refreshed along with it.
    reportCursor(view);

    return () => {
      if (handleRef.current === handle) handleRef.current = null;
      unregisterCodeEditor(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path]);

  // ---- closed tabs: drop their EditorState from the cache ----
  //
  // Without this, every file opened during a long session keeps a full
  // document plus an undo stack. The cache is only useful while the tab is
  // open (a closed tab is read from disk again next time).
  //
  // The content pending a push to the language server has to be dropped as
  // well: closing the tab already sent a didClose from the store, and a
  // didChange arriving 300ms later would "open" the document again on the
  // server side.
  //
  // The subscription compares the reference of tabs first: the store notifies
  // on every keystroke, and a Set must not be built per keystroke.
  useEffect(() => {
    let lastTabs = useCodeStore.getState().tabs;
    return useCodeStore.subscribe((s) => {
      if (s.tabs === lastTabs) return;
      lastTabs = s.tabs;
      const open = new Set(s.tabs);
      for (const path of [...statesRef.current.keys()]) {
        if (!open.has(path)) statesRef.current.delete(path);
      }
      for (const [path, pending] of [...syncTimersRef.current]) {
        if (open.has(path)) continue;
        clearTimeout(pending.timer);
        syncTimersRef.current.delete(path);
      }
    });
  }, []);

  // ---- syntax package: loaded dynamically per languageId ----
  //
  // The dependency list includes file.path: when two files are **the same
  // language** (two .rs), watching only the languageId does not re-run and the
  // state of the new file stays "without a syntax package" — the highlighting
  // is gone entirely. Depending on path guarantees a reconfigure per file
  // switch; an already loaded language is available synchronously, so there is
  // no flash of unhighlighted text.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const desc = findLanguage(file.languageId);
    const apply = (support: Extension) => {
      view.dispatch({ effects: languageCompartment.reconfigure(support) });
    };
    if (!desc) {
      apply([]);
      return;
    }
    if (desc.support) {
      apply(desc.support);
      return;
    }
    let cancelled = false;
    desc
      .load()
      .then((support) => {
        if (!cancelled) apply(support);
      })
      .catch(() => {
        if (!cancelled) apply([]);
      });
    return () => {
      cancelled = true;
    };
  }, [file.path, file.languageId]);

  // ---- vim switch ----
  //
  // The dependency list includes file.path: switching files swaps in a new
  // EditorState whose vim compartment is empty (see buildExtensions). Without
  // a reconfigure along with it, vim silently stops working after a file
  // switch.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: vimCompartment.reconfigure(
        codeVim
          ? [vimModeExtension(), vimKeyCaptureExtension(), vimActiveLine(), vimVisualHighlight()]
          : [],
      ),
    });
    if (!codeVim) onMode?.("");
  }, [codeVim, file.path, onMode]);

  // ---- line wrapping switch ----
  //
  // Likewise dependent on file.path: switching files swaps in a new state and
  // line wrapping is an extension of each state. Reconfigure the compartment
  // instead of rebuilding the view — toggling wrapping must not throw away
  // the undo stack and the caret along with it.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wrapCompartment.reconfigure(codeWrap ? EditorView.lineWrapping : []),
    });
  }, [codeWrap, file.path]);

  // ---- typewriter mode ----
  //
  // The same model as the notes area (editor/typewriter.ts): the caret line
  // rests at a fixed ratio of the viewport and the top / bottom margins are
  // derived from that same ratio (--typewriter-top / --typewriter-bottom are
  // written on the scrollDOM and the body padding in CSS reads them).
  // Changing the position rebuilds the plugin, so the position is a
  // dependency as well; after a file switch it has to be reconfigured too —
  // the compartment travels with the EditorState.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: typewriterCompartment.reconfigure(
        typewriter ? typewriterExtension(typewriterPosition, { reserveTop: false }) : [],
      ),
    });
  }, [typewriter, typewriterPosition, file.path]);

  // ---- external change: replace the whole document (re-read from disk after a rename) ----
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === content) return;
    const cursor = Math.min(view.state.selection.main.head, content.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      selection: { anchor: cursor },
    });
    statesRef.current.set(file.path, view.state);
  }, [content, file.path]);

  // ---- jump request: place the caret at the target position ----
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !jump || jump.path !== file.path) return;
    // The position comes from a language server; a non-finite one would build a
    // NaN offset whose dispatch throws inside CodeMirror (doc.lineAt), and an
    // error thrown in an effect unmounts the whole app.
    const { line: jumpLine, character } = jump.position;
    if (!Number.isFinite(jumpLine) || !Number.isFinite(character)) {
      useCodeStore.getState().clearJump();
      return;
    }
    const line = jumpLine + 1;
    if (line < 1 || line > view.state.doc.lines) {
      useCodeStore.getState().clearJump();
      return;
    }
    const target = view.state.doc.line(line);
    const offset = Math.min(target.from + character, target.to);
    view.dispatch({
      selection: { anchor: offset },
      effects: EditorView.scrollIntoView(offset, { y: "center" }),
    });
    view.focus();
    useCodeStore.getState().clearJump();
  }, [file.path, jump]);

  // ---- focus: entering the editor switches the command target to it ----
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const onFocus = () => {
      if (handleRef.current) setActiveCodeEditor(handleRef.current);
    };
    view.dom.addEventListener("focusin", onFocus);
    return () => view.dom.removeEventListener("focusin", onFocus);
  }, []);

  return <div className="code-editor-host" ref={hostRef} />;
}

/** The vim mode name (NORMAL / INSERT / VISUAL); null when vim is off. */
function vimModeOf(view: EditorView): string | null {
  const cm = getCM(view);
  const vim = cm?.state?.vim as { insertMode?: boolean; visualMode?: boolean } | undefined;
  if (!vim) return null;
  if (vim.visualMode) return "VISUAL";
  if (vim.insertMode) return "INSERT";
  return "NORMAL";
}
