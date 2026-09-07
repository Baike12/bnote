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
 *
 * Half a viewport of top space is reserved on the scroll container (via the
 * --typewriter-top CSS var that global.css reads for the content padding) so
 * the first line can be centered too — a fresh note has nothing above line 1
 * to scroll up to, and without the space it would sit glued to the top. The
 * var lives on scrollDOM because CM's contentAttributes rewrites the content
 * element's style attribute wholesale, which would wipe an inline var there.
 */
export const typewriterMode = ViewPlugin.fromClass(
  class {
    private view: EditorView;
    private ro: ResizeObserver;

    constructor(view: EditorView) {
      this.view = view;
      applyTopSpace(view);
      centerCursor(view);
      this.ro = new ResizeObserver(() => applyTopSpace(this.view));
      this.ro.observe(view.scrollDOM);
    }

    update(u: ViewUpdate) {
      if (u.selectionSet || u.docChanged) {
        centerCursor(u.view);
      }
      if (u.geometryChanged) applyTopSpace(u.view);
    }

    destroy() {
      this.ro.disconnect();
      this.view.scrollDOM.style.removeProperty("--typewriter-top");
    }
  },
);

/** Half the scroller (minus one line) above the content: line 1 centers. */
function applyTopSpace(view: EditorView) {
  const half = Math.max(0, (view.scrollDOM.clientHeight - view.defaultLineHeight) / 2);
  view.scrollDOM.style.setProperty("--typewriter-top", `${Math.round(half)}px`);
}

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
