import type { EditorView } from "@codemirror/view";

/**
 * 代码编辑器的实例登记处。
 *
 * 命令层(跳转到定义、跳转到引用、保存…)永远只该作用于**用户正在用的那个**
 * 代码编辑器,所以这里记一份「当前聚焦的实例 + 它对应的文件」。
 *
 * 与笔记编辑器的登记处(`src/editor/api.ts`)是分开的两个:笔记区与代码区
 * 是两个独立的编辑上下文,各自的命令各自找各自的目标。
 */

/** 一个代码编辑器实例的上下文。 */
export interface CodeEditorHandle {
  /** 项目根绝对路径。 */
  root: string;
  /** 项目相对路径。 */
  path: string;
  /** languageId(后端按扩展名判定)。 */
  language: string;
  view: EditorView;
}

const live = new Set<CodeEditorHandle>();

let active: CodeEditorHandle | null = null;

/** 新实例挂上;同时成为活动编辑器。 */
export function registerCodeEditor(handle: CodeEditorHandle): void {
  live.add(handle);
  active = handle;
}

export function unregisterCodeEditor(handle: CodeEditorHandle): void {
  live.delete(handle);
  if (active === handle) {
    active = null;
    // 退到还活着的那个(多标签时关掉当前页,焦点不该整个丢掉)。
    for (const h of live) {
      if (h.view.dom.isConnected) {
        active = h;
        break;
      }
    }
  }
}

/** 焦点进入某个实例时调用,把命令目标切到它。 */
export function setActiveCodeEditor(handle: CodeEditorHandle | null): void {
  if (!handle) return;
  if (live.has(handle)) active = handle;
}

/** 某个视图对应的句柄(诊断这类按视图跑的逻辑用它,别用「当前聚焦的」——
 *  那依赖焦点,焦点不在编辑器上时会取错文件)。 */
export function handleForView(view: EditorView): CodeEditorHandle | null {
  for (const h of live) {
    if (h.view === view) return h;
  }
  return null;
}

/** 当前聚焦的代码编辑器;没有就 null。 */
export function activeCodeEditor(): CodeEditorHandle | null {
  if (active && live.has(active) && active.view.dom.isConnected) return active;
  for (const h of live) {
    if (h.view.dom.isConnected) return h;
  }
  return null;
}

/** 全部活着的实例。 */
export function activeCodeEditors(): CodeEditorHandle[] {
  return [...live].filter((h) => h.view.dom.isConnected);
}
