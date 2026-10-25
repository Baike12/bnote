import type { EditorView } from "@codemirror/view";
import { getConfigSnapshot, rememberCursorPosition } from "@/state/appStore";

/**
 * Remember-cursor-position: records where the user left off in each note
 * (cursor offset + scroll top) and replays it when the note reopens. Saves
 * are debounced while editing; openNote() flushes before switching away so a
 * quick file switch never loses the last position.
 */

const SAVE_DELAY = 300;

let timer: ReturnType<typeof setTimeout> | null = null;
/**
 * `doc` 是排队时的文档引用:saveNow 触发时用它自证「还是针对这份文档」。
 * openNote 换文档的窗口里,事件带着旧文件的路径排队、落笔时文档已经换成
 * 新的——不比对就把新文档的位置写进旧路径,等于污染另一个文件的记忆。
 */
let pending: { path: string; view: EditorView; doc: object } | null = null;

function saveNow() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const p = pending;
  pending = null;
  if (!p) return;
  if (p.view.state.doc !== p.doc) return;
  const pos = p.view.state.selection.main.head;
  const scroll = Math.round(p.view.scrollDOM.scrollTop);
  rememberCursorPosition(p.path, pos, scroll);
}

/** Debounced save of the current position in `path`. */
export function scheduleCursorSave(path: string, view: EditorView) {
  pending = { path, view, doc: view.state.doc };
  if (timer) clearTimeout(timer);
  timer = setTimeout(saveNow, SAVE_DELAY);
}

/**
 * 纯滚动也计入「读到哪了」。滚轮/触摸板滚动只是 scrollDOM 的 DOM 滚动,
 * 不产生任何 CodeMirror 事务,只在 selectionSet/docChanged 上挂保存会把
 * 「只读不写」的整个阅读过程漏掉——这正是「阅读位置失效」的根因。
 * scroll 事件走同一条防抖保存:连续滚动的每帧只是重挂定时器(O(1),不读
 * 布局),滚动停下 300ms 后才真正读一次位置落盘。返回卸载函数。
 */
export function observeScrollSave(
  view: EditorView,
  getPath: () => string | null,
): () => void {
  const onScroll = () => {
    const path = getPath();
    if (path) scheduleCursorSave(path, view);
  };
  view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
  return () => view.scrollDOM.removeEventListener("scroll", onScroll);
}

/** Save immediately (file switch, window blur, editor teardown). */
export function flushCursorSave() {
  saveNow();
}

/** True while a debounced save has not been written yet (flush before quit). */
export function hasPendingCursorSave() {
  return pending !== null;
}

/** Re-applies the remembered position/scroll for `path`, if any. */
export function restoreSavedCursor(view: EditorView, path: string) {
  const saved = getConfigSnapshot().cursorPositions?.[path];
  if (!saved) return;
  const pos = Math.min(saved.pos, view.state.doc.length);
  view.dispatch({ selection: { anchor: pos } });
  // scrollTop 必须在 CM 测量周期的 write 阶段写(typewriter.ts / openNote
  // 的行号跳转同一约定)。loadDocument 的 setState 之后高度表还是估算值,
  // 直写落在估算坐标系里;紧随的第一次 measure 把高度修正成真实值时,CM
  // 的滚动锚定补偿会把位置再挪一段估算误差(恢复点越深误差越大)。滚动
  // 保存(scroll 事件)会把这段补偿当成阅读位置记下,每重开一次就往下漂
  // 一段(实测棘轮:1000→1369→1921→…)。requestMeasure 的 write 在真实
  // 几何确立之后执行,补偿项≈0,恢复落点即保存值。
  view.requestMeasure({
    read: () => null,
    write: () => {
      const dom = view.scrollDOM;
      dom.scrollTop = Math.max(0, Math.min(saved.scroll, dom.scrollHeight));
    },
  });
}
