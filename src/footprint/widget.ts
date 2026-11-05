import { WidgetType } from "@codemirror/view";
import { todayStamp } from "@/lib/todoStamp";
import { renderBlockHtml } from "./render";
import {
  defaultFold,
  foldSig,
  toggleGroup,
  toggleZone,
  type FoldState,
  type FootprintView,
} from "./view";

/**
 * The block level "today's footprint" widget at the end of a daily note. The data
 * is an immutable view snapshot (FootprintView plus the fold signature); when the
 * index or the fold changes the extension creates a new instance and the DOM is
 * redrawn as a whole - the footprint zone is an aggregation view that updates
 * rarely, so there is no incremental rendering.
 *
 * Folding is UI state of the session (held at module level, not persisted): one
 * switch for the zone and one per group, everything expanded by default. The
 * interaction protocol marks the DOM with data-footprint-* and the clicks are
 * routed by the global mousedown handler of the extension (the same scheme as
 * data-math-from in livePreview).
 */

/** Fold state of the session (all editor instances share the same footprint). */
let fold: FoldState = defaultFold();

export function currentFold(): FoldState {
  return fold;
}

export function foldSignature(): string {
  return foldSig(fold);
}

export function flipZoneFold(): void {
  fold = toggleZone(fold);
}

export function flipGroupFold(path: string): void {
  fold = toggleGroup(fold, path);
}

// ---------------------------------------------------------------- widget

const ARROW_OPEN = "▾";
const ARROW_CLOSED = "▸";

export class FootprintWidget extends WidgetType {
  constructor(
    /** Day the footprint belongs to: today's daily note shows "today's footprint", a historical daily note shows that date. */
    readonly day: string,
    readonly viewData: FootprintView,
    readonly foldSnapshot: FoldState,
  ) {
    super();
  }

  eq(other: FootprintWidget): boolean {
    return (
      other.foldSnapshot.zoneCollapsed === this.foldSnapshot.zoneCollapsed &&
      other.viewData === this.viewData &&
      other.foldSigStr === this.foldSigStr
    );
  }

  /** The signature used in eq (cached after construction, so the set is not serialized again on every comparison). */
  get foldSigStr(): string {
    return foldSig(this.foldSnapshot);
  }

  toDOM(): HTMLElement {
    const zone = document.createElement("div");
    zone.className = "footprint-zone";

    const head = document.createElement("div");
    head.className = "footprint-zone-head";
    head.dataset.footprintAction = "toggle-zone";
    const title = this.day === todayStamp() ? "今日足迹" : `${this.day} 足迹`;
    head.textContent = `${this.foldSnapshot.zoneCollapsed ? ARROW_CLOSED : ARROW_OPEN} ${title} · ${this.viewData.fileCount} 个文件 · ${this.viewData.blockCount} 段`;
    zone.appendChild(head);

    if (this.foldSnapshot.zoneCollapsed) return zone;

    for (const group of this.viewData.groups) {
      const groupEl = document.createElement("div");
      groupEl.className = "footprint-group";
      const collapsed = this.foldSnapshot.groups.has(group.path);

      const groupHead = document.createElement("div");
      groupHead.className = "footprint-group-head";
      groupHead.dataset.footprintAction = "toggle-group";
      groupHead.dataset.footprintPath = group.path;
      const arrow = document.createElement("span");
      arrow.textContent = collapsed ? ARROW_CLOSED : ARROW_OPEN;
      const title = document.createElement("span");
      title.className = "footprint-group-title";
      title.dataset.footprintAction = "open-group";
      title.dataset.footprintPath = group.path;
      title.textContent = `《${group.label}》`;
      const count = document.createElement("span");
      count.className = "footprint-group-count";
      count.textContent = ` · ${group.blocks.length} 段`;
      groupHead.append(arrow, title, count);
      groupEl.appendChild(groupHead);

      if (!collapsed) {
        for (const block of group.blocks) {
          const body = document.createElement("div");
          body.className = "footprint-block";
          body.dataset.footprintAction = "open-block";
          body.dataset.footprintPath = group.path;
          body.dataset.footprintLine = String(block.start);
          body.innerHTML = renderBlockHtml(block.text);
          groupEl.appendChild(body);
        }
      }
      zone.appendChild(groupEl);
    }
    return zone;
  }

  ignoreEvent(): boolean {
    return false; // the event bubbles up to CM, the click routing lives in the mousedown handler of the extension
  }
}
