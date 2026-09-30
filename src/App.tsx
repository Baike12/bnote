import { useEffect, lazy, Suspense } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { agentApi, api } from "@/lib/tauri";
import "./commands/builtin";
import { runCommand } from "@/commands/registry";
import { installGlobalKeybindings } from "@/commands/globalKeys";
import { loadOverrides } from "@/commands/keybindingOverrides";
import { installEditingChords } from "@/lib/editingChords";
import { registerVimExCommands } from "@/editor/vim/vim";
import { reloadDocument } from "@/editor/setup";
import { renumberHeadings } from "@/editor/numbering";
import { editorApi } from "@/editor/api";
import { loadedFile } from "@/editor/loadedFile";
import { flushCursorSave, hasPendingCursorSave } from "@/editor/cursorMemory";
import { flushLinksPersist, hasPendingLinksPersist } from "@/daily/links";
import {
  flushFootprintsPersist,
  hasPendingFootprintsPersist,
  noteDirtyPaths,
} from "@/footprint/store";
import { flushPersistConfig, hasPendingPersist } from "@/state/appStore";
import { imeOnWindowBlur, imeOnWindowFocus, imeWarmUp } from "@/editor/imeSwitch";
import {
  applySettingsToEditor,
  openVault,
  refreshTree,
  reloadSnippetsFromVault,
  restoreEditorFocus,
} from "@/app/actions";
import {
  DEFAULT_SETTINGS,
  setConfigSnapshot,
  useAppStore,
  type PersistedConfig,
} from "@/state/appStore";
import { Sidebar } from "@/components/Sidebar";
import { EditorPane } from "@/components/EditorPane";
import { StudyLayout } from "@/components/StudyLayout";
import { QuickSwitcher } from "@/components/QuickSwitcher";
import { LinkSuggest } from "@/components/LinkSuggest";
import { CommandPalette } from "@/components/CommandPalette";
import { QuickAddModal } from "@/components/QuickAddModal";
import { SettingsModal } from "@/components/SettingsModal";
import { Toast, Welcome } from "@/components/Welcome";
import { fileName } from "@/lib/path";

/** 画布是独立 chunk(含 excalidraw 及其字体加载逻辑),只在打开时下载。 */
const DrawingCanvas = lazy(() => import("@/components/DrawingCanvas"));

export default function App() {
  const vaultPath = useAppStore((s) => s.vaultPath);
  const vaultName = useAppStore((s) => s.vaultName);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const currentFile = useAppStore((s) => s.currentFile);
  const studyMode = useAppStore((s) => s.studyMode);
  const drawingSession = useAppStore((s) => s.drawingSession);
  // Agent context: the backend reads the current note path for its system prompt.
  useEffect(() => {
    void agentApi.setCurrentNote(currentFile).catch(() => {});
  }, [currentFile]);

  useEffect(() => {
    installGlobalKeybindings();
    installEditingChords();
    registerVimExCommands((id) => runCommand(id));
    let unlisten: (() => void) | undefined;
    let imeUnlisten: (() => void) | undefined;

    void (async () => {
      await loadOverrides().catch(() => {});
      const cfg = (await api.loadAppConfig().catch(() => null)) as PersistedConfig | null;
      setConfigSnapshot(cfg ?? {});
      if (cfg?.recentFiles?.length) {
        useAppStore.setState({ recentFiles: cfg.recentFiles });
      }
      const saved = cfg?.settings ?? {};
      useAppStore.getState().replaceSettings({
        ...DEFAULT_SETTINGS,
        ...saved,
        ime: { ...DEFAULT_SETTINGS.ime, ...(saved.ime ?? {}) },
        latex: { ...DEFAULT_SETTINGS.latex, ...(saved.latex ?? {}) },
      });
      unlisten = await listen<string[]>("vault-changed", (event) => {
        void handleVaultChanged(event.payload);
      });
      void listen<string>("ime-fallback", (event) => {
        useAppStore.getState().showToast(event.payload);
      }).then((off) => {
        imeUnlisten = off;
      });
      // TIS 预热（见 imeWarmUp）：首次 TIS 调用要去联系输入法服务（本机实测
      // ~90ms）且必须走苹果主线程，不能留到用户第一次切 vim 模式那一刻才付。
      imeWarmUp();
      if (cfg?.lastVault) {
        await openVault(cfg.lastVault);
      }
    })();

    return () => {
      unlisten?.();
      imeUnlisten?.();
    };
  }, []);

  // Settings changes propagate to the editor (vim, typewriter, live preview…).
  useEffect(() => {
    const unsub = useAppStore.subscribe((s, prev) => {
      if (s.settings !== prev.settings) void applySettingsToEditor();
      // 标题自动编号刚开启：当前文件立即重排一次，给即时反馈。
      if (s.settings.autoNumberHeadings && !prev.settings.autoNumberHeadings) {
        if (editorApi.view) renumberHeadings(editorApi.view);
      }
      // A modal (settings / switcher / palette / quick add) handing control
      // back: put the caret focus on the note again. Deferred past the modal
      // unmount, and skipped when something else already took focus (e.g.
      // openNote focusing the freshly loaded note).
      if (s.modal === null && prev.modal !== null) {
        setTimeout(restoreEditorFocus, 0);
      }
    });
    return unsub;
  }, []);

  // Quit-safety: the cursor save (300ms) and config write (300ms) are both
  // debounced — flush them when the app is hidden/closed, or the last cursor
  // move before a Cmd-Q would be lost and "remember position" breaks.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState !== "hidden") return;
      flushCursorSave();
      flushPersistConfig();
      flushLinksPersist();
      flushFootprintsPersist();
    };
    document.addEventListener("visibilitychange", onHidden);
    let unlisten: (() => void) | undefined;
    try {
      void getCurrentWindow()
        .onCloseRequested(async (event) => {
          if (
            !hasPendingCursorSave() &&
            !hasPendingPersist() &&
            !hasPendingLinksPersist() &&
            !hasPendingFootprintsPersist()
          ) {
            return;
          }
          event.preventDefault();
          flushCursorSave();
          flushPersistConfig();
          flushLinksPersist();
          flushFootprintsPersist();
          await getCurrentWindow().destroy();
        })
        .then((off) => {
          unlisten = off;
        });
    } catch {
      // not running under Tauri
    }
    // Menu → Quit carries no key equivalent (⌘Q belongs to bnote's keybinding
    // layer), so the native terminate path is gone. The menu hands the request
    // here instead, where the same flush-then-destroy as the close button
    // applies — quitting never costs the debounced cursor/config write.
    let unlistenMenuQuit: (() => void) | undefined;
    void listen("bnote:menu-quit", () => {
      flushCursorSave();
      flushPersistConfig();
      flushLinksPersist();
      flushFootprintsPersist();
      void getCurrentWindow().destroy();
    })
      .then((off) => {
        unlistenMenuQuit = off;
      })
      .catch(() => {
        // not running under Tauri
      });
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      unlisten?.();
      unlistenMenuQuit?.();
    };
  }, []);

  // Window activation: focus belongs on the current line again, and the IME
  // scope (forced source restored on blur, re-applied on focus) kicks in.
  // DOM focus/blur plus Tauri's window events — handlers are idempotent, so
  // double delivery from either channel is harmless.
  useEffect(() => {
    const onBlur = () => {
      flushCursorSave();
      imeOnWindowBlur();
    };
    const onFocus = () => {
      imeOnWindowFocus();
      restoreEditorFocus();
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    let unlisten: (() => void) | undefined;
    try {
      // getCurrentWindow() 在非 Tauri 环境（浏览器 harness）会同步抛错，
      // 此时只有 DOM focus/blur 生效，窗口事件订阅直接跳过。
      void getCurrentWindow()
        .onFocusChanged(({ payload }) => (payload ? onFocus() : onBlur()))
        .then((off) => {
          unlisten = off;
        });
    } catch {
      // not running under Tauri
    }
    return () => {
      window.removeEventListener("blur", onBlur);
      unlisten?.();
    };
  }, []);

  const breadcrumb = (() => {
    if (!vaultPath) return "bnote";
    const rel = currentFile?.startsWith(vaultPath)
      ? currentFile.slice(vaultPath.length + 1)
      : "";
    const parts = [vaultName];
    if (rel) {
      const segs = rel.split("/");
      for (const seg of segs.slice(0, -1)) parts.push(seg);
      parts.push(fileName(rel).replace(/\.(md|markdown|txt)$/i, ""));
    }
    return parts.join("  /  ");
  })();

  const main = (
    <main className="main">
      {studyMode ? (
        <StudyLayout />
      ) : (
        <>
          <div
            className="titlebar"
            data-tauri-drag-region
            // When the sidebar is hidden the macOS traffic lights overlay the
            // titlebar's left edge — keep the toggle button clear of them.
            style={{ paddingLeft: sidebarOpen ? 12 : 78 }}
          >
            <button
              className="icon-btn titlebar-icon"
              title={sidebarOpen ? "收起侧边栏 (⌘\\)" : "展开侧边栏 (⌘\\)"}
              onClick={() => useAppStore.getState().toggleSidebar()}
            >
              ◧
            </button>
            <div className="breadcrumb">{breadcrumb}</div>
          </div>
          <EditorPane />
        </>
      )}
    </main>
  );

  return (
    <div className="app">
      {sidebarOpen && vaultPath && <Sidebar />}
      {main}
      {!vaultPath && <Welcome />}
      <LinkSuggest />
      <QuickSwitcher />
      <CommandPalette />
      <QuickAddModal />
      <SettingsModal />
      {drawingSession && (
        <Suspense fallback={null}>
          <DrawingCanvas />
        </Suspense>
      )}
      <Toast />
    </div>
  );
}

async function handleVaultChanged(paths: string[]) {
  const store = useAppStore.getState();
  const view = editorApi.view;

  // 今日足迹:任何来源的文件变更都先喂给足迹库(自带过滤与防抖)。必须在
  // 下面的 self-write echo 早退之前——「编辑器打字 → 自动保存 → watcher」
  // 正是足迹的主数据链路。
  noteDirtyPaths(paths);

  // Self-write echo: autosave/manual save triggers the watcher. When the only
  // change is the open note and disk matches memory, do nothing — reloading
  // would reset the cursor and drop the vim/snippet compartments.
  if (
    store.currentFile &&
    !store.dirty &&
    view &&
    paths.length === 1 &&
    paths[0] === store.currentFile
  ) {
    try {
      const disk = await api.readFile(store.currentFile);
      if (disk === view.state.doc.toString()) return;
    } catch {
      // deleted or unreadable — fall through to the generic path
    }
  }

  await refreshTree();
  const snippetOutcome = await reloadSnippetsFromVault();

  if (store.currentFile && paths.includes(store.currentFile)) {
    if (!store.dirty && view) {
      try {
        const content = await api.readFile(store.currentFile);
        if (content !== view.state.doc.toString()) {
          // Genuine external edit: reload keeping the cursor in place, then
          // re-apply settings — setState() resets the extension compartments.
          reloadDocument(view, content, store.currentFile);
          loadedFile.current = store.currentFile;
          await applySettingsToEditor();
        }
      } catch {
        // 重命名刚打开的新路径与旧路径的 watcher 事件交错时，可能读到已被
        // 改名的旧文件——只在它仍是当前文件时才关闭，避免误清新打开的笔记。
        if (useAppStore.getState().currentFile === store.currentFile) {
          store.closeFile();
        }
      }
    }
  }

  if (store.settings.vim && paths.some((p) => p.includes(".bnote/vimrc"))) {
    await applySettingsToEditor();
  }

  // 仓库片段文件自身变化：装载结果要反馈出来——成功报条数确认，失败报原因
  //（blob 导入被 CSP 拦、用户 JS 语法错误，这些曾经全被静默吞掉，改了没反应）。
  if (snippetOutcome && paths.some((p) => p.includes(".bnote/snippets"))) {
    if (snippetOutcome.status === "user") {
      store.showToast(`公式片段已更新，共 ${snippetOutcome.count} 条`);
    } else if (snippetOutcome.status === "error") {
      store.showToast(`公式片段加载失败: ${snippetOutcome.error}`);
    }
  }
}
