import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { StateField, Transaction } from "@codemirror/state";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef, Tree } from "@lezer/common";
import { mathRegions } from "./context";
import { DONE_STAMP_RE, todayStamp } from "./ops";
import {
  EscapeCharWidget,
  HiddenLineWidget,
  HrWidget,
  ListBulletWidget,
  MathPreviewWidget,
  MathWidget,
  TaskCheckboxWidget,
} from "./widgets";

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
const wikiLinksPerView = new WeakMap<EditorView, WikiLinkEntry[]>();

export interface LivePreviewHooks {
  openWikiLink?: (target: string) => void;
  openExternalUrl?: (url: string) => void;
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

/** False when a selection-only change provably leaves every decoration as it
 *  was — letting plain-text cursor moves (vim h/j/k/l, arrows) skip rebuilds. */
function selectionAffectsDecos(oldState: EditorState, newState: EditorState): boolean {
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
  return false;
}

// --------------------------------------------------------------------------
// Block decorations — computed inside the state field (no dispatch round trip)
// --------------------------------------------------------------------------

interface BlockStatics {
  /** Fence lines (open/close) of fenced code blocks, hidden unless editing. */
  fences: Interval[];
  codeRanges: Interval[];
  inlineCodeRanges: Interval[];
  hrs: Interval[];
}

function collectBlockStatics(state: EditorState): BlockStatics {
  const fences: Interval[] = [];
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
          for (let child = nodeRef.node.firstChild; child; child = child.nextSibling) {
            if (child.name === "CodeMark") {
              const line = doc.lineAt(child.from);
              fences.push({ from: line.from, to: line.to });
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

function buildBlockDecos(
  state: EditorState,
  statics: BlockStatics,
  ranges: readonly { from: number; to: number }[],
): { decos: DecorationSet; sig: string } {
  const doc = state.doc;
  const maths = mathRegions(state);
  const out: Range<Decoration>[] = [];
  const sig: string[] = [];
  const active = (from: number, to: number) =>
    ranges.some((r) => r.from <= to && r.to >= from);

  const exclude = [...statics.codeRanges, ...statics.inlineCodeRanges];
  const excluded = (from: number, to: number) =>
    exclude.some((r) => from < r.to && to > r.from);

  for (const f of statics.fences) {
    if (!active(f.from, f.to)) {
      out.push(
        Decoration.replace({ widget: new HiddenLineWidget(), block: true }).range(f.from, f.to),
      );
      sig.push(`f${f.from}`);
    }
  }
  for (const hr of statics.hrs) {
    if (!active(hr.from, hr.to)) {
      out.push(Decoration.replace({ widget: new HrWidget(), block: true }).range(hr.from, hr.to));
      sig.push(`h${hr.from}`);
    }
  }
  for (const region of maths) {
    if (!region.display) continue;
    if (excluded(region.from, region.to)) continue;

    if (active(region.from, region.to)) {
      // Editing this formula: live-rendered preview right below the source.
      if (hooks.mathPreview !== false) {
        const anchorLine = doc.lineAt(Math.max(region.from, region.to - 1));
        out.push(
          Decoration.widget({
            widget: new MathPreviewWidget(region.content, true),
            block: true,
          }).range(anchorLine.to),
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
        widget: new MathWidget(region.content, true, region.from),
        block: true,
      }).range(openLine.from, closeLine.to),
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
  /** syntaxTree 引用：装饰依赖语法树，而树是后台逐步解析出来的
   *  （文件切换后首帧是空树）——树推进后必须据此重建。 */
  tree: Tree;
}

function makeBlockValue(
  state: EditorState,
  prev: BlockFieldValue | null,
  tr: Transaction | null,
  tree: Tree,
): BlockFieldValue {
  const docChanged = !!tr && tr.docChanged;
  const statics =
    !prev || docChanged || tree !== prev.tree ? collectBlockStatics(state) : prev.statics;

  const { decos, sig } = buildBlockDecos(state, statics, state.selection.ranges);
  if (prev && !docChanged && sig === prev.sig) {
    // 装饰没变：保留原 DecorationSet，但记下新树，避免后续每次树推进都重算。
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
      // 后台解析按片推进，中间片也会派发更新：只认完成的那一次，
      // 避免大文档解析期间每片都全文重算。
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

function buildInlineDecorations(view: EditorView): DecorationSet {
  const state = view.state;
  const doc = state.doc;
  const visible = view.visibleRanges;
  const selections = state.selection.ranges;

  const out: DecorationSink = { inline: [] };
  const claimed: Interval[] = []; // replace-decorations must not overlap

  const active = (from: number, to: number) =>
    selections.some((r) => r.from <= to && r.to >= from);

  const activeLine = (lineFrom: number, lineTo: number) => active(lineFrom, lineTo);

  const claim = (from: number, to: number) => {
    for (const c of claimed) if (overlaps({ from, to }, c)) return false;
    claimed.push({ from, to });
    return true;
  };

  // Math regions must be known before the syntax-tree walk: nodes fully
  // inside a formula (\, \; { } * …) are LaTeX, not markdown escapes.
  const maths = mathRegions(state);
  const inAnyMath = (from: number, to: number) =>
    maths.some((r) => from >= r.from && to <= r.to);

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
        if (!active(nodeRef.from, nodeRef.to)) {
          decorateEmphasis(nodeRef.node, name === "StrongEmphasis" ? "md-strong" : "md-em", out, claim);
        }
        return false;
      }
      if (name === "Strikethrough") {
        if (!active(nodeRef.from, nodeRef.to)) {
          decorateEmphasis(nodeRef.node, "md-strike", out, claim);
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
            Decoration.replace({ widget: new EscapeCharWidget(char) }).range(nodeRef.from, nodeRef.to),
          );
        }
        return false;
      }
      if (name === "Link") {
        if (!active(nodeRef.from, nodeRef.to)) {
          decorateLink(nodeRef.node, out);
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
        out.inline.push(
          Decoration.line({ class: `md-list-line li-i${depth}` }).range(markLine.from),
        );
        if (spaces > 0 && claim(markLine.from, mark.from)) {
          out.inline.push(Decoration.replace({}).range(markLine.from, mark.from));
        }
        if (!activeLine(nodeRef.from, nodeRef.to)) {
          decorateListMark(doc, mark, out, claim);
        }
        return false;
      }
      if (name === "TaskMarker") {
        const checked = /^\[[xX]\]/.test(doc.sliceString(nodeRef.from, nodeRef.to));
        if (!activeLine(nodeRef.from, nodeRef.to) && claim(nodeRef.from, nodeRef.to)) {
          out.inline.push(
            Decoration.replace({ widget: new TaskCheckboxWidget(checked) }).range(
              nodeRef.from,
              nodeRef.to,
            ),
          );
        }
        return false;
      }
      return true;
    },
  });

  // ---- Math ----
  // Whole display blocks (rendered widget / preview) live in the state field;
  // here only single-line display and inline formulas, plus source highlights
  // for the formula being edited.
  const exclude: Interval[] = [...codeRanges, ...inlineCodeRanges];
  for (const region of maths) {
    if (region.to < visibleFrom || region.from > visibleTo) continue;
    if (inRangeList(exclude, region.from, region.to)) continue;

    if (active(region.from, region.to)) {
      highlightMathSource(doc, region, out);
      continue;
    }

    const singleLine =
      !region.display ||
      doc.lineAt(region.from).number === doc.lineAt(Math.max(region.from, region.to - 1)).number;
    if (!singleLine) continue; // rendered by the block-decorations field

    if (claim(region.from, region.to)) {
      out.inline.push(
        Decoration.replace({ widget: new MathWidget(region.content, false) }).range(
          region.from,
          region.to,
        ),
      );
    }
  }

  // ---- Wikilinks ([[target|alias]]) ----
  const wikiLinks: WikiLinkEntry[] = [];
  decorateWikiLinks(
    state,
    visibleFrom,
    visibleTo,
    exclude,
    active,
    claim,
    out,
    wikiLinks,
  );

  wikiLinksPerView.set(view, wikiLinks);
  return Decoration.set(out.inline, true);
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


/**
 * Renders the list marker (`-`, `*`, `+`, `1.`) per item kind:
 * task items hide the marker entirely (the checkbox from `- [ ]` becomes the
 * line's lead, matching Obsidian), bullets become a `•` glyph, ordered
 * markers stay visible but dimmed. Standard GFM: only `- [ ]` is a task — a
 * bare `[ ]` line keeps its literal brackets.
 */
function decorateListMark(
  doc: { sliceString(from: number, to?: number): string },
  mark: SyntaxNode,
  out: DecorationSink,
  claim: (from: number, to: number) => boolean,
) {
  const item = mark.parent;
  const isTask = !!item && item.getChild("Task") !== null;
  const markText = doc.sliceString(mark.from, mark.to);
  const isOrdered = /^\d/.test(markText);

  if (isTask) {
    // Hide the marker plus the single space before the `[ ]` checkbox.
    let to = mark.to;
    if (doc.sliceString(to, to + 1) === " ") to++;
    if (claim(mark.from, to)) {
      out.inline.push(Decoration.replace({}).range(mark.from, to));
    }
    return;
  }
  if (isOrdered) {
    out.inline.push(Decoration.mark({ class: "md-listmark" }).range(mark.from, mark.to));
    return;
  }
  if (claim(mark.from, mark.to)) {
    out.inline.push(
      Decoration.replace({ widget: new ListBulletWidget() }).range(mark.from, mark.to),
    );
  }
}

function decorateHeading(
  doc: { sliceString(from: number, to?: number): string; lineAt(pos: number): { from: number; to: number; number: number } },
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

function decorateEmphasis(
  node: SyntaxNode,
  contentClass: string,
  out: DecorationSink,
  claim: (from: number, to: number) => boolean,
) {
  const marks: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "EmphasisMark" || child.name === "StrikethroughMark") {
      marks.push(child);
    }
  }
  if (marks.length === 0) return;
  const first = marks[0];
  const last = marks[marks.length - 1];
  for (const m of marks) {
    if (claim(m.from, m.to)) {
      out.inline.push(Decoration.replace({}).range(m.from, m.to));
    }
  }
  if (last.to > first.to) {
    out.inline.push(Decoration.mark({ class: contentClass }).range(first.to, last.from));
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
  doc: { lineAt(pos: number): { from: number; to: number; number: number }; line(n: number): { from: number; to: number } },
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
  doc: { lineAt(pos: number): { from: number; to: number; number: number }; line(n: number): { from: number; to: number } },
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
        if (!claim(from, from + 2) || !claim(to - 2, to)) continue;

        const raw = m[1];
        const pipe = raw.indexOf("|");
        const target = (pipe === -1 ? raw : raw.slice(0, pipe)).split("#")[0].trim();
        const alias = pipe === -1 ? null : raw.slice(pipe + 1);
        if (!target) continue;

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
    /** 上次构建装饰所用的语法树；后台解析推进（Language.setState 派发）
     *  后据此重建——否则刚载入的文件要等光标移动才会渲染。 */
    tree: Tree;

    constructor(view: EditorView) {
      this.tree = syntaxTree(view.state);
      this.inline = buildInlineDecorations(view);
    }

    update(u: ViewUpdate) {
      const tree = syntaxTree(u.view.state);
      const treeChanged = tree !== this.tree;
      if (!u.docChanged && !u.viewportChanged && !u.selectionSet && !treeChanged) return;
      if (!u.docChanged && !u.viewportChanged && !treeChanged) {
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
        const line = doc.line(
          openNo + Math.min(total - 1, Math.max(0, Math.floor(frac * total))),
        );
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
