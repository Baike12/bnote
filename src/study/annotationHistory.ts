/**
 * Undo/redo stack for annotation operations.
 *
 * It stores **snapshots of the whole annotation array** (both the array and
 * the annotation objects are modified immutably), so undoing a delete restores
 * the rectangles and texts exactly. The limit keeps a long editing session
 * from growing memory without bound. Whether text input collapses into a
 * single step is the caller's decision (see PdfViewer's textEditRef).
 */
export interface AnnotationHistory<T> {
  undo: T[];
  redo: T[];
  limit: number;
}

export function createAnnotationHistory<T>(limit = 100): AnnotationHistory<T> {
  return { undo: [], redo: [], limit };
}

/** Record the state before a change; a new change invalidates the redo stack. */
export function recordAnnotationHistory<T>(
  history: AnnotationHistory<T>,
  before: T,
): void {
  history.undo.push(before);
  if (history.undo.length > history.limit) history.undo.shift();
  history.redo.length = 0;
}

/** Return the previous state (the current state goes onto the redo stack); null when there is nothing to undo. */
export function undoAnnotationHistory<T>(
  history: AnnotationHistory<T>,
  current: T,
): T | null {
  if (history.undo.length === 0) return null;
  const previous = history.undo.pop() as T;
  history.redo.push(current);
  return previous;
}

/** Return the next state (the current state goes back onto the undo stack); null when there is nothing to redo. */
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
