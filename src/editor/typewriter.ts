import { EditorView, ViewPlugin, scrollPastEnd } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/**
 * Typewriter mode: keeps the caret vertically centered by nudging scrollTop
 * after every selection or document change. Scrolling by hand is untouched.
 *
 * The scroll must go through requestMeasure: writing scrollTop synchronously
 * inside update() is clobbered by CodeMirror's own scroll maintenance while
 * it syncs the DOM for the same update.
 */
export const typewriterMode = ViewPlugin.fromClass(
  class {
    update(u: ViewUpdate) {
      if (u.selectionSet || u.docChanged) {
        centerCursor(u.view);
      }
    }
  },
);

export function centerCursor(view: EditorView) {
  view.requestMeasure({
    read: (v) => {
      const head = v.state.selection.main.head;
      const coords = v.coordsAtPos(head, 1);
      if (!coords) return 0;
      const rect = v.scrollDOM.getBoundingClientRect();
      const current = (coords.top + coords.bottom) / 2 - rect.top;
      return current - v.scrollDOM.clientHeight / 2;
    },
    write: (delta) => {
      if (Math.abs(delta) > 1) view.scrollDOM.scrollTop += delta;
    },
  });
}

/** Extension factory so a Compartment can enable/disable the mode. */
export function typewriterExtension(): Extension {
  // scrollPastEnd gives the last lines enough room below to reach the center.
  return [typewriterMode, scrollPastEnd()];
}
