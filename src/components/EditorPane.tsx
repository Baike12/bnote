import { useEffect, useRef } from "react";
import { createEditor, loadDocument } from "@/editor/setup";
import { editorApi } from "@/editor/api";
import { loadedFile } from "@/editor/loadedFile";
import { cancelCursorSave, scheduleCursorSave } from "@/editor/cursorMemory";
import { applySettingsToEditor, newNote, openNote, saveNote } from "@/app/actions";
import { useAppStore } from "@/state/appStore";
import { currentVimMode } from "@/editor/vim/vim";
import { fileName } from "@/lib/path";

const AUTOSAVE_DELAY = 800;

export function EditorPane() {
  const hostRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const modeRef = useRef<HTMLSpanElement>(null);
  const currentFile = useAppStore((s) => s.currentFile);
  const autoSave = useAppStore((s) => s.settings.autoSave);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const view = createEditor(hostRef.current!, "", {
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
    void applySettingsToEditor();
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      cancelCursorSave();
      view.destroy();
      editorApi.view = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <div className="editor-pane">
      <div className="editor-host" ref={hostRef} />
      {!currentFile && vaultPath && (
        <div className="editor-empty">
          <p>打开左侧笔记，或</p>
          <button className="btn" onClick={() => void newNote()}>
            新建笔记
          </button>
        </div>
      )}
      <div className="status-bar">
        <span ref={modeRef} className="vim-mode" />
        <span ref={statusRef} />
        <span className="spacer" />
        {dirty && <span className="dirty-dot" title="未保存">●</span>}
        <span className="file-hint">{currentFile ?? ""}</span>
      </div>
    </div>
  );
}
