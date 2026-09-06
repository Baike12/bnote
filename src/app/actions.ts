import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { api, type FileNode } from "@/lib/tauri";
import { useAppStore, setConfigSnapshot, getConfigSnapshot } from "@/state/appStore";
import { loadDocument } from "@/editor/setup";
import { getView } from "@/editor/api";
import { loadedFile } from "@/editor/loadedFile";
import { reconfigureLivePreview, reconfigureTypewriter, reconfigureVim } from "@/editor/setup";
import { configureLivePreview } from "@/editor/livePreview";
import { loadVimrc } from "@/editor/vim/loader";
import { reloadSnippets } from "@/editor/snippets/engine";
import type { RawSnippet } from "@/editor/snippets/default-snippets";
import { dirname, joinPath } from "@/lib/path";

/** App-level operations shared by commands, components and bootstrap. */

/** Native folder picker (async JS API — never blocks the main thread). */
export async function pickVaultDialog(): Promise<string | null> {
  const selection = await openFileDialog({
    directory: true,
    title: "选择笔记仓库文件夹",
  });
  return typeof selection === "string" ? selection : null;
}

export async function openVault(path: string): Promise<boolean> {
  try {
    const info = await api.setVault(path);
    const store = useAppStore.getState();
    store.setVault(info);
    setConfigSnapshot({ ...getConfigSnapshot(), lastVault: info.path });
    await refreshTree();
    await reloadSnippetsFromVault();
    // /tmp 等 symlink 路径 canonicalize 后前缀可能变化，直接尝试打开。
    const lastFile = getConfigSnapshot().lastFile;
    if (lastFile) {
      await openNote(lastFile).catch((e) => {
        useAppStore.getState().showToast(`打开上次文件失败: ${String(e)}`);
      });
    }
    return true;
  } catch (e) {
    console.error("open vault failed", e);
    useAppStore.getState().showToast(`打开仓库失败: ${String(e)}`);
    return false;
  }
}

export async function refreshTree(): Promise<void> {
  const { vaultPath, setTree, setFlatFiles, tree } = useAppStore.getState();
  if (!vaultPath) return;
  try {
    const [root, files] = await Promise.all([api.readTree(), api.listFiles()]);
    setFlatFiles(files);
    // Re-fetch previously expanded directories so the visible tree stays
    // complete after external changes.
    const loaded = collectLoadedDirs(tree);
    if (loaded.length > 0) {
      const merged = await Promise.all(
        loaded.map(async (rel) => {
          try {
            return [rel, await api.readDir(rel)] as const;
          } catch {
            return null;
          }
        }),
      );
      for (const item of merged) {
        if (item) mergeChildren(root, item[0], item[1]);
      }
    }
    setTree(root);
  } catch (e) {
    console.warn("refresh tree failed", e);
  }
}

function collectLoadedDirs(nodes: FileNode[]): string[] {
  const out: string[] = [];
  const walk = (list: FileNode[]) => {
    for (const n of list) {
      if (n.kind === "dir" && n.children !== null) {
        out.push(n.relPath);
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return out;
}

function mergeChildren(nodes: FileNode[], relPath: string, children: FileNode[]): boolean {
  for (const n of nodes) {
    if (n.relPath === relPath && n.kind === "dir") {
      n.children = children;
      return true;
    }
    if (n.kind === "dir" && n.children && mergeChildren(n.children, relPath, children)) {
      return true;
    }
  }
  return false;
}

/** Loads one directory level into the tree (lazy expansion). */
export async function loadDirChildren(relPath: string): Promise<void> {
  try {
    const children = await api.readDir(relPath);
    const { tree, setTree } = useAppStore.getState();
    const copy = structuredClone(tree);
    mergeChildren(copy, relPath, children);
    setTree(copy);
  } catch (e) {
    console.warn("read dir failed", e);
  }
}

export async function openNote(path: string): Promise<void> {
  const view = getView();
  if (!view) {
    useAppStore.getState().showToast("编辑器尚未就绪，无法打开文件");
    return;
  }
  const content = await api.readFile(path);
  loadDocument(view, content);
  loadedFile.current = path;
  useAppStore.getState().openFile(path);
  // setState() reset compartment values — re-apply current settings.
  await applySettingsToEditor();
  view.focus();
}

export async function saveNote(): Promise<void> {
  const { currentFile, showToast } = useAppStore.getState();
  const view = getView();
  if (!currentFile || !view) return;
  try {
    await api.writeFile(currentFile, view.state.doc.toString());
    useAppStore.getState().markDirty(false);
  } catch (e) {
    showToast(`保存失败: ${String(e)}`);
  }
}

export async function newNote(): Promise<void> {
  const { vaultPath, currentFile } = useAppStore.getState();
  if (!vaultPath) return;
  const parent = currentFile ? dirname(currentFile, vaultPath) : "";
  try {
    const created = await api.createFile(parent, "Untitled.md");
    await refreshTree();
    await openNote(created.path);
    useAppStore.getState().setModal(null);
  } catch (e) {
    useAppStore.getState().showToast(`新建笔记失败: ${String(e)}`);
  }
}

export async function newFolder(parent?: string): Promise<void> {
  const { vaultPath } = useAppStore.getState();
  if (!vaultPath) return;
  try {
    await api.createDir(parent ?? "", "New Folder");
    await refreshTree();
  } catch (e) {
    useAppStore.getState().showToast(`新建文件夹失败: ${String(e)}`);
  }
}

export async function renameEntry(path: string, newName: string): Promise<void> {
  const { currentFile } = useAppStore.getState();
  try {
    const newPath = await api.renamePath(path, newName);
    await refreshTree();
    if (currentFile === path) {
      await openNote(newPath);
    }
  } catch (e) {
    useAppStore.getState().showToast(`重命名失败: ${String(e)}`);
  }
}

export async function trashEntry(path: string): Promise<void> {
  const { currentFile } = useAppStore.getState();
  try {
    await api.trashPath(path);
    if (currentFile === path) {
      useAppStore.getState().closeFile();
      const view = getView();
      if (view) loadDocument(view, "");
      loadedFile.current = null;
    }
    await refreshTree();
  } catch (e) {
    useAppStore.getState().showToast(`删除失败: ${String(e)}`);
  }
}

export function wikiLinkTargetPath(target: string): string | null {
  const { flatFiles, vaultPath } = useAppStore.getState();
  if (!vaultPath) return null;
  const wanted = target.trim().toLowerCase().replace(/\.md$/, "");
  const hit = flatFiles.find((rel) => {
    const base = rel.replace(/\.md$/i, "").toLowerCase();
    return base === wanted || base.split("/").pop() === wanted || rel.toLowerCase() === `${wanted}.md`;
  });
  return hit ? joinPath(vaultPath, hit) : null;
}

export function openWikiLink(target: string) {
  const path = wikiLinkTargetPath(target);
  if (path) {
    void openNote(path);
  } else {
    useAppStore.getState().showToast(`未找到笔记: ${target}`);
  }
}

/** Applies store settings (vim, typewriter, live preview, snippets) to the editor. */
export async function applySettingsToEditor(): Promise<void> {
  const view = getView();
  const { settings } = useAppStore.getState();
  document.documentElement.style.setProperty("--editor-font-size", `${settings.fontSize}px`);
  if (!view) return;
  reloadSnippets(null, settings.snippets);
  configureLivePreview({ mathPreview: settings.mathPreview });
  reconfigureLivePreview(view, settings.livePreview);
  reconfigureTypewriter(view, settings.typewriter);
  const mappings = settings.vim ? await loadVimrc().catch(() => []) : [];
  reconfigureVim(view, settings.vim, mappings);
}

/** Loads `<vault>/.bnote/snippets.js` when present, falling back to defaults. */
export async function reloadSnippetsFromVault(): Promise<void> {
  const { vaultPath, settings } = useAppStore.getState();
  if (!vaultPath) return;
  try {
    const src = await api.readVaultFile("snippets.js");
    if (!src) {
      reloadSnippets(null, settings.snippets);
      return;
    }
    const raws = await importSnippetModule(src);
    reloadSnippets(raws, settings.snippets);
  } catch (e) {
    console.warn("[bnote] failed to load vault snippets.js", e);
    reloadSnippets(null, settings.snippets);
  }
}

async function importSnippetModule(src: string): Promise<RawSnippet[]> {
  const blob = new Blob([src], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    const mod = await import(/* @vite-ignore */ url);
    const data = (mod as { default?: unknown }).default ?? mod;
    return Array.isArray(data) ? (data as RawSnippet[]) : [];
  } finally {
    URL.revokeObjectURL(url);
  }
}
