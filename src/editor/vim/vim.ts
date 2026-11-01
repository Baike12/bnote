import { vim, Vim, getCM, CodeMirror } from "@replit/codemirror-vim";

// Re-exported for harness/debug access to the underlying engine singleton.
export { Vim, getCM };
import type { EditorView, KeyBinding } from "@codemirror/view";
import { keymap, ViewPlugin, Decoration } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorSelection, RangeSetBuilder } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import { setSearchQuery, SearchQuery } from "@codemirror/search";
import type { VimMapping, VimMode } from "./vimrc";
import { readClipboardText, writeClipboardText } from "@/lib/clipboard";
import { moveByLinesVisual } from "./verticalMotion";

export type RunCommand = (commandId: string) => void;

let runCommandRef: RunCommand = () => {};

/** :w / :wq / :q … plus :Bnote <command-id> for any bnote command. */
export function registerVimExCommands(run: RunCommand) {
  runCommandRef = run;
  Vim.defineEx("write", "w", () => run("workspace.save-note"));
  Vim.defineEx("wq", "wq", () => {
    run("workspace.save-note");
    run("workspace.close-window");
  });
  Vim.defineEx("x", "x", () => {
    run("workspace.save-note");
    run("workspace.close-window");
  });
  Vim.defineEx("quit", "q", () => run("workspace.close-window"));
  Vim.defineEx("noh", "noh", (cm) => {
    const view = (cm as unknown as { cm6: EditorView }).cm6;
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
  });
  Vim.defineEx("Bnote", "B", (_cm, params) => {
    const id = (params?.args ?? [])[0];
    if (id) run(id);
  });
}

export function vimModeExtension(): Extension {
  patchVimNewlineIndent();
  patchVimNotice();
  patchVimVerticalMotion();
  patchVimMarkerFind();
  return vim();
}

/* ---- Bottom messages: suppress the yank notice, turn every other message
   into "dismissed by any key".
   All engine messages go through showConfirm → openNotification (the only
   exit the adapter has):
   - every yank pops a 1.5s red "N lines yanked". In vim that line is governed
     by the report option; the engine implements no such switch and no option
     can turn it off, so it is dropped by content at this layer;
   - every other message (errors, :set echoes) only gets a 15s timer from the
     engine: it cannot be closed and you can only wait it out. Vim's feel is
     "the next command or key clears it", so close is hooked onto
     state.closeVimNotification — the engine's own key path
     (multiSelectHandleKey) calls it on the next keystroke. Long messages
     (the :reg output that needs Enter) are the engine's own business, and
     their behavior is unchanged. ---- */

let noticePatched = false;

/** The yank message showConfirm builds: `N lines yanked`, with a register
 *  suffix `into "a` (the engine misses the closing quote — do not write it as
 *  a normal quoted pair). Both call sites have this shape. */
const YANK_NOTICE = /^\d+ lines yanked(?: into ".+)?$/;

/** How long a non-blocking message stays; the engine defaults to 15s, shortened
 *  to vim's feel (a keystroke still dismisses it immediately). */
const NOTICE_MS = 4000;

function patchVimNotice() {
  if (noticePatched) return;
  noticePatched = true;
  try {
    const proto = CodeMirror.prototype as unknown as {
      openNotification: (
        this: { state: { closeVimNotification?: (() => void) | null } },
        template: HTMLElement,
        options?: { duration?: number },
      ) => (() => void) | undefined;
    };
    const open = proto.openNotification;
    proto.openNotification = function (template, options) {
      if (YANK_NOTICE.test(template.textContent?.trim() ?? "")) return undefined;
      // duration 0 = a long message that needs Enter to confirm; keep it as is.
      const duration = Math.min(options?.duration ?? NOTICE_MS, NOTICE_MS);
      const close = open.call(this, template, { ...options, duration });
      if (typeof close === "function") this.state.closeVimNotification = close;
      return close;
    };
  } catch (e) {
    console.warn("[bnote] vim notice patch failed", e);
  }
}

/* ---- vim o/O indent compat: the engine implements `o`/`O` via CM6's
   insertNewlineAndIndent, which expands a tab indent to spaces (tabStop
   columns). Vim copies the leading whitespace verbatim — patch the shim
   command and the open-line action so o/O keep tabs and exact spaces
   (O takes the CURRENT line's indent, not the line above's). ---- */

let newlineIndentPatched = false;

function patchVimNewlineIndent() {
  if (newlineIndentPatched) return;
  newlineIndentPatched = true;
  try {
    const VimAny = Vim as unknown as Record<string, any>;
    const commands = (CodeMirror as unknown as {
      commands: Record<string, ((cm: { cm6: EditorView }) => void) | undefined>;
    }).commands;
    // Safety net for other engine paths that newline-and-indent.
    commands.newlineAndIndent = (cm) => {
      const view = cm.cm6;
      const state = view.state;
      view.dispatch(
        state.update(
          state.changeByRange((range) => {
            const line = state.doc.lineAt(range.head);
            const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
            return {
              changes: { from: range.head, insert: state.lineBreak + indent },
              range: EditorSelection.cursor(range.head + state.lineBreak.length + indent.length),
            };
          }),
          { scrollIntoView: true, userEvent: "input" },
        ),
      );
    };
    // Faithful port of the engine's newLineAndEnterInsertMode with verbatim
    // indent (O uses the current line's indent, vim-style).
    VimAny.defineAction("newLineAndEnterInsertMode", function (
      this: Record<string, any>,
      cm: { cm6: EditorView },
      actionArgs: { after?: boolean; repeat?: number },
      vimState: Record<string, unknown>,
    ) {
      vimState.insertMode = true;
      const view = cm.cm6;
      const state = view.state;
      const line = state.doc.lineAt(state.selection.main.head);
      const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
      const openAfter = actionArgs.after !== false;
      if (!openAfter && line.number === 1) {
        view.dispatch({
          changes: { from: 0, insert: indent + state.lineBreak },
          selection: { anchor: indent.length },
          scrollIntoView: true,
        });
      } else {
        const at = openAfter ? line.to : state.doc.line(line.number - 1).to;
        view.dispatch({
          changes: { from: at, insert: state.lineBreak + indent },
          selection: { anchor: at + state.lineBreak.length + indent.length },
          scrollIntoView: true,
        });
      }
      this.enterInsertMode(cm, { repeat: actionArgs.repeat }, vimState);
    });
  } catch (e) {
    console.warn("[bnote] vim o/O indent patch failed", e);
  }
}

/* ---- Visually anchored vertical motion: swap the engine's moveByLines for
   the pixel-anchored implementation. The design and its evidence are in the
   comment block at the top of ./verticalMotion.ts. ---- */

let verticalMotionPatched = false;

function patchVimVerticalMotion() {
  if (verticalMotionPatched) return;
  verticalMotionPatched = true;
  const VimAny = Vim as unknown as {
    defineMotion: (name: string, fn: unknown) => void;
  };
  VimAny.defineMotion("moveByLines", moveByLinesVisual);
}

/* ---- Cross-document jump markers: Marker.find() must report "does not
   exist" for an offset that is not in this document instead of throwing. The
   engine's (@replit/codemirror-vim 6.4 / -core 0.1.0) Marker holds a bare
   document offset and find() = posFromIndex(offset); when the offset exceeds
   the current document length Text.lineAt throws RangeError directly. The
   original CM5 TextMarker travels with the document, and once the document is
   gone find() returns undefined, so jumpList.add/move (vim-core
   vim.js:578/603) gracefully skip it as "marker does not exist" — the CM6 port
   dropped that semantics.
   Trigger chain: the jumpList hangs off the engine's module-level singleton
   vimGlobalState and survives across documents and across view.setState; bnote
   switches files through the wholesale setState replacement in
   loadDocument/reloadDocument (setup.ts), not a transaction, so markers are
   never mapPos-ed. So after pressing G/gg/n//… (toJumplist, marker = a large
   offset) in a long document and then switching to a shorter one, gg/G always
   throws at recordJumpPosition → jumpList.add → curMark.find() — the throw
   happens before setSelection, so the caret never lands; the engine's catch
   resets the vim state (the status line still reads NORMAL) and non-jumplist
   keys such as j/k keep working — users see "gg/G does nothing in normal
   mode", and every keystroke hits the same dead marker (add throws before it
   writes the slot, so the pointer does not advance), so it stays broken for
   the whole session, until a restart or opening a longer document flushes the
   poison marker.
   Fix = restore the CM5 semantics: for an out-of-range offset (<0 or
   >doc.length) find() returns null, add() continues in the next slot, and
   move() skips the dead marker as nonexistent. The Marker class is not
   exported, so it can only be reached through an instance's prototype: wrap
   setBookmark (the only place the whole engine constructs a new Marker) and,
   at the moment the first bookmark lands, patch its prototype and tear the
   wrapper down. An out-of-range offset is the only reliable "cross-document
   leftover" signal — document identity is not tracked (after an edit inside
   the same document the Text reference necessarily changes, so identity
   comparison cannot be established); the residue of "the offset is legal but
   semantically wrong" (switching to a document of similar length) matches
   upstream: one odd jump is recorded and then heals. The regression test is
   in ./jumpList.test.ts (real engine + real shim Marker). ---- */

let markerFindPatched = false;
let markerProtoHooked = false;

/** Runs when the first bookmark lands: take Marker.prototype from the
 *  instance and wrap find(). The setBookmark wrapper is torn down right after
 *  (the hook runs once). */
function hookMarkerPrototype(marker: object, restoreSetBookmark: () => void) {
  if (markerProtoHooked) return;
  const proto = Object.getPrototypeOf(marker) as
    | ({ offset: number | null; cm: { cm6: EditorView }; find(): unknown })
    | null;
  if (!proto || typeof proto.find !== "function") return; // Not the shape we recognize: keep the wrapper and try again on the next bookmark
  markerProtoHooked = true;
  restoreSetBookmark();
  const origFind = proto.find;
  proto.find = function (this: { offset: number | null; cm: { cm6: EditorView } }) {
    const offset = this.offset;
    if (offset != null) {
      const doc = this.cm.cm6.state.doc;
      // An offset the current document cannot hold comes from a marker left by another document; report "does not exist" instead of throwing.
      if (offset < 0 || offset > doc.length) return null;
    }
    return origFind.call(this);
  };
}

/** Restores the CM5 semantics of Marker.find() (see the comment block above);
 *  exported only for the gate (jumpList.test.ts has to install the patch first
 *  in a DOM-less node). */
export function patchVimMarkerFind() {
  if (markerFindPatched) return;
  markerFindPatched = true;
  try {
    const proto = CodeMirror.prototype as unknown as {
      setBookmark: (this: CodeMirror, cursor: never, options?: { insertLeft?: boolean }) => object;
    };
    const origSetBookmark = proto.setBookmark;
    proto.setBookmark = function (cursor, options) {
      const marker = origSetBookmark.call(this, cursor, options);
      hookMarkerPrototype(marker, () => {
        proto.setBookmark = origSetBookmark;
      });
      return marker;
    };
  } catch (e) {
    console.warn("[bnote] vim marker find patch failed", e);
  }
}

/* ---- clipboard=unnamed: sync the vim unnamed register with the system clipboard.
   The underlying vim engine already maps register "+" to navigator.clipboard;
   here we patch the unnamed register '"' to follow it: every yank/delete/change
   writes to the clipboard, and p/P reads it back. ---- */

let clipboardUnnamed = false;
let clipboardPatched = false;

export function setVimClipboardUnnamed(on: boolean) {
  clipboardUnnamed = on;
  if (!on || clipboardPatched) return;
  clipboardPatched = true;
  try {
    const VimAny = Vim as unknown as Record<string, any>;
    const controller = VimAny.getRegisterController();
    // Prototype-level patch survives the engine resetting its global state.
    const proto = Object.getPrototypeOf(controller);
    const origPush = proto.pushText;
    proto.pushText = function (
      registerName: string,
      operator: string,
      text: string,
      linewise: boolean,
      blockwise: boolean,
    ) {
      origPush.call(this, registerName, operator, text, linewise, blockwise);
      if (clipboardUnnamed && registerName !== "_" && registerName !== "+") {
        const out = linewise && !text.endsWith("\n") ? `${text}\n` : text;
        void writeClipboardText(out);
      }
    };
    // Redefine the paste action: when clipboard=unnamed and no explicit
    // register was given, read the system clipboard first. `this` inside a
    // vim action is the engine's actions object (continuePaste lives there).
    // Read through lib/clipboard (navigator.clipboard.readText is unavailable
    // in WKWebView and this path used to fail silently); fall back to the
    // register content on failure.
    VimAny.defineAction("paste", function (
      this: Record<string, any>,
      cm: unknown,
      actionArgs: { registerName?: string },
      vimState: unknown,
    ) {
      const controller = VimAny.getRegisterController();
      const name = actionArgs.registerName || "";
      if (clipboardUnnamed && name === "") {
        const register = controller.getRegister("");
        readClipboardText().then((value) => {
          if (value) register.setText(value, value.endsWith("\n"), false);
          this.continuePaste(cm, actionArgs, vimState, register.toString(), register);
        });
        return;
      }
      // Default engine behavior: "+" reads the clipboard, others read the register.
      const register = controller.getRegister(name);
      if (name === "+") {
        void readClipboardText().then((value) => {
          if (value !== null) this.continuePaste(cm, actionArgs, vimState, value, register);
        });
      } else {
        this.continuePaste(cm, actionArgs, vimState, register.toString(), register);
      }
    });
  } catch (e) {
    console.warn("[bnote] clipboard=unnamed patch failed", e);
  }
}

/* ---- visual-mode selection paint: the decoration layer is the ONLY painter
   while vim visual mode is on.
   The geometry of CM's own selection (the .cm-selectionBackground rectangle
   plus the browser's native ::selection) is derived from coordinates, and two
   parts of it can never line up: the horizontal boundary comes from the
   padding of .cm-line (this app puts its padding on .cm-content, so the
   rectangle is wider than the line box and presses on the left over the quote
   bar), and the vertical end is taken from coordsAtPos(to, -2) (right next to
   a block-level widget — a formula block, a formula preview — the coordinate
   falls inside the widget and grows a narrow gray band that spans rows and
   is hundreds of pixels tall). The decoration geometry comes from the DOM line
   boxes and the document coordinates, neither path distorts, so the visual
   selection is painted only by this layer:
   - cm-vimVisualLine / cm-vimVisualLineHint: the line band (for linewise the
     line band is the selection itself; for charwise/blockwise the line band
     is only the hint color "these lines are involved");
   - cm-vimVisualRange: the exact range (the character interval for charwise,
     the per-line block for blockwise).
   The CM rectangle is made transparent under cm-vimSelPaint (see global.css).
   ---- */

const visualLineDeco = Decoration.line({ class: "cm-vimVisualLine" });
/* The line band of charwise/blockwise is only the hint color "these lines are
   involved": the exact-range layer already uses the selection's own color,
   and the same color in both places blurs the selected range into one patch. */
const visualLineHintDeco = Decoration.line({ class: "cm-vimVisualLineHint" });
const visualRangeDeco = Decoration.mark({ class: "cm-vimVisualRange" });

/** The class put on .cm-editor while the paint layer owns the selection (CSS
 *  turns CM's selection rectangle off by it). */
const OWN_PAINT_CLASS = "cm-vimSelPaint";

interface Pos {
  line: number;
  ch: number;
}

interface VisualDoc {
  length: number;
  lines: number;
  sliceString(from: number, to?: number): string;
  line(n: number): { from: number; to: number; text: string };
  lineAt(pos: number): { from: number; to: number; number: number };
}

interface VisualVimState {
  visualMode?: boolean;
  visualLine?: boolean;
  visualBlock?: boolean;
  sel?: { anchor?: Pos; head?: Pos };
}

/** Pure body of the highlighted-line set in visual mode: the vim engine's sel
 *  (CodeMirror 5 style, 0-based line/ch) wins — linewise visual often keeps the
 *  CM selection empty; the CM selection is the fallback only when the engine
 *  keeps no sel. Exported for the gate that locks the geometry (forward /
 *  backward / linewise / empty selection). */
export function visualLineNumbers(
  doc: VisualDoc,
  vimState: VisualVimState | null,
  ranges: readonly { from: number; to: number; empty?: boolean }[],
): number[] {
  if (!vimState?.visualMode) return [];
  const lines = new Set<number>();
  const sel = vimState.sel;
  if (sel?.anchor != null && sel?.head != null) {
    const aLine = Math.min(sel.anchor.line, sel.head.line) + 1;
    const bLine = Math.max(sel.anchor.line, sel.head.line) + 1;
    const endLine = doc.lines;
    const from = Math.max(1, Math.min(aLine, endLine));
    const to = Math.max(1, Math.min(bLine, endLine));
    const hasExtent = sel.anchor.line !== sel.head.line || sel.anchor.ch !== sel.head.ch;
    if (!hasExtent && !vimState.visualLine) {
      // Charwise visual with a collapsed range: nothing visible yet.
      return [];
    }
    for (let n = from; n <= to; n++) lines.add(n);
  } else {
    for (const range of ranges) {
      if (range.empty) continue;
      // A selection ending at a line start really ends on the previous line.
      let to = range.to;
      if (to > range.from && to === doc.lineAt(to).from) to -= 1;
      for (let n = doc.lineAt(range.from).number; n <= doc.lineAt(to).number; n++) {
        lines.add(n);
      }
    }
  }
  return [...lines].sort((a, b) => a - b);
}

/** Pure body of the "exact range" in visual mode (document offsets),
 *  complementary to the line band:
 *  - linewise: the whole line is expressed by the line band, so this returns
 *    empty (another character-colored layer would just deepen the same color);
 *  - blockwise: the engine syncs only the segment the caret is in into the CM
 *    selection, so the block shape must be sliced per line from the
 *    anchor/head column interval (lines whose columns run past the end are
 *    clamped to the line end — that is how vim's block selection behaves);
 *  - charwise: the selection the engine synced into CM is used as is (the
 *    engine guarantees the head character is included).
 *  Only used for painting: the geometry comes from document coordinates and
 *  never goes through coordsAtPos, so block-level widget boundaries cannot
 *  distort it. Exported for the gate that locks the geometry. */
export function visualRangeSpans(
  doc: VisualDoc,
  vimState: VisualVimState | null,
  ranges: readonly { from: number; to: number; empty?: boolean }[],
): { from: number; to: number }[] {
  if (!vimState?.visualMode) return [];
  const sel = vimState.sel;
  if (vimState.visualLine) return [];
  const out: { from: number; to: number }[] = [];
  if (vimState.visualBlock && sel?.anchor != null && sel?.head != null) {
    const a = sel.anchor;
    const h = sel.head;
    const first = Math.max(1, Math.min(a.line, h.line) + 1);
    const last = Math.min(doc.lines, Math.max(a.line, h.line) + 1);
    const startCh = Math.min(a.ch, h.ch);
    const endCh = Math.max(a.ch, h.ch) + 1; // vim's selection includes the head character
    for (let n = first; n <= last; n++) {
      const line = doc.line(n);
      const width = line.to - line.from;
      const from = line.from + Math.min(startCh, width);
      const to = line.from + Math.min(endCh, width);
      if (to > from) out.push({ from, to });
    }
    return out;
  }
  for (const range of ranges) {
    if (!range.empty && range.to > range.from) out.push({ from: range.from, to: range.to });
  }
  return out;
}

/** All decorations to paint for the visual selection: line band + exact
 *  range. An empty set means there is currently no painter (a collapsed
 *  selection right after pressing v), and exclusive painting is released
 *  accordingly. Exported for the gate that locks the geometry and the
 *  painting ownership. */
export function visualSelectionDecos(
  doc: VisualDoc,
  vimState: VisualVimState | null,
  ranges: readonly { from: number; to: number; empty?: boolean }[],
): DecorationSet {
  if (!vimState?.visualMode) return Decoration.set([]);
  const lines = visualLineNumbers(doc, vimState, ranges);
  const spans = visualRangeSpans(doc, vimState, ranges);
  // For linewise the line band is the selection itself (the selection's own
  // color); for charwise/blockwise the exact-range layer sits on top of it, so
  // the line band falls back to the hint color.
  const lineDeco = vimState.visualLine ? visualLineDeco : visualLineHintDeco;
  if (spans.length === 0) {
    // The line band is ordered by itself: use the O(n) builder (rebuilt on every keystroke of a large linewise selection).
    const builder = new RangeSetBuilder<Decoration>();
    for (const n of lines) {
      const line = doc.line(n);
      builder.add(line.from, line.from, lineDeco);
    }
    return builder.finish();
  }
  const decos: Range<Decoration>[] = [];
  for (const n of lines) decos.push(lineDeco.range(doc.line(n).from));
  for (const span of spans) decos.push(visualRangeDeco.range(span.from, span.to));
  return Decoration.set(decos, true);
}

export function vimVisualHighlight(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private lastVisual: boolean;
      private ownsPaint = false;
      private view: EditorView;

      constructor(view: EditorView) {
        this.view = view;
        this.lastVisual = !!vimStateOf(view)?.visualMode;
        this.decorations = this.build(view);
        this.syncOwnership();
      }

      update(u: ViewUpdate) {
        const visual = !!vimStateOf(u.view)?.visualMode;
        if (u.docChanged || u.selectionSet || u.viewportChanged || visual !== this.lastVisual) {
          this.lastVisual = visual;
          this.decorations = this.build(u.view);
          this.syncOwnership();
        }
      }

      destroy() {
        this.view.dom.classList.remove(OWN_PAINT_CLASS);
      }

      /** Once the decoration layer paints a selection, CM's selection rectangle
       *  must yield — two painters for one state are exactly the source of the
       *  misalignment (see the comment at the top of the file). When there is no
       *  painter, CM must still be free to paint its own rectangle. */
      private syncOwnership() {
        const owns = this.decorations.size > 0;
        if (owns === this.ownsPaint) return;
        this.ownsPaint = owns;
        this.view.dom.classList.toggle(OWN_PAINT_CLASS, owns);
      }

      build(view: EditorView): DecorationSet {
        return visualSelectionDecos(
          view.state.doc,
          vimStateOf(view) as VisualVimState | null,
          view.state.selection.ranges,
        );
      }
    },
		{ decorations: (v) => v.decorations },
	);
}

/* ---- Active line shade: an own decoration model that replaces
   highlightActiveLine + the ancestor-class gated CSS.
   The engine toggles the .cm-vimMode class on scrollDOM on Esc/i, and any
   selector that uses it as an ancestor condition makes the invalidation scope
   cover the whole viewport subtree (every row and its KaTeX/markdown subtree
   has to re-check the rules). The shade becomes a single line decoration:
   its visibility follows vimDrawsBlockCursor directly (the same criterion the
   engine uses to put cm-vimMode on the scroller for the normal/visual/replace
   block cursor, compared verbatim against updateClass), and insert mode emits
   no decoration. A toggle touches only the caret's row, so the invalidation
   scope shrinks to one row and the wide scope loses one consumer. ---- */

/** Pure construction of the activeLine line decoration: when no block cursor
 *  is painted (insert mode, no engine) it returns an empty set, otherwise it
 *  puts cm-activeLine on the head line of every range (multiple ranges on the
 *  same line are deduplicated). Exported for the gate that locks the
 *  visibility criterion and the decoration geometry. */
export function activeLineDecos(
  state: EditorState,
  drawsBlockCursor: boolean,
): DecorationSet {
  if (!drawsBlockCursor) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const seen = new Set<number>();
  for (const r of state.selection.ranges) {
    const lineFrom = state.doc.lineAt(r.head).from;
    if (seen.has(lineFrom)) continue;
    seen.add(lineFrom);
    builder.add(lineFrom, lineFrom, activeLineDeco);
  }
  return builder.finish();
}

const activeLineDeco = Decoration.line({ class: "cm-activeLine" });

export function vimActiveLine(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = activeLineDecos(view.state, vimDrawsBlockCursor(view));
      }

      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged) {
          this.decorations = activeLineDecos(u.view.state, vimDrawsBlockCursor(u.view));
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

function vimStateOf(view: EditorView): { insertMode?: boolean; visualMode?: boolean } | null {
  const cm = getCM(view) as unknown as { state?: { vim?: { insertMode?: boolean; visualMode?: boolean } } } | null;
  return cm?.state?.vim ?? null;
}

/** Visual selection: the text plus the covered doc range (⌘⇧B takes both the
 *  inserted heading and the landing point from here). */
export interface VisualSelection {
  /** The selection text (for linewise the whole line including the line
   *  break; for blockwise a per-line slice; for charwise the exact interval). */
  text: string;
  /** The doc position range covered by the selection. */
  from: number;
  to: number;
}

/**
 * The engine's sel (0-based line/ch, CM5 style) → the selection in visual
 * mode: linewise takes the whole line (including the line break), blockwise
 * takes the column interval per line (columns past the end are clamped to the
 * line end, that is how vim's block selection behaves), charwise takes the
 * character interval from the anchor to the caret (including the head
 * character). All three are computed from the engine's sel and never read the
 * CM selection — under linewise/blockwise the engine syncs only part of the
 * range into CM (measured: for a ⌃V block selection CM holds only the caret's
 * segment), so the engine's sel is authoritative. Exported for the gate that
 * locks the coordinate model.
 */
export function visualSelection(
  doc: VisualDoc,
  vimState: VisualVimState | null,
): VisualSelection | null {
  const sel = vimState?.sel;
  if (!vimState?.visualMode || !sel?.anchor || !sel.head) return null;
  const lineNo = (n: number) => Math.max(1, Math.min(n + 1, doc.lines));
  const aLine = lineNo(sel.anchor.line);
  const hLine = lineNo(sel.head.line);
  const first = Math.min(aLine, hLine);
  const last = Math.max(aLine, hLine);
  const from = doc.line(first).from;
  const to = doc.line(last).to;
  if (vimState.visualLine) {
    return { text: doc.sliceString(from, to), from, to };
  }
  if (vimState.visualBlock) {
    const startCh = Math.min(sel.anchor.ch, sel.head.ch);
    const endCh = Math.max(sel.anchor.ch, sel.head.ch) + 1; // vim's selection includes the head character
    const rows: string[] = [];
    for (let n = first; n <= last; n++) {
      const lineText = doc.line(n).text;
      rows.push(
        lineText.slice(Math.min(startCh, lineText.length), Math.min(endCh, lineText.length)),
      );
    }
    return { text: rows.join("\n"), from, to };
  }
  // charwise: the character positions of the anchor and the caret, sorted, then [smaller, larger+1) — including the head character.
  const posOf = (p: { line: number; ch: number }) => {
    const line = doc.line(lineNo(p.line));
    return Math.min(line.from + Math.max(0, p.ch), line.to);
  };
  const a = posOf(sel.anchor);
  const h = posOf(sel.head);
  const cf = Math.min(a, h);
  const ct = Math.min(Math.max(a, h) + 1, doc.length);
  return { text: doc.sliceString(cf, ct), from: cf, to: ct };
}

/**
 * The selection source for ⌘⇧B "select and insert" in vim visual mode: take
 * the engine-maintained selection (visualSelection) and leave visual mode.
 * Returning null means "not in visual mode" (the caller uses the CM selection
 * directly). Leaving happens here: the command has already consumed this
 * selection and the caret's later dispatch lands in the new block; keeping the
 * visual state would let the engine's next keystroke drag the caret back to
 * the old selection (which would still be highlighted).
 */
export function takeVimVisual(view: EditorView): VisualSelection | null {
  const cm = getCM(view) as unknown as { state?: { vim?: VisualVimState } } | null;
  const vim = cm?.state?.vim;
  if (!cm || !vim?.visualMode) return null;
  const selection = visualSelection(view.state.doc, vim);
  (
    Vim as unknown as { exitVisualMode: (cm: unknown, moveHead?: boolean) => void }
  ).exitVisualMode(cm, false);
  return selection;
}

/** Whether the engine is drawing a block cursor right now. The criterion is
 *  copied verbatim from @replit/codemirror-vim's measureCursor
 *  (`vim && (!vim.insertMode || overwrite)`): in insert mode (non-replace) the
 *  block cursor layer renders empty, so the measure flush done for it has no
 *  object. overwrite is the flag the engine hangs on its own CM5-compatible
 *  state (the plain object inside getCM, not a CM6 field) and can only be
 *  read that way. */
export function vimDrawsBlockCursor(view: EditorView): boolean {
  const cm = getCM(view) as unknown as {
    state?: { vim?: { insertMode?: boolean }; overwrite?: boolean };
  } | null;
  const st = cm?.state;
  if (!st?.vim) return false;
  return !st.vim.insertMode || !!st.overwrite;
}

export function currentVimMode(view: EditorView): VimMode | null {
  const v = vimStateOf(view);
  if (!v) return null;
  if (v.insertMode) return "insert";
  if (v.visualMode) return "visual";
  return "normal";
}

const SPECIAL_KEYS: Record<string, string> = {
  esc: "Escape",
  cr: "Enter",
  return: "Enter",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  bs: "Backspace",
  bar: "|",
  lt: "<",
  gt: ">",
  lead: "\\",
};

/** `<C-s>` → CM6 key string "Ctrl-s"; `<D-s>` → "Mod-s". */
export function normalizeVimKey(lhs: string): string | null {
  if (!lhs.startsWith("<") || !lhs.endsWith(">")) {
    return lhs.length === 1 ? lhs : null;
  }
  const inner = lhs.slice(1, -1);
  let result = "";
  let mods = "";
  const parts = inner.split("-");
  let keyPart = parts[parts.length - 1];
  for (let i = 0; i < parts.length - 1; i++) {
    const mod = parts[i].toLowerCase();
    if (mod === "c" || mod === "ctrl") mods += "Ctrl-";
    else if (mod === "d" || mod === "cmd" || mod === "meta") mods += "Mod-";
    else if (mod === "m" || mod === "a" || mod === "alt") mods += "Alt-";
    else if (mod === "s" || mod === "shift") mods += "Shift-";
    else return null;
  }
  const lower = keyPart.toLowerCase();
  if (SPECIAL_KEYS[lower]) {
    keyPart = SPECIAL_KEYS[lower];
  } else if (keyPart.length !== 1 && !/^(F\d+|Arrow.+|Home|End|PageUp|PageDown|Delete|Insert)$/.test(keyPart)) {
    return null;
  }
  result = keyPart;
  return mods + result;
}

/** Builds the CM6 keymap that runs bnote commands for `:command` mappings. */
export function commandMappingKeymap(mappings: VimMapping[]): Extension {
  // A key can be mapped more than once per mode (`noremap` plus `vnoremap`, or
  // a stray duplicate); vim lets the LAST definition win, while a keymap picks
  // the first binding it finds — so collapse duplicates back-to-front.
  const byKey = new Map<string, KeyBinding>();
  vimCommandBindings.clear(); // Each rebuild replaces everything, so mappings deleted from the vimrc do not linger
  for (const m of mappings) {
    if (!m.commandId) continue;
    const key = normalizeVimKey(m.lhs);
    if (!key) continue;
    const mode = m.mode;
    byKey.set(`${mode}\u0000${key}`, {
      key,
      run: (view) => {
        const current = currentVimMode(view);
        if (!current) return false; // vim not enabled — don't hijack keys
        if (mode === "insert" && current !== "insert") return false;
        if (mode === "normal" && current !== "normal") return false;
        if (mode === "visual" && current !== "visual") return false;
        runCommandRef(m.commandId!);
        return true;
      },
    });
  }
  // Command mappings also enter the capture registry (the lhs verbatim is the
  // engine's key vocabulary, a later definition overrides an earlier one): the
  // capture dispatch must consult it before the engine — `nmap <C-b> :Bnote…`
  // collides with the engine's native <C-b> (page down), and if the engine got
  // it first the sidebar toggle would be eaten by the page down. The keymap
  // itself is kept: insert mode lets the capture pass, and the keymap on the
  // chain still catches it.
  for (const m of mappings) {
    if (!m.commandId) continue;
    if (!normalizeVimKey(m.lhs)) continue; // Same criterion as the keymap: a single key or a key with modifiers
    vimCommandBindings.set(`${m.mode}\u0000${m.lhs}`, m.commandId);
  }
  const bindings = [...byKey.values()];
  return bindings.length > 0 ? keymap.of(bindings) : [];
}

/** The nmap … :Bnote command mappings (mode\0engine key vocabulary → command id); used only by the capture dispatch. */
const vimCommandBindings = new Map<string, string>();

/** Look up a command mapping by the current mode and the engine key vocabulary; returns undefined when unbound. Exported for the gate. */
export function lookupVimCommand(engineKey: string, mode: VimMode): string | undefined {
  return vimCommandBindings.get(`${mode}\u0000${engineKey}`);
}

/* ---- Capture-phase key dispatch: in normal/visual mode the engine sees the
   key before the whole CM keymap chain ----

   CM6 funnels all keyBindings into **one** shared keydown handler (the
   enables of the keymap facet), flattened at the position of the first
   keymap.of declaration — in baseExtensions that is snippetsExtension(), the
   earliest one, so this handler runs before the vim engine (whose compartment
   is declared later). The engine's own keydown chain entry never returns true
   (it acts through side effects and never "claims" the event), so any key
   bound by some keymap never reaches the engine: in normal mode Enter lands on
   defaultKeymap's insertNewlineAndIndent (inserting a line out of nowhere)
   and Backspace on deleteCharBackward (deleting a character); only unbound
   keys such as j/k/gg reach the engine — so the feel is mostly right and only
   the keys that collide with a binding break.
   Fix = hand the key to the engine in the capture phase on view.dom (before
   the whole CM chain at the contentDOM target phase): in normal/visual mode
   the engine takes over, and a claimed key means preventDefault +
   stopPropagation (the capture phase intercepts it on the parent, so the
   event never reaches contentDOM and the keymap chain no longer runs at
   all); in insert mode the way is given — the snippet's Tab/Escape and
   latex's Backspace editing enhancements legitimately run first in insert
   mode, and the engine still receives keys like Esc/jj through the entry at
   the tail of its chain.
   Guards: the target is not contentDOM (the vim panel's input box and the
   like) → do not touch; IME composition or a dead key → do not touch (the
   engine's keydown entry has a useNextTextInput state machine, do not
   intercept it); the event was already claimed upstream → do not touch. */

/** The decision core of the capture dispatch (exported for the gate to lock the
 *  contract): true = the key goes to the engine (normal/visual);
 *  false = the key is released to the CM keymap chain (insert mode, IME
 *  composition, dead key, already handled upstream, target not on the edited
 *  content). */
export function vimCapturesKey(input: {
  insertMode: boolean;
  composing: boolean;
  deadKey: boolean;
  targetIsContentDOM: boolean;
  defaultPrevented: boolean;
}): boolean {
  if (input.defaultPrevented || !input.targetIsContentDOM) return false;
  if (input.composing || input.deadKey) return false;
  return !input.insertMode;
}

export function vimKeyCaptureExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly view: EditorView;
      private readonly onKeydown = (e: KeyboardEvent) => {
        const cm = getCM(this.view);
        const vim = cm?.state?.vim as { insertMode?: boolean } | undefined;
        if (!cm || !vim) return;
        if (
          !vimCapturesKey({
            insertMode: !!vim.insertMode,
            composing: e.isComposing || e.keyCode === 229,
            deadKey: e.key === "Process" || e.key === "Dead" || e.key === "Unidentified",
            targetIsContentDOM: e.target === this.view.contentDOM,
            defaultPrevented: e.defaultPrevented,
          })
        ) {
          return;
        }
        const engineKey = Vim.vimKeyFromEvent(
          e,
          vim as Parameters<typeof Vim.vimKeyFromEvent>[1],
        );
        if (!engineKey) return;
        const mode = currentVimMode(this.view);
        const commandId = mode ? lookupVimCommand(engineKey, mode) : undefined;
        if (commandId) {
          e.preventDefault();
          e.stopPropagation();
          runCommandRef(commandId);
          return;
        }
        // When the engine claims the key it calls preventDefault +
        // stopPropagation internally (the original semantics of the wrapper's
        // handleKey), so the event never reaches contentDOM and the keymap
        // chain no longer runs; when it does not claim it (unknown key or
        // modifier chord) the key is released to the keymap chain, the same
        // route as without vim.
        const plugin = (
          cm.state as { vimPlugin?: { handleKey(e: KeyboardEvent, view: EditorView): unknown } }
        ).vimPlugin;
        plugin?.handleKey(e, this.view);
      };

      constructor(view: EditorView) {
        this.view = view;
        view.dom.addEventListener("keydown", this.onKeydown, true);
      }

      destroy() {
        this.view.dom.removeEventListener("keydown", this.onKeydown, true);
      }
    },
  );
}

/** Applies key-sequence mappings through the vim engine itself. */
export function applyNativeMappings(mappings: VimMapping[]) {
  try {
    Vim.mapclear();
  } catch {
    // mapclear without args is fine on a fresh Vim instance
  }
  for (const m of mappings) {
    if (m.commandId) continue; // handled by the CM6 keymap
    const ctx =
      m.mode === "insert" ? "insert" : m.mode === "visual" ? "visual" : "normal";
    // The rhs must be passed verbatim: when the engine expands a keyToKey
    // mapping it splits on angle-bracket tokens (the vimToCmKeyMap branch of
    // doKeyToKey), and <Esc>/<CR>/<Tab>/<Space> are shapes it knows natively.
    // An early version rewrote <Esc> to a bare "Esc" — the expander then
    // replaceSelection-ed the three single characters E·s·c into the document
    // one by one, and `imap jj <Esc>` could never leave insert mode again;
    // the user reports of "gg/G does nothing in normal mode" actually
    // happened in insert state. The regression test is in
    // ./nativeMappings.test.ts.
    const rhs = m.rhs;
    try {
      if (m.noremap) Vim.noremap(m.lhs, rhs, ctx);
      else Vim.map(m.lhs, rhs, ctx);
    } catch (e) {
      console.warn(`vimrc: cannot map ${m.lhs} → ${m.rhs}`, e);
    }
  }
}
