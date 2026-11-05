import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { mathOwnsEndpoints, mathRegions } from "./context";

/**
 * The text styling of emphasis (italic / bold) is drawn here instead of by the
 * syntax highlighting tags.
 *
 * Root cause: `_` is a subscript in LaTeX, lezer does not know about math, and
 * pairs two `_` from different formulas into one Emphasis node — the whole
 * span of body text between them then falls inside the node. A HighlightStyle
 * colors by **node range**, so no amount of filtering in the decoration layer
 * can stop that; hence `t.emphasis` / `t.strong` were removed from the style
 * table in markdown.ts and the same "delimiter inside math = mispair" rule now
 * decides the styling here.
 *
 * This also settles another matter: when the caret rests on an emphasized
 * line (live preview's marker hiding gives way), the text still has its
 * color — previously it came from the tag, now both modes share one set of
 * decorations. The decoration marks only the **content** (after the first
 * marker, before the last one); the marker characters keep the source color.
 */
const emphasisMark = Decoration.mark({ class: "md-em" });
const strongMark = Decoration.mark({ class: "md-strong" });
const strikeMark = Decoration.mark({ class: "md-strike" });

/** Pure build (no DOM, unit-testable): walks the syntax tree over the visible ranges only. */
export function buildEmphasisMarks(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  if (ranges.length === 0) return Decoration.none;
  const out: Range<Decoration>[] = [];
  const maths = mathRegions(state);
  syntaxTree(state).iterate({
    from: ranges[0].from,
    to: ranges[ranges.length - 1].to,
    enter: (ref) => {
      const name = ref.name;
      if (name !== "Emphasis" && name !== "StrongEmphasis" && name !== "Strikethrough") {
        return true;
      }
      // A node mispaired inside math: discard it wholesale, then judge its
      // children on their own.
      if (mathOwnsEndpoints(maths, ref.from, ref.to)) return true;
      let first: SyntaxNode | null = null;
      let last: SyntaxNode | null = null;
      for (let child = ref.node.firstChild; child; child = child.nextSibling) {
        if (child.name === "EmphasisMark" || child.name === "StrikethroughMark") {
          if (!first) first = child;
          last = child;
        }
      }
      if (!first || !last || last.to <= first.to) return true;
      const deco =
        name === "StrongEmphasis"
          ? strongMark
          : name === "Strikethrough"
            ? strikeMark
            : emphasisMark;
      out.push(deco.range(first.to, last.from));
      return true; // keep descending: nested emphasis (***x***) is marked separately
    },
  });
  return Decoration.set(out, true);
}

/** Always enabled (the live preview toggle does not affect it): it only owns the text styling, never the marker visibility. */
export function emphasisMarksExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildEmphasisMarks(view.state, view.visibleRanges);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
          this.decorations = buildEmphasisMarks(u.state, u.view.visibleRanges);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
