import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/tauri";
import "./commands/builtin";
import { runCommand } from "@/commands/registry";
import { installGlobalKeybindings } from "@/commands/globalKeys";
import { loadOverrides } from "@/commands/keybindingOverrides";
import { registerVimExCommands } from "@/editor/vim/vim";
import { reloadDocument } from "@/editor/setup";
import { editorApi } from "@/editor/api";
import { loadedFile } from "@/editor/loadedFile";
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
    });
    return unsub;
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
