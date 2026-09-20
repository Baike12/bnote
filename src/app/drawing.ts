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
 * 画布会话的编排与保存调度(模块级状态,画布组件只是薄 UI)。
 *
 * 会话语义对齐 Obsidian:画图也是一个「文件」,⌘D 相当于在这个文件上打开
 * 画布;通过快速跳转(或 ⌘↩)回到来源笔记时,刚画的图才作为普通图片嵌入
 * 插回到来源笔记记住的光标位置——插入动作发生在「回来」那一刻,而不是
 * 打开画布时。
 *
 * 保存是唯一写入者:串行化调度(in-flight 时只记「还要再存」,完成后补),
 * 不并发写盘;内容没变(序列化相等)直接跳过。
 */

const SAVE_DEBOUNCE_MS = 600;

// ---- 模块级保存调度(单一写入者) ------------------------------------------

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

/** 画布 onChange 入口:只写状态 + 重置防抖,拖拽路径零渲染开销。 */
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
    rerunAfter = true; // 正在写盘:完成后补一轮,绝不并发写
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
    const count = (snap.elements as { isDeleted?: boolean }[]).filter(
      (el) => !el.isDeleted,
    ).length;
    if (count > 0) await exportPng(snap, session.path);
  } catch (e) {
    lastWritten.current = null; // 写失败:下次必须重写
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

/** 把未落盘的改动立刻写掉(⌘S / 页面隐藏 / 会话收尾前)。 */
export async function flushDrawingSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (latest.current) await runDrawingSave();
}

/** 画布打开时读入场景,并接管 md 包裹头(写回时原样保留)。 */
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

// ---- 会话编排 --------------------------------------------------------------

/** ⌘D:新建画图并打开画布。嵌入要等「回到笔记」那一刻才插入(见模块注释)。 */
export async function openNewDrawing(): Promise<void> {
  const store = useAppStore.getState();
  const view = getView();
  if (!store.vaultPath || !view || !store.currentFile) {
    store.showToast("先打开一篇笔记,再新建画图");
    return;
  }
  if (store.drawingSession) return; // 画布已开着:⌘D 是 excalidraw 的复制,忽略
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

/** 点击笔记里渲染出的画图嵌入:打开画布编辑那个文件(嵌入已存在,无需回填)。 */
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
 * 收尾一次画布会话(切换文件 / ⌘↩ / 完成画图命令都会走到这里):
 * 冲盘 → 画过的图按来源笔记记住的光标位置回填嵌入并落盘 → 空图删文件 →
 * 刷新资产索引。画布组件先于本函数卸载(会话先关,组件随之消失)。
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
      // 立刻落盘:紧随其后的切换(比如快速跳转回来源笔记)会从磁盘重读,
      // 不落盘的话刚插入的嵌入会被旧内容覆盖掉。
      const { saveNote } = await import("@/app/actions");
      await saveNote();
    }
  } finally {
    // 新导出的 PNG 要进资产索引;watcher 也会触发刷新,这里主动刷是为了让
    // 装饰立刻能解析到,不等 watcher 的 300ms 批处理。
    await refreshAssetsAndDecos(session);
  }
}

/** 来源笔记还开着且位置有效才回填;文档被换过就放弃(不盲写)。 */
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
    // 光标落到嵌入的下一行:live preview 对光标所在行保持源码,不挪开的话
    // 看到的是原文而不是渲染出的图。
    selection: { anchor: pos + prefix.length + embed.length + 1 },
  });
}

async function refreshAssetsAndDecos(session: DrawingSession): Promise<void> {
  const { refreshTree } = await import("@/app/actions");
  await refreshTree();
  const view = getView();
  const store = useAppStore.getState();
  if (view && session.originNote && session.originNote === store.currentFile) {
    // 同值 effect 事务不改文档,只让 livePreview 重建装饰——
    // PNG 是画布保存后才出现的,嵌入行的 <img> 需要这次机会重新解析。
    view.dispatch({ effects: setDocPath.of(documentPath(view.state)) });
  }
  view?.focus();
}

/** 画图文件旁边那张预览 PNG 的绝对路径。 */
export function drawingPngPath(drawingPath: string): string {
  const dir = drawingPath.includes("/") ? drawingPath.slice(0, drawingPath.lastIndexOf("/")) : "";
  const png = drawingPngName(fileName(drawingPath));
  return dir ? joinPath(dir, png) : png;
}
