import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { StateField, Transaction } from "@codemirror/state";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef, Tree } from "@lezer/common";
import { mathBodySpan, mathOwnsEndpoints, mathRegions, selectionInMathBody } from "./context";
import { calloutRegions } from "./callout";
import { collectAnchors } from "./calloutAnchor";
import { documentPath, setDocPath } from "./docPath";
import { useAppStore } from "@/state/appStore";
import { convertFileSrc } from "@tauri-apps/api/core";
import { DONE_STAMP_RE, todayStamp } from "@/lib/todoStamp";
import {
  CalloutEdgeWidget,
  CalloutTitleWidget,
  EscapeCharWidget,
  HiddenLineWidget,
  HrWidget,
  ListBulletWidget,
  MathInlinePreviewWidget,
  MathPreviewWidget,
  MathWidget,
  TaskCheckboxWidget,
} from "./widgets";
import { ImageWidget } from "./widgets";
import { perfEnd, perfFields, perfStart } from "@/perf/trace";
import { drawingStem, isDrawingFileName } from "@/lib/excalidrawFile";

/**
 * Obsidian-style live preview: everything in the viewport is rendered
 * (headings, emphasis, code fences, math, links…) except the line the cursor
 * is on — and whole math/code blocks while the cursor is inside them, which
 * stay as raw source for editing.
 *
 * Performance design (cursor moves must never cascade):
 * - Block replace decorations can only come from a state field, so the field
 *   computes them ITSELF from each transaction (doc + selection) — no
 *   plugin→effect→dispatch round trip, which used to cost two extra full
 *   update cycles whenever a math block expanded or collapsed.
 * - Keyboard motions can never land past a display-math block: the per-view
 *   motion clamp (motionClamp.ts, installed in setup.ts) stops the caret at
 *   the block's near edge inside the motion transaction itself, so the field
 *   sees the final selection and expands the block in the same frame.
 * - The inline plugin skips its rebuild when a selection-only change cannot
 *   alter any decoration (same covered lines, no toggle-able syntax there).
 */

interface Interval {
  from: number;
  to: number;
}

interface WikiLinkEntry extends Interval {
  target: string;
}

/** Clickable rendered wikilinks of the last build, per view. */
const wikiLinksPerView = new WeakMap<object, WikiLinkEntry[]>();

export interface LivePreviewHooks {
  openWikiLink?: (target: string) => void;
  openExternalUrl?: (url: string) => void;
  /** Click the preview image of a drawing embed: open that .excalidraw file in the canvas. */
  openDrawing?: (path: string) => void;
  /** Live-rendered preview below a math region while the cursor edits it. */
  mathPreview?: boolean;
}

const hooks: LivePreviewHooks = {};

export function configureLivePreview(h: LivePreviewHooks) {
  Object.assign(hooks, h);
}

function overlaps(a: Interval, b: Interval) {
  return a.from < b.to && a.to > b.from;
}

/**
 * Rendering of these tokens toggles with exact cursor position INSIDE a line
 * (emphasis/inline-code marks collapse to raw source, inline math swaps to a
 * widget, links/escapes change). A cursor move that stays on lines without
 * any of them cannot change a single decoration.
 */
const INLINE_TRIGGER_RE = /[*_~`$[\]\\:<>]/;

/** The width of the "marker slot" at the start of a line: indent + list marker
 *  + the whitespace after it + an optional task bracket and its whitespace.
 *  Non-marker shapes (including a line starting with inline emphasis such as
 *  `*emphasis*` — the marker must be followed by whitespace or the line end)
 *  return null. A caret crossing this slot flips the marker's activity rule
 *  (source ⇄ widget), so the slot boundary is aligned with the active()
 *  decision of each rendering branch (the touching point counts as active,
 *  hence the <= comparison). */
function markerSlotEnd(text: string): number | null {
  let i = 0;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  const rest = text.slice(i);
  let markerLen: number;
  if (rest[0] === "-" || rest[0] === "*" || rest[0] === "+") {
    markerLen = 1;
  } else {
    const ordered = /^\d{1,9}[.)]/.exec(rest);
    if (!ordered) return null;
    markerLen = ordered[0].length;
  }
  let j = i + markerLen;
  if (j >= text.length) return j; // the line ends with the marker (a bare "-")
  if (text[j] !== " " && text[j] !== "\t") return null;
  while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
  const task = /^\[[ xX]\]/.exec(text.slice(j));
  if (task) {
    j += task[0].length;
    while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
  }
  return j;
}

/** False when a selection-only change provably leaves every decoration as it
 *  was — letting plain-text cursor moves (vim h/j/k/l, arrows) skip rebuilds.
 *  Exported so the perf gate can lock the fast path: a pure same-line move
 *  outside the marker slot must return false. */
export function selectionAffectsDecos(oldState: EditorState, newState: EditorState): boolean {
  const oldRanges = oldState.selection.ranges;
  const newRanges = newState.selection.ranges;
  if (oldRanges.length !== newRanges.length) return true;
  const doc = newState.doc;
  for (let i = 0; i < newRanges.length; i++) {
    const o = oldRanges[i];
    const n = newRanges[i];
    if (
      doc.lineAt(o.from).number !== doc.lineAt(n.from).number ||
      doc.lineAt(o.to).number !== doc.lineAt(n.to).number
    ) {
      return true;
    }
  }
  for (const r of newRanges) {
    const fromLine = doc.lineAt(r.from).number;
    const toLine = doc.lineAt(r.to).number;
    for (let n = fromLine; n <= toLine; n++) {
      if (INLINE_TRIGGER_RE.test(doc.line(n).text)) return true;
    }
  }
  // A same-line move across the "marker slot": the activity rules of
  // ListMark/TaskMarker and the trailing-space retention of empty items
  // (keepMarkerTrailingSpace) both depend on the caret position within the
  // line — vim's same-line moves such as 0/$/A used to leave a bare `-` / a
  // bare `[ ]` permanently on screen (a rendering regression).
  for (let i = 0; i < newRanges.length; i++) {
    const o = oldRanges[i];
    const n = newRanges[i];
    if (o.from === n.from && o.to === n.to) continue;
    const line = doc.lineAt(n.from);
    const slotEnd = markerSlotEnd(line.text);
    if (slotEnd === null) continue;
    if (slotEnd >= line.to - line.from) return true; // empty list item: any same-line move may flip the whitespace retention
    const base = line.from;
    if (o.from - base <= slotEnd !== n.from - base <= slotEnd) return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// Block decorations — computed inside the state field (no dispatch round trip)
// --------------------------------------------------------------------------

interface BlockStatics {
  /** Fence lines (open/close) with their parent block's range: a fence line is
   *  hidden only while the cursor is outside the whole block — inside, the
   *  block shows as editable source (same rule as math blocks). */
  fences: { line: Interval; block: Interval }[];
  codeRanges: Interval[];
  inlineCodeRanges: Interval[];
  hrs: Interval[];
}

function collectBlockStatics(state: EditorState): BlockStatics {
  const fences: { line: Interval; block: Interval }[] = [];
  const codeRanges: Interval[] = [];
  const inlineCodeRanges: Interval[] = [];
  const hrs: Interval[] = [];
  const doc = state.doc;
  syntaxTree(state).iterate({
    from: 0,
    to: doc.length,
    enter: (nodeRef: SyntaxNodeRef) => {
      switch (nodeRef.name) {
        case "FencedCode": {
          codeRanges.push({ from: nodeRef.from, to: nodeRef.to });
          const block = { from: nodeRef.from, to: nodeRef.to };
          for (let child = nodeRef.node.firstChild; child; child = child.nextSibling) {
            if (child.name === "CodeMark") {
              const line = doc.lineAt(child.from);
              fences.push({ line: { from: line.from, to: line.to }, block });
            }
          }
          return false;
        }
        case "IndentedCode":
        case "CodeBlock":
          codeRanges.push({ from: nodeRef.from, to: nodeRef.to });
          return false;
        case "InlineCode":
          inlineCodeRanges.push({ from: nodeRef.from, to: nodeRef.to });
          return false;
        case "HorizontalRule":
          hrs.push({ from: nodeRef.from, to: nodeRef.to });
          return false;
        default:
          return true;
      }
    },
  });
  return { fences, codeRanges, inlineCodeRanges, hrs };
}

/**
 * Whether a transaction can change the block statics. Only the characters that
 * build/destroy a tree-level block construct qualify: fences
 * (backtick/tilde), HR markers (-, *, _), and any edit at a line start
 * (list/indent forms). Callout titles and edges are **not** derived here —
 * they come straight from `calloutRegions(state)` in buildBlockDecos, so a
 * title edit can never leave a stale widget behind. Any other insertion or
 * deletion (ordinary prose, code content, commands inside a formula) shifts
 * the static ranges and is mapped instead of re-walking the whole syntax tree
 * on every keystroke.
 */
function mayAffectBlockStatics(tr: Transaction): boolean {
  const oldDoc = tr.startState.doc;
  const newDoc = tr.state.doc;
  let affected = false;
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (affected) return;
    const removed = oldDoc.sliceString(fromA, toA);
    const inserted = newDoc.sliceString(fromB, toB);
    if (/[`~*_\-\n]/.test(removed) || /[`~*_\-\n]/.test(inserted)) {
      affected = true;
      return;
    }
    if (oldDoc.lineAt(fromA).from === fromA || newDoc.lineAt(fromB).from === fromB) {
      affected = true;
    }
  });
  return affected;
}

function mapInterval(interval: Interval, tr: Transaction): Interval {
  const from = tr.changes.mapPos(interval.from, 1);
  const to = tr.changes.mapPos(interval.to, -1);
  return from === interval.from && to === interval.to ? interval : { from, to };
}

/** Maps the block statics through an ordinary edit; block boundaries only
 *  move when text before them is inserted or removed. */
function mapBlockStatics(statics: BlockStatics, tr: Transaction): BlockStatics {
  return {
    fences: statics.fences.map((f) => ({
      line: mapInterval(f.line, tr),
      block: mapInterval(f.block, tr),
    })),
    codeRanges: statics.codeRanges.map((r) => mapInterval(r, tr)),
    inlineCodeRanges: statics.inlineCodeRanges.map((r) => mapInterval(r, tr)),
    hrs: statics.hrs.map((r) => mapInterval(r, tr)),
  };
}

function buildBlockDecos(
  state: EditorState,
  statics: BlockStatics,
  ranges: readonly { from: number; to: number }[],
): { decos: DecorationSet; sig: string } {
  const doc = state.doc;
  const maths = mathRegions(state);
  const callouts = calloutRegions(state);
  const out: Range<Decoration>[] = [];
  const sig: string[] = [];
  const active = (from: number, to: number) => ranges.some((r) => r.from <= to && r.to >= from);
  // The nesting depth of the callout containing pos, -1 = not inside any block.
  // The line elements of block members replaced across lines (math blocks /
  // HR) are moved out of the DOM, so the block surface is carried by the
  // widget itself (see widgets.ts).
  const calloutDepthAt = (pos: number): number => {
    for (const c of callouts) if (pos >= c.from && pos <= c.to) return c.depth;
    return -1;
  };

  const exclude = [...statics.codeRanges, ...statics.inlineCodeRanges];
  const excluded = (from: number, to: number) => exclude.some((r) => from < r.to && to > r.from);

  for (const f of statics.fences) {
    // Block-level decision (the same rule as for math blocks): while the
    // cursor is on any line of the block, both fence lines stay editable
    // source; only when the cursor leaves the whole block are the fences
    // hidden and the rendered state entered.
    if (!active(f.block.from, f.block.to)) {
      out.push(
        Decoration.replace({ widget: new HiddenLineWidget(), block: true }).range(
          f.line.from,
          f.line.to,
        ),
      );
      sig.push(`f${f.line.from}`);
    }
  }
  for (const c of callouts) {
    const edges: { kind: "open" | "close"; title: string; line: number }[] = [
      { kind: "open", title: c.title, line: c.openLine },
    ];
    if (c.closed) edges.push({ kind: "close", title: "", line: c.closeLine });
    for (const e of edges) {
      const line = doc.line(e.line);
      // The same block-level rule as for fences: while the cursor is inside the
      // callout (boundary lines included) the `:::` source stays editable, and
      // only leaving the whole block hides it. The rendered state is provided
      // by the widget's own top/bottom caps (a whole-line block replace moves
      // the line element out of the DOM where line decorations cannot reach
      // it) — with a title the title is rendered at heading-3 font size,
      // otherwise the cap has no text at all.
      if (active(c.from, c.to)) continue;
      if (e.kind === "open" && e.title) {
        out.push(
          Decoration.replace({
            widget: new CalloutTitleWidget(e.title, line.from, c.depth),
            block: true,
          }).range(line.from, line.to),
        );
        sig.push(`co${line.from}:${e.title}`);
      } else {
        out.push(
          Decoration.replace({
            widget: new CalloutEdgeWidget(e.kind === "open", line.from, c.depth),
            block: true,
          }).range(line.from, line.to),
        );
        sig.push(`ce${line.from}`);
      }
    }
  }
  for (const hr of statics.hrs) {
    if (!active(hr.from, hr.to)) {
      out.push(
        Decoration.replace({
          widget: new HrWidget(calloutDepthAt(hr.from)),
          block: true,
        }).range(hr.from, hr.to),
      );
      sig.push(`h${hr.from}`);
    }
  }
  for (const region of maths) {
    if (!region.display) continue;
    if (excluded(region.from, region.to)) continue;

    if (active(region.from, region.to)) {
      // Editing this formula: live-rendered preview right below the source.
      // Empty content has nothing to preview, so it takes no space — inserting
      // a math block would otherwise leave a blank stretch right below it.
      if (hooks.mathPreview !== false && region.content.trim()) {
        const anchorLine = doc.lineAt(Math.max(region.from, region.to - 1));
        // Anchor at the **end of the line** of this block's closing line (the
        // end of the region's last line, doc.length at the end of the
        // document). Anchoring at the start of the next line has two problems
        // (measured in the browser, @codemirror/view 6.43):
        //   1. If the next line is another display math block, its whole-block
        //      replace starts exactly at the line start, and a block widget
        //      inside the replaced range is dropped by CM — a directly
        //      adjacent second math block makes the preview vanish for no
        //      reason (the "the live rendering disappeared" the user reported
        //      on 2026-10-31);
        //   2. A block widget that owns the start of the next line adds an
        //      empty cm-line to the DOM (a 7-line document renders 8 line
        //      boxes), so ~24px appear out of nowhere between the preview
        //      and the text below.
        // The line-end anchor lets the preview follow this block, independent
        // of its neighbours.
        const anchor = anchorLine.to;
        out.push(
          Decoration.widget({
            widget: new MathPreviewWidget(region.content, true, calloutDepthAt(region.from)),
            block: true,
            // The preview comes **after** the source: when the region reaches
            // the end of the document the anchor is where the caret sits, and
            // side<0 would draw the caret below the preview (which looks like
            // "it jumped to the next line").
            side: 1,
          }).range(anchor),
        );
        sig.push(`p${region.from}:${region.content}`);
      }
      continue;
    }

    const openLine = doc.lineAt(region.from);
    const closeLine = doc.lineAt(Math.max(region.from, region.to - 1));
    if (openLine.number === closeLine.number) continue; // single-line: inline path
    out.push(
      Decoration.replace({
        widget: new MathWidget(region.content, true, region.from, calloutDepthAt(region.from)),
        block: true,
      }).range(openLine.from, Math.min(closeLine.to, region.to)),
    );
    sig.push(`m${region.from}:${region.content}`);
  }
  return { decos: Decoration.set(out, true), sig: sig.join("|") };
}

interface BlockFieldValue {
  statics: BlockStatics;
  decos: DecorationSet;
  /** Signature of `decos`; equal signature ⇒ identical decoration set. */
  sig: string;
  /** The syntaxTree reference: the decorations depend on the syntax tree, and
   *  the tree is parsed in the background (the first frame after a file switch
   *  sees an empty tree) — once the tree advances, they must be rebuilt. */
  tree: Tree;
}

const STATICS_FIELDS = perfFields("docLines", "mode");
const BLOCK_DECOS_FIELDS = perfFields("docLines");

function makeBlockValue(
  state: EditorState,
  prev: BlockFieldValue | null,
  tr: Transaction | null,
  tree: Tree,
): BlockFieldValue {
  const docChanged = !!tr && tr.docChanged;
  const staticsStart = perfStart();
  let statics: BlockStatics;
  let mode: "collect" | "map" | "reuse";
  if (!prev || (!docChanged && tree !== prev.tree)) {
    statics = collectBlockStatics(state);
    mode = "collect";
  } else if (!docChanged) {
    statics = prev.statics;
    mode = "reuse";
  } else if (mayAffectBlockStatics(tr)) {
    statics = collectBlockStatics(state);
    mode = "collect";
  } else {
    statics = mapBlockStatics(prev.statics, tr);
    mode = "map";
  }
  perfEnd(staticsStart, "livePreview.statics", STATICS_FIELDS, state.doc.lines, mode);

  const decoStart = perfStart();
  const { decos, sig } = buildBlockDecos(state, statics, state.selection.ranges);
  perfEnd(decoStart, "livePreview.blockDecos", BLOCK_DECOS_FIELDS, state.doc.lines);
  if (prev && !docChanged && sig === prev.sig) {
    // The decorations did not change: keep the original DecorationSet but
    // record the new tree, so that every later tree advance does not trigger
    // a recompute.
    return tree === prev.tree ? prev : { ...prev, tree };
  }
  return { statics, decos, sig, tree };
}

/** Holds the block replace decorations (hidden fences, display math, rules);
 *  CM6 only accepts block decorations from a state field. */
export const blockDecorationsField = StateField.define<BlockFieldValue>({
  create: (state) => makeBlockValue(state, null, null, syntaxTree(state)),
  update(value, tr) {
    const tree = syntaxTree(tr.state);
    const treeChanged = tree !== value.tree;
    if (!tr.docChanged && !tr.selection && !treeChanged) return value;
    if (treeChanged && !tr.docChanged && !tr.selection) {
      // The background parse advances in slices and the intermediate slices
      // dispatch updates too: only the completed one counts, so that a large
      // document is not fully recomputed for every slice while it parses.
      if (!syntaxTreeAvailable(tr.state, tr.state.doc.length)) return value;
      return makeBlockValue(tr.state, value, tr, tree);
    }
    if (!tr.docChanged && !selectionAffectsDecos(tr.startState, tr.state)) return value;
    return makeBlockValue(tr.state, value, tr, tree);
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.decos),
});

// --------------------------------------------------------------------------
// Inline decorations (viewport-scoped plugin)
// --------------------------------------------------------------------------

interface DecorationSink {
  inline: Range<Decoration>[];
}

/** The only view surface the package needs: building decorations reads only
 *  the state and the viewport ranges. Tests use it to build a DOM-less fake
 *  view and lock geometric models such as the "marker token activity rule". */
export interface DecorationBuildView {
  state: EditorState;
  visibleRanges: readonly { from: number; to: number }[];
}

/** Viewport-scoped inline decorations (italic, list markers, inline math,
 *  wikilink...). Exported so tests can lock the token activity rules on a
 *  DOM-less fake view. */
const INLINE_FIELDS = perfFields("docLines", "visibleRanges", "decos");

export function buildInlineDecorations(view: DecorationBuildView): DecorationSet {
  const t = perfStart();
  const state = view.state;
  const doc = state.doc;
  const visible = view.visibleRanges;
  const selections = state.selection.ranges;

  const out: DecorationSink = { inline: [] };
  const claimed: Interval[] = []; // replace-decorations must not overlap

  const active = (from: number, to: number) => selections.some((r) => r.from <= to && r.to >= from);

  const activeLine = (lineFrom: number, lineTo: number) => active(lineFrom, lineTo);

  const claim = (from: number, to: number) => {
    for (const c of claimed) if (overlaps({ from, to }, c)) return false;
    claimed.push({ from, to });
    return true;
  };

  // Math regions must be known before the syntax-tree walk: nodes fully
  // inside a formula (\, \; { } * …) are LaTeX, not markdown escapes.
  const maths = mathRegions(state);
  const inAnyMath = (from: number, to: number) => maths.some((r) => from >= r.from && to <= r.to);

  // Ranges where rendering must never kick in (code blocks, inline code).
  const codeRanges: Interval[] = [];
  const inlineCodeRanges: Interval[] = [];

  const inRangeList = (list: Interval[], from: number, to: number) =>
    list.some((r) => from < r.to && to > r.from);

  const visibleFrom = Math.min(...visible.map((v) => v.from));
  const visibleTo = Math.max(...visible.map((v) => v.to));

  syntaxTree(state).iterate({
    from: visibleFrom,
    to: visibleTo,
    enter: (nodeRef: SyntaxNodeRef) => {
      const name = nodeRef.name;

      // Formula content is not markdown — skip all node decoration inside.
      if (inAnyMath(nodeRef.from, nodeRef.to)) return false;

      if (name === "FencedCode") {
        codeRanges.push({ from: nodeRef.from, to: nodeRef.to });
        if (!active(nodeRef.from, nodeRef.to)) {
          decorateFencedCodeLines(doc, nodeRef.node, out);
        }
        return false;
      }
      if (name === "IndentedCode" || name === "CodeBlock") {
        codeRanges.push({ from: nodeRef.from, to: nodeRef.to });
        return false;
      }
      if (name === "InlineCode") {
        inlineCodeRanges.push({ from: nodeRef.from, to: nodeRef.to });
        if (!active(nodeRef.from, nodeRef.to)) {
          decorateInlineCode(nodeRef.node, out, claim);
        }
        return false;
      }
      if (name.startsWith("ATXHeading")) {
        const level = Number(name.slice("ATXHeading".length)) || 1;
        // Line spacing applies whether or not the line is being edited, so
        // the text doesn't jump when the cursor enters/leaves a heading.
        const lineFrom = doc.lineAt(nodeRef.from).from;
        out.inline.push(Decoration.line({ class: `md-hline md-hline-${level}` }).range(lineFrom));
        // Heading colors apply on the active line too; only the hash hiding
        // is lifted there so the raw `#` markers stay editable.
        decorateHeading(doc, nodeRef.node, level, out, claim, activeLine(nodeRef.from, nodeRef.to));
        return false;
      }
      if (name === "Emphasis" || name === "StrongEmphasis") {
        // A node mispaired inside math (see mathOwnsEndpoints): the text
        // styling is filtered centrally by emphasisMarksExtension, so here not
        // even the marker hiding is done.
        if (mathOwnsEndpoints(maths, nodeRef.from, nodeRef.to)) return true;
        if (!active(nodeRef.from, nodeRef.to)) {
          hideEmphasisMarks(nodeRef.node, out, claim);
        }
        return false;
      }
      if (name === "SetextHeading2") {
        decorateSetextDash(doc, nodeRef.node, selections, out, claim);
        return false;
      }
      if (name === "Strikethrough") {
        if (mathOwnsEndpoints(maths, nodeRef.from, nodeRef.to)) return true;
        if (!active(nodeRef.from, nodeRef.to)) {
          hideEmphasisMarks(nodeRef.node, out, claim);
        }
        return false;
      }
      if (name === "Blockquote") {
        decorateBlockquote(doc, nodeRef.node, selections, out);
        return true; // descend for nested quotes and inline content
      }
      if (name === "HorizontalRule") {
        return false; // rendered by the block-decorations field
      }
      if (name === "Escape") {
        if (!activeLine(nodeRef.from, nodeRef.to) && claim(nodeRef.from, nodeRef.to)) {
          const char = doc.sliceString(nodeRef.from + 1, nodeRef.to);
          out.inline.push(
            Decoration.replace({ widget: new EscapeCharWidget(char) }).range(
              nodeRef.from,
              nodeRef.to,
            ),
          );
        }
        return false;
      }
      if (name === "Link") {
        if (
          !mathOwnsEndpoints(maths, nodeRef.from, nodeRef.to) &&
          !active(nodeRef.from, nodeRef.to)
        ) {
          decorateLink(nodeRef.node, out);
        }
        return false;
      }
      if (name === "Image") {
        if (
          !mathOwnsEndpoints(maths, nodeRef.from, nodeRef.to) &&
          !active(nodeRef.from, nodeRef.to)
        ) {
          decorateImage(nodeRef.node, state, out, claim);
        }
        return false;
      }
      if (name === "URL" || name === "Autolink") {
        if (!active(nodeRef.from, nodeRef.to)) {
          out.inline.push(Decoration.mark({ class: "md-link" }).range(nodeRef.from, nodeRef.to));
        }
        return false;
      }
      if (name === "ListMark") {
        const mark = nodeRef.node;
        const markLine = doc.lineAt(mark.from);
        const spaces = mark.from - markLine.from;
        // Obsidian-style indent: hide the literal spaces and let the line
        // decoration pad + hang instead. Applied on active lines too, so the
        // layout doesn't shift when the cursor enters/leaves the line.
        const depth = Math.min(16, Math.floor(spaces / 2)) * 2;
        const kind = listKind(doc, mark);
        out.inline.push(
          Decoration.line({ class: `md-list-line li-i${depth} ${kind}` }).range(markLine.from),
        );
        if (spaces > 0 && claim(markLine.from, mark.from)) {
          out.inline.push(Decoration.replace({}).range(markLine.from, mark.from));
        }
        if (!activeLine(nodeRef.from, nodeRef.to)) {
          decorateListMark(
            doc,
            mark,
            kind,
            out,
            claim,
            keepMarkerTrailingSpace(
              selections,
              markLine.from,
              markLine.to,
              whitespaceEnd(doc, mark.to),
            ),
          );
        }
        return false;
      }
      if (name === "TaskMarker") {
        const checked = /^\[[xX]\]/.test(doc.sliceString(nodeRef.from, nodeRef.to));
        // The checkbox owns `[ ]` plus the whitespace after it, so its box
        // (0.9em) + margin-right (--li-gap) are the whole marker slot and the
        // item text lands on the wrapped-line indent (see global.css) — unless
        // the whitespace is line-final and the caret rests at the slot end
        // (empty item): then it stays visible as the caret's text anchor.
        const markLine = doc.lineAt(nodeRef.from);
        let to = whitespaceEnd(doc, nodeRef.to);
        if (keepMarkerTrailingSpace(selections, markLine.from, markLine.to, to)) {
          to = nodeRef.to;
        }
        if (!activeLine(nodeRef.from, nodeRef.to) && claim(nodeRef.from, to)) {
          out.inline.push(
            Decoration.replace({ widget: new TaskCheckboxWidget(checked) }).range(nodeRef.from, to),
          );
        }
        return false;
      }
      return true;
    },
  });

  // ---- Callout blocks (`:::` containers): background + left rule assembled per line ----
  // Both content lines and boundary lines get the block surface class (the
  // boundary lines show their source when the cursor enters the block, but the
  // surface never breaks); the top/bottom padding and the rounded corners
  // are carried by the opening/closing boundary lines. The line decorations
  // do not depend on the cursor position — a pure cursor move that takes the
  // selectionAffectsDecos fast path rebuilds none of this. Nested regions
  // each paint a layer, and the depth classes d1/d2 shift the inner ones
  // right (see global.css).
  const callouts = calloutRegions(state);
  for (const c of callouts) {
    if (c.to < visibleFrom || c.from > visibleTo) continue;
    const firstNo = Math.max(c.openLine, doc.lineAt(visibleFrom).number);
    const lastNo = Math.min(c.closeLine, doc.lineAt(visibleTo).number);
    for (let n = firstNo; n <= lastNo; n++) {
      const line = doc.line(n);
      const edge =
        n === c.openLine
          ? " md-callout-open"
          : n === c.closeLine && c.closed
            ? " md-callout-close"
            : "";
      out.inline.push(
        Decoration.line({ class: `md-callout-line d${Math.min(c.depth, 2)}${edge}` }).range(
          line.from,
        ),
      );
    }
  }

  const exclude: Interval[] = [...codeRanges, ...inlineCodeRanges];

  // ---- Callout anchors: body text that is the same run of text as some callout title ----
  // The entry point left in the original text by "insert with selection",
  // rendered as an underline dashed line (in the same color as the block's
  // left rule). The match is plain text equality (whitespace-flexible, see
  // calloutAnchor.ts), independent of the syntax tree, so it is already
  // complete right after a file loads and the tree has not parsed; the range
  // excludes callout regions and code regions (those are not entries).
  for (const a of collectAnchors(doc, callouts, visibleFrom, visibleTo, exclude)) {
    out.inline.push(Decoration.mark({ class: "md-callout-anchor" }).range(a.from, a.to));
  }

  // ---- Math ----
  // Whole display blocks (rendered widget / preview) live in the state field;
  // here only single-line display and inline formulas — rendered when the
  // caret is outside, source + rendering copy while editing.
  for (const region of maths) {
    if (region.to < visibleFrom || region.from > visibleTo) continue;
    if (inRangeList(exclude, region.from, region.to)) continue;

    const singleLine =
      !region.display ||
      doc.lineAt(region.from).number === doc.lineAt(Math.max(region.from, region.to - 1)).number;

    // Inline math is decided by the "body", not by active(): the boundary
    // positions (from/to) lie outside the widget, and after collapsing the
    // source the caret rests right after the rendered result (the natural spot
    // after tabbing out or after typing the closing $). Block-level math still
    // uses active() — the boundary positions of a whole-line widget belong to
    // the block's own line.
    //
    // While editing, source + **a rendered copy right after the closing
    // delimiter**: the copy is an inline box, so the text behind it (including
    // the next formula on the same line, when editing a in `a xxxx b`) is
    // pushed back as a whole and nothing is covered. Block formulas get their
    // preview from the block layer below the source; inline regions have no
    // such layer, so it has to be added here.
    if (selections.some((r) => selectionInMathBody(region, r.from, r.to))) {
      highlightMathSource(doc, region, out);
      if (singleLine && hooks.mathPreview !== false && region.content.trim()) {
        out.inline.push(
          Decoration.widget({
            widget: new MathInlinePreviewWidget(region.content),
            side: 1,
          }).range(region.to),
        );
      }
      continue;
    }

    if (!singleLine) continue; // rendered by the block-decorations field

    if (claim(region.from, region.to)) {
      // The `to` of a single-line region must not pass the line end: once a
      // replace crosses the newline, CM6 throws "Decorations that replace
      // line breaks may not be specified via plugins".
      const to = Math.min(region.to, doc.lineAt(region.from).to);
      out.inline.push(
        // `from` goes to the widget as well: a click on the rendered formula
        // must find the region back via dataset.mathFrom and land inside the
        // body (the boundary positions no longer expand the source, see
        // selectionInMathBody).
        Decoration.replace({ widget: new MathWidget(region.content, false, region.from) }).range(
          region.from,
          to,
        ),
      );
    }
  }

  // ---- Wikilinks ([[target|alias]]) ----
  const wikiLinks: WikiLinkEntry[] = [];
  decorateWikiLinks(state, visibleFrom, visibleTo, exclude, active, claim, out, wikiLinks);

  wikiLinksPerView.set(view, wikiLinks);
  const set = Decoration.set(out.inline, true);
  perfEnd(t, "livePreview.inline", INLINE_FIELDS, doc.lines, visible.length, out.inline.length);
  return set;
}

// --------------------------------------------------------------------------
// Per-node decoration helpers
// --------------------------------------------------------------------------

const mathTokenRe = /(\$\$)|(\\[a-zA-Z]+|\\.)|([{}[\]^_&~])/g;

/** Obsidian-style syntax coloring of the raw math source shown while the
 *  cursor edits a formula: delimiters purple, commands red, braces/structure
 *  chars orange. Spans are disjoint (single regex pass). */
function highlightMathSource(
  doc: { sliceString(from: number, to?: number): string },
  region: { from: number; to: number },
  out: DecorationSink,
) {
  const text = doc.sliceString(region.from, region.to);
  if (text.length > 20_000) return;
  mathTokenRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = mathTokenRe.exec(text))) {
    const cls = m[1] ? "md-math-delim" : m[2] ? "md-math-cmd" : "md-math-brace";
    const from = region.from + m.index;
    out.inline.push(Decoration.mark({ class: cls }).range(from, from + m[0].length));
  }
}

/** Marker kind of a list item, which picks the line's marker slot width
 *  (`.li-b` / `.li-t` / `.li-o` in global.css). Standard GFM: only `- [ ]` is
 *  a task — a bare `[ ]` line keeps its literal brackets. */
type ListMarkerKind = "li-b" | "li-t" | "li-o";

function listKind(
  doc: { sliceString(from: number, to?: number): string },
  mark: SyntaxNode,
): ListMarkerKind {
  const item = mark.parent;
  if (item && item.getChild("Task") !== null) return "li-t";
  return /^\d/.test(doc.sliceString(mark.from, mark.to)) ? "li-o" : "li-b";
}

/** End of the space/tab run at `pos`, capped at the end of its line. */
function whitespaceEnd(
  doc: { sliceString(from: number, to?: number): string; lineAt(pos: number): { to: number } },
  pos: number,
): number {
  const end = doc.lineAt(pos).to;
  let to = pos;
  while (to < end && /[ \t]/.test(doc.sliceString(to, to + 1))) to++;
  return to;
}

/**
 * For an empty list item (the whitespace after the marker runs to the end of
 * the line) with the caret resting at the start of the item, the marker's
 * replace decoration must not swallow the trailing whitespace: that would
 * leave the line without any text node, and the caret — sitting on the
 * element position at the widget's boundary — gets no caret rectangle from
 * WebKit (getClientRects is empty), so the drawing degenerates to the edge
 * of the line content: after continuing a list with Enter the caret "flashes
 * to the line start" and only the next layout change puts it back where it
 * belongs. Keep that space as the text anchor; the caret's document position
 * (the start of the item text) is correct, what is missing is only a
 * visible anchor.
 */
function keepMarkerTrailingSpace(
  selections: readonly { from: number; to: number }[],
  lineFrom: number,
  lineTo: number,
  wsTo: number,
): boolean {
  return (
    wsTo === lineTo &&
    selections.some((r) => r.from <= lineTo && r.to >= lineFrom && r.from >= wsTo)
  );
}

/**
 * The parsing ambiguity of an empty list item: a bare `-` line after a
 * paragraph (optionally with trailing whitespace) is ambiguous with the
 * underline of a setext level-2 heading in CommonMark, and the parser picks
 * setext — there is no ListMark in the tree, so the bullet widget can never
 * be built. The empty item cut out after a paragraph with Cmd+; therefore
 * looks like "it did not work", and only when the first character is typed
 * does the parse flip into a list and the whole line reflows, which reads as
 * a stutter.
 *
 * The rendering layer treats that shape as an empty list item: zero indent,
 * a single `-`, and nothing but whitespace left on the line. The decoration
 * is exactly the same shape as a real ListMark (li-i0 li-b line decoration +
 * ListBulletWidget), so when body text is typed and the parse flips into a
 * ListMark the result is visually seamless. A real setext usage (more than
 * one `-` in the underline, or body text still on the line) does not match
 * and stays as it is.
 */
function decorateSetextDash(
  doc: {
    sliceString(from: number, to?: number): string;
    lineAt(pos: number): { from: number; to: number };
  },
  node: SyntaxNode,
  selections: readonly { from: number; to: number }[],
  out: DecorationSink,
  claim: (from: number, to: number) => boolean,
) {
  const markLine = doc.lineAt(Math.max(node.from, node.to - 1));
  let found: SyntaxNode | null = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "HeaderMark") {
      found = child;
      break;
    }
  }
  if (!found || found.from !== markLine.from) return;
  const mark: SyntaxNode = found;
  if (doc.sliceString(mark.from, mark.to) !== "-") return;
  const wsTo = whitespaceEnd(doc, mark.to);
  if (wsTo !== markLine.to) return;
  // The line decoration follows the same rule as the ListMark branch: it is
  // pushed on the active line too, so the layout does not shift as the caret
  // enters and leaves.
  out.inline.push(Decoration.line({ class: "md-list-line li-i0 li-b" }).range(markLine.from));
  // When the caret presses into the marker characters it flips back to
  // editable source (the same activity rule as for ListMark).
  if (selections.some((r) => r.from <= mark.to && r.to >= mark.from)) return;
  const to = keepMarkerTrailingSpace(selections, markLine.from, markLine.to, wsTo) ? mark.to : wsTo;
  if (claim(mark.from, to)) {
    out.inline.push(Decoration.replace({ widget: new ListBulletWidget() }).range(mark.from, to));
  }
}

/**
 * Renders the list marker (`-`, `*`, `+`, `1.`) per item kind:
 * task items hide the marker entirely (the checkbox from `- [ ]` becomes the
 * line's lead, matching Obsidian), bullets become a `•` glyph, ordered
 * markers stay visible but dimmed. Bullets and checkboxes also swallow the
 * whitespace after the marker: the widget then covers the item's whole marker
 * slot, so the item text starts exactly at the line's `--li-hang` (where
 * wrapped lines align) instead of a literal space further right.
 */
function decorateListMark(
  doc: { sliceString(from: number, to?: number): string; lineAt(pos: number): { to: number } },
  mark: SyntaxNode,
  kind: ListMarkerKind,
  out: DecorationSink,
  claim: (from: number, to: number) => boolean,
  keepTrailingSpace: boolean,
) {
  if (kind === "li-t") {
    // Hide the marker plus the gap before the `[ ]` checkbox.
    const to = whitespaceEnd(doc, mark.to);
    if (claim(mark.from, to)) {
      out.inline.push(Decoration.replace({}).range(mark.from, to));
    }
    return;
  }
  if (kind === "li-o") {
    out.inline.push(Decoration.mark({ class: "md-listmark" }).range(mark.from, mark.to));
    return;
  }
  let to = whitespaceEnd(doc, mark.to);
  if (keepTrailingSpace) to = mark.to;
  if (claim(mark.from, to)) {
    out.inline.push(Decoration.replace({ widget: new ListBulletWidget() }).range(mark.from, to));
  }
}

function decorateHeading(
  doc: {
    sliceString(from: number, to?: number): string;
    lineAt(pos: number): { from: number; to: number; number: number };
  },
  node: SyntaxNode,
  level: number,
  out: DecorationSink,
  claim: (from: number, to: number) => boolean,
  isActive: boolean,
) {
  let mark: SyntaxNode | null = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "HeaderMark") {
      mark = child;
      break;
    }
  }
  if (!mark) return;
  // Hide the hashes plus following spaces so the text starts at the left edge.
  // On the active line they stay visible for editing.
  let contentFrom = mark.to;
  while (contentFrom < node.to && doc.sliceString(contentFrom, contentFrom + 1) === " ") {
    contentFrom++;
  }
  if (!isActive && contentFrom > mark.from && claim(mark.from, contentFrom)) {
    out.inline.push(Decoration.replace({}).range(mark.from, contentFrom));
  } else if (isActive) {
    // Raw `#` markers on the active line, dimmed like Obsidian's formatting.
    out.inline.push(Decoration.mark({ class: "md-hmark" }).range(mark.from, contentFrom));
  }
  out.inline.push(
    Decoration.mark({ class: `md-heading md-h${level}` }).range(contentFrom, node.to),
  );
}

/** Only hides the delimiters of emphasis / bold / strikethrough; the text
 *  styling (italic, bold, color) is drawn by emphasisMarksExtension — that
 *  rule must be able to recognize nodes mispaired inside math. */
function hideEmphasisMarks(
  node: SyntaxNode,
  out: DecorationSink,
  claim: (from: number, to: number) => boolean,
) {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name !== "EmphasisMark" && child.name !== "StrikethroughMark") continue;
    if (claim(child.from, child.to)) {
      out.inline.push(Decoration.replace({}).range(child.from, child.to));
    }
  }
}

function decorateInlineCode(
  node: SyntaxNode,
  out: DecorationSink,
  claim: (from: number, to: number) => boolean,
) {
  const marks: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeMark") marks.push(child);
  }
  if (marks.length < 2) return;
  const first = marks[0];
  const last = marks[marks.length - 1];
  if (claim(first.from, first.to)) {
    out.inline.push(Decoration.replace({}).range(first.from, first.to));
  }
  if (claim(last.from, last.to)) {
    out.inline.push(Decoration.replace({}).range(last.from, last.to));
  }
  if (last.from > first.to) {
    out.inline.push(Decoration.mark({ class: "md-inline-code" }).range(first.to, last.from));
  }
}

/** Content-line styling for fenced code; hiding the fence lines themselves is
 *  the block-decorations field's job. */
function decorateFencedCodeLines(
  doc: {
    lineAt(pos: number): { from: number; to: number; number: number };
    line(n: number): { from: number; to: number };
  },
  node: SyntaxNode,
  out: DecorationSink,
) {
  let openLineNo = -1;
  let closeLineNo = -1;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeMark") {
      const line = doc.lineAt(child.from);
      if (openLineNo === -1) openLineNo = line.number;
      else closeLineNo = line.number;
    }
  }
  if (openLineNo === -1) return;
  const startLine = openLineNo + 1;
  const endLine = closeLineNo === -1 ? doc.lineAt(node.to - 1).number : closeLineNo - 1;
  for (let n = startLine; n <= endLine; n++) {
    const line = doc.line(n);
    out.inline.push(Decoration.line({ class: "md-code-line" }).range(line.from));
  }
}

function decorateBlockquote(
  doc: {
    lineAt(pos: number): { from: number; to: number; number: number };
    line(n: number): { from: number; to: number };
  },
  node: SyntaxNode,
  selections: readonly { from: number; to: number }[],
  out: DecorationSink,
) {
  const firstLine = doc.lineAt(node.from).number;
  const lastLine = doc.lineAt(Math.max(node.from, node.to - 1)).number;
  for (let n = firstLine; n <= lastLine; n++) {
    const line = doc.line(n);
    const isActive = selections.some((r) => r.from <= line.to && r.to >= line.from);
    if (!isActive) {
      out.inline.push(Decoration.line({ class: "md-quote" }).range(line.from));
    }
  }
}

/** Image file extensions: they decide whether `![[…]]` is an image embed or a plain wikilink. */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?|heic)$/i;

/** The directory part (the last path segment removed); null when there is no directory. */
function dirOf(path: string | null): string | null {
  if (!path) return null;
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : null;
}

/** Decodes escapes such as `%20` (a reference written by hand in a note may be escaped). */
function decodeRef(raw: string): string {
  if (!raw.includes("%")) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Absolute path -> a URL of the Tauri asset protocol; outside Tauri (the
 *  harness) the path is returned unchanged, so the decoration itself can still
 *  be built in the browser (the image just fails to load). */
function assetSrc(absPath: string): string {
  const normalized = absPath.replace(/\/{2,}/g, "/");
  try {
    return convertFileSrc(normalized);
  } catch {
    return normalized;
  }
}

/** Finds a media file in the vault by file name (Obsidian's attachment
 *  references carry only the file name). With several same-named files the
 *  shortest path wins, matching Obsidian's "shortest path" rule. */
function findAssetByName(name: string): string | null {
  let best: string | null = null;
  for (const rel of useAppStore.getState().flatAssets) {
    if (rel !== name && !rel.endsWith(`/${name}`)) continue;
    if (best === null || rel.length < best.length) best = rel;
  }
  return best;
}

/**
 * The candidate URLs of one image reference, in the order they are tried.
 *
 * Several different resolution conventions coexist in the same vault, and
 * **none of them can be decided in advance** (checking whether a file exists
 * is asynchronous IPC while the decorations are built synchronously), so the
 * candidates are handed to the widget as a list: on a load failure it tries
 * the next one.
 *
 * 1. Relative to the directory of the note — the standard markdown form and
 *    also what the PDF converter writes (`assets/<stem>/p1-fig1.svg` next to
 *    `<stem>.md`);
 * 2. Relative to the vault root — Obsidian's convention for `![](…)`;
 * 3. By file name across the whole vault — `![[Pasted image 1.png]]` and
 *    Obsidian's "shortest path" references.
 */
function imageCandidates(raw: string, state: EditorState): string[] {
  const ref = raw.trim();
  if (!ref) return [];
  if (/^(https?:|data:|blob:)/i.test(ref)) return [ref];
  if (/^asset:/i.test(ref)) return [ref];

  const out: string[] = [];
  const add = (abs: string | null) => {
    if (!abs) return;
    const url = assetSrc(abs);
    if (url && !out.includes(url)) out.push(url);
  };
  const { vaultPath } = useAppStore.getState();
  const decoded = decodeRef(ref);
  if (decoded.startsWith("/")) {
    // It may be an absolute path, or Obsidian's vault-root form — try both.
    add(decoded);
    if (vaultPath) add(`${vaultPath}${decoded}`);
    return out;
  }
  const docDir = dirOf(documentPath(state));
  if (docDir) add(`${docDir}/${decoded}`);
  if (vaultPath) add(`${vaultPath}/${decoded}`);
  // The whole-vault lookup applies to bare file names only: a reference that
  // carries a path must not be shadowed by "some file with the same name".
  if (vaultPath && !decoded.includes("/")) {
    const hit = findAssetByName(decoded);
    if (hit) add(`${vaultPath}/${hit}`);
  }
  return out;
}

/** The alt text of `![alt](url)` (between the first and the second LinkMark). */
function imageAlt(node: SyntaxNode, state: EditorState): string {
  const marks: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "LinkMark") marks.push(child);
    if (marks.length === 2) break;
  }
  if (marks.length < 2 || marks[1].from <= marks[0].to) return "";
  return state.sliceDoc(marks[0].to, marks[1].from);
}

function decorateImage(
  node: SyntaxNode,
  state: EditorState,
  out: DecorationSink,
  claim: (from: number, to: number) => boolean,
) {
  let urlNode: SyntaxNode | null = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "URL") urlNode = child;
  }
  if (!urlNode) return;
  const raw = state.sliceDoc(urlNode.from, urlNode.to).replace(/\s+"[^"]*"$/, "");
  const srcs = imageCandidates(raw, state);
  if (srcs.length === 0) return;
  if (!claim(node.from, node.to)) return;
  out.inline.push(
    Decoration.replace({ widget: new ImageWidget(srcs, imageAlt(node, state), raw) }).range(
      node.from,
      node.to,
    ),
  );
}

/**
 * The preview image candidates of a drawing embed: the drawing file is
 * located by name in the asset list, and the preview PNG is the `.png` with
 * the same stem in the same directory (the canvas exports it automatically on
 * every save). When the asset list holds no drawing file, or the PNG has not
 * been exported yet, the candidates fall back to "find a same-named png
 * across the vault" — the widget renders nothing for an empty candidate
 * list, so the source stays visible and nothing is swallowed.
 */
function drawingEmbedCandidates(target: string): { srcs: string[]; path: string | null } {
  const { vaultPath } = useAppStore.getState();
  if (!vaultPath) return { srcs: [], path: null };
  const srcs: string[] = [];
  const add = (abs: string) => {
    const url = assetSrc(abs);
    if (url && !srcs.includes(url)) srcs.push(url);
  };
  const rel = findAssetByName(target);
  const stem = drawingStem(target);
  if (rel) {
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : null;
    add(`${vaultPath}/${dir ? `${dir}/` : ""}${stem}.png`);
  }
  const pngRel = findAssetByName(`${stem}.png`);
  if (pngRel) add(`${vaultPath}/${pngRel}`);
  return { srcs, path: rel ? `${vaultPath}/${rel}` : null };
}

function decorateLink(node: SyntaxNode, out: DecorationSink) {
  const marks: SyntaxNode[] = [];
  let url: SyntaxNode | null = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "LinkMark") marks.push(child);
    else if (child.name === "URL") url = child;
  }
  if (marks.length >= 2 && url) {
    // label = text between the first two marks: "[label](url)"
    const labelFrom = marks[0].to;
    const labelTo = marks[1].from;
    if (labelTo > labelFrom) {
      out.inline.push(Decoration.mark({ class: "md-link" }).range(labelFrom, labelTo));
    }
    out.inline.push(Decoration.mark({ class: "md-url" }).range(url.from, url.to));
  }
}

function decorateWikiLinks(
  state: EditorState,
  visibleFrom: number,
  visibleTo: number,
  exclude: Interval[],
  active: (from: number, to: number) => boolean,
  claim: (from: number, to: number) => boolean,
  out: DecorationSink,
  wikiLinks: WikiLinkEntry[],
) {
  if (!state.sliceDoc(visibleFrom, visibleTo).includes("[[")) return;
  const doc = state.doc;
  const re = /\[\[([^\[\]\n]+?)\]\]/g;
  let pos = visibleFrom;
  while (pos <= visibleTo) {
    const line = doc.lineAt(pos);
    const lineText = doc.sliceString(line.from, line.to);
    if (lineText.includes("[[") && !active(line.from, line.to)) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(lineText))) {
        const from = line.from + m.index;
        const to = from + m[0].length;
        if (exclude.some((r) => from < r.to && to > r.from)) continue;

        const raw = m[1];
        const pipe = raw.indexOf("|");
        const target = (pipe === -1 ? raw : raw.slice(0, pipe)).split("#")[0].trim();
        const alias = pipe === -1 ? null : raw.slice(pipe + 1);
        if (!target) continue;

        // `![[x.png]]` is an embed, not a link: the whole span (including the
        // leading `!`) renders as an image.
        const embedFrom = m.index > 0 && lineText[m.index - 1] === "!" ? from - 1 : -1;
        if (embedFrom >= 0 && IMAGE_EXT_RE.test(target)) {
          const srcs = imageCandidates(target, state);
          if (srcs.length > 0 && claim(embedFrom, to)) {
            out.inline.push(
              Decoration.replace({
                widget: new ImageWidget(srcs, target, target),
              }).range(embedFrom, to),
            );
            continue;
          }
        }

        // `![[x.excalidraw]]` drawing embed: render the automatically exported
        // preview PNG next to it; clicking it returns to the canvas to edit.
        // The `.excalidraw.md` of older vaults is recognized as well.
        if (embedFrom >= 0 && isDrawingFileName(target)) {
          const { srcs, path } = drawingEmbedCandidates(target);
          if (srcs.length > 0 && claim(embedFrom, to)) {
            out.inline.push(
              Decoration.replace({
                widget: new ImageWidget(srcs, target, target, path ?? undefined),
              }).range(embedFrom, to),
            );
            continue;
          }
        }

        if (!claim(from, from + 2) || !claim(to - 2, to)) continue;

        if (alias !== null) {
          const aliasStart = from + 2 + pipe + 1;
          if (aliasStart > from + 2 && claim(from + 2, aliasStart)) {
            out.inline.push(Decoration.replace({}).range(from + 2, aliasStart));
          }
          out.inline.push(Decoration.mark({ class: "md-wikilink" }).range(aliasStart, to - 2));
        } else {
          out.inline.push(Decoration.mark({ class: "md-wikilink" }).range(from + 2, to - 2));
        }
        out.inline.push(Decoration.replace({}).range(from, from + 2));
        out.inline.push(Decoration.replace({}).range(to - 2, to));
        wikiLinks.push({ from, to, target });
      }
    }
    if (line.to >= visibleTo || line.to >= doc.length) break;
    pos = line.to + 1;
  }
}

// --------------------------------------------------------------------------
// Plugin + click handling
// --------------------------------------------------------------------------

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    inline: DecorationSet = Decoration.none;
    /** The syntax tree used for the last decoration build; once the background
     *  parse advances (dispatched by Language.setState) the decorations are
     *  rebuilt from it — otherwise a freshly loaded file would not render
     *  until the caret moved. */
    tree: Tree;

    constructor(view: EditorView) {
      this.tree = syntaxTree(view.state);
      this.inline = buildInlineDecorations(view);
    }

    update(u: ViewUpdate) {
      const tree = syntaxTree(u.view.state);
      const treeChanged = tree !== this.tree;
      // Switching files must rebuild (the base for relative image paths
      // changes with them): docPath is an effect transaction that changes
      // neither the document nor the caret, so without a special case not a
      // single decoration would update.
      const pathChanged = u.transactions.some((t) => t.effects.some((e) => e.is(setDocPath)));
      if (!u.docChanged && !u.viewportChanged && !u.selectionSet && !treeChanged && !pathChanged)
        return;
      if (!u.docChanged && !u.viewportChanged && !treeChanged && !pathChanged) {
        if (!selectionAffectsDecos(u.startState, u.view.state)) {
          return; // cursor moved within plain text — nothing can change
        }
      }
      this.inline = buildInlineDecorations(u.view);
      this.tree = tree;
    }
  },
  {
    decorations: (v) => v.inline,
  },
);

const linkHandlers = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement | null;
    if (!target) return false;

    // The rendered boundary of a callout (title / cap): clicking it goes
    // back to its source line — the caret lands at the start of the opening
    // marker line and the boundary then reveals its source (the same
    // interaction as clicking a rendered math block to return to the source).
    const calloutEdge = target.closest?.(".cw-callout-title, .cw-callout-edge") as
      (HTMLElement & { dataset: { calloutFrom?: string } }) | null;
    if (calloutEdge?.dataset?.calloutFrom) {
      event.preventDefault();
      view.dispatch({ selection: { anchor: Number(calloutEdge.dataset.calloutFrom) } });
      return true;
    }

    // A rendered inline formula: clicking it means entering the body. The
    // boundary positions (from/to) no longer expand the source (see
    // selectionInMathBody), so clicking there would land outside the formula
    // and look like the click missed. The landing point is the body start or
    // end depending on the horizontal position, matching the "edit where you
    // click" intuition.
    const mathInline = target.closest?.(".cw-math-inline") as HTMLElement | null;
    if (mathInline?.dataset?.mathFrom) {
      const region = mathRegions(view.state).find(
        (r) => r.from === Number(mathInline.dataset.mathFrom),
      );
      if (region) {
        const body = mathBodySpan(region);
        const rect = mathInline.getBoundingClientRect();
        const anchor = event.clientX < rect.left + rect.width / 2 ? body.from : body.to;
        event.preventDefault();
        view.dispatch({ selection: { anchor } });
        return true;
      }
    }

    // Rendered display-math block: reopen the raw source at the clicked line.
    const mathBlock = target.closest?.(".cw-math-block") as HTMLElement | null;
    if (mathBlock?.dataset?.mathFrom) {
      const region = mathRegions(view.state).find(
        (r) => r.from === Number(mathBlock.dataset.mathFrom),
      );
      if (region) {
        const doc = view.state.doc;
        const openNo = doc.lineAt(region.from).number;
        const closeNo = doc.lineAt(region.to).number;
        const rect = mathBlock.getBoundingClientRect();
        const total = closeNo - openNo + 1;
        const frac = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;
        const line = doc.line(openNo + Math.min(total - 1, Math.max(0, Math.floor(frac * total))));
        const mapped = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
        const anchor = Math.min(line.to, Math.max(line.from, mapped ?? line.from));
        event.preventDefault();
        view.dispatch({ selection: { anchor } });
        return true;
      }
    }

    // Task checkbox: toggle [ ] <-> [x], keeping the ✅ date stamp in step
    // with the toggleTodo cycle (done = checked + stamp).
    const task = target.closest?.(".md-task");
    if (task) {
      let pos: number;
      try {
        pos = view.posAtDOM(task, 0);
      } catch {
        return false;
      }
      const line = view.state.doc.lineAt(pos);
      const m = /^(\s*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\](.*)$/.exec(line.text);
      if (m) {
        const markFrom = line.from + m[1].length;
        const stamp = DONE_STAMP_RE.exec(m[3]);
        const textEnd = markFrom + 3 + (stamp ? stamp.index : m[3].length);
        event.preventDefault();
        const changes: { from: number; to?: number; insert: string }[] = [
          { from: markFrom + 1, to: markFrom + 2, insert: m[2] === " " ? "x" : " " },
        ];
        if (m[2] === " ") {
          changes.push({ from: textEnd, to: line.to, insert: ` ✅ ${todayStamp()}` });
        } else if (stamp) {
          changes.push({ from: textEnd, to: line.to, insert: "" });
        }
        view.dispatch({ changes });
        return true;
      }
      return false;
    }

    const isWiki = target.closest?.(".md-wikilink");
    const isLink = target.closest?.(".md-link, .md-url");

    // The preview image of a drawing embed: open the canvas to edit that file
    // (checked before the plain image path).
    const image = target.closest?.(".cw-image") as HTMLElement | null;
    if (image?.dataset?.excalidrawPath && hooks.openDrawing) {
      event.preventDefault();
      hooks.openDrawing(image.dataset.excalidrawPath);
      return true;
    }

    if (!isWiki && !isLink) return false;

    let pos: number;
    try {
      pos = view.posAtDOM(target, 0);
    } catch {
      return false;
    }

    if (isWiki) {
      const entries = wikiLinksPerView.get(view) ?? [];
      const entry = entries.find((e) => pos >= e.from && pos <= e.to);
      if (entry && hooks.openWikiLink) {
        event.preventDefault();
        hooks.openWikiLink(entry.target);
        return true;
      }
      return false;
    }

    // External link: resolve URL from the syntax tree.
    const node = syntaxTree(view.state).resolveInner(pos, -1);
    let link: SyntaxNode | null = node.name === "Link" ? node : node.parent;
    while (link && link.name !== "Link") link = link.parent;
    if (link) {
      for (let child = link.firstChild; child; child = child.nextSibling) {
        if (child.name === "URL") {
          const url = view.state.sliceDoc(child.from, child.to);
          if (hooks.openExternalUrl) {
            event.preventDefault();
            hooks.openExternalUrl(url);
            return true;
          }
        }
      }
    }
    return false;
  },
});

export function livePreviewExtension(): Extension {
  return [blockDecorationsField, livePreviewPlugin, linkHandlers];
}
