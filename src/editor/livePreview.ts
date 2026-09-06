import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import { mathRegions } from "./context";
import { EscapeCharWidget, HiddenLineWidget, HrWidget, MathWidget, TaskCheckboxWidget } from "./widgets";

/**
 * Obsidian-style live preview: everything in the viewport is rendered
 * (headings, emphasis, code fences, math, links…) except the line the cursor
 * is on — and whole math/code blocks while the cursor is inside them, which
 * stay as raw source for editing.
 *
 * CodeMirror only allows block replace decorations from STATIC facet values
 * (state fields) — neither plugins nor dynamic facet functions may provide
 * them. So the plugin computes both sets, and block ones are handed to the
 * field below via an effect dispatched from an update listener (guarded by a
 * signature to avoid dispatch loops).
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
}

const hooks: LivePreviewHooks = {};

export function configureLivePreview(h: LivePreviewHooks) {
  Object.assign(hooks, h);
}

function overlaps(a: Interval, b: Interval) {
  return a.from < b.to && a.to > b.from;
}

interface DecorationSink {
  inline: Range<Decoration>[];
  block: Range<Decoration>[];
  /** `${from}:${to}:${kind}` per block range, for change detection. */
  blockSig: string[];
}

function addBlock(out: DecorationSink, from: number, to: number, deco: Decoration, kind: string) {
  out.block.push(deco.range(from, to));
  out.blockSig.push(`${from}:${to}:${kind}`);
}

const setBlockDecorations = StateEffect.define<DecorationSet>();

/** Holds the block replace decorations (hidden fences, display math, rules);
 *  CM6 only accepts block decorations from a state field. */
export const blockDecorationsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setBlockDecorations)) next = e.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function buildDecorations(
  view: EditorView,
): { inline: DecorationSet; block: DecorationSet; blockSig: string[]; wikiLinks: WikiLinkEntry[] } {
  const state = view.state;
  const doc = state.doc;
  const visible = view.visibleRanges;
  const selections = state.selection.ranges;

  const out: DecorationSink = { inline: [], block: [], blockSig: [] };
  const claimed: Interval[] = []; // replace-decorations must not overlap
  const wikiLinks: WikiLinkEntry[] = [];

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
        const node = nodeRef.node;
        codeRanges.push({ from: node.from, to: node.to });
        if (!active(node.from, node.to)) {
          decorateFencedCode(doc, node, out, claim);
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
        if (!activeLine(nodeRef.from, nodeRef.to)) {
          decorateHeading(doc, nodeRef.node, level, out, claim);
        }
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
        if (!activeLine(nodeRef.from, nodeRef.to) && claim(nodeRef.from, nodeRef.to)) {
          addBlock(out, nodeRef.from, nodeRef.to, Decoration.replace({ widget: new HrWidget(), block: true }), "hr");
        }
        return false;
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
      if (name === "ListItemMark") {
        if (!activeLine(nodeRef.from, nodeRef.to)) {
          out.inline.push(Decoration.mark({ class: "md-listmark" }).range(nodeRef.from, nodeRef.to));
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
          if (checked) {
            // Dim the rest of the completed item's line (Obsidian-style).
            const lineEnd = doc.lineAt(nodeRef.to).to;
            if (lineEnd > nodeRef.to) {
              out.inline.push(Decoration.mark({ class: "md-task-done" }).range(nodeRef.to, lineEnd));
            }
          }
        }
        return false;
      }
      return true;
    },
  });

  // ---- Math ----
  const exclude: Interval[] = [...codeRanges, ...inlineCodeRanges];
  for (const region of maths) {
    if (region.to < visibleFrom || region.from > visibleTo) continue;
    if (active(region.from, region.to)) continue;
    if (inRangeList(exclude, region.from, region.to)) continue;

    if (region.display) {
      const openLine = doc.lineAt(region.from);
      const closeLine = doc.lineAt(Math.max(region.from, region.to - 1));
      if (openLine.number === closeLine.number) {
        if (claim(region.from, region.to)) {
          out.inline.push(
            Decoration.replace({ widget: new MathWidget(region.content, false) }).range(
              region.from,
              region.to,
            ),
          );
        }
      } else {
        const from = openLine.from;
        const to = closeLine.to;
        if (claim(from, to)) {
          addBlock(
            out,
            from,
            to,
            Decoration.replace({ widget: new MathWidget(region.content, true), block: true }),
            `math:${region.content}`,
          );
        }
      }
    } else {
      if (claim(region.from, region.to)) {
        out.inline.push(
          Decoration.replace({ widget: new MathWidget(region.content, false) }).range(
            region.from,
            region.to,
          ),
        );
      }
    }
  }

  // ---- Wikilinks ([[target|alias]]) ----
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
  return {
    inline: Decoration.set(out.inline, true),
    block: Decoration.set(out.block, true),
    blockSig: out.blockSig,
    wikiLinks,
  };
}

// --------------------------------------------------------------------------
// Per-node decoration helpers
// --------------------------------------------------------------------------

function decorateHeading(
  doc: { sliceString(from: number, to?: number): string; lineAt(pos: number): { from: number; to: number; number: number } },
  node: SyntaxNode,
  level: number,
  out: DecorationSink,
  claim: (from: number, to: number) => boolean,
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
  let contentFrom = mark.to;
  while (contentFrom < node.to && doc.sliceString(contentFrom, contentFrom + 1) === " ") {
    contentFrom++;
  }
  if (contentFrom > mark.from && claim(mark.from, contentFrom)) {
    out.inline.push(Decoration.replace({}).range(mark.from, contentFrom));
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

function decorateFencedCode(
  doc: { lineAt(pos: number): { from: number; to: number; number: number }; line(n: number): { from: number; to: number } },
  node: SyntaxNode,
  out: DecorationSink,
  claim: (from: number, to: number) => boolean,
) {
  let openLineNo = -1;
  let closeLineNo = -1;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeMark") {
      const line = doc.lineAt(child.from);
      if (openLineNo === -1) openLineNo = line.number;
      else closeLineNo = line.number;
      if (claim(line.from, line.to)) {
        addBlock(
          out,
          line.from,
          line.to,
          Decoration.replace({ widget: new HiddenLineWidget(), block: true }),
          `fence:${line.number}`,
        );
      }
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
    /** Set when the block decoration set changed and must be pushed to the
     *  state field by the sync listener (dispatch is illegal mid-update). */
    pendingBlock: DecorationSet | null = null;
    private lastSig: string[] = [];

    constructor(view: EditorView) {
      this.rebuild(view);
    }

    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.rebuild(u.view);
      }
    }

    private rebuild(view: EditorView) {
      const built = buildDecorations(view);
      this.inline = built.inline;
      if (!arrayEquals(this.lastSig, built.blockSig)) {
        this.lastSig = built.blockSig;
        this.pendingBlock = built.block;
      }
    }
  },
  {
    decorations: (v) => v.inline,
  },
);

function arrayEquals(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const blockDecoSync = EditorView.updateListener.of((u) => {
  const plugin = u.view.plugin(livePreviewPlugin);
  if (!plugin?.pendingBlock) return;
  const pending = plugin.pendingBlock;
  plugin.pendingBlock = null;
  u.view.dispatch({ effects: setBlockDecorations.of(pending) });
});

const linkHandlers = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement | null;
    if (!target) return false;

    // Task checkbox: flip [ ] <-> [x] in the source line.
    const task = target.closest?.(".md-task");
    if (task) {
      let pos: number;
      try {
        pos = view.posAtDOM(task, 0);
      } catch {
        return false;
      }
      const line = view.state.doc.lineAt(pos);
      const m = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/.exec(line.text);
      if (m) {
        const markFrom = line.from + m[1].length;
        event.preventDefault();
        view.dispatch({
          changes: { from: markFrom + 1, to: markFrom + 2, insert: m[2] === " " ? "x" : " " },
        });
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
  return [blockDecorationsField, livePreviewPlugin, blockDecoSync, linkHandlers];
}
