import type { EditorView } from "@codemirror/view";
import { columnOnLine, pixelGoalOf, visibleVerticalTarget } from "@/editor/motionClamp";

/* ---- Visually anchored vertical motion: the landing point of j/k/+/-/_ follows the eye ----

   The engine's moveByLines decides the horizontal landing point from the
   "document character column" (vim.lastHPos). That coordinate has no visual
   meaning in live preview: list indentation spaces, `- `, `[ ]`, the heading
   `#` and emphasis markers are hidden by decorations (zero width), so the same
   character column lands at a different visual position on each line — with a
   fixed column intent the caret jumps sideways line by line (measured ±25-63px)
   and it can also step into a list marker slot, flipping that token back to
   its source rendering and displacing the line text. The engine's own
   vim.lastHSPos (the landing pixel x, relative to the content box) is the
   coordinate the user's eye follows; the original implementation computes it
   but only feeds it to the soft-wrap clamp (hasMarkedText), discarding it for
   ordinary landing points.

   The landing point is pixel-anchored here:
   - the target line is still a document line (cur.line ± repeat): the
     semantics of line operators such as dd/dj are unchanged and soft-wrapped
     segments are still crossed as a whole (same as the existing behavior);
   - hidden lines (fences/formula blocks/hr) are not steps, and the near edge
     of a formula is a landing point — the same detection as motionClamp
     (visibleVerticalTarget), one single hidden-line model;
   - the horizontal landing point is the visible character boundary on the
     target line closest to the retained visual x, resolved through
     posAtCoords (the same geometry model as rendering, so it never lands
     inside hidden content); when the line is not painted it degrades to an
     average character width estimate (the same motionClamp contract — the
     line is about to scroll into the viewport and the next keystroke
     re-anchors);
   - the end-of-line intent of `$` (lastHPos=Infinity) is preserved
     automatically: a retained x past the target line's end lands at the line
     end; the first-non-blank intent of `+`/`-`/`_` resolves to the first
     visible character (on a list line the first visible character is the
     body text, not the hidden marker);
   - consecutive vertical motions do not write the visual anchor back: the
     quantization error of snapping the landing point to a character boundary
     would accumulate key by key if it fed back into the goal (measured: 8
     keys drift 47px to the right). The visual anchor stays fixed within one
     continuous motion, which is exactly vim's curswant semantics; a
     horizontal motion leaves the family and re-anchors;
   - every anchor is taken from a visible position — the old path that read a
     hidden coordinate, got a garbage x≈0 and propagated it to later
     keystrokes no longer exists. ---- */

export interface VimCorePos {
  line: number;
  ch: number;
}

export interface MoveByLinesArgs {
  forward: boolean;
  repeat: number;
  repeatOffset?: number;
  toFirstChar?: boolean;
}

export interface VimCoreState {
  lastMotion: unknown;
  lastHPos: number;
  lastHSPos: number;
}

export interface CmShim {
  cm6: EditorView;
  firstLine(): number;
  lastLine(): number;
}

/** `this` is the engine's motions table (moveToStartOfLine and friends live
 *  on it, for the family check). */
export function moveByLinesVisual(
  this: Record<string, any>,
  cm: CmShim,
  head: VimCorePos,
  motionArgs: MoveByLinesArgs,
  vim: VimCoreState,
): VimCorePos {
  const view = cm.cm6;
  const state = view.state;
  const doc = state.doc;

  // A consecutive vertical motion in the family reuses the retained visual
  // anchor; after any other action (leaving insert mode, 0, w...) the first
  // step re-anchors from the caret's real position.
  const family =
    vim.lastMotion === this.moveByLines ||
    vim.lastMotion === this.moveByDisplayLines ||
    vim.lastMotion === this.moveByScroll ||
    vim.lastMotion === this.moveToColumn ||
    vim.lastMotion === this.moveToEol;
  const eolIntent = family && vim.lastHPos === Infinity;
  if (!family) vim.lastHPos = head.ch;

  const repeat = motionArgs.repeat + (motionArgs.repeatOffset || 0);
  const line = motionArgs.forward ? head.line + repeat : head.line - repeat;
  if (line < cm.firstLine() && head.line === cm.firstLine()) {
    return this.moveToStartOfLine(cm, head, motionArgs, vim);
  }
  if (line > cm.lastLine() && head.line === cm.lastLine()) {
    // Faithful port of the engine's private moveToEol(keepHPos=true): stay
    // put at the line end, leave the bookkeeping alone.
    return { line: head.line + motionArgs.repeat - 1, ch: Infinity };
  }

  const down = !!motionArgs.forward;
  const count = Math.abs(repeat) || 0;
  const targetNo = visibleVerticalTarget(state, head.line + 1, down, count);
  const target = doc.line(targetNo);

  const contentLeft = view.contentDOM.getBoundingClientRect().left;
  let goal: number;
  if (family && Number.isFinite(vim.lastHSPos)) {
    goal = vim.lastHSPos;
  } else {
    const headLine = doc.line(head.line + 1);
    goal = pixelGoalOf(view, headLine.from + Math.min(head.ch, headLine.length), contentLeft);
  }

  let ch: number;
  if (motionArgs.toFirstChar) {
    const m = /\S/.exec(target.text);
    const firstNonWhite = m ? m.index : 0;
    // The first non-blank character may be a hidden marker (list line): the
    // pixel resolution lands on the first visible character, and the x≈0 read
    // at the hidden position resolves to that same first visible character.
    ch = columnOnLine(
      view,
      target,
      pixelGoalOf(view, target.from + firstNonWhite, contentLeft),
      contentLeft,
    );
    // A new intent: the anchor is reset to the landing point (vim's `+`
    // resets the curswant semantics).
    vim.lastHSPos = pixelGoalOf(view, target.from + ch, contentLeft);
  } else if (eolIntent) {
    // End-of-line intent: lastHSPos was already set to the line end x by `$`
    // (moveToEol) and stays unchanged.
    ch = target.length;
  } else {
    ch = columnOnLine(view, target, goal, contentLeft);
    if (!family) {
      // The first step after a new action (leaving insert mode, 0, w...):
      // the anchor taken here is the new anchor.
      vim.lastHSPos = goal;
    }
  }

  vim.lastHPos = eolIntent ? Infinity : ch;
  return { line: targetNo - 1, ch };
}
