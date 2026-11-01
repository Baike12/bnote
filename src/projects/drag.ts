import { RangeSet, type Extension, type Range } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import { documentPath } from "@/editor/docPath";
import { isTodo, parseListLine } from "@/daily/model";

/**
 * Drag source of the todos on a project card.
 *
 * It uses a drag handle in the left gutter instead of making the whole `.cm-line`
 * draggable: the latter would steal the mouse drag for selecting text (holding and
 * dragging turns into an HTML5 drag), which is unacceptable for the feel outside
 * of vim. The handle is real DOM (a CM gutter marker) and only writes the source
 * path and the line number into the dataTransfer on dragstart; the drop target is
 * the daily note editor (see the drop handling of DailyNotePane).
 */

export const TODO_DRAG_MIME = "application/x-bnote-todo";

export interface TodoDragPayload {
  srcPath: string;
  line: number;
}

export function encodeTodoDrag(p: TodoDragPayload): string {
  return JSON.stringify(p);
}

export function decodeTodoDrag(raw: string): TodoDragPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<TodoDragPayload>;
    if (typeof parsed.srcPath !== "string" || typeof parsed.line !== "number") return null;
    if (!parsed.srcPath || !Number.isFinite(parsed.line) || parsed.line < 1) return null;
    return { srcPath: parsed.srcPath, line: Math.floor(parsed.line) };
  } catch {
    return null;
  }
}

const markersByView = new WeakMap<EditorView, Map<number, TodoDragMarker>>();

class TodoDragMarker extends GutterMarker {
  constructor(readonly line: number) {
    super();
  }

  eq(other: TodoDragMarker): boolean {
    return other.line === this.line;
  }

  toDOM(): Node {
    const handle = document.createElement("span");
    handle.className = "cm-project-drag-handle";
    handle.textContent = "⠿";
    handle.draggable = true;
    handle.title = "拖到右侧日记,或按发送快捷键";
    handle.addEventListener("dragstart", (event) => {
      const view = viewOfMarker(this);
      if (!view) return;
      const path = documentPath(view.state);
      if (!path) return;
      const dt = (event as DragEvent).dataTransfer;
      if (!dt) return;
      dt.effectAllowed = "copy";
      dt.setData(TODO_DRAG_MIME, encodeTodoDrag({ srcPath: path, line: this.line }));
      dt.setData("text/plain", view.state.doc.line(this.line).text);
    });
    return handle;
  }
}

/** marker -> the view it belongs to; the drag reads the current document (the path and the line text). */
const owner = new WeakMap<TodoDragMarker, EditorView>();

function viewOfMarker(marker: TodoDragMarker): EditorView | null {
  return owner.get(marker) ?? null;
}

function markersFor(view: EditorView): Map<number, TodoDragMarker> {
  let map = markersByView.get(view);
  if (!map) {
    map = new Map();
    markersByView.set(view, map);
  }
  return map;
}

function buildMarkers(view: EditorView): RangeSet<GutterMarker> {
  const doc = view.state.doc;
  if (view.visibleRanges.length === 0) return RangeSet.of([]);
  const from = Math.min(...view.visibleRanges.map((r) => r.from));
  const to = Math.max(...view.visibleRanges.map((r) => r.to));
  const ranges: Range<GutterMarker>[] = [];
  const map = markersFor(view);
  for (let n = doc.lineAt(from).number; ; n++) {
    const line = doc.line(n);
    if (isTodo(parseListLine(line.text))) {
      let marker = map.get(n);
      if (!marker) {
        marker = new TodoDragMarker(n);
        owner.set(marker, view);
        map.set(n, marker);
      }
      ranges.push(marker.range(line.from));
    }
    if (line.to >= to || line.to >= doc.length) break;
  }
  return RangeSet.of(ranges, true);
}

/** Editor extension of a project card: a column of todo drag handles on the left. */
export function projectTodoDragExtension(): Extension {
  return gutter({
    class: "cm-project-drag-gutter",
    markers: (view) => buildMarkers(view),
  });
}
