import { WidgetType } from "@codemirror/view";
import katex from "katex";
import { fileName } from "@/lib/path";

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

export function renderMathHtml(src: string, display: boolean): string {
  const key = (display ? "D\u0000" : "I\u0000") + src;
  let html = cache.get(key);
  if (html === undefined) {
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
  ) {
    super();
  }

  eq(other: MathWidget) {
    return other.src === this.src && other.display === this.display && other.from === this.from;
  }

  toDOM() {
    const wrap = document.createElement(this.display ? "div" : "span");
    wrap.className = this.display ? "cw-math cw-math-block" : "cw-math cw-math-inline";
    if (this.from !== undefined) wrap.dataset.mathFrom = String(this.from);
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
  ) {
    super();
  }

  eq(other: MathPreviewWidget) {
    return other.src === this.src && other.display === this.display;
  }

  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cw-math cw-math-preview";
    wrap.innerHTML = renderMathHtml(this.src, this.display);
    return wrap;
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

export class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cw-hr";
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
    /** 画图嵌入(.excalidraw)的绝对路径:点击预览图打开画布再编辑。 */
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
