import { RangeSet, type Extension, type Range } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import { documentPath } from "@/editor/docPath";
import { isTodo, parseListLine } from "@/daily/model";

/**
 * 项目卡片的待办拖拽源。
 *
 * 用左侧 gutter 的拖拽手柄,而不是把整行 `.cm-line` 设成 draggable:后者会
 * 抢掉鼠标拖选文本(按住拖动变成 HTML5 拖拽),在 vim 之外的手感上不可接受。
 * 手柄是真实 DOM(CM 的 gutter marker),dragstart 时才把源路径与行号写进
 * dataTransfer;落点是日记编辑器(见 DailyNotePane 的 drop 处理)。
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

/** marker → 所属视图;拖拽时要读当前文档(路径与行文本)。 */
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

/** 项目卡片的编辑器扩展:左侧一列待办拖拽手柄。 */
export function projectTodoDragExtension(): Extension {
  return gutter({
    class: "cm-project-drag-gutter",
    markers: (view) => buildMarkers(view),
  });
}
