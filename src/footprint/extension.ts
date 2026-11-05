import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { documentPath, setDocPath } from "@/editor/docPath";
import { todayStamp } from "@/lib/todoStamp";
import { useAppStore } from "@/state/appStore";
import { openNoteByPath } from "@/lib/navigation";
import { dailyDayOf, dailyPathFor, isDailyPath } from "@/daily/model";
import {
  ensureFootprintDay,
  footprintsFor,
  footprintEntriesFor,
  footprintRevision,
  onFootprintsChanged,
  refreshFootprints,
} from "./store";
import { buildFootprintView, type FootprintView } from "./view";
import { FootprintWidget, currentFold, flipGroupFold, flipZoneFold, foldSignature } from "./widget";

/**
 * The two editor faces of the footprint:
 *  - Daily side, footprintZoneExtension: a block level widget is attached to the
 *    end of the document of a daily note of any day (block decorations can only
 *    come out of a StateField, the same constraint as
 *    livePreview.blockDecorationsField) - today reads the live index, a
 *    historical day reads the archive frozen during the rotation. Nothing is
 *    attached when the day has no footprint.
 *  - Source side, footprintMarksExtension: the first line of every block that was
 *    collected today gets a pip line decoration (the same geometry discipline as
 *    in daily/marks.ts, "it takes no part in the inline layout"; a day from the
 *    archive gets no pip, the semantics of a pip is always "today's footprint was
 *    collected into today's daily note").
 *
 * The index lives outside the editor (noteDirty, refreshAll and the rotation write
 * it in the store), the broadcast arrives here through onFootprintsChanged and
 * dispatches an empty transaction tagged with footprintChanged to wake the
 * recompute (it may be nested in another dispatch, hence the microtask - same as
 * dailyMarks).
 */

/** Tag on the empty transaction: the footprint index or the fold state changed, the decorations have to be recomputed. */
export const footprintChanged = StateEffect.define<null>();

// ---------------------------------------------------------------- daily side: the zone widget

interface ZoneValue {
  decos: DecorationSet;
  /** Revision plus fold signature plus the activation decision: when it does not change the old DecorationSet is reused and the widget DOM is not redrawn. */
  sig: string;
}

/** Which day's daily note the current document is; null for a file that is not a daily note. */
function activeDailyDay(state: EditorState): string | null {
  const path = documentPath(state);
  return path !== null ? dailyDayOf(path) : null;
}

function buildZoneValue(state: EditorState): ZoneValue {
  const day = activeDailyDay(state);
  if (day === null) return { decos: Decoration.none, sig: "off" };
  const entries = footprintEntriesFor(day);
  if (entries.length === 0) return { decos: Decoration.none, sig: `empty:${day}` };
  const viewData: FootprintView = buildFootprintView(entries);
  const widget = new FootprintWidget(day, viewData, currentFold());
  return {
    decos: Decoration.set([
      // Anchored at the end of the document (the same constraint as a formula
      // block: a block widget anchors at the start of a line; the end of the
      // document is doc.length).
      Decoration.widget({ widget, block: true }).range(state.doc.length),
    ]),
    // Today follows the live index; the historical archive is a frozen snapshot,
    // so a jittering revision does not trigger a repaint.
    sig: `${day}|${day === todayStamp() ? footprintRevision() : "h"}|${foldSignature()}|${state.doc.length}`,
  };
}

export const footprintZoneField = StateField.define<ZoneValue>({
  create: buildZoneValue,
  update(value, tr) {
    const wake = tr.effects.some((e) => e.is(footprintChanged) || e.is(setDocPath));
    if (!tr.docChanged && !wake) return value;
    const next = buildZoneValue(tr.state);
    if (!tr.docChanged && next.sig === value.sig) return value;
    return next;
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.decos),
});

// ---------------------------------------------------------------- click routing

/** Click routing for the data-footprint-* attributes on the widget DOM (the same
 *  pattern as the mousedown handler of livePreview): the zone and group arrows
 *  fold, the group name and the block body jump to the source file. */
function footprintMousedown(): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target as HTMLElement | null;
      const el = target?.closest?.("[data-footprint-action]") as HTMLElement | null;
      if (!el) return false;
      const action = el.dataset.footprintAction;
      if (action === "toggle-zone") {
        flipZoneFold();
        wakeView(view);
        return true;
      }
      if (action === "toggle-group") {
        const path = el.dataset.footprintPath;
        if (path) {
          flipGroupFold(path);
          wakeView(view);
        }
        return true;
      }
      if (action === "open-block" || action === "open-group") {
        const path = el.dataset.footprintPath;
        if (!path) return true;
        const line = Number(el.dataset.footprintLine);
        openNoteByPath(path, Number.isFinite(line) && line > 0 ? line : undefined);
        return true;
      }
      return false;
    },
  });
}

// ---------------------------------------------------------------- wake up

function wakeView(view: EditorView): void {
  queueMicrotask(() => {
    if (view.dom.isConnected) view.dispatch({ effects: footprintChanged.of(null) });
  });
}

/** The broadcast of the store -> waking transaction; it also keeps watch over "the
 *  document became a daily note": after the day switched, the first access
 *  finishes the rotation here (the footprint of the old day is frozen into the
 *  archive, a historical daily note can show it right away); today's daily note
 *  additionally rebuilds the whole index as a fallback (it covers the changes made
 *  while the app was not running - the watcher only reports changes of the running
 *  session, so after a restart there is no dirty path to feed it).
 *  refreshFootprints has a throttle of its own, switching between files quickly
 *  does not read the whole vault again. */
function footprintWakeExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      private unsubscribe: () => void;

      constructor(private view: EditorView) {
        this.unsubscribe = onFootprintsChanged(() => wakeView(this.view));
        void this.maybeFullRefresh();
      }

      update(u: ViewUpdate) {
        if (!u.transactions.some((t) => t.effects.some((e) => e.is(setDocPath)))) return;
        void this.maybeFullRefresh();
      }

      private async maybeFullRefresh(): Promise<void> {
        const path = documentPath(this.view.state);
        if (!path || !isDailyPath(path)) return;
        await ensureFootprintDay();
        wakeView(this.view);
        const vaultRoot = useAppStore.getState().vaultPath;
        if (vaultRoot && path === dailyPathFor(vaultRoot, todayStamp())) {
          await refreshFootprints();
          wakeView(this.view);
        }
      }

      destroy() {
        this.unsubscribe();
      }
    },
  );
}

// ---------------------------------------------------------------- source side: the pip

/** The slice of the view that is built (isomorphic to DailyMarkView of dailyMarks, so tests need no DOM). */
export interface FootprintMarkView {
  state: EditorState;
  visibleRanges: readonly { from: number; to: number }[];
}

/** The first line of the blocks collected today inside the viewport -> line decorations. Pure function. */
export function buildFootprintMarks(
  view: FootprintMarkView,
  blocks: readonly { start: number }[],
): DecorationSet {
  if (blocks.length === 0 || view.visibleRanges.length === 0) return Decoration.none;
  const doc = view.state.doc;
  const starts = new Set(blocks.map((b) => b.start));
  const from = Math.min(...view.visibleRanges.map((r) => r.from));
  const to = Math.max(...view.visibleRanges.map((r) => r.to));
  const mark = Decoration.line({
    class: "md-footprint",
    attributes: { title: "今日足迹已收录到今日日记" },
  });
  const out: Range<Decoration>[] = [];
  for (let n = doc.lineAt(from).number; ; n++) {
    if (starts.has(n)) out.push(mark.range(doc.line(n).from));
    const line = doc.line(n);
    if (line.to >= to || line.to >= doc.length) break;
  }
  return Decoration.set(out, true);
}

const footprintMarksPlugin = ViewPlugin.fromClass(
  class {
    marks: DecorationSet = Decoration.none;
    private unsubscribe: () => void;

    constructor(private view: EditorView) {
      this.unsubscribe = onFootprintsChanged(() => wakeView(this.view));
      this.marks = this.build();
    }

    destroy() {
      this.unsubscribe();
    }

    private build(): DecorationSet {
      const state = this.view.state;
      const path = documentPath(state);
      // Only the source side gets a mark; a daily note file (it is the aggregation
      // page itself) does not
      if (!path || isDailyPath(path)) return Decoration.none;
      return buildFootprintMarks(this.view, footprintsFor(path));
    }

    update(u: ViewUpdate) {
      const pathChanged = u.transactions.some((t) =>
        t.effects.some((e) => e.is(setDocPath) || e.is(footprintChanged)),
      );
      if (!u.docChanged && !u.viewportChanged && !pathChanged) return;
      this.marks = this.build();
    }
  },
  { decorations: (v) => v.marks },
);

// ---------------------------------------------------------------- assembly

export function footprintZoneExtension(): Extension {
  return [footprintZoneField, footprintMousedown(), footprintWakeExtension()];
}

export function footprintMarksExtension(): Extension {
  return footprintMarksPlugin;
}
