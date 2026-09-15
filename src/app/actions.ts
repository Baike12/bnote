import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { api, type FileNode } from "@/lib/tauri";
import { useAppStore, setConfigSnapshot, getConfigSnapshot } from "@/state/appStore";
import { loadDocument } from "@/editor/setup";
import { getView } from "@/editor/api";
import { insertWikilinkText, wikilinkTargetOnLine } from "@/editor/ops";
import { loadedFile } from "@/editor/loadedFile";
import { flushCursorSave, restoreSavedCursor } from "@/editor/cursorMemory";
import { reconfigureLivePreview, reconfigureTypewriter, reconfigureVim } from "@/editor/setup";
import { configureLivePreview } from "@/editor/livePreview";
import { loadVimrc } from "@/editor/vim/loader";
import { reloadSnippets } from "@/editor/snippets/engine";
import type { RawSnippet } from "@/editor/snippets/default-snippets";
import { dirname, fileName, joinPath, wikilinkText } from "@/lib/path";

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
  const { vaultPath, setTree, setFlatFiles, setFolders, tree } = useAppStore.getState();
  if (!vaultPath) return;
  try {
    const [root, index] = await Promise.all([api.readTree(), api.listFiles()]);
    setFlatFiles(index.files);
    setFolders(index.dirs);
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
  // The pending save still refers to the previously open doc — write it out
  // before the swap, then replay this note's remembered position.
  flushCursorSave();
  const content = await api.readFile(path);
  loadDocument(view, content);
  loadedFile.current = path;
  useAppStore.getState().openFile(path);
  // setState() reset compartment values — re-apply current settings.
  await applySettingsToEditor();
  restoreSavedCursor(view, path);
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

/**
 * Quick-add: create a note in a quick-add command's folder. The folder is
 * vault-relative and created at the root when missing (mkdir -p); the note
 * name dedups like newNote ("name 2.md").
 */
export async function quickAddNote(folder: string, name: string): Promise<void> {
  const { vaultPath } = useAppStore.getState();
  if (!vaultPath) return;
  const base = name.replace(/\.(md|markdown|txt)$/i, "").trim();
  if (!base) return;
  const rel = folder.trim().replace(/^\/+|\/+$/g, "");
  try {
    if (rel) await api.ensureDir(rel);
    const created = await api.createFile(rel, `${base}.md`);
    await refreshTree();
    await openNote(created.path);
  } catch (e) {
    useAppStore.getState().showToast(`快速添加失败: ${String(e)}`);
  }
}

export async function newFolder(parent?: string): Promise<void> {
  const { vaultPath } = useAppStore.getState();
  if (!vaultPath) return;
  try {
    // 后端可能改名去重（"New Folder 2"），重命名要盯住真正建出来的那个目录。
    const created = await api.createDir(parent ?? "", "New Folder");
    await refreshTree();
    useAppStore.getState().requestRename(created.relPath);
  } catch (e) {
    useAppStore.getState().showToast(`新建文件夹失败: ${String(e)}`);
  }
}

export async function renameEntry(path: string, newName: string, isFile = false): Promise<void> {
  const { currentFile } = useAppStore.getState();
  try {
    let name = newName.trim();
    // 文件重命名没写扩展名时沿用原扩展名（否则 list_files 过滤后文件会从树里消失）。
    if (isFile && !name.includes(".")) {
      const oldName = fileName(path);
      const dot = oldName.lastIndexOf(".");
      if (dot > 0) name += oldName.slice(dot);
    }
    const newPath = await api.renamePath(path, name);
    await refreshTree();
    if (currentFile === path) {
      await openNote(newPath);
    } else if (currentFile && currentFile.startsWith(`${path}/`)) {
      // 重命名的是当前文件所在（父）目录：按新前缀重新打开。
      await openNote(`${newPath}/${currentFile.slice(path.length + 1)}`);
    }
  } catch (e) {
    useAppStore.getState().showToast(`重命名失败: ${String(e)}`);
  }
}

export async function trashEntry(path: string): Promise<void> {
  const { currentFile } = useAppStore.getState();
  try {
    await api.trashPath(path);
    if (currentFile && (currentFile === path || currentFile.startsWith(`${path}/`))) {
      // 删除的可能是当前文件的父目录——一并按前缀判断。
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

/**
 * 跟随一条内部链接（预览里点击 / ⌘K 跳到本行链接）：压一层回退链再打开目标。
 * 返回是否真的跳了——没找到目标时 toast，自链接时静默（交给调用方决定焦点）。
 */
export function openWikiLink(target: string, from = useAppStore.getState().currentFile): boolean {
  const path = wikiLinkTargetPath(target);
  if (!path) {
    useAppStore.getState().showToast(`未找到笔记: ${target}`);
    return false;
  }
  // 自链接不回读磁盘：openNote 会重载文档，未保存的改动会丢。
  if (path === from) return false;
  if (from) useAppStore.getState().pushLinkBack(from, path);
  void openNote(path);
  return true;
}

/** 「回退到链接跳转前的文件」：沿链接跳转链往回走一层，链外打开过就失效。 */
export function goBackLink(): void {
  const { currentFile, popLinkBack, showToast } = useAppStore.getState();
  const path = currentFile ? popLinkBack() : null;
  if (!path) {
    showToast("没有可回退的链接跳转");
    return;
  }
  void openNote(path).catch((e) => {
    useAppStore.getState().showToast(`无法打开 ${fileName(path)}: ${String(e)}`);
  });
}

/** 打开链接补全面板时的文档状态；写回前比对，文档换过（切文件、外部重载）就放弃。 */
let linkPickState: EditorState | null = null;

/**
 * 「插入 / 跳转内部链接」快捷键：光标行已经有链接就跳到那篇笔记（一行一个链接，
 * 所以本行再插就是重复），否则在光标处开补全面板——空输入列出最近打开的笔记，
 * 输入即按快速跳转同一套排序过滤。
 */
export function linkShortcut(view: EditorView): void {
  const { currentFile, linkSuggest, modal, showToast } = useAppStore.getState();
  if (modal) return; // 命令面板 / 快速跳转 / 设置开着：不抢前台，什么也不做
  if (linkSuggest) {
    useAppStore.getState().closeLinkSuggest(); // 再按一次 = 收起
    return;
  }
  if (!currentFile) {
    showToast("先打开一篇笔记，再插入链接");
    return;
  }
  const target = wikilinkTargetOnLine(view);
  if (target) {
    if (!openWikiLink(target)) view.focus(); // 没跳成（没找到 / 自链接）：焦点还给编辑器
    return;
  }
  const coords = view.coordsAtPos(view.state.selection.main.head);
  if (!coords) return;
  linkPickState = view.state;
  useAppStore.getState().openLinkSuggest({
    left: coords.left,
    top: coords.top,
    bottom: coords.bottom,
  });
}

/** 补全面板选中一篇笔记：把 `[[链接]]` 写进光标处（会自证文档没被换过）。 */
export function insertPickedLink(rel: string): void {
  const state = linkPickState;
  const view = getView();
  linkPickState = null;
  useAppStore.getState().closeLinkSuggest();
  if (!view || state === null || view.state !== state) return;
  const text = wikilinkText(rel, useAppStore.getState().flatFiles);
  if (text === null) {
    useAppStore.getState().showToast("这个文件名带链接语法字符，没法写成 [[链接]]");
    view.focus();
    return;
  }
  insertWikilinkText(view, text);
}

/**
 * Returns keyboard focus to the note's current line when nothing in the
 * window holds it (activeElement fell back to <body>) — e.g. after
 * alt-tabbing back to bnote, closing a modal, or dismissing the link panel.
 * Never yanks focus from the sidebar tree or a focused input.
 */
export function restoreEditorFocus() {
  if (useAppStore.getState().modal) return;
  const ae = document.activeElement;
  if (ae && ae !== document.body && ae !== document.documentElement) return;
  getView()?.focus();
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
