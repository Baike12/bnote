import { WidgetType } from "@codemirror/view";
import katex from "katex";
import { fileName } from "@/lib/path";
import { perfEnd, perfFields, perfStart } from "@/perf/trace";

/** Rendered-math HTML cache: decorations rebuild on every cursor move, but
 *  KaTeX output for identical sources is reused so scrolling stays cheap. */
const cache = new Map<string, string>();
const MAX_CACHE = 800;

/** KaTeX ≥0.18 auto-numbers rows of `align`/`gather`/`equation`/`alignat`,
 *  painting "(1)" tags the notes never asked for (each block restarts at 1).
 *  Switching to the starred variants keeps identical layout minus the tag;
 *  an explicit `\tag{…}` still renders in starred environments. */
const AUTO_NUMBERED_ENV_RE =
  /\\(begin|end)\{(align|alignat|gather|equation|flalign|eqnarray)(\*?)\}/g;

function withoutAutoNumbers(src: string): string {
  return src.replace(AUTO_NUMBERED_ENV_RE, (_m, kind, env, star) =>
    star ? _m : `\\${kind}{${env}*}`,
  );
}

const KATEX_FIELDS = perfFields("display", "bytes");

export function renderMathHtml(src: string, display: boolean): string {
  const key = (display ? "D\u0000" : "I\u0000") + src;
  let html = cache.get(key);
  if (html === undefined) {
    const t = perfStart();
    try {
      html = katex.renderToString(withoutAutoNumbers(src), {
        displayMode: display,
        throwOnError: false,
        errorColor: "#ff6b6b",
        strict: false,
        trust: false,
        output: "html",
        globalGroup: true,
      });
    } catch {
      html = `<span class="cw-math-error">${escapeHtml(src)}</span>`;
    }
    perfEnd(t, "katex.render", KATEX_FIELDS, display, src.length);
    if (cache.size >= MAX_CACHE) {
      let dropped = 0;
      for (const k of cache.keys()) {
        cache.delete(k);
        if (++dropped >= MAX_CACHE / 4) break;
      }
    }
    cache.set(key, html);
  }
  return html;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export class MathWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly display: boolean,
    /** Doc position of the region start; lets click handlers find the region. */
    readonly from?: number,
    /** Depth inside a callout block (≥0): a cross-line block replace removes the
     *  line element from the DOM, so the widget has to carry the block face
     *  itself (background/bar/indent) — reusing the md-callout-line classes. */
    readonly calloutDepth?: number,
  ) {
    super();
  }

  eq(other: MathWidget) {
    return (
      other.src === this.src &&
      other.display === this.display &&
      other.from === this.from &&
      other.calloutDepth === this.calloutDepth
    );
  }

  toDOM() {
    const wrap = document.createElement(this.display ? "div" : "span");
    wrap.className = this.display ? "cw-math cw-math-block" : "cw-math cw-math-inline";
    if (this.from !== undefined) wrap.dataset.mathFrom = String(this.from);
    if (this.display && this.calloutDepth !== undefined && this.calloutDepth >= 0) {
      wrap.classList.add("md-callout-line", `d${Math.min(this.calloutDepth, 2)}`);
    }
    wrap.innerHTML = renderMathHtml(this.src, this.display);
    return wrap;
  }

  ignoreEvent() {
    return false;
  }
}

/** Live preview shown below a math region while the cursor edits it
 *  (Obsidian latex-suite style): source stays visible on top. */
export class MathPreviewWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly display: boolean,
    /** Depth inside a callout block (≥0): the preview is an inserted block
     *  widget, so its block face aligns with the callout that holds it. */
    readonly calloutDepth?: number,
  ) {
    super();
  }

  eq(other: MathPreviewWidget) {
    return (
      other.src === this.src &&
      other.display === this.display &&
      other.calloutDepth === this.calloutDepth
    );
  }

  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cw-math cw-math-preview";
    if (this.calloutDepth !== undefined && this.calloutDepth >= 0) {
      wrap.classList.add("md-callout-line", `d${Math.min(this.calloutDepth, 2)}`);
    }
    wrap.innerHTML = renderMathHtml(this.src, this.display);
    return wrap;
  }

  ignoreEvent() {
    return false;
  }
}

/** Live preview of an inline formula while the cursor edits it: source stays
 *  visible on the left, the rendered formula sits right after the closing
 *  delimiter and pushes the rest of the line to the right (block formulas get
 *  MathPreviewWidget below their source; an inline formula has no block layer
 *  to host a preview). */
export class MathInlinePreviewWidget extends WidgetType {
  constructor(readonly src: string) {
    super();
  }

  eq(other: MathInlinePreviewWidget) {
    return other.src === this.src;
  }

  toDOM() {
    const el = document.createElement("span");
    el.className = "cw-math cw-math-preview-inline";
    el.innerHTML = renderMathHtml(this.src, false);
    return el;
  }

  ignoreEvent() {
    return false;
  }
}

/** Zero-height block widget used to hide fence lines entirely. */
export class HiddenLineWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cw-hidden-line";
    return el;
  }
}

/**
 * Rendered state of a callout's opening marker line (`::: Title`): while the
 * cursor is outside the block, this widget replaces the whole source line. A
 * full-line block replace in CM6 removes the line element from the DOM — so the
 * block face's top cap (background/bar/top padding/rounding) has to be carried
 * by the widget, using the same visual tokens as the line classes seen while the
 * boundary line is visible (.md-callout-line.md-callout-open); depth aligns the
 * inner indentation. dataset.calloutFrom records the opening marker's position
 * so clicking the title can jump back to that source line.
 */
export class CalloutTitleWidget extends WidgetType {
  constructor(
    readonly title: string,
    /** Start of the opening marker line (doc position), for click-to-source. */
    readonly from: number,
    /** Nesting depth; picks the d1/d2 indent class. */
    readonly depth: number,
  ) {
    super();
  }

  eq(other: CalloutTitleWidget) {
    return other.title === this.title && other.from === this.from && other.depth === this.depth;
  }

  toDOM() {
    const el = document.createElement("div");
    el.className = `cw-callout-title d${Math.min(this.depth, 2)}`;
    el.textContent = this.title;
    el.dataset.calloutFrom = String(this.from);
    return el;
  }

  ignoreEvent() {
    return false;
  }
}

/**
 * Rendered state of a titleless callout's opening and closing marker lines
 * (`:::`): no text, but the block face's caps are kept — the line element has
 * been removed from the DOM by the block replace, so the caps can only live
 * here (same reason as above).
 */
export class CalloutEdgeWidget extends WidgetType {
  constructor(
    /** Opening cap (true: adds the padding and the top rounding) or closing cap
     *  (false). */
    readonly open: boolean,
    /** Start of the opening marker line, for click-to-source. */
    readonly from: number,
    readonly depth: number,
  ) {
    super();
  }

  eq(other: CalloutEdgeWidget) {
    return other.open === this.open && other.from === this.from && other.depth === this.depth;
  }

  toDOM() {
    const el = document.createElement("div");
    el.className = `cw-callout-edge${this.open ? " open" : ""} d${Math.min(this.depth, 2)}`;
    el.dataset.calloutFrom = String(this.from);
    return el;
  }

  ignoreEvent() {
    return false;
  }
}

export class HrWidget extends WidgetType {
  /** Depth inside a callout block (≥0): the full-line block replace removes the
   *  line element from the DOM, so the widget carries the block face itself. */
  constructor(readonly calloutDepth: number = -1) {
    super();
  }
  eq(other: HrWidget) {
    return other.calloutDepth === this.calloutDepth;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cw-hr";
    if (this.calloutDepth >= 0) {
      el.classList.add("md-callout-line", `d${Math.min(this.calloutDepth, 2)}`);
    }
    const hr = document.createElement("hr");
    el.appendChild(hr);
    return el;
  }
}

/** Bullet glyph replacing `-`/`*`/`+` list markers in live preview. The dot
 *  itself is drawn by CSS (`.md-bullet::before`) so its size and distance to
 *  the item text are tunable independent of any glyph's font metrics. */
export class ListBulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "md-bullet";
    return el;
  }
}

/** Rendered checkbox for a GFM task-list marker (`- [ ]` / `- [x]`). */
export class TaskCheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  eq(other: TaskCheckboxWidget) {
    return other.checked === this.checked;
  }

  toDOM() {
    const el = document.createElement("span");
    el.className = "md-task" + (this.checked ? " checked" : "");
    el.setAttribute("role", "checkbox");
    el.setAttribute("aria-checked", this.checked ? "true" : "false");
    return el;
  }

  ignoreEvent() {
    return false;
  }
}

/** Renders an escaped character (`\*` → `*`). */
export class EscapeCharWidget extends WidgetType {
  constructor(readonly char: string) {
    super();
  }
  eq(other: EscapeCharWidget) {
    return other.char === this.char;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cw-escape";
    el.textContent = this.char;
    return el;
  }
}

/**
 * Rendered image (`![alt](url)` or `![[name.png]]`), replacing the source when
 * the cursor is not on its line (study mode: converted-PDF figures stay
 * visible in place).
 *
 * `srcs` is a candidate list, not one URL: a reference like `assets/x/p1.svg`
 * resolves differently depending on whether it is read as relative to the note
 * or to the vault root, and `![[Pasted image.png]]` has to be found by file
 * name anywhere in the vault. None of those can be checked up front — every
 * filesystem call is async IPC, and decorations are built synchronously — so
 * the widget walks the list on `error` instead. `hint` is the reference as the
 * note spells it, shown when nothing loads.
 */
export class ImageWidget extends WidgetType {
  constructor(
    readonly srcs: string[],
    readonly alt: string,
    readonly hint: string,
    /** Absolute path of an Excalidraw embed (.excalidraw): clicking the preview
     *  opens the canvas so the drawing can be edited further. */
    readonly excalidrawPath?: string,
  ) {
    super();
  }

  eq(other: ImageWidget) {
    return (
      other.alt === this.alt &&
      other.hint === this.hint &&
      other.excalidrawPath === this.excalidrawPath &&
      other.srcs.length === this.srcs.length &&
      other.srcs.every((s, i) => s === this.srcs[i])
    );
  }

  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cw-image";
    if (this.excalidrawPath) wrap.dataset.excalidrawPath = this.excalidrawPath;
    const img = document.createElement("img");
    img.alt = this.alt;
    img.loading = "lazy";
    let i = 0;
    img.addEventListener("error", () => {
      if (++i < this.srcs.length) {
        img.src = this.srcs[i];
        return;
      }
      img.style.display = "none";
      wrap.classList.add("cw-image-broken");
      wrap.title = this.srcs.join("\n");
      wrap.dataset.hint = fileName(this.hint);
    });
    img.src = this.srcs[0];
    wrap.appendChild(img);
    return wrap;
  }

  ignoreEvent() {
    return false;
  }
}
