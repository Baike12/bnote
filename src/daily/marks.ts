import { StateEffect, type EditorState, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { documentPath, setDocPath } from "@/editor/docPath";
import { todayStamp } from "@/editor/ops";
import { useAppStore } from "@/state/appStore";
import { onLinksChanged, peekLinks, type DailyLink } from "./links";
import { dailyPathFor, isDailyPath, isTodo, parseListLine, todoText } from "./model";

/**
 * Visual marks on todo lines that are linked to a daily note.
 *
 * The semantics differ per side, and each side shows the one thing that matters
 * right now:
 *  - Source note (a todo in a project): mark the links that point at **today's**
 *    daily note - the ones ⌘⇧J sees as "already synced". An entry sent yesterday
 *    does not count today, which matches the per-day ownership rule of the send
 *    command; otherwise the same line would carry the marks of several days. The
 *    `auto` links (aggregated as soon as they exist) are not marked on the source
 *    side: under auto sync every todo has a link, and marks all over the vault are
 *    no longer information.
 *  - Daily note file (any day): mark the links that point at **this** daily note
 *    and carry the name of the source note - it is the only hint that the entry
 *    came from a sync instead of being written by hand.
 *
 * Rendering uses **line decorations plus absolutely positioned pseudo elements**
 * (the CSS lives in global.css): no widget is inserted and the inline layout is
 * untouched, so the indentation and wrapping geometry of a list stays
 * pixel-identical to the unmarked case.
 *
 * The link store lives outside the editor (sending, mirroring and unlinking all
 * happen in the engine), so the writers of the store notify this module through
 * the subscription in links.ts, and this module dispatches a tagged empty
 * transaction to wake CM up for a recompute (`onLinksChanged` may fire inside
 * another dispatch, hence the microtask).
 */

/** Tag on the empty transaction: the link store changed, the decorations have to be recomputed. */
export const dailyLinksChanged = StateEffect.define<null>();

/** The slice of the view the marks need (isomorphic to livePreview.DecorationBuildView, so tests need no DOM). */
export interface DailyMarkView {
  state: EditorState;
  visibleRanges: readonly { from: number; to: number }[];
}

export interface DailyMarkContext {
  /** Path of the currently open file. */
  path: string;
  /** All links this file takes part in (store.forFile(path)). */
  links: DailyLink[];
  /** Path of today's daily note. */
  todayDailyPath: string;
}

/** Name of the source note (directory and .md stripped), used in the label and the tooltip on the daily side. */
export function sourceLabel(srcPath: string): string {
  return srcPath.slice(srcPath.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

function markFor(link: DailyLink, dailySide: boolean): Decoration {
  const attrs: Record<string, string> = dailySide
    ? {
        "data-daily-src": sourceLabel(link.srcPath),
        title: `与《${sourceLabel(link.srcPath)}》的待办同步中`,
      }
    : {
        // "Sent" on the source side: the project card draws this line as a shadow
        // (the editing right belongs to the copy in the daily note). A normal note
        // has no style for it, the attribute itself is harmless.
        "data-daily-sent": "1",
        title:
          link.kind === "recorded"
            ? "勾选完成时已记录到今日日记,两侧保持同步"
            : "已发送到今日日记,两侧保持同步",
      };
  return Decoration.line({ class: "md-daily-link", attributes: attrs });
}

/** Todo lines inside the viewport that are linked to a daily note -> line decorations. Pure function: it only reads the state and the passed link table. */
export function buildDailyMarks(view: DailyMarkView, ctx: DailyMarkContext): DecorationSet {
  const dailySide = isDailyPath(ctx.path);
  const byText = new Map<string, DailyLink>();
  for (const l of ctx.links) {
    const relevant = dailySide
      ? l.dailyPath === ctx.path
      : l.kind !== "auto" && l.srcPath === ctx.path && l.dailyPath === ctx.todayDailyPath;
    if (relevant && !byText.has(l.text)) byText.set(l.text, l);
  }
  if (byText.size === 0 || view.visibleRanges.length === 0) return Decoration.none;

  const doc = view.state.doc;
  const from = Math.min(...view.visibleRanges.map((r) => r.from));
  const to = Math.max(...view.visibleRanges.map((r) => r.to));
  const out: Range<Decoration>[] = [];
  for (let n = doc.lineAt(from).number; ; n++) {
    const line = doc.line(n);
    const parsed = parseListLine(line.text);
    if (isTodo(parsed)) {
      const link = byText.get(todoText(parsed));
      if (link) out.push(markFor(link, dailySide).range(line.from));
    }
    if (line.to >= to || line.to >= doc.length) break;
  }
  return Decoration.set(out, true);
}

/** A change of the link store -> dispatch a waking transaction (after the current update finished, to avoid a nested dispatch). */
function wake(view: EditorView): void {
  queueMicrotask(() => {
    if (!view.dom.isConnected) return;
    view.dispatch({ effects: dailyLinksChanged.of(null) });
  });
}

const dailyMarksPlugin = ViewPlugin.fromClass(
  class {
    marks: DecorationSet = Decoration.none;
    private unsubscribe: () => void;

    constructor(private view: EditorView) {
      this.unsubscribe = onLinksChanged(() => wake(this.view));
      this.marks = this.build();
    }

    destroy() {
      this.unsubscribe();
    }

    private build(): DecorationSet {
      const state = this.view.state;
      const path = documentPath(state);
      const vaultRoot = useAppStore.getState().vaultPath;
      if (!path || !vaultRoot) return Decoration.none;
      const store = peekLinks(vaultRoot);
      if (!store) return Decoration.none; // the link store is not loaded: mark nothing yet, the subscription wakes us once it is
      return buildDailyMarks(this.view, {
        path,
        links: store.forFile(path),
        todayDailyPath: dailyPathFor(vaultRoot, todayStamp()),
      });
    }

    update(u: ViewUpdate) {
      const pathChanged = u.transactions.some((t) =>
        t.effects.some((e) => e.is(setDocPath) || e.is(dailyLinksChanged)),
      );
      if (!u.docChanged && !u.viewportChanged && !pathChanged) return;
      this.marks = this.build();
    }
  },
  { decorations: (v) => v.marks },
);

export function dailyMarksExtension(): Extension {
  return dailyMarksPlugin;
}
