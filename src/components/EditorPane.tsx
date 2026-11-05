import { useEffect, useRef } from "react";
import { createEditor, loadDocument } from "@/editor/setup";
import { editorApi, registerEditorView, unregisterEditorView } from "@/editor/api";
import { loadedFile } from "@/editor/loadedFile";
import { flushCursorSave, observeScrollSave, restoreSavedCursor, scheduleCursorSave } from "@/editor/cursorMemory";
import { applySettingsToEditor, newNote, openNote, saveNote } from "@/app/actions";
import { useAppStore } from "@/state/appStore";
import { currentVimMode } from "@/editor/vim/vim";
import { fileName } from "@/lib/path";
import { PythonRunPanel } from "@/components/python/PythonRunPanel";
import { FocusChip } from "@/components/focus/FocusChip";

const AUTOSAVE_DELAY = 800;

/**
 * Switching into study mode unmounts and remounts this component: the App's
 * main area changes from "titlebar + note editor" to the three-column layout
 * (the right column is still the note editor), React replaces the whole
 * subtree by element type, and the CodeMirror instance on the notes side is
 * brand new. Two consequences have to be covered here:
 *
 * 1. The module-level loadedFile records "which file an instance has loaded".
 *    If it is not cleared on unmount, the new instance takes the old record,
 *    skips reading the file and starts from an empty document; the note looks
 *    empty on screen, and as soon as the document changes (a keystroke, an
 *    undo) the autosave overwrites the whole note with that empty document.
 *    So a new instance always starts as "not loaded" unless the handoff data
 *    below claims it.
 * 2. The autosave pending on a timer at unmount must not be dropped (that is
 *    exactly the path the layout switch hits): it has to be written out, and
 *    the document itself is handed to the next instance, so the remount does
 *    not have to read the file again.
 */
interface EditorHandoff {
  path: string;
  doc: string;
}

/** The document left behind by the last unmounted note editor; consumed exactly once by the next note editor. */
let handoff: EditorHandoff | null = null;

export function EditorPane() {
  const hostRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const modeRef = useRef<HTMLSpanElement>(null);
  const currentFile = useAppStore((s) => s.currentFile);
  const autoSave = useAppStore((s) => s.settings.autoSave);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // The handoff only claims the same note; if the file changed in between, treat it as no handoff and read from disk as usual.
    const carried = handoff;
    handoff = null;
    const reuse = carried?.path === useAppStore.getState().currentFile ? carried : null;

    const view = createEditor(hostRef.current!, reuse?.doc ?? "", {
      onDocChanged: () => {
        const store = useAppStore.getState();
        store.markDirty(true);
        if (store.settings.autoSave) scheduleAutosave();
      },
      onCursorMoved: () => {
        updateStatus();
        // Remember where the user is per file (debounced; flushed on switch).
        const path = useAppStore.getState().currentFile;
        if (path) scheduleCursorSave(path, view);
      },
    });
    editorApi.view = view;
    registerEditorView(view);
    // Scrolling with the wheel is reading progress too: the scroll position and the caret share one debounced save.
    const disposeScrollSave = observeScrollSave(view, () =>
      useAppStore.getState().currentFile,
    );
    if (reuse) {
      // The document is already in this instance: mark it as loaded so the
      // [currentFile] effect below does not read the file again, and restore
      // the caret to the remembered position as usual.
      loadedFile.current = reuse.path;
      restoreSavedCursor(view, reuse.path);
    } else {
      // A fresh instance has loaded nothing: clear the marker and let the [currentFile] effect call openNote.
      loadedFile.current = null;
    }
    void applySettingsToEditor();
    return () => {
      // The unmount path is the one the layout switch hits too: the pending autosave must not be lost, write it out first.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        if (useAppStore.getState().dirty) void saveNote();
      }
      // The caret position is kept too: the remount restores from it, otherwise the caret lands on the previous note's stale position.
      flushCursorSave();
      disposeScrollSave();
      // Only hand over a document that really got loaded: if the layout was switched before the read came back (opened, then switched right away), this is still the empty document and handing it over would pass empty content off as the note.
      const path = loadedFile.current;
      handoff = path ? { path, doc: view.state.doc.toString() } : null;
      view.destroy();
      // Only unregister when the active view is this one (in the project view another instance may already have taken over).
      unregisterEditorView(view);
    };
     
  }, []);

  // React to settings changes that affect autosave scheduling.
  useEffect(() => {
    if (!autoSave && saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
  }, [autoSave]);

  // Load the file when the store's current file changed outside openNote()
  // (e.g. restoring the last session).
  useEffect(() => {
    const view = editorApi.view;
    if (!view) return;
    if (!currentFile) {
      if (loadedFile.current !== null) {
        loadDocument(view, "");
        loadedFile.current = null;
      }
      return;
    }
    if (loadedFile.current === currentFile) return;
    let cancelled = false;
    void openNote(currentFile).catch((e) => {
      if (!cancelled) {
        useAppStore.getState().showToast(`无法打开文件: ${String(e)}`);
        useAppStore.getState().closeFile();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [currentFile]);

  function scheduleAutosave() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void saveNote();
    }, AUTOSAVE_DELAY);
  }

  function updateStatus() {
    const view = editorApi.view;
    if (!view || !statusRef.current) return;
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    statusRef.current.textContent = `行 ${line.number}，列 ${pos - line.from + 1}`;
    if (modeRef.current) {
      const vimOn = useAppStore.getState().settings.vim;
      const mode = vimOn ? currentVimMode(view) : null;
      const text = mode === "insert" ? "INSERT" : mode === "visual" ? "VISUAL" : mode === "normal" ? "NORMAL" : "";
      modeRef.current.textContent = text;
      modeRef.current.className = `vim-mode${text === "INSERT" ? " insert" : ""}`;
    }
  }

  const dirty = useAppStore((s) => s.dirty);
  const vaultPath = useAppStore((s) => s.vaultPath);

  // Reflect the open note in the window title (hidden-title overlay keeps
  // the native title area clean, but the AX title is still readable).
  useEffect(() => {
    document.title = currentFile ? `${fileName(currentFile)} - bnote` : "bnote";
  }, [currentFile]);

  return (
    <div className="editor-pane" data-key-region="notes">
      <div className="editor-host" ref={hostRef} />
      <PythonRunPanel />
      {!currentFile && vaultPath && (
        <div className="editor-empty">
          <p>打开左侧笔记，或</p>
          <button className="btn" onClick={() => void newNote()}>
            新建笔记
          </button>
        </div>
      )}
      <div className="status-bar">
        {/* Left: the pomodoro chip (entry point for the focus timer and the
            exclusive lock). Right: vim mode and the caret position. The file
            path is not repeated here, the title bar on top already has it. */}
        <FocusChip />
        <span className="spacer" />
        {dirty && <span className="dirty-dot" title="未保存">●</span>}
        <span ref={modeRef} className="vim-mode" />
        <span ref={statusRef} />
      </div>
    </div>
  );
}
