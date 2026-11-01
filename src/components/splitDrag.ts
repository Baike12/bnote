import type { PointerEvent as ReactPointerEvent } from "react";

export interface SplitDragOptions {
  /** pointerdown on the divider (the drag origin and the handle element). */
  event: ReactPointerEvent<HTMLElement>;
  /** Layout container (width reference and the CSS variable target). */
  host: HTMLElement | null;
  /** CSS variables this drag is allowed to write. */
  variables: string[];
  /** Comparison base at pointerup (the preference value stored in settings). */
  stored: Record<string, number>;
  /** Turns "pointer offset from the press point" into the variable values to write. */
  compute: (dx: number) => Record<string, number>;
  /** Commit the preference once the pointer is up and a value actually changed. */
  commit: (values: Record<string, number>) => void;
  /** Called after each pointer move (consumers such as a child webview that must re-report its bounds). */
  onMove?: () => void;
}

/**
 * Shared skeleton for divider drags: used by the three study mode columns and
 * the three project view columns.
 *
 * While the pointer moves we only write CSS variables, never setState: the
 * panes hold CodeMirror instances and a 60 Hz re-render is far too expensive;
 * the preference is committed once, on pointerup. The drag is computed from the
 * **offset**: the origin is where the divider currently sits, so grabbing it
 * 4 px off does not make it jump.
 */
export function startSplitDrag({
  event,
  host,
  variables,
  stored,
  compute,
  commit,
  onMove,
}: SplitDragOptions): void {
  if (!host) return;
  const hostRect = host.getBoundingClientRect();
  if (hostRect.width <= 0) return;
  event.preventDefault();

  const handle = event.currentTarget;
  handle.classList.add("dragging");
  // The pointer listeners live on window (not the 8 px handle), so a fast move or leaving the window does not lose the drag.
  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    // No active pointer (synthetic event / pointerless input)
  }

  const startX = event.clientX;
  let latest: Record<string, number> | null = null;

  const onPointerMove = (move: PointerEvent) => {
    const values = compute(move.clientX - startX);
    latest = values;
    for (const [name, value] of Object.entries(values)) {
      host.style.setProperty(name, `${value}px`);
    }
    onMove?.();
  };

  const onPointerUp = () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    handle.classList.remove("dragging");
    const done = latest;
    if (done && variables.some((name) => done[name] !== stored[name])) commit(done);
    // The displayed width (clamped by CSS in a narrow window) is not a new preference and must not be written back into the variables: restore the stored values.
    for (const name of variables) {
      host.style.setProperty(name, `${latest?.[name] ?? stored[name]}px`);
    }
  };

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
}
