import { WidgetType } from "@codemirror/view";
import katex from "katex";

/** Rendered-math HTML cache: decorations rebuild on every cursor move, but
 *  KaTeX output for identical sources is reused so scrolling stays cheap. */
const cache = new Map<string, string>();
const MAX_CACHE = 800;

export function renderMathHtml(src: string, display: boolean): string {
  const key = (display ? "D\u0000" : "I\u0000") + src;
  let html = cache.get(key);
  if (html === undefined) {
    try {
      html = katex.renderToString(src, {
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
  ) {
    super();
  }

  eq(other: MathWidget) {
    return other.src === this.src && other.display === this.display;
  }

  toDOM() {
    const wrap = document.createElement(this.display ? "div" : "span");
    wrap.className = this.display ? "cw-math cw-math-block" : "cw-math cw-math-inline";
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
