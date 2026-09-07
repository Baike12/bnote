import { EditorSelection } from "@codemirror/state";
import type { EditorState, Line, SelectionRange } from "@codemirror/state";
import type { Decoration, EditorView } from "@codemirror/view";
import { mathRegions } from "./context";
import { blockDecorationsField } from "./livePreview";

/**
 * CM6 resolves vertical cursor motion from pixel coordinates, and its scan
 * explicitly skips non-text blocks — so a single j/k or arrow press leaps
 * clean over a collapsed display-math widget (the rendered formula) to the
 * line beyond it. Lines outside the viewport (not currently drawn) get
 * skipped the same way. Patching up results after the fact cannot catch
 * every case, so the motion itself is intercepted per view.
 *
 * An empty-range single-step motion (no explicit pixel distance) whose
 * result spans two or more document lines is re-derived by walking from the
 * start line toward the result: lines hidden under a block replace
 * decoration (collapsed fences, hr, math widgets) are not steps, and the
 * near edge of a display-math region — its opening `$$` coming from above,
 * closing `$$` from below — is the landing point that opens the formula.
 * Counts (5j) clamp per step, so they walk into the block instead of flying
 * past it. Page-style jumps pass an explicit distance and are left alone,
 * as are visual-mode selections and horizontal motions.
 */
export function installMathMotionClamp(view: EditorView): void {
  const original = view.moveVertically;
  Object.defineProperty(view, "moveVertically", {
    value: (start: SelectionRange, forward: boolean, distance?: number): SelectionRange =>
      relineVerticalStep(view, start, original.call(view, start, forward, distance), distance),
    writable: true,
    configurable: true,
  });
}

function relineVerticalStep(
  view: EditorView,
  start: SelectionRange,
  result: SelectionRange,
  distance: number | undefined,
): SelectionRange {
  if (distance !== undefined || !start.empty || !result.empty) return result;
  const state = view.state;
  const doc = state.doc;
  const startLineNo = doc.lineAt(start.head).number;
  const endLineNo = doc.lineAt(result.head).number;
  const step = endLineNo - startLineNo;
  if (step >= -1 && step <= 1) return result;

  const down = step > 1;
  const { isHiddenStep, isMathEdge } = analyze(state, startLineNo, down);

  let target: Line | null = null;
  for (let n = startLineNo + (down ? 1 : -1); down ? n <= endLineNo : n >= endLineNo; n += down ? 1 : -1) {
    const line = doc.line(n);
    if (isMathEdge(n) || !isHiddenStep(line)) {
      target = line;
      break;
    }
  }
  if (target === null) return result;

  const goal =
    result.goalColumn !== undefined && result.goalColumn >= 0
      ? result.goalColumn
      : pixelGoalOf(view, start.head);
  return EditorSelection.cursor(
    target.from + columnOnLine(view, target, goal),
    result.assoc,
    undefined,
    result.goalColumn,
  );
}

function pixelGoalOf(view: EditorView, pos: number): number {
  const rect = view.coordsAtPos(pos);
  if (!rect) return 0;
  return rect.left - view.contentDOM.getBoundingClientRect().left;
}

/** Column under a pixel goal on `line`: precise when the line is drawn,
 *  estimated from average character width when it is off-screen (the motion
 *  is about to scroll it into view anyway). */
function columnOnLine(view: EditorView, line: Line, goal: number): number {
  const rect = view.coordsAtPos(line.from);
  if (rect) {
    const x = view.contentDOM.getBoundingClientRect().left + goal;
    const pos = view.posAtCoords({ x, y: rect.top + 1 }, false);
    if (pos !== null) {
      const l = view.state.doc.lineAt(pos);
      if (l.number === line.number) return pos - l.from;
    }
  }
  return Math.min(line.length, Math.max(0, Math.round(goal / view.defaultCharacterWidth)));
}

function analyze(state: EditorState, startLineNo: number, down: boolean): {
  isHiddenStep: (line: Line) => boolean;
  isMathEdge: (lineNo: number) => boolean;
} {
  const doc = state.doc;
  const field = state.field(blockDecorationsField, false);

  // Multi-line display regions, as [openLineNo, closeLineNo].
  const regions: [number, number][] = [];
  for (const region of mathRegions(state)) {
    if (!region.display) continue;
    const openNo = doc.lineAt(region.from).number;
    const closeNo = doc.lineAt(Math.max(region.from, region.to - 1)).number;
    if (openNo !== closeNo) regions.push([openNo, closeNo]);
  }

  // The cursor sitting inside a region means the region is being edited —
  // its source is (about to be) drawn, so its lines are plain steps. This
  // also keeps multi-step counts (5j) walking through the source exactly,
  // even though the collapsed widget still lingers in this frame's field.
  const active = regions.find(([o, c]) => o <= startLineNo && startLineNo <= c);

  const isHiddenStep = (line: Line): boolean => {
    if (active && active[0] <= line.number && line.number <= active[1]) return false;
    if (!field) return false;
    let covered = false;
    field.decos.between(line.from, line.to, (from, to, deco) => {
      // `block` exists at runtime but is only typed on the spec.
      if ((deco as Decoration & { block?: boolean }).block && from <= line.from && to >= line.to) {
        covered = true;
      }
    });
    return covered;
  };

  // Near edges of still-collapsed regions, in the walk's direction.
  const edges = new Set<number>();
  for (const [o, c] of regions) {
    if (active && active[0] === o) continue;
    edges.add(down ? o : c);
  }
  return { isHiddenStep, isMathEdge: (n) => edges.has(n) };
}
