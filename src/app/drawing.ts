import { api } from "@/lib/tauri";
import {
  DRAWING_FOLDER,
  drawingPngName,
  emptySceneJson,
  newDrawingFileName,
} from "@/lib/excalidrawFile";
import { useAppStore, type DrawingSession } from "@/state/appStore";
import { getView } from "@/editor/api";
import { setDocPath, documentPath } from "@/editor/docPath";
import { fileName, joinPath } from "@/lib/path";

/**
 * 画布会话的编排(新建→嵌入→打开 / 编辑已有 / 关闭收尾)。
 *
 * 流程对齐 Obsidian excalidraw 插件的 `autocreate-and-embed`:嵌入链接在打开
 * 画布**之前**就写进笔记——画布中途崩溃/直接关窗,笔记里也已经有了入口,
 * 不存在「画了但没插上」的中间态。空图关闭时再把嵌入和文件撤掉。
 */

/** ⌘D:新建画图,嵌入当前笔记光标处,打开画布。 */
export async function openNewDrawing(): Promise<void> {
  const store = useAppStore.getState();
  const view = getView();
  if (!store.vaultPath || !view || !store.currentFile) {
    store.showToast("先打开一篇笔记,再新建画图");
    return;
  }
  if (store.drawingSession) return; // 画布已开着:忽略重复触发
  try {
    await api.ensureDir(DRAWING_FOLDER);
    const created = await api.createFile(DRAWING_FOLDER, newDrawingFileName());
    await api.writeFile(created.path, emptySceneJson());
    const name = fileName(created.relPath);
    const range = insertEmbedAtCursor(view, name);
    useAppStore.getState().openDrawingSession({
      path: created.path,
      isNew: true,
      notePath: useAppStore.getState().currentFile,
      embedRange: range,
    });
  } catch (e) {
    useAppStore.getState().showToast(`新建画图失败: ${String(e)}`);
  }
}

/** 点击笔记里渲染出的画图嵌入:打开画布编辑那个文件。 */
export function openDrawingFile(path: string): void {
  const store = useAppStore.getState();
  if (store.drawingSession) return;
  store.openDrawingSession({
    path,
    isNew: false,
    notePath: null,
    embedRange: null,
  });
}

/**
 * 画布关闭后的收尾(画布自己保证最终状态已落盘才调用):
 * 空的新图 → 撤掉嵌入、删文件;否则刷新资产索引让 PNG 可解析,
 * 并轻推一次装饰重建,让刚导出的预览图立刻渲染出来。
 */
export async function afterDrawingClosed(
  session: DrawingSession,
  sceneEmpty: boolean,
): Promise<void> {
  useAppStore.getState().closeDrawingSession();
  if (session.isNew && sceneEmpty && session.notePath && session.embedRange) {
    removeEmbed(session.notePath, session.embedRange, session.path);
    await api.trashPath(session.path).catch(() => {});
  }
  // 新导出的 PNG 要进资产索引;外部写入本来就会触发 watcher → refreshTree,
  // 这里主动刷一次是为了让装饰立刻能解析到,不等 watcher 的 300ms 批处理。
  await refreshAssetsAndDecos(session);
}

async function refreshAssetsAndDecos(session: DrawingSession): Promise<void> {
  const { refreshTree } = await import("@/app/actions");
  await refreshTree();
  const view = getView();
  const store = useAppStore.getState();
  if (view && session.notePath && session.notePath === store.currentFile) {
    // 同值 effect 事务不改文档,只让 livePreview 重建装饰——
    // PNG 是画布保存后才出现的,嵌入行的 <img> 需要这次机会重新解析。
    view.dispatch({ effects: setDocPath.of(documentPath(view.state)) });
  }
  view?.focus();
}

/** 光标处插入一行 `![[name]]`,返回插入范围(撤掉空图时用)。
 *  光标落在嵌入的下一行:live preview 对光标所在行保持源码,不挪开的话
 *  关掉画布看到的是原文而不是渲染出的图。 */
function insertEmbedAtCursor(
  view: NonNullable<ReturnType<typeof getView>>,
  name: string,
): { from: number; to: number } {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const prefix = pos > line.from ? "\n" : "";
  const embed = `![[${name}]]`;
  const insert = `${prefix}${embed}\n`;
  view.dispatch({
    changes: { from: pos, insert },
    selection: { anchor: pos + insert.length },
  });
  return { from: pos + prefix.length, to: pos + prefix.length + embed.length };
}

/** 撤掉空图的嵌入行。范围对不上(用户动过笔记)就不碰文档。 */
function removeEmbed(notePath: string, range: { from: number; to: number }, drawingPath: string) {
  const view = getView();
  const store = useAppStore.getState();
  if (!view || store.currentFile !== notePath) return;
  const doc = view.state.doc;
  if (range.to > doc.length) return;
  const expected = `![[${fileName(drawingPath)}]]`;
  if (doc.sliceString(range.from, range.to) !== expected) return;
  const line = doc.lineAt(range.from);
  if (line.text !== expected) return; // 同行还有别的内容:保守起见整体不动
  const to = line.to < doc.length ? line.to + 1 : line.to; // 连同行尾换行
  view.dispatch({ changes: { from: line.from, to } });
}

/** 画图文件旁边那张预览 PNG 的绝对路径。 */
export function drawingPngPath(drawingPath: string): string {
  const dir = drawingPath.includes("/") ? drawingPath.slice(0, drawingPath.lastIndexOf("/")) : "";
  const png = drawingPngName(fileName(drawingPath));
  return dir ? joinPath(dir, png) : png;
}
