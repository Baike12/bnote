import { EditorView, ViewPlugin, scrollPastEnd } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { typewriterReserve, typewriterScrollDelta } from "./typewriterPosition";

/**
 * Typewriter mode: keeps the caret line at a fixed share of the viewport
 * (50% = centered) by nudging scrollTop after every selection or document
 * change. Scrolling by hand is untouched.
 *
 * The scroll must go through requestMeasure: writing scrollTop synchronously
 * inside update() is clobbered by CodeMirror's own scroll maintenance while
 * it syncs the DOM for the same update.
 *
 * The scroll container reserves top/bottom space (via --typewriter-top and
 * --typewriter-bottom, which global.css reads for the content padding) so the
 * first and last lines can reach the same height too — a fresh note has
 * nothing above line 1, and without the space it would sit glued to the top.
 * The vars live on scrollDOM because CM's contentAttributes rewrites the
 * content element's style attribute wholesale, which would wipe an inline var
 * there. Position changes rebuild this plugin (compartment reconfigure), which
 * re-applies the reserve and re-centers in one transaction.
 */
function typewriterPlugin(position: number) {
  return ViewPlugin.fromClass(
    class {
      private view: EditorView;
      private ro: ResizeObserver;

      constructor(view: EditorView) {
        this.view = view;
        applyReserve(view, position);
        centerCursor(view, position);
        this.ro = new ResizeObserver(() => applyReserve(this.view, position));
        this.ro.observe(view.scrollDOM);
      }

      update(u: ViewUpdate) {
        if (u.selectionSet || u.docChanged) {
          centerCursor(u.view, position);
        }
        if (u.geometryChanged) applyReserve(u.view, position);
      }

      destroy() {
        this.ro.disconnect();
        this.view.scrollDOM.style.removeProperty("--typewriter-top");
        this.view.scrollDOM.style.removeProperty("--typewriter-bottom");
      }
    },
  );
}

/** Space above and below the content so line 1 / the last line can reach it. */
function applyReserve(view: EditorView, position: number) {
  const { top, bottom } = typewriterReserve(
    view.scrollDOM.clientHeight,
    view.defaultLineHeight,
    position,
  );
  view.scrollDOM.style.setProperty("--typewriter-top", `${top}px`);
  view.scrollDOM.style.setProperty("--typewriter-bottom", `${bottom}px`);
}

function centerCursor(view: EditorView, position: number) {
  view.requestMeasure({
    read: (v) => {
      const head = v.state.selection.main.head;
      const coords = v.coordsAtPos(head, 1);
      if (!coords) return 0;
      const rect = v.scrollDOM.getBoundingClientRect();
      const current = (coords.top + coords.bottom) / 2 - rect.top;
      return typewriterScrollDelta(current, v.scrollDOM.clientHeight, position);
    },
    write: (delta) => {
      if (Math.abs(delta) > 1) view.scrollDOM.scrollTop += delta;
    },
  });
}

/**
 * Extension factory so a Compartment can enable/disable the mode and change
 * its position. `scrollPastEnd` keeps the last lines reachable when the
 * position is above 50%, on top of the bottom reserve.
 */
export function typewriterExtension(position: number): Extension {
  return [typewriterPlugin(position), scrollPastEnd()];
}
