/**
 * 批注操作的撤销/重做栈。
 *
 * 存的是**整份批注数组的快照**(数组与批注对象都不可变修改),所以撤销
 * 一次删除能原样恢复矩形与文字。上限防止长时间编辑把内存越攒越大。
 * 文字输入是否合并成一步由调用方决定(见 PdfViewer 的 textEditRef)。
 */
export interface AnnotationHistory<T> {
  undo: T[];
  redo: T[];
  limit: number;
}

export function createAnnotationHistory<T>(limit = 100): AnnotationHistory<T> {
  return { undo: [], redo: [], limit };
}

/** 记录改动前的状态;新改动让重做栈失效。 */
export function recordAnnotationHistory<T>(
  history: AnnotationHistory<T>,
  before: T,
): void {
  history.undo.push(before);
  if (history.undo.length > history.limit) history.undo.shift();
  history.redo.length = 0;
}

/** 返回上一份状态(当前状态进重做栈);没有可撤销的返回 null。 */
export function undoAnnotationHistory<T>(
  history: AnnotationHistory<T>,
  current: T,
): T | null {
  if (history.undo.length === 0) return null;
  const previous = history.undo.pop() as T;
  history.redo.push(current);
  return previous;
}

/** 返回下一份状态(当前状态回撤销栈);没有可重做的返回 null。 */
export function redoAnnotationHistory<T>(
  history: AnnotationHistory<T>,
  current: T,
): T | null {
  if (history.redo.length === 0) return null;
  const next = history.redo.pop() as T;
  history.undo.push(current);
  return next;
}

export function resetAnnotationHistory<T>(history: AnnotationHistory<T>): void {
  history.undo.length = 0;
  history.redo.length = 0;
}
