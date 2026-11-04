import { useCallback, useEffect, useRef, useState } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { search, highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import {
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { json } from "@codemirror/lang-json";
import { codeHighlighting } from "@/editor/markdown";
import { typewriterExtension } from "@/editor/typewriter";
import {
  currentVimMode,
  vimActiveLine,
  vimKeyCaptureExtension,
  vimModeExtension,
  vimVisualHighlight,
} from "@/editor/vim/vim";
import { registerJsonView, unregisterJsonView } from "@/editor/jsonDocument";
import { api } from "@/lib/tauri";
import { fileName, isJsonPath } from "@/lib/path";
import { useAppStore } from "@/state/appStore";

const AUTOSAVE_DELAY = 800;

function vimExtensions() {
  return [vimModeExtension(), vimKeyCaptureExtension(), vimActiveLine(), vimVisualHighlight()];
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Raw editor for `.bnote` JSON configuration files.
 *
 * The note editor is a markdown live-preview surface; JSON needs the code
 * editor's behavior instead: syntax highlighting, line numbers, folding,
 * bracket closing and the typewriter mode with the first line pinned to the
 * top (`reserveTop: false`, the same option the code pane uses). Vim follows
 * the notes switch (`settings.vim`) because these files belong to the notes
 * world, not to a code project.
 *
 * The document is written by this component alone (debounced autosave + the
 * command layer's save through `jsonDocument`); `currentFile` switching
 * recreates the view so an undo can never carry one file's text into another.
 */
export function JsonFilePane() {
  const path = useAppStore((s) => s.currentFile);
  const dirty = useAppStore((s) => s.dirty);
  const autoSave = useAppStore((s) => s.settings.autoSave);
  const vimOn = useAppStore((s) => s.settings.vim);
  const typewriter = useAppStore((s) => s.settings.typewriter);
  const typewriterPosition = useAppStore((s) => s.settings.typewriterPosition);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const positionRef = useRef<HTMLSpanElement | null>(null);
  const modeRef = useRef<HTMLSpanElement | null>(null);
  const vimCompartment = useRef(new Compartment()).current;
  const typewriterCompartment = useRef(new Compartment()).current;
  const autoSaveRef = useRef(autoSave);
  autoSaveRef.current = autoSave;
  const [error, setError] = useState<string | null>(null);
  const [valid, setValid] = useState(true);

  const report = useCallback((view: EditorView) => {
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    if (positionRef.current) {
      positionRef.current.textContent = `行 ${line.number}，列 ${head - line.from + 1}`;
    }
    if (modeRef.current) {
      const current = useAppStore.getState().settings.vim ? currentVimMode(view) : null;
      const text =
        current === "insert"
          ? "INSERT"
          : current === "visual"
            ? "VISUAL"
            : current === "normal"
              ? "NORMAL"
              : "";
      modeRef.current.textContent = text;
      modeRef.current.className = `vim-mode${text === "INSERT" ? " insert" : ""}`;
    }
  }, []);

  /** Serialized write: an autosave and ⌘S may overlap, and the last request must win. */
  const saveNow = useCallback(async (target: string) => {
    const view = viewRef.current;
    if (!view || !dirtyRef.current) return;
    const text = view.state.doc.toString();
    const run = writeQueue.current.then(() => api.writeFile(target, text));
    writeQueue.current = run.catch(() => {});
    try {
      await run;
      const store = useAppStore.getState();
      const stillCurrent = store.currentFile === target;
      const stillSameText = viewRef.current?.state.doc.toString() === text;
      if (stillCurrent && stillSameText) {
        dirtyRef.current = false;
        store.markDirty(false);
      }
    } catch (e) {
      useAppStore.getState().showToast(`保存失败: ${String(e)}`);
    }
  }, []);

  // One view per file. Recreating (instead of replacing the doc) keeps every
  // file's undo history its own and makes a stale selection impossible.
  useEffect(() => {
    const target = path;
    if (!target || !isJsonPath(target)) return;
    let cancelled = false;
    dirtyRef.current = false;
    useAppStore.getState().markDirty(false);
    setError(null);
    let detachKeys: (() => void) | null = null;

    const build = (content: string) => {
      if (cancelled || !hostRef.current) return;
      const settings = useAppStore.getState().settings;
      const view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: content,
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightActiveLine(),
            foldGutter(),
            history(),
            drawSelection(),
            highlightSelectionMatches(),
            EditorState.tabSize.of(2),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            EditorView.lineWrapping,
            json(),
            codeHighlighting(),
            search({ top: true }),
            keymap.of([
              ...closeBracketsKeymap,
              ...searchKeymap,
              ...foldKeymap,
              ...completionKeymap,
              ...defaultKeymap,
              ...historyKeymap,
              indentWithTab,
            ]),
            vimCompartment.of(settings.vim ? vimExtensions() : []),
            typewriterCompartment.of(
              settings.typewriter
                ? typewriterExtension(settings.typewriterPosition, { reserveTop: false })
                : [],
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
              ".cm-activeLine": {
                backgroundColor: "var(--code-active-line, rgba(127,127,127,0.08))",
              },
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
              if (u.docChanged) {
                dirtyRef.current = true;
                const store = useAppStore.getState();
                store.markDirty(true);
                setValid(isValidJson(u.state.doc.toString()));
                if (autoSaveRef.current) {
                  if (saveTimer.current) clearTimeout(saveTimer.current);
                  saveTimer.current = setTimeout(() => {
                    saveTimer.current = null;
                    void saveNow(target);
                  }, AUTOSAVE_DELAY);
                }
              }
              if (u.selectionSet || u.docChanged) report(u.view);
            }),
          ],
        }),
      });
      viewRef.current = view;
      registerJsonView({ view, save: () => saveNow(target) });
      setValid(isValidJson(content));
      report(view);
      view.focus();
      const onKeyDown = () => {
        if (!useAppStore.getState().settings.vim) return;
        queueMicrotask(() => {
          if (viewRef.current === view) report(view);
        });
      };
      view.dom.addEventListener("keydown", onKeyDown, true);
      detachKeys = () => view.dom.removeEventListener("keydown", onKeyDown, true);
    };

    void api
      .readFile(target)
      .then(build)
      .catch((e) => {
        if (!cancelled) setError(`读取失败: ${String(e)}`);
      });

    return () => {
      cancelled = true;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      // The write captures the document synchronously; the queue keeps it
      // ordered behind any autosave already in flight.
      void saveNow(target);
      const view = viewRef.current;
      if (view) {
        detachKeys?.();
        unregisterJsonView(view);
        view.destroy();
        viewRef.current = null;
      }
    };
  }, [path, report, saveNow, vimCompartment, typewriterCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: vimCompartment.reconfigure(vimOn ? vimExtensions() : []) });
    report(view);
  }, [vimOn, report, vimCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: typewriterCompartment.reconfigure(
        typewriter ? typewriterExtension(typewriterPosition, { reserveTop: false }) : [],
      ),
    });
  }, [typewriter, typewriterPosition, typewriterCompartment]);

  useEffect(() => {
    if (path) document.title = `${fileName(path)} - bnote`;
  }, [path]);

  if (!path || !isJsonPath(path)) return null;

  return (
    <div className="editor-pane" data-key-region="notes">
      <div className="json-editor-host" ref={hostRef} />
      <div className="status-bar">
        <span className={valid ? undefined : "json-file-invalid"}>
          {error ?? (valid ? "JSON" : "JSON 无效")}
        </span>
        <span className="spacer" />
        {dirty && (
          <span className="dirty-dot" title="未保存">
            ●
          </span>
        )}
        <span ref={modeRef} className="vim-mode" />
        <span ref={positionRef} />
      </div>
    </div>
  );
}
