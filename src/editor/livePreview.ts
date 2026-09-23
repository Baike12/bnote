import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { StateField, Transaction } from "@codemirror/state";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef, Tree } from "@lezer/common";
import { mathRegions } from "./context";
import { documentPath, setDocPath } from "./docPath";
import { useAppStore } from "@/state/appStore";
import { convertFileSrc } from "@tauri-apps/api/core";
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
import { ImageWidget } from "./widgets";
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
  /** 点击画图嵌入的预览图:用画布打开那个 .excalidraw 文件。 */
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

/** 行首「标记槽」的宽度：缩进 + 列表标记 + 后随空白 + 可选任务括号及其空白。
 *  非标记形态（含 `*emphasis*` 这种行内强调开头——标记后必须跟空白或行尾）
 *  返回 null。光标跨过这个槽会翻转标记的活动规则（源码 ⇄ widget），槽边界
 *  与各渲染分支的 active() 判定对齐（触点算活动，因此判定用 <=）。 */
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
  if (j >= text.length) return j; // 行以标记结尾（裸 "-"）
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
 *  导出供性能门禁锁快路径:标记槽之外的同行纯移动必须返回 false。 */
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
  // 同行内跨「标记槽」移动：ListMark/TaskMarker 的活动规则、空项的尾随
  // 空白保留（keepMarkerTrailingSpace）都依赖同行内的光标位置——vim 的
  // 0/$/A 这类同行移动曾把裸 `-`/裸 `[ ]` 永久留在屏上（渲染回归）。
  for (let i = 0; i < newRanges.length; i++) {
    const o = oldRanges[i];
    const n = newRanges[i];
    if (o.from === n.from && o.to === n.to) continue;
    const line = doc.lineAt(n.from);
    const slotEnd = markerSlotEnd(line.text);
    if (slotEnd === null) continue;
    if (slotEnd >= line.to - line.from) return true; // 空列表项:任何同行移动都可能翻转空白保留
    const base = line.from;
    if ((o.from - base <= slotEnd) !== (n.from - base <= slotEnd)) return true;
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
    // 块级判定（与公式块同一条规则）：光标在块内任何一行，两行围栏都保持
    // 源码可编辑；光标离开整块才隐藏围栏进入渲染态。
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
      // 空内容没有可预览的东西，不占位——插入公式块后下方立刻多出一段空白。
      if (hooks.mathPreview !== false && region.content.trim()) {
        const anchorLine = doc.lineAt(Math.max(region.from, region.to - 1));
        // 块级 widget 必须锚在行首：锚在 anchorLine.to（换行符之前）会把该行
        // 劈成两行，DOM 里多出一个不属于任何文档行的幽灵空行（预览与下文
        // 之间的大间隙，j/k 的像素落点也随之多一步）。
        const anchor =
          anchorLine.to < doc.length ? doc.line(anchorLine.number + 1).from : doc.length;
        out.push(
          Decoration.widget({
            widget: new MathPreviewWidget(region.content, true),
            block: true,
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

/** 包内唯一需要的视图面：装饰构建只读 state 与视口范围。测试用它构造
 *  无 DOM 的假视图，锁住「标记 token 活动规则」等几何模型。 */
export interface DecorationBuildView {
  state: EditorState;
  visibleRanges: readonly { from: number; to: number }[];
}

/** Viewport-scoped inline decorations（斜体、列表标记、行内公式、wikilink…）。
 *  导出是为了测试能在无 DOM 的假视图上锁住 token 活动规则。 */
export function buildInlineDecorations(view: DecorationBuildView): DecorationSet {
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
      if (name === "SetextHeading2") {
        decorateSetextDash(doc, nodeRef.node, selections, out, claim);
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
      if (name === "Image") {
        if (!active(nodeRef.from, nodeRef.to)) {
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
            keepMarkerTrailingSpace(selections, markLine.from, markLine.to, whitespaceEnd(doc, mark.to)),
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
            Decoration.replace({ widget: new TaskCheckboxWidget(checked) }).range(
              nodeRef.from,
              to,
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
      // 单行区域的 to 必须不越过行尾:replace 一旦跨过换行符,CM6 直接抛
      // "Decorations that replace line breaks may not be specified via plugins"。
      const to = Math.min(region.to, doc.lineAt(region.from).to);
      out.inline.push(
        Decoration.replace({ widget: new MathWidget(region.content, false) }).range(
          region.from,
          to,
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
 * 空列表项（标记后的空白直达行尾）且光标停在项首时，marker 的替换装饰不能
 * 把行尾空白一起吞掉：那会让整行没有任何文本节点，光标落在 widget 边界的
 * 元素位置上，WebKit 算不出光标矩形（getClientRects 为空），绘制退化到行
 * 内容边缘——Enter 续行后光标“闪到行首”，下一次布局变化才落回正确位置。
 * 保留这个空格作文本锚点；光标的文档位置（项文本起点）本身是对的，缺的
 * 只是可见锚点。
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
 * 空列表项的解析歧义:段落后的裸 `-` 行(可带尾随空白)在 CommonMark 里与
 * setext 二级标题的下划线歧义,且解析器取 setext——树里没有 ListMark,
 * bullet widget 永远建不出来。Cmd+; 在段落后切出的空项因此看起来“没生效”,
 * 输入第一个字符时解析才翻转成列表、整行重排,读作卡顿。
 *
 * 渲染层把这种形态按空列表项处理:零缩进、单个 `-`、行内余下全是空白。
 * 装饰与真 ListMark 完全同形(li-i0 li-b 行装饰 + ListBulletWidget),正文
 * 键入后解析翻转成 ListMark 时视觉无缝。真 setext 用法(下划线多于一个
 * `-`、或行内还有正文)不命中,维持原样。
 */
function decorateSetextDash(
  doc: { sliceString(from: number, to?: number): string; lineAt(pos: number): { from: number; to: number } },
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
  // 行装饰与 ListMark 分支同规矩:活动行也推,布局不随光标进出位移。
  out.inline.push(Decoration.line({ class: "md-list-line li-i0 li-b" }).range(markLine.from));
  // 光标压进标记字符时翻回源码可编辑(与 ListMark 同一条活动规则)。
  if (selections.some((r) => r.from <= mark.to && r.to >= mark.from)) return;
  const to = keepMarkerTrailingSpace(selections, markLine.from, markLine.to, wsTo)
    ? mark.to
    : wsTo;
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

/** 图片类扩展名:决定 `![[…]]` 是图片嵌入还是普通 wikilink。 */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?|heic)$/i;

/** 目录部分(去掉最后一段);没有目录时返回 null。 */
function dirOf(path: string | null): string | null {
  if (!path) return null;
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : null;
}

/** `%20` 之类的转义还原(笔记里手写的引用可能是转义过的)。 */
function decodeRef(raw: string): string {
  if (!raw.includes("%")) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 绝对路径 → Tauri asset 协议的 URL;非 Tauri 环境(harness)原样返回,
 *  这样装饰本身在浏览器里也能建出来(只是图片必然加载失败)。 */
function assetSrc(absPath: string): string {
  const normalized = absPath.replace(/\/{2,}/g, "/");
  try {
    return convertFileSrc(normalized);
  } catch {
    return normalized;
  }
}

/** vault 里按文件名找媒体文件(Obsidian 的附件引用就是只写文件名)。
 *  同名多个时取路径最短的那个,与 Obsidian 的「shortest path」一致。 */
function findAssetByName(name: string): string | null {
  let best: string | null = null;
  for (const rel of useAppStore.getState().flatAssets) {
    if (rel !== name && !rel.endsWith(`/${name}`)) continue;
    if (best === null || rel.length < best.length) best = rel;
  }
  return best;
}

/**
 * 一条图片引用的候选 URL,按尝试顺序排列。
 *
 * 同一个 vault 里同时存在几种互不相同的解析约定,而且**都没法事先判断**
 * (查文件是否存在是异步 IPC,装饰是同步构建的),所以把候选排成一列交给
 * widget:加载失败就试下一个。
 *
 * 1. 相对笔记所在目录 —— 标准 markdown 写法,也是 PDF 转换器写出来的形式
 *    (`<stem>.md` 旁边的 `assets/<stem>/p1-fig1.svg`);
 * 2. 相对 vault 根 —— Obsidian 对 `![](…)` 的约定;
 * 3. 按文件名在整个 vault 里找 —— `![[Pasted image 1.png]]`,以及 Obsidian
 *    的「shortest path」引用。
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
    // 既可能是绝对路径,也可能是 Obsidian 的 vault 根写法,两个都试。
    add(decoded);
    if (vaultPath) add(`${vaultPath}${decoded}`);
    return out;
  }
  const docDir = dirOf(documentPath(state));
  if (docDir) add(`${docDir}/${decoded}`);
  if (vaultPath) add(`${vaultPath}/${decoded}`);
  // 只对纯文件名做全库查找:带路径的引用不该被"随便一个同名文件"顶掉。
  if (vaultPath && !decoded.includes("/")) {
    const hit = findAssetByName(decoded);
    if (hit) add(`${vaultPath}/${hit}`);
  }
  return out;
}

/** `![alt](url)` 的 alt 文本(第一个和第二个 LinkMark 之间)。 */
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
 * 画图嵌入的预览图候选:画图文件按文件名在资产清单里定位,预览 PNG 就是
 * 同目录同名 `.png`(画布每次保存自动导出)。清单里没有画图文件、或 PNG
 * 还没导出过时,依次落到「全库找同名 png」——widget 对空候选直接不渲染,
 * 源码保持可见,不吞内容。
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

        // `![[x.png]]` 是嵌入,不是链接:整段(含开头的 `!`)渲染成图片。
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

        // `![[x.excalidraw]]` 画图嵌入:渲染旁边那张自动导出的预览 PNG,
        // 点开可回画布编辑。老库里的 `.excalidraw.md` 同样认。
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
      // 换了文件(图片的相对路径基准跟着变)必须重建:docPath 是 effect
      // 事务,本身不改文档也不动光标,不特判就一条装饰都不会更新。
      const pathChanged = u.transactions.some((t) =>
        t.effects.some((e) => e.is(setDocPath)),
      );
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

    // 画图嵌入的预览图:打开画布编辑那个文件(先于普通图片路径判断)。
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
