import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { api, type FileNode } from "@/lib/tauri";
import { useAppStore, getConfigSnapshot, persistConfig, flushPersistConfig, type ThemeName } from "@/state/appStore";
import { loadDocument } from "@/editor/setup";
import { getView, activeEditors } from "@/editor/api";
import { documentPath } from "@/editor/docPath";
import { insertWikilinkText, wikilinkTargetOnLine } from "@/editor/ops";
import { todayStamp } from "@/lib/todoStamp";
import { registerNoteOpener } from "@/lib/navigation";

// The footprint decorations (a leaf module) open notes through this signal
// instead of importing this file; a direct import made
// footprint → app/actions → editor/setup → footprint circular.
registerNoteOpener((path, line) => void openNote(path, line));
import { loadedFile } from "@/editor/loadedFile";
import { flushCursorSave, restoreSavedCursor } from "@/editor/cursorMemory";
import { reconfigureLivePreview, reconfigureTypewriter, reconfigureVim } from "@/editor/setup";
import { configureLivePreview } from "@/editor/livePreview";
import { loadVimrc } from "@/editor/vim/loader";
import {
  applySnippetsEnabled,
  snippetLoader,
  type SnippetLoadOutcome,
} from "@/editor/snippets/load";
import { configureLatexSuite } from "@/editor/snippets/config";
import { dirname, fileName, isJsonPath, joinPath, wikilinkText } from "@/lib/path";
import { saveJsonFile } from "@/editor/jsonDocument";
import { ensureLinks } from "@/daily/links";
import { ensureFootprints } from "@/footprint/store";
import { recentVaultTarget, touchRecentVault } from "@/vault/recent";
import { loadKeymap } from "@/commands/keybindingOverrides";
import { normalizeTemplateDir, renderTemplate } from "@/templates/template";

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
    // The keybinding config is per-vault (same folder as vimrc / snippets),
    // so opening a vault switches to another set. A failed config read must
    // not take the whole open down: fall back to the default keybindings, the
    // next save rewrites them.
    await loadKeymap(info.path).catch((e) => console.warn("load keybindings failed", e));
    // The link table behind the cross-file todo sync: loaded when the vault
    // opens. The sync path in the updateListener reads it synchronously via
    // peekLinks, so the IPC is fired here early and is usually ready before
    // the user starts editing.
    void ensureLinks(info.path).catch((e) => console.warn("load daily links failed", e));
    // Today's footprint: the baseline is read on open and rotated on demand
    // (done in the background, it does not block opening the vault).
    void ensureFootprints(info.path).catch((e) => console.warn("load footprints failed", e));
    // The vault MRU: recorded on open (opening is the moment the MRU is
    // written, same as zed). It goes to disk through the same debounced write
    // as lastVault; persistConfig updates the snapshot in sync, so a later
    // partial save does not roll this back.
    persistConfig({
      ...getConfigSnapshot(),
      lastVault: info.path,
      recentVaults: touchRecentVault(getConfigSnapshot().recentVaults ?? [], info.path),
    });
    await refreshTree();
    await reloadSnippetsFromVault();
    // The prefix of a symlinked path such as /tmp may change after
    // canonicalization, so just try to open it.
    // The "last file" is remembered per vault: switching away and back
    // lands on that vault's own note.
    const lastFile = getConfigSnapshot().lastFileByVault?.[info.path];
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

/**
 * Switch to the most recently opened vault: the first non-current vault in
 * the MRU (the current one is filtered out on read, so toggling between two
 * vaults works; without an open vault it falls back to the most recent one).
 * The switch reuses the current window — the whole openVault chain is the
 * vault-switch orchestration (the backend's set_vault replaces idempotently +
 * the watcher recycles itself, front-end caches keyed by vault are
 * invalidated). Leaving the old vault is finalized first, matching zed's
 * prepare_to_close save step: dirty files are written to disk and the
 * debounced cursor/config writes are flushed immediately, so a failed switch
 * leaves the old vault's state intact.
 */
export async function switchRecentVault(): Promise<void> {
  const store = useAppStore.getState();
  if (store.drawingSession) {
    store.showToast("画布还没收尾,先完成或取消画图再切仓库");
    return;
  }
  const target = recentVaultTarget(getConfigSnapshot().recentVaults ?? [], store.vaultPath);
  if (!target) {
    store.showToast("没有其他最近打开的仓库");
    return;
  }
  flushCursorSave();
  if (store.dirty && store.currentFile) await saveNote();
  // The lastFileByVault / recentFiles of the vault being left are written to
  // disk first: even if opening the new vault fails, the old vault's restore
  // point survives a restart.
  flushPersistConfig();
  await openVault(target);
}

export async function refreshTree(): Promise<void> {
  const { vaultPath, setTree, setFlatFiles, setFlatAssets, setFolders, tree } =
    useAppStore.getState();
  if (!vaultPath) return;
  try {
    const [root, index] = await Promise.all([api.readTree(), api.listFiles()]);
    setFlatFiles(index.files);
    setFlatAssets(index.assets);
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

export async function openNote(path: string, line?: number): Promise<void> {
  // A file switch while the canvas is open (quick switcher / command palette)
  // finalizes the canvas first: the drawn image is filled back into the
  // cursor position of the source note (Obsidian-style "a drawing is a file"
  // semantics), and only then does the switch happen.
  if (useAppStore.getState().drawingSession) {
    const { finalizeDrawingSession } = await import("@/app/drawing");
    await finalizeDrawingSession();
    if (useAppStore.getState().drawingSession) return; // the finalization is taken by a concurrent run: give up this switch
  }
  const store = useAppStore.getState();
  // JSON configuration files have their own editor. When the note editor is
  // unmounted (a JSON file is open), setting currentFile lets React mount it;
  // its own effect then calls openNote again with a live view. The project
  // view has no note editor at all, so it keeps the honest toast.
  if (isJsonPath(path) || !getView()) {
    if (store.mode === "projects") {
      store.showToast("项目视图没有笔记编辑器，先退出项目视图");
      return;
    }
    if (store.dirty) await saveNote();
    store.openFile(path);
    return;
  }
  const view = getView();
  if (!view) return;
  // The pending save still refers to the previously open doc — write it out
  // before the swap, then replay this note's remembered position.
  flushCursorSave();
  // Write this note's unsaved content to disk before leaving it: the
  // autosave is debounced by 800ms, and a switch right after it cancels the
  // timer along with its payload — by then currentFile has already changed,
  // so a late write could not land on this note any more. The write is
  // fired in parallel with the read, so it only costs one extra IPC when
  // there really is a change, and the total latency is the larger of the
  // two. This only holds while "the path of the file being left is still
  // valid": the write does create_dir_all + create, so writing to a path that
  // no longer exists would recreate the file — see renameEntry for the
  // rename case.
  const pendingSave = useAppStore.getState().dirty ? saveNote() : Promise.resolve();
  const content = await api.readFile(path);
  await pendingSave;
  // The editor may have been replaced while the file was being read
  // (entering study mode remounts EditorPane). Then the content must
  // neither be pushed into the destroyed view nor mark "loaded" for the new
  // instance — the new instance would skip the read and start from an empty
  // document. Let its own effect open this note.
  if (getView() !== view) return;
  loadDocument(view, content, path);
  loadedFile.current = path;
  useAppStore.getState().openFile(path);
  // setState() reset compartment values — re-apply current settings.
  await applySettingsToEditor(view);
  restoreSavedCursor(view, path);
  if (line !== undefined) {
    // The footprint / a jump landing on a line number: the cursor memory
    // (restoreSavedCursor) runs first, this overrides it.
    const doc = view.state.doc;
    const l = doc.line(Math.min(Math.max(1, line), doc.lines));
    view.dispatch({ selection: { anchor: l.from } });
    // Centering the scroll: writing scrollTop must go through requestMeasure
    // (the same convention as typewriter.ts), a direct write would compete
    // with CM's measurement cycle.
    view.requestMeasure({
      read: () => view.coordsAtPos(l.from),
      write: (coords) => {
        if (!coords) return;
        const scroller = view.scrollDOM;
        const rect = scroller.getBoundingClientRect();
        scroller.scrollTop = Math.max(0, scroller.scrollTop + (coords.top - rect.top) - scroller.clientHeight / 2);
      },
    });
  }
  view.focus();
}

/**
 * Save the document held by the focused editor.
 *
 * The target file is taken from `documentPath`, no longer from `currentFile`
 * alone: the editor focused in the project view holds
 * `.bnote/projects/<project>.md` while `currentFile` still points at the
 * previous note — writing by currentFile would overwrite the project
 * document into that note. The global dirty flag is only touched when the
 * saved file is exactly the current note (the project / journal editors have
 * their own autosave).
 */
export async function saveNote(): Promise<void> {
  const store = useAppStore.getState();
  const currentFile = store.currentFile;
  // The JSON editor owns `.json` files; its view is the one on screen while
  // the note editor is unmounted. Going through its save keeps ⌘S and the
  // debounced autosave on one serialized writer.
  if (currentFile && isJsonPath(currentFile)) {
    await saveJsonFile();
    return;
  }
  const view = getView();
  if (!view) return;
  const path = documentPath(view.state) ?? currentFile;
  if (!path) return;
  try {
    await api.writeFile(path, view.state.doc.toString());
    if (currentFile === path) useAppStore.getState().markDirty(false);
  } catch (e) {
    store.showToast(`保存失败: ${String(e)}`);
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
 *
 * `template` is a vault-relative template file chosen on the command: its
 * content becomes the new note's initial content (`{{date}}` / `{{title}}`
 * substituted). A missing/unreadable template never blocks creation — the
 * note is created empty and the user is told why.
 */
export async function quickAddNote(
  folder: string,
  name: string,
  template?: string | null,
): Promise<void> {
  const { vaultPath } = useAppStore.getState();
  if (!vaultPath) return;
  const base = name.replace(/\.(md|markdown|txt)$/i, "").trim();
  if (!base) return;
  const rel = folder.trim().replace(/^\/+|\/+$/g, "");
  const templateRel = normalizeTemplateDir(template ?? "");
  try {
    if (rel) await api.ensureDir(rel);
    const created = await api.createFile(rel, `${base}.md`);
    if (templateRel) {
      try {
        const text = await api.readFile(joinPath(vaultPath, templateRel));
        await api.writeFile(
          created.path,
          renderTemplate(text, { date: todayStamp(), title: base }),
        );
      } catch {
        useAppStore.getState().showToast("模板读取失败，已创建空文件");
      }
    }
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
    // The backend may dedup the name ("New Folder 2"), so the rename has to
    // watch the directory that was really created.
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
    // A file renamed without an extension keeps the original one (otherwise
    // the file disappears from the tree after the list_files filter).
    if (isFile && !name.includes(".")) {
      const oldName = fileName(path);
      const dot = oldName.lastIndexOf(".");
      if (dot > 0) name += oldName.slice(dot);
    }
    // A rename invalidates the current file's path. openNote's "write before
    // leaving" uses currentFile (still the old path at that moment), and the
    // write would recreate the now non-existent file — so while the path is
    // still valid, save this note's unsaved content first.
    if (
      currentFile &&
      (currentFile === path || currentFile.startsWith(`${path}/`)) &&
      useAppStore.getState().dirty
    ) {
      await saveNote();
    }
    const newPath = await api.renamePath(path, name);
    await refreshTree();
    if (currentFile === path) {
      await openNote(newPath);
    } else if (currentFile && currentFile.startsWith(`${path}/`)) {
      // The renamed entry is the (parent) directory of the current file:
      // reopen it under the new prefix.
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
      // The deleted entry may be the parent directory of the current file —
      // the prefix check covers both cases.
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
 * Follow an internal link (a click in the live preview / ⌘K to the link on
 * the current line): push one level onto the back chain and open the target.
 * Returns whether it really jumped — a missing target shows a toast, a
 * self-link stays silent (the caller decides about the focus).
 */
export function openWikiLink(target: string, from = useAppStore.getState().currentFile): boolean {
  const path = wikiLinkTargetPath(target);
  if (!path) {
    useAppStore.getState().showToast(`未找到笔记: ${target}`);
    return false;
  }
  // A self-link does not re-read from disk: openNote reloads the document,
  // which would lose the unsaved changes.
  if (path === from) return false;
  if (from) useAppStore.getState().pushLinkBack(from, path);
  void openNote(path);
  return true;
}

/** "Go back to the file before the link jump": walk one level back along the link jump chain; opening something outside the chain invalidates it. */
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

/** The document state when the link suggest panel was opened; it is compared before writing back, and the write is dropped when the document changed (another file, an external reload). */
let linkPickState: EditorState | null = null;

/**
 * The "insert / jump to internal link" shortcut: if the cursor's line
 * already has a link, jump to that note (there is one link per line, so
 * inserting another one on this line would be a duplicate); otherwise open
 * the suggest panel at the cursor — an empty input lists the recently opened
 * notes, and typing filters them with the same ordering as the quick
 * switcher.
 */
export function linkShortcut(view: EditorView): void {
  const { currentFile, linkSuggest, modal, showToast } = useAppStore.getState();
  if (modal) return; // the command palette / quick switcher / settings are open: do not steal the foreground, do nothing
  if (linkSuggest) {
    useAppStore.getState().closeLinkSuggest(); // pressing again = collapse
    return;
  }
  if (!currentFile) {
    showToast("先打开一篇笔记，再插入链接");
    return;
  }
  const target = wikilinkTargetOnLine(view);
  if (target) {
    if (!openWikiLink(target)) view.focus(); // the jump did not happen (not found / self-link): give the focus back to the editor
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

/** A note was picked in the suggest panel: write `[[link]]` at the cursor (it also proves the document was not replaced). */
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

/**
 * The single writer of the applied theme: the data-theme attribute on
 * documentElement (dark sets no attribute, :root defaults to dark). A copy is
 * written to localStorage for theme-boot.js to apply before React starts, so
 * light users do not see a dark flash on startup; the persistent truth is
 * still config.json.
 */
function applyTheme(theme: ThemeName): void {
  const root = document.documentElement;
  if (theme === "light") root.dataset.theme = "light";
  else delete root.dataset.theme;
  try {
    localStorage.setItem("bnote.theme", theme);
  } catch {
    // An unavailable localStorage only costs the anti-flash on the next
    // startup; the theme still applies
  }
}

/**
 * Applies store settings (vim, typewriter, live preview, snippets) to the editors.
 *
 * The project view holds several instances (the project cards / the journal
 * on the right), and a settings change has to reconfigure each of them:
 * applying it only to `getView()` would leave the unfocused one on the old
 * switches and make it "suddenly" change when it is focused again. `target`
 * is for the single instance that just swapped documents (after openNote
 * only that one is rebuilt).
 */
export async function applySettingsToEditor(target?: EditorView): Promise<void> {
  const { settings } = useAppStore.getState();
  document.documentElement.style.setProperty("--editor-font-size", `${settings.fontSize}px`);
  applyTheme(settings.theme);
  const views = target
    ? target.dom.isConnected
      ? [target]
      : []
    : activeEditors();
  if (views.length === 0) return;
  // Only flip the switch, never touch the source: resetting the source to
  // null would push the vault snippets back to the built-in ones on every
  // file open / settings change (a real regression, load.test.ts has a wiring
  // gate for it).
  applySnippetsEnabled(settings.snippets);
  configureLatexSuite(settings.latex);
  configureLivePreview({ mathPreview: settings.mathPreview });
  const mappings = settings.vim ? await loadVimrc().catch(() => []) : [];
  for (const view of views) {
    if (!view.dom.isConnected) continue;
    reconfigureLivePreview(view, settings.livePreview);
    reconfigureTypewriter(view, settings.typewriter);
    reconfigureVim(view, settings.vim, mappings);
  }
}

/**
 * Loads `<vault>/.bnote/snippets.js` when present, falling back to builtin.
 * Returns the outcome so callers can report honestly (settings save toast,
 * watcher toast) instead of claiming "it took effect" while the load actually
 * failed.
 */
export async function reloadSnippetsFromVault(): Promise<SnippetLoadOutcome | null> {
  const { vaultPath, settings } = useAppStore.getState();
  if (!vaultPath) return null;
  try {
    const src = await api.readVaultFile("snippets.js");
    return await snippetLoader.load(src, settings.snippets);
  } catch (e) {
    console.warn("[bnote] failed to load vault snippets.js", e);
    return await snippetLoader.load(null, settings.snippets);
  }
}
