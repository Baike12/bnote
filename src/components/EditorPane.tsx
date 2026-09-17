import { useEffect, useRef } from "react";
import { createEditor, loadDocument } from "@/editor/setup";
import { editorApi } from "@/editor/api";
import { loadedFile } from "@/editor/loadedFile";
import { flushCursorSave, restoreSavedCursor, scheduleCursorSave } from "@/editor/cursorMemory";
import { applySettingsToEditor, newNote, openNote, saveNote } from "@/app/actions";
import { useAppStore } from "@/state/appStore";
import { currentVimMode } from "@/editor/vim/vim";
import { fileName } from "@/lib/path";

const AUTOSAVE_DELAY = 800;

/**
 * 切换学习模式会把这个组件卸载重挂：App 的主区从「标题栏 + 笔记编辑器」换成
 * 三栏布局（右栏仍是笔记编辑器），React 按元素类型替换整棵子树，笔记栏这一侧
 * 的 CodeMirror 实例是全新的。两个后果都必须在这里兜住：
 *
 * 1. 模块级的 loadedFile 记录的是「某个实例装过哪个文件」，卸载时不清空的话，
 *    新实例会拿旧实例的记录跳过读盘，从一个空文档起步——界面上笔记是空的，
 *    而只要发生一次文档变更（键入、撤销），自动保存就把整篇笔记覆盖成这个空
 *    文档。所以新实例一律从「未加载」起步，除非下面这份交接数据认领它。
 * 2. 卸载时挂在定时器上的自动保存不能一丢了之（那条路径正是切布局踩到的），
 *    要落盘；文档本身也交给下一个实例，重挂就不必再读一次盘。
 */
interface EditorHandoff {
  path: string;
  doc: string;
}

/** 上一次卸载的笔记编辑器留下的文档；只被下一个笔记编辑器消费一次。 */
let handoff: EditorHandoff | null = null;

export function EditorPane() {
  const hostRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const modeRef = useRef<HTMLSpanElement>(null);
  const currentFile = useAppStore((s) => s.currentFile);
  const autoSave = useAppStore((s) => s.settings.autoSave);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // 交接只认领同一篇笔记；中途换过文件就当没有，照常从磁盘读。
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
    if (reuse) {
      // 文档已经在这个实例里了：标记成已加载，下面的 [currentFile] effect 便不再
      // 读盘，光标照旧按记住的位置复位。
      loadedFile.current = reuse.path;
      restoreSavedCursor(view, reuse.path);
    } else {
      // 新实例什么都没装：清掉标记，交给 [currentFile] effect 去 openNote。
      loadedFile.current = null;
    }
    void applySettingsToEditor();
    return () => {
      // 卸载路径也是「切布局」踩到的那条：待写的自动保存不能丢，先落盘。
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        if (useAppStore.getState().dirty) void saveNote();
      }
      // 光标位置也留着——重挂后靠它复位（不然回到上一篇的旧位置）。
      flushCursorSave();
      // 只交接真正装好的文档：读盘还没回来就切布局的话（刚打开就切），这里还是
      // 空文档，交接出去等于把空内容冒充成笔记内容。
      const path = loadedFile.current;
      handoff = path ? { path, doc: view.state.doc.toString() } : null;
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
