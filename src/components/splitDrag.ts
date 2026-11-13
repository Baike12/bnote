import type { PointerEvent as ReactPointerEvent } from "react";

export interface SplitDragOptions {
  /** pointerdown on the divider (the drag origin and the handle element). */
  event: ReactPointerEvent<HTMLElement>;
  /** Layout container (size reference and the CSS variable target). */
  host: HTMLElement | null;
  /** CSS variables this drag is allowed to write. */
  variables: string[];
  /** Comparison base at pointerup (the preference value stored in settings). */
  stored: Record<string, number>;
  /** Turns "pointer offset from the press point" into the variable values to write. */
  compute: (delta: number) => Record<string, number>;
  /** Commit the preference once the pointer is up and a value actually changed. */
  commit: (values: Record<string, number>) => void;
  /** Called after each pointer move (consumers such as a child webview that must re-report its bounds). */
  onMove?: () => void;
  /**
   * Drag axis: `"x"` (default) for column widths, `"y"` for row heights such
   * as the terminal drawer. `compute` receives the offset along that axis.
   */
  axis?: "x" | "y";
}

/**
 * Shared skeleton for divider drags: the study mode columns, the project view
 * columns (widths) and the code pane's terminal drawer (height).
 *
 * While the pointer moves we only write CSS variables, never setState: the
 * panes hold CodeMirror instances and a 60 Hz re-render is far too expensive;
 * the preference is committed once, on pointerup. The drag is computed from the
 * **offset**: the origin is where the divider currently sits, so grabbing it
 * 4 px off does not make it jump.
 *
 * The write and the `onMove` report run **once per frame**, not once per
 * pointer event: consumers measure the new geometry, and a measure is a forced
 * layout of the whole layout (see the paint step below).
 */
export function startSplitDrag({
  event,
  host,
  variables,
  stored,
  compute,
  commit,
  onMove,
  axis = "x",
}: SplitDragOptions): void {
  if (!host) return;
  const hostRect = host.getBoundingClientRect();
  // A collapsed host cannot be measured: the drag would divide by nothing.
  if ((axis === "y" ? hostRect.height : hostRect.width) <= 0) return;
  event.preventDefault();

  const handle = event.currentTarget;
  handle.classList.add("dragging");
  // The pointer listeners live on window (not the 8 px handle), so a fast move or leaving the window does not lose the drag.
  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    // No active pointer (synthetic event / pointerless input)
  }

  const startPos = axis === "y" ? event.clientY : event.clientX;
  /** The values the last painted frame wrote (what pointerup commits). */
  let latest: Record<string, number> | null = null;
  /** The values of pointer moves the next frame has not painted yet. */
  let pending: Record<string, number> | null = null;
  let frame = 0;

  const write = (values: Record<string, number>) => {
    for (const [name, value] of Object.entries(values)) {
      host.style.setProperty(name, `${value}px`);
    }
  };

  // A pointermove is not a frame boundary: a 120 Hz display or a high-rate
  // mouse delivers several moves per frame, and the consumers of `onMove`
  // measure the new geometry right after the write — doing that per event
  // forces a synchronous layout of the whole three-column app several times
  // per frame, and the pointer handler itself stalls behind it. Record the
  // offset here (O(1)) and write + report at most once per frame; the layout
  // then runs exactly once per frame, on its own frame.
  const paint = () => {
    frame = 0;
    const values = pending;
    pending = null;
    if (!values) return;
    latest = values;
    write(values);
    onMove?.();
  };

  const onPointerMove = (move: PointerEvent) => {
    const delta = (axis === "y" ? move.clientY : move.clientX) - startPos;
    pending = compute(delta);
    if (frame === 0) frame = requestAnimationFrame(paint);
  };

  const onPointerUp = () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    if (frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    // A move that arrived after the last painted frame belongs to the drag:
    // commit the pointer's final position, not the last frame's.
    if (pending) {
      latest = pending;
      pending = null;
    }
    handle.classList.remove("dragging");
    const done = latest;
    if (!done) return;
    // The pointer's final position is a geometry of its own: paint it and let
    // the consumers report it, so a child webview does not stay at the last
    // frame's bounds when the drag ends between two frames.
    write(done);
    onMove?.();
    if (variables.some((name) => done[name] !== stored[name])) {
      // The preference now holds exactly these values; writing them keeps the
      // DOM in sync until React re-renders with the committed width.
      commit(done);
    } else {
      // A click (or a drag that ended where it started) is not a new
      // preference: put the stored values back, the drag's display values
      // (clamped by CSS in a narrow window) must not stick.
      for (const name of variables) host.style.setProperty(name, `${stored[name]}px`);
    }
  };

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
}
