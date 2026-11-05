import { api } from "@/lib/tauri";
import {
  DRAWING_FOLDER,
  drawingPngName,
  emptySceneJson,
  newDrawingFileName,
  parseDrawingFile,
  serializeDrawingFile,
  type DrawingScene,
} from "@/lib/excalidrawFile";
import { useAppStore, type DrawingSession } from "@/state/appStore";
import { getView } from "@/editor/api";
import { setDocPath, documentPath } from "@/editor/docPath";
import { fileName, joinPath } from "@/lib/path";

/**
 * Orchestration and save scheduling of the canvas session (module-level
 * state; the canvas component is only thin UI).
 *
 * The session semantics follow Obsidian: a drawing is also "a file" and ⌘D
 * opens the canvas on that file; only when returning to the source note via
 * the quick switcher (or ⌘↩) is the drawing inserted as a plain image embed
 * at the cursor position remembered for the source note — the insert happens
 * at the moment of coming back, not when the canvas is opened.
 *
 * Saving is the single writer: the writes are serialized (while one is in
 * flight only "there is more to save" is noted and a follow-up run is
 * scheduled afterwards), never concurrent; unchanged content (identical
 * serialization) is skipped.
 */

const SAVE_DEBOUNCE_MS = 600;

// ---- Module-level save scheduling (single writer) --------------------------

interface SceneSnapshot {
  elements: readonly unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown> | null;
}

const latest: { current: SceneSnapshot | null } = { current: null };
const mdWrapper: { current: string | null } = { current: null };
const lastWritten: { current: string | null } = { current: null };
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let rerunAfter = false;

const saveListeners = new Set<(busy: boolean) => void>();
function notifySave(busy: boolean) {
  for (const cb of saveListeners) cb(busy);
}

/** The canvas onChange entry point: it only writes the state and resets the debounce, so the drag path costs no rendering. */
export function beginDrawingSave(snap: SceneSnapshot): void {
  latest.current = snap;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void runDrawingSave();
  }, SAVE_DEBOUNCE_MS);
}

async function runDrawingSave(): Promise<void> {
  const session = useAppStore.getState().drawingSession;
  const snap = latest.current;
  if (!session || !snap) return;
  if (inFlight) {
    rerunAfter = true; // a write is in flight: run one more round afterwards, never write concurrently
    return;
  }
  const json = serializeDrawingFile(
    snap as unknown as DrawingScene,
    fileName(session.path),
    mdWrapper.current,
  );
  if (json === lastWritten.current) return;
  inFlight = true;
  notifySave(true);
  try {
    await api.writeFile(session.path, json);
    lastWritten.current = json;
    const count = (snap.elements as { isDeleted?: boolean }[]).filter((el) => !el.isDeleted).length;
    if (count > 0) await exportPng(snap, session.path);
  } catch (e) {
    lastWritten.current = null; // the write failed: the next one must rewrite
    useAppStore.getState().showToast(`画布保存失败: ${String(e)}`);
  } finally {
    inFlight = false;
    notifySave(false);
    if (rerunAfter) {
      rerunAfter = false;
      void runDrawingSave();
    }
  }
}

/** Write the changes that have not been persisted yet, right away (⌘S / page hidden / before the session is finalized). */
export async function flushDrawingSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (latest.current) await runDrawingSave();
}

/** Read the scene when the canvas opens and take over the md wrapper head (kept verbatim on write-back). */
export async function loadDrawingScene(path: string): Promise<DrawingScene> {
  const text = await api.readFile(path);
  const parsed = parseDrawingFile(text, fileName(path));
  mdWrapper.current = parsed.mdWrapper;
  latest.current = null;
  lastWritten.current = null;
  return parsed.scene;
}

export function subscribeDrawingSave(busy: (b: boolean) => void): () => void {
  saveListeners.add(busy);
  return () => saveListeners.delete(busy);
}

async function exportPng(snap: SceneSnapshot, drawingPath: string): Promise<void> {
  const { exportToBlob } = await import("@excalidraw/excalidraw");
  const opts = {
    elements: snap.elements,
    appState: { ...(snap.appState as object), exportBackground: true },
    files: snap.files ?? null,
    mimeType: "image/png",
    exportPadding: 32,
    getDimensions: (width: number, height: number) => ({
      width: width * 2,
      height: height * 2,
      scale: 2,
    }),
  } as unknown as Parameters<typeof exportToBlob>[0];
  const blob = await exportToBlob(opts);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  await api.writeFileBase64(drawingPngPath(drawingPath), dataUrl.slice(dataUrl.indexOf(",") + 1));
}

// ---- Session orchestration -------------------------------------------------

/** ⌘D: create a new drawing and open the canvas. The embed is inserted only at the moment of "coming back to the note" (see the module comment). */
export async function openNewDrawing(): Promise<void> {
  const store = useAppStore.getState();
  const view = getView();
  if (!store.vaultPath || !view || !store.currentFile) {
    store.showToast("先打开一篇笔记,再新建画图");
    return;
  }
  if (store.drawingSession) return; // the canvas is already open: ⌘D is excalidraw's duplicate, ignore it
  try {
    await api.ensureDir(DRAWING_FOLDER);
    const created = await api.createFile(DRAWING_FOLDER, newDrawingFileName());
    await api.writeFile(created.path, emptySceneJson());
    useAppStore.getState().openDrawingSession({
      path: created.path,
      isNew: true,
      originNote: store.currentFile,
      originPos: view.state.selection.main.head,
    });
  } catch (e) {
    useAppStore.getState().showToast(`新建画图失败: ${String(e)}`);
  }
}

/** Click a drawing embed rendered in a note: open the canvas to edit that file (the embed already exists, nothing to fill back). */
export function openDrawingFile(path: string): void {
  const store = useAppStore.getState();
  if (store.drawingSession) return;
  store.openDrawingSession({
    path,
    isNew: false,
    originNote: store.currentFile,
    originPos: null,
  });
}

/**
 * Finalize a canvas session (switching files / ⌘↩ / the "finish drawing"
 * command all end up here): flush the disk → fill the drawn image back in
 * as an embed at the cursor position remembered for the source note and save
 * it → delete the file of an empty drawing → refresh the asset index. The
 * canvas component unmounts before this function runs (the session is closed
 * first and the component disappears with it).
 */
export async function finalizeDrawingSession(): Promise<void> {
  const store = useAppStore.getState();
  const session = store.drawingSession;
  if (!session) return;
  store.closeDrawingSession();
  await flushDrawingSave();

  const els = (latest.current?.elements ?? []) as { isDeleted?: boolean }[];
  const empty = els.every((el) => el.isDeleted);

  try {
    if (session.isNew && empty) {
      await api.trashPath(session.path).catch(() => {});
    } else if (session.isNew && !empty) {
      insertEmbedAt(session);
      // Write to disk right away: the switch that follows (for example the
      // quick switcher back to the source note) re-reads from disk, and
      // without this write the freshly inserted embed would be overwritten by
      // the old content.
      const { saveNote } = await import("@/app/actions");
      await saveNote();
    }
  } finally {
    // The newly exported PNG has to enter the asset index; the watcher also
    // triggers a refresh, but refreshing here lets the decoration resolve it
    // immediately instead of waiting for the watcher's 300ms batch.
    await refreshAssetsAndDecos(session);
  }
}

/** The embed is only filled back when the source note is still open and the position is still valid; if the document was replaced the fill is dropped (no blind write). */
function insertEmbedAt(session: DrawingSession): void {
  const view = getView();
  const store = useAppStore.getState();
  if (!view || !session.originNote || session.originPos === null) return;
  if (store.currentFile !== session.originNote) return;
  if (documentPath(view.state) !== session.originNote) return;
  const doc = view.state.doc;
  const pos = Math.min(session.originPos, doc.length);
  const line = doc.lineAt(pos);
  const prefix = pos > line.from ? "\n" : "";
  const embed = `![[${fileName(session.path)}]]`;
  view.dispatch({
    changes: { from: pos, insert: `${prefix}${embed}\n` },
    // The cursor lands on the line after the embed: the live preview keeps
    // the source text on the cursor's line, and without moving away you
    // would see the raw text instead of the rendered image.
    selection: { anchor: pos + prefix.length + embed.length + 1 },
  });
}

async function refreshAssetsAndDecos(session: DrawingSession): Promise<void> {
  const { refreshTree } = await import("@/app/actions");
  await refreshTree();
  const view = getView();
  const store = useAppStore.getState();
  if (view && session.originNote && session.originNote === store.currentFile) {
    // The same-value effect transaction does not change the document, it
    // only makes the live preview rebuild its decorations — the PNG appears
    // only after the canvas is saved, so the <img> of the embed line needs
    // this chance to resolve again.
    view.dispatch({ effects: setDocPath.of(documentPath(view.state)) });
  }
  view?.focus();
}

/** The absolute path of the preview PNG next to the drawing file. */
export function drawingPngPath(drawingPath: string): string {
  const dir = drawingPath.includes("/") ? drawingPath.slice(0, drawingPath.lastIndexOf("/")) : "";
  const png = drawingPngName(fileName(drawingPath));
  return dir ? joinPath(dir, png) : png;
}
