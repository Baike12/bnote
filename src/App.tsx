import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "@/lib/tauri";
import "./commands/builtin";
import { runCommand } from "@/commands/registry";
import { installGlobalKeybindings } from "@/commands/globalKeys";
import { loadOverrides } from "@/commands/keybindingOverrides";
import { registerVimExCommands } from "@/editor/vim/vim";
import { reloadDocument } from "@/editor/setup";
import { renumberHeadings } from "@/editor/numbering";
import { editorApi } from "@/editor/api";
import { loadedFile } from "@/editor/loadedFile";
import { flushCursorSave, hasPendingCursorSave } from "@/editor/cursorMemory";
import { flushPersistConfig, hasPendingPersist } from "@/state/appStore";
import { imeOnWindowBlur, imeOnWindowFocus } from "@/editor/imeSwitch";
import {
  applySettingsToEditor,
  openVault,
  refreshTree,
  reloadSnippetsFromVault,
} from "@/app/actions";
import {
  DEFAULT_SETTINGS,
  setConfigSnapshot,
  useAppStore,
  type PersistedConfig,
} from "@/state/appStore";
import { Sidebar } from "@/components/Sidebar";
import { EditorPane } from "@/components/EditorPane";
import { QuickSwitcher } from "@/components/QuickSwitcher";
import { CommandPalette } from "@/components/CommandPalette";
import { QuickAddModal } from "@/components/QuickAddModal";
import { SettingsModal } from "@/components/SettingsModal";
import { Toast, Welcome } from "@/components/Welcome";
import { fileName } from "@/lib/path";

export default function App() {
  const vaultPath = useAppStore((s) => s.vaultPath);
  const vaultName = useAppStore((s) => s.vaultName);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const currentFile = useAppStore((s) => s.currentFile);

  useEffect(() => {
    installGlobalKeybindings();
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
      });
      unlisten = await listen<string[]>("vault-changed", (event) => {
        void handleVaultChanged(event.payload);
      });
      void listen<string>("ime-fallback", (event) => {
        useAppStore.getState().showToast(event.payload);
      }).then((off) => {
        imeUnlisten = off;
      });
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
    };
    document.addEventListener("visibilitychange", onHidden);
    let unlisten: (() => void) | undefined;
    try {
      void getCurrentWindow()
        .onCloseRequested(async (event) => {
          if (!hasPendingCursorSave() && !hasPendingPersist()) return;
          event.preventDefault();
          flushCursorSave();
          flushPersistConfig();
          await getCurrentWindow().destroy();
        })
        .then((off) => {
          unlisten = off;
        });
    } catch {
      // not running under Tauri
    }
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      unlisten?.();
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

  return (
    <div className="app">
      {sidebarOpen && vaultPath && <Sidebar />}
      <main className="main">
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
      </main>
      {!vaultPath && <Welcome />}
      <QuickSwitcher />
      <CommandPalette />
      <QuickAddModal />
      <SettingsModal />
      <Toast />
    </div>
  );
}

/**
 * Returns keyboard focus to the note's current line when nothing in the
 * window holds it (activeElement fell back to <body>) — e.g. after
 * alt-tabbing back to bnote or closing a modal. Never yanks focus from the
 * sidebar tree or a focused input.
 */
function restoreEditorFocus() {
  if (useAppStore.getState().modal) return;
  const ae = document.activeElement;
  if (ae && ae !== document.body && ae !== document.documentElement) return;
  editorApi.view?.focus();
}

async function handleVaultChanged(paths: string[]) {
  const store = useAppStore.getState();
  const view = editorApi.view;

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
  await reloadSnippetsFromVault();

  if (store.currentFile && paths.includes(store.currentFile)) {
    if (!store.dirty && view) {
      try {
        const content = await api.readFile(store.currentFile);
        if (content !== view.state.doc.toString()) {
          // Genuine external edit: reload keeping the cursor in place, then
          // re-apply settings — setState() resets the extension compartments.
          reloadDocument(view, content);
          loadedFile.current = store.currentFile;
          await applySettingsToEditor();
        }
      } catch {
        store.closeFile();
      }
    }
  }

  if (store.settings.vim && paths.some((p) => p.includes(".bnote/vimrc"))) {
    await applySettingsToEditor();
  }
}
