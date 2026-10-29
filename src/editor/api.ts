import type { EditorView } from "@codemirror/view";
import { documentPath } from "./docPath";

/**
 * 编辑器实例登记处。
 *
 * 学习模式与项目管理视图里同时存在两个编辑器(中栏内容 / 右栏笔记,或项目
 * 卡片 / 日记),而命令层(edit.*、保存、vim 映射)永远只该作用于**用户正在
 * 用的那一个**。所以这里有两层:
 *
 *  - `live`:全部活着的实例(setState 换文档不影响,实例本身不变),设置变更
 *    要逐个应用(reconfigureVim/livePreview 都是按 view 的)。
 *  - `editorApi.view`:最近取得焦点的实例,`getView()` 读它——命令语义与单
 *    编辑器时代一致,只是「那个编辑器」变成了「聚焦的那个」。
 */
export const editorApi: { view: EditorView | null } = {
  view: null,
};

const live = new Set<EditorView>();

/** 新实例挂上;同时成为活动编辑器(新挂的实例就是用户刚看到的那个)。 */
export function registerEditorView(view: EditorView): void {
  live.add(view);
  editorApi.view = view;
}

export function unregisterEditorView(view: EditorView): void {
  live.delete(view);
  if (editorApi.view === view) editorApi.view = null;
}

/** 全部已连接(还在 DOM 里)的实例;设置变更逐个应用。 */
export function activeEditors(): EditorView[] {
  return [...live].filter((v) => v.dom.isConnected);
}

/** 焦点进入某个实例时调用,把命令目标切到它。 */
export function setActiveEditor(view: EditorView): void {
  if (live.has(view)) editorApi.view = view;
}

/** 装了某个文件的实例(写日记前要就地改内存时用)。 */
export function findEditorFor(path: string): EditorView | null {
  for (const v of activeEditors()) {
    if (documentPath(v.state) === path) return v;
  }
  return null;
}

export function getView(): EditorView | null {
  return editorApi.view;
}

/**
 * 把焦点交给编辑器,但**不让浏览器滚动它的祖先**。
 *
 * 项目看板的横向位置由布局自己管(`--board-edge-pad` + 居中滚动);一次普通的
 * `view.focus()` 会让浏览器把编辑器滚进视口,把刚算好的居中位置顶掉(实测
 * scrollLeft 从 0 跳到 237)。焦点只该改焦点,不该改滚动。
 */
export function focusEditor(view: EditorView | null): void {
  view?.contentDOM.focus({ preventScroll: true });
}
