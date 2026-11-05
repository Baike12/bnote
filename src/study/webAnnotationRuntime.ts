/**
 * The runtime that is injected into the web page of the content column.
 *
 * It must stay self-contained: `buildWebAnnotationScript` serializes this
 * function with `Function.prototype.toString` and hands it to the native
 * webview as an init script, so it cannot close over module variables. Every
 * pure function it needs arrives through the `helpers` argument.
 */

import type {
  locateQuote,
  normalizeWebAnnotations,
  textPointAt,
  WebAnnotation,
  WebAnnotationKind,
} from "./webAnnotations";
import type { mergeLineRects } from "./pdfAnnotations";
import type { normalizePageStep, snapScrollTopToLine } from "./reading";
import type { eventKeyName, parseBinding } from "@/commands/keys";

// ---------------------------------------------------------------------------
// The runtime injected into the page
// ---------------------------------------------------------------------------

interface RuntimeHelpers {
  locateQuote: typeof locateQuote;
  textPointAt: typeof textPointAt;
  mergeLineRects: typeof mergeLineRects;
  normalizeWebAnnotations: typeof normalizeWebAnnotations;
  normalizePageStep: typeof normalizePageStep;
  snapScrollTopToLine: typeof snapScrollTopToLine;
  parseBinding: typeof parseBinding;
  eventKeyName: typeof eventKeyName;
}

interface TextEntry {
  node: Text;
  start: number;
  end: number;
}

interface DocRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The in-page runtime. It has to be self-contained: the script is serialized
 * with `Function.prototype.toString` and injected into the native webview
 * (see `buildWebAnnotationScript`), and the module variables of the closure
 * do not exist in the page — every pure function it needs is passed in
 * through the `helpers` argument.
 */
export function webAnnotationRuntime(helpers: RuntimeHelpers): void {
  const w = window as unknown as { __bnoteAnno?: Record<string, unknown> };
  if (w.__bnoteAnno) return;

  const HOST_ID = "bnote-web-anno-host";
  const STORE_PREFIX = "bnote:web-annotations:v1:";
  const POS_PREFIX = "bnote:web-position:v1:";
  const TITLE_PREFIX = "bnote-anno:";
  const CONTEXT = 40;
  const MAX_QUOTE = 2000;
  const MAX_NOTE_TEXT = 2000;
  /** Width of the annotation card in px; when it does not fit, it sticks to the right edge of the viewport. */
  const NOTE_CARD_W = 240;

  let mode: WebAnnotationKind | null = null;
  let url = location.href;
  let items: WebAnnotation[] = loadFromStorage(url);
  let host: HTMLElement | null = null;
  let layer: HTMLElement | null = null;
  /**
   * Selection translation: the master switch is pushed in by the main window;
   * annotation mode (a non-null mode) always wins. The request number
   * translateSeq is the page's only writer token — a new selection, closing
   * the card or switching mode all bump it by 1, and a late result from Rust
   * that cannot prove it is current is dropped, so two cards never fight over
   * the same spot.
   */
  let translateEnabled = false;
  let translateSeq = 0;
  /**
   * The identifier of this page load. Rust carries it back verbatim with the
   * result, and the page only accepts the token of the current document: when
   * a translation request of the old page returns after a navigation, the new
   * page's runtime does not draw it.
   */
  const TRANSLATE_DOC = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let translateHost: HTMLElement | null = null;
  let translateCard: HTMLElement | null = null;
  let translateX = 0;
  let translateY = 0;
  let buildScrollX = 0;
  let buildScrollY = 0;
  let hitRects: Array<DocRect & { id: string }> = [];
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  let observer: MutationObserver | null = null;
  let scrollPending = false;
  let suppressClickUntil = 0;
  /** The text annotation just created / clicked: after the rebuild, focus its input and put the caret at the end. */
  let focusNoteId: string | null = null;
  /** The input of every annotation card (keyed by annotation id); both the rebuild and the focus go through this table. */
  let noteInputs: Map<string, HTMLTextAreaElement> = new Map();
  /** The scroll ratio to restore when the page is opened; null = there is no record or the user has taken over. */
  let restoreRatio: number | null = location.hash ? null : loadPosition(url);
  /** After the user scrolls, clicks or presses a key, the later timed restores no longer fight for the position. */
  let userScrolled = false;
  /** While the scroll is restored programmatically, do not store it again as the user's reading progress. */
  let applyingScroll = false;
  let savePositionTimer: ReturnType<typeof setTimeout> | null = null;
  let emitAnnotationsTimer: ReturnType<typeof setTimeout> | null = null;
  /** The page-turn step (a ratio of the visible height), pushed in by the main window; 50% by default. */
  let pageStep = helpers.normalizePageStep(0.5);
  /** The configurable page-turn keys (the binding strings parsed by the command layer), pushed in by the main window. */
  let prevKeys: string[] = ["PageUp", "ArrowLeft"];
  let nextKeys: string[] = ["PageDown", "ArrowRight"];
  /**
   * The shortcuts to forward back to the main window (the general commands plus the region switch / web zoom of the reading area).
   * The keys of a native sub-webview do not bubble to the main window, so a match here is written into document.title and turned into a
   * Tauri event on the Rust side.
   */
  let hostKeys: string[] = [];
  let hostKeySeq = 0;
  let shadeHost: HTMLElement | null = null;
  let shadeLayer: HTMLElement | null = null;
  let shadeCornerLeft: HTMLElement | null = null;
  let shadeCornerRight: HTMLElement | null = null;

  function storageKey(target: string): string {
    return STORE_PREFIX + target;
  }

  function loadFromStorage(target: string): WebAnnotation[] {
    try {
      const raw = localStorage.getItem(storageKey(target));
      return raw ? helpers.normalizeWebAnnotations(JSON.parse(raw)) : [];
    } catch {
      return [];
    }
  }

  function saveToStorage(target: string, list: WebAnnotation[]): void {
    try {
      if (list.length > 0) localStorage.setItem(storageKey(target), JSON.stringify(list));
      else localStorage.removeItem(storageKey(target));
    } catch {
      // Private mode / quota full: the highlights in the page still work, they just are not persisted to localStorage.
    }
  }

  function saveCurrent(): void {
    saveToStorage(url, items);
  }

  // ---- Reading position: one scroll ratio per URL in localStorage --------------------
  // The web page's DOM is not in the main window, so letting the page store it itself is the simplest option; a ratio rather than pixels,
  // so a changed window width still returns to the same passage. When the URL carries a #anchor the link anchor wins and nothing is restored.

  function loadPosition(target: string): number | null {
    try {
      const raw = localStorage.getItem(POS_PREFIX + target);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { r?: unknown };
      const ratio =
        parsed && typeof parsed.r === "number" && Number.isFinite(parsed.r) ? parsed.r : null;
      if (ratio === null) return null;
      return Math.min(1, Math.max(0, ratio));
    } catch {
      return null;
    }
  }

  /** The reading ratio of the current main scroll container; null when there is nothing scrollable. */
  function scrollRatioNow(): number | null {
    const target = pageTarget();
    if (!target) return null;
    const max = target.scrollHeight - target.clientHeight;
    if (max < 8) return null;
    return Math.min(1, Math.max(0, target.scrollTop / max));
  }

  function savePositionNow(): void {
    savePositionTimer = null;
    if (applyingScroll) return;
    const ratio = scrollRatioNow();
    if (ratio === null) return;
    try {
      localStorage.setItem(POS_PREFIX + url, JSON.stringify({ r: ratio, at: Date.now() }));
    } catch {
      // Private mode / quota full: the position cannot be remembered, but reading is unaffected.
    }
  }

  function scheduleSavePosition(): void {
    if (applyingScroll) return;
    if (savePositionTimer) clearTimeout(savePositionTimer);
    savePositionTimer = setTimeout(savePositionNow, 350);
  }

  function applyStoredScroll(): void {
    if (userScrolled || restoreRatio === null) return;
    const target = pageTarget();
    if (!target) return;
    const max = target.scrollHeight - target.clientHeight;
    if (max < 8) return;
    const y = Math.round(restoreRatio * max);
    if (Math.abs(target.scrollTop - y) <= 2) return;
    applyingScroll = true;
    target.scrollTop = y;
    // The dispatch timing of the scroll event differs between engines; wait a full beat before allowing the save.
    setTimeout(() => {
      applyingScroll = false;
    }, 150);
  }

  /**
   * Several attempts: page scripts, images and lazy loading keep growing the
   * page after load, so a single placement usually cannot measure the final
   * height yet. As soon as the user acts (see userTookOver) all attempts are
   * void immediately.
   */
  function scheduleRestore(): void {
    if (restoreRatio === null) return;
    for (const delay of [0, 60, 200, 500, 1000, 2000, 3500]) {
      setTimeout(applyStoredScroll, delay);
    }
  }

  function userTookOver(): void {
    userScrolled = true;
    restoreRatio = null;
  }

  function emit(): void {
    try {
      // Rust's on_document_title_changed reads this prefix and turns it into a Tauri event for the main window.
      document.title = TITLE_PREFIX + JSON.stringify({ url, annotations: items });
    } catch {
      // Ignore a title the page made read-only: the data is still in localStorage, the main window picks it up on the next merge.
    }
  }

  function newId(): string {
    try {
      const c = globalThis.crypto;
      if (c && typeof c.randomUUID === "function") return `web-${c.randomUUID()}`;
    } catch {
      // No randomUUID outside a secure context
    }
    return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  // ---- The body text stream and the anchors ----

  function collectText(): { text: string; entries: TextEntry[] } {
    const parts: string[] = [];
    const entries: TextEntry[] = [];
    let offset = 0;
    const root = document.body || document.documentElement;
    if (!root) return { text: "", entries };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const el = node.parentElement;
      if (!el) continue;
      if (el.closest("#" + HOST_ID)) continue;
      const tag = el.tagName;
      if (
        tag === "SCRIPT" ||
        tag === "STYLE" ||
        tag === "NOSCRIPT" ||
        tag === "TEXTAREA" ||
        tag === "OPTION"
      ) {
        continue;
      }
      const value = node.nodeValue ?? "";
      if (!value) continue;
      // Hidden text (display:none, collapsed menus) does not enter the text stream, otherwise the offsets drift after the rebuild.
      const probe = document.createRange();
      probe.selectNodeContents(node);
      if (probe.getClientRects().length === 0) continue;
      entries.push({ node, start: offset, end: offset + value.length });
      parts.push(value);
      offset += value.length;
    }
    return { text: parts.join(""), entries };
  }

  function offsetOfPoint(entries: TextEntry[], container: Node, offset: number): number | null {
    if (container.nodeType === 3) {
      for (const e of entries) {
        if (e.node === container) {
          const len = e.node.nodeValue ? e.node.nodeValue.length : 0;
          return e.start + Math.min(offset, len);
        }
      }
      return null;
    }
    let first: TextEntry | null = null;
    let last: TextEntry | null = null;
    for (const e of entries) {
      if (!container.contains(e.node)) continue;
      if (!first) first = e;
      last = e;
    }
    if (!first) return null;
    if (offset <= 0) return first.start;
    const child = container.childNodes[offset] || null;
    if (child) {
      for (const e of entries) {
        if (child === e.node || child.contains(e.node)) return e.start;
      }
    }
    return last ? last.end : first.start;
  }

  function rangeOf(a: WebAnnotation, info: { text: string; entries: TextEntry[] }): Range | null {
    const start = helpers.locateQuote(info.text, a.quote, a.offset, a.prefix, a.suffix);
    if (start < 0) return null;
    const from = helpers.textPointAt(info.entries, start, "start");
    const to = helpers.textPointAt(info.entries, start + a.quote.length, "end");
    if (!from || !to) return null;
    try {
      const range = document.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      return range;
    } catch {
      return null;
    }
  }

  // ---- The highlight layer ----

  function ensureLayer(): HTMLElement | null {
    if (layer && host && host.isConnected) return layer;
    const doc = document;
    if (!doc.documentElement) return null;
    host = doc.createElement("div");
    host.id = HOST_ID;
    const hs = host.style;
    hs.position = "fixed";
    hs.left = "0";
    hs.top = "0";
    hs.width = "0";
    hs.height = "0";
    hs.overflow = "visible";
    hs.pointerEvents = "none";
    hs.zIndex = "2147483646";
    if (typeof host.attachShadow === "function") {
      const root = host.attachShadow({ mode: "open" });
      layer = doc.createElement("div");
      root.appendChild(layer);
    } else {
      layer = doc.createElement("div");
      host.appendChild(layer);
    }
    const ls = layer.style;
    ls.position = "absolute";
    ls.left = "0";
    ls.top = "0";
    ls.width = "0";
    ls.height = "0";
    ls.pointerEvents = "none";
    doc.documentElement.appendChild(host);
    return layer;
  }

  // ---- Page turning and the upper-half shade ----

  /**
   * The reading split after a page turn: the old content above is dimmed and
   * fades out at the boundary, no dividing line is drawn; both ends are
   * finished with the rounded tip of the shade. All of it lives in the shadow
   * root, so page CSS does not touch it, and it takes no mouse events. It is
   * drawn as soon as the page is opened and the split stays the same while
   * turning pages and scrolling (the position only depends on the step).
   */
  function ensureShade(): void {
    if (shadeHost && shadeHost.isConnected && shadeLayer && shadeCornerLeft && shadeCornerRight) {
      return;
    }
    const doc = document;
    if (!doc.documentElement) return;
    const hostEl = doc.createElement("div");
    hostEl.id = "bnote-read-shade-host";
    const hs = hostEl.style;
    hs.position = "fixed";
    hs.left = "0";
    hs.top = "0";
    hs.width = "100%";
    hs.height = "100%";
    hs.pointerEvents = "none";
    hs.zIndex = "2147483647";
    const shade = doc.createElement("div");
    const cornerLeft = doc.createElement("div");
    const cornerRight = doc.createElement("div");
    if (typeof hostEl.attachShadow === "function") {
      const root = hostEl.attachShadow({ mode: "open" });
      root.appendChild(shade);
      root.appendChild(cornerLeft);
      root.appendChild(cornerRight);
    } else {
      hostEl.appendChild(shade);
      hostEl.appendChild(cornerLeft);
      hostEl.appendChild(cornerRight);
    }
    const ss = shade.style;
    ss.position = "fixed";
    ss.left = "0";
    ss.top = "0";
    ss.width = "100%";
    ss.pointerEvents = "none";
    // The shade bends downward into a rounded tip at both ends; outside the rounded tip (on the shade side) a same-colored dimming is added, inside the circle it stays transparent.
    // Without a dividing line, these two tips are the only shape the boundary has.
    const corner = (el: HTMLElement, at: "left" | "right"): void => {
      const s = el.style;
      s.position = "fixed";
      if (at === "left") s.left = "0";
      else s.right = "0";
      s.width = "12px";
      s.height = "12px";
      s.pointerEvents = "none";
      s.background =
        at === "left"
          ? "radial-gradient(circle at 100% 100%, transparent 11.5px, rgba(0, 0, 0, 0.12) 12px)"
          : "radial-gradient(circle at 0 100%, transparent 11.5px, rgba(0, 0, 0, 0.12) 12px)";
    };
    corner(cornerLeft, "left");
    corner(cornerRight, "right");
    shadeHost = hostEl;
    shadeLayer = shade;
    shadeCornerLeft = cornerLeft;
    shadeCornerRight = cornerRight;
    doc.documentElement.appendChild(hostEl);
    paintShade();
  }

  function paintShade(): void {
    // The old content takes the top 1-step, dimmed so that it fades out at the boundary (no stroke).
    const old = ((1 - pageStep) * 100).toFixed(2);
    if (shadeLayer) {
      shadeLayer.style.height = `${old}%`;
      shadeLayer.style.background =
        "linear-gradient(to bottom, rgba(0, 0, 0, 0.24), rgba(0, 0, 0, 0.12))";
    }
    if (shadeCornerLeft) shadeCornerLeft.style.top = `${old}%`;
    if (shadeCornerRight) shadeCornerRight.style.top = `${old}%`;
  }

  function setPageStep(value: unknown): void {
    pageStep = helpers.normalizePageStep(value);
    paintShade();
  }

  function keyList(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === "string" && item) out.push(item);
    }
    return out;
  }

  /** The main window pushes the command layer's bindings over as-is (an empty array = the user unbound them). */
  function setKeys(prev: unknown, next: unknown): void {
    const prevList = keyList(prev);
    const nextList = keyList(next);
    if (prevList) prevKeys = prevList;
    if (nextList) nextKeys = nextList;
  }

  /** The "forward to the main window" keys pushed in by the main window (the general commands plus the region switch / web zoom). */
  function setHostKeys(value: unknown): void {
    const list = keyList(value);
    if (list) hostKeys = list;
  }

  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  /**
   * Shares one binding parser with commands/keys.ts (including the ⌘− form
   * where the modifier key itself is "-") and the same modifier
   * normalization (Shift+symbol and macOS Option+letter are both matched by
   * the physical key).
   */
  function bindingMatches(event: KeyboardEvent, binding: string): boolean {
    const parsed = helpers.parseBinding(binding);
    const key = parsed.key;
    if (!key) return false;
    const mods = parsed.mods;
    if (mods.includes("Mod") !== (IS_MAC ? event.metaKey : event.ctrlKey)) return false;
    if (mods.includes("Shift") !== event.shiftKey) return false;
    if (mods.includes("Alt") !== event.altKey) return false;
    if (mods.includes("Ctrl") !== (IS_MAC && event.ctrlKey)) return false;
    if (mods.includes("Meta") !== (!IS_MAC && event.metaKey)) return false;
    return helpers.eventKeyName(event) === key;
  }

  /** The main scroll container of the page: the document when the window scrolls, otherwise the closest scrollable ancestor below the viewport center. */
  function pageTarget(): HTMLElement | null {
    const docEl = (document.scrollingElement || document.documentElement) as HTMLElement | null;
    if (docEl && docEl.scrollHeight > window.innerHeight + 1) return docEl;
    let el = document.elementFromPoint(
      window.innerWidth / 2,
      window.innerHeight / 2,
    ) as HTMLElement | null;
    while (el && el !== document.documentElement) {
      const overflow = getComputedStyle(el).overflowY;
      if (
        (overflow === "auto" || overflow === "scroll" || overflow === "overlay") &&
        el.scrollHeight > el.clientHeight + 1
      ) {
        return el;
      }
      el = el.parentElement;
    }
    if (docEl && docEl.scrollHeight > docEl.clientHeight + 1) return docEl;
    return null;
  }

  /** The line rects of the text nodes on the viewport split line (client coordinates). */
  function lineBandsAtViewportY(y: number): Array<{ top: number; bottom: number }> {
    const out: Array<{ top: number; bottom: number }> = [];
    if (typeof document.caretRangeFromPoint !== "function") return out;
    const xs = [0.15, 0.3, 0.5, 0.7, 0.85].map((f) => Math.round(window.innerWidth * f));
    for (const x of xs) {
      const caret = document.caretRangeFromPoint(x, y);
      const node = caret?.startContainer ?? null;
      if (!node || node.nodeType !== 3) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (r.width > 0.5 && r.height > 0.5 && r.bottom > y && r.top < y) {
          out.push({ top: r.top, bottom: r.bottom });
        }
      }
    }
    return out;
  }

  /** Scroll one page by the step; returns whether this runtime took it over (only then is preventDefault called). */
  function scrollPage(delta: number): boolean {
    if (!delta) return false;
    const target = pageTarget();
    if (!target) return false;
    // After an explicit page turn the position of the initial open is no longer restored.
    userTookOver();
    const documentScroller =
      target === document.scrollingElement ||
      target === document.documentElement ||
      target === document.body;
    const view = documentScroller ? window.innerHeight : target.clientHeight;
    const max = Math.max(0, target.scrollHeight - target.clientHeight);
    const nominal = Math.min(max, Math.max(0, target.scrollTop + delta * view * pageStep));
    target.scrollTop = nominal;
    // Already at the first or last page, so it stops there; otherwise the split line is aligned with a text line edge within 2% of the viewport.
    if (nominal <= 0 || nominal >= max) return true;
    const boundary = window.innerHeight * (1 - pageStep);
    const snapped = helpers.snapScrollTopToLine(
      nominal,
      view,
      target.scrollHeight,
      boundary,
      lineBandsAtViewportY(boundary),
      window.innerHeight * 0.02,
    );
    if (snapped !== nominal) target.scrollTop = snapped;
    return true;
  }

  function onPageKey(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    // The reading-area shortcuts of the main window (switch to the agent / notes column): the page matches first, and a hit is forwarded to the
    // main window — both sides use the same region keybindings, and the main window pushes them again after a rebinding.
    if (hostKeys.length > 0) {
      const forwarded = hostKeys.find((binding) => bindingMatches(event, binding));
      if (forwarded) {
        if (isEditable(event.target as Element | null)) return;
        hostKeySeq += 1;
        document.title = `bnote-key:${JSON.stringify({ key: forwarded, n: hostKeySeq })}`;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    // PageUp/PageDown are fixed page-turn keys (consistent with the main window's command dispatch): even when they are unbound, a press
    // without modifiers still turns the page; with modifiers the binding table / the page itself decides.
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    let delta = 0;
    if (plain && event.key === "PageDown") delta = 1;
    else if (plain && event.key === "PageUp") delta = -1;
    else if (nextKeys.some((key) => bindingMatches(event, key))) delta = 1;
    else if (prevKeys.some((key) => bindingMatches(event, key))) delta = -1;
    if (!delta) return;
    // The page turn and the arrow keys inside an input / editable area belong to the control itself (caret movement, text scrolling).
    if (isEditable(event.target as Element | null)) return;
    if (scrollPage(delta)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function styleMark(el: HTMLElement, kind: WebAnnotationKind): void {
    const s = el.style;
    s.position = "absolute";
    s.background = kind === "note" ? "rgba(0, 140, 255, 0.42)" : "rgba(255, 224, 0, 0.42)";
    s.mixBlendMode = "multiply";
    s.borderRadius = "2px";
    s.pointerEvents = "none";
  }

  function applyScrollTransform(): void {
    if (!layer) return;
    layer.style.transform = `translate(${buildScrollX - window.scrollX}px, ${
      buildScrollY - window.scrollY
    }px)`;
  }

  /** Write the text annotation card's input back: only on a pause or on blur is it persisted and reported, so typing is never interrupted. */
  function scheduleAnnotationSave(): void {
    if (emitAnnotationsTimer) clearTimeout(emitAnnotationsTimer);
    emitAnnotationsTimer = setTimeout(() => {
      emitAnnotationsTimer = null;
      saveCurrent();
      emit();
    }, 400);
  }

  function unionRect(rects: DocRect[]): DocRect | null {
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const r of rects) {
      if (!(r.w > 0) || !(r.h > 0)) continue;
      left = Math.min(left, r.x);
      top = Math.min(top, r.y);
      right = Math.max(right, r.x + r.w);
      bottom = Math.max(bottom, r.y + r.h);
    }
    if (left === Number.POSITIVE_INFINITY) return null;
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  /**
   * The text annotation card: it sticks to the right of the selection (to the
   * left when it does not fit) and scrolls along with the body text. The card
   * lives in a shadow root, so page CSS cannot reach it; the input is a
   * plain textarea.
   */
  function buildNoteCard(
    annotation: WebAnnotation,
    rects: DocRect[],
    sx: number,
    sy: number,
  ): HTMLElement {
    const bbox = unionRect(rects);
    const card = document.createElement("div");
    const s = card.style;
    s.position = "absolute";
    s.width = `${NOTE_CARD_W}px`;
    s.boxSizing = "border-box";
    s.background = "rgba(255, 255, 255, 0.97)";
    s.color = "#1f2328";
    s.border = "1px solid rgba(30, 130, 220, 0.45)";
    s.borderLeft = "3px solid rgb(30, 130, 220)";
    s.borderRadius = "6px";
    s.boxShadow = "0 4px 16px rgba(0, 0, 0, 0.18)";
    s.padding = "6px 24px 6px 8px";
    s.pointerEvents = "auto";
    s.cursor = "text";
    s.zIndex = "1";
    s.font =
      "12px/1.5 -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', sans-serif";
    // Keep it inside the viewport horizontally: when it does not fit on the right, flip it to the left of the selection, and if that fails stick to the right edge.
    const limit = Math.max(8, window.innerWidth - NOTE_CARD_W - 8);
    const rightEdge = bbox ? bbox.x + bbox.w - sx : window.innerWidth;
    let left = rightEdge + 10;
    if (left > limit) left = rightEdge - NOTE_CARD_W - 20;
    s.left = `${Math.round(Math.max(8, Math.min(left, limit)))}px`;
    s.top = `${Math.round((bbox ? bbox.y : window.scrollY) - sy)}px`;

    const remove = document.createElement("button");
    const rs = remove.style;
    rs.position = "absolute";
    rs.top = "2px";
    rs.right = "4px";
    rs.width = "18px";
    rs.height = "18px";
    rs.padding = "0";
    rs.border = "none";
    rs.background = "transparent";
    rs.color = "#8a8f98";
    rs.font = "14px/18px -apple-system, sans-serif";
    rs.cursor = "pointer";
    remove.textContent = "×";
    remove.title = "删除这条批注";
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeAnnotation(annotation.id);
    });

    const input = document.createElement("textarea");
    const is = input.style;
    is.display = "block";
    is.width = "100%";
    is.boxSizing = "border-box";
    is.border = "none";
    is.background = "transparent";
    is.color = "inherit";
    is.font = "inherit";
    is.lineHeight = "inherit";
    is.resize = "none";
    is.outline = "none";
    is.padding = "0";
    is.margin = "0";
    is.minHeight = "42px";
    is.maxHeight = "200px";
    is.overflowY = "auto";
    is.cursor = "text";
    input.rows = 2;
    input.value = annotation.text;
    input.placeholder = "写批注…";
    const autosize = () => {
      is.height = "auto";
      is.height = `${Math.min(200, Math.max(42, input.scrollHeight))}px`;
    };
    input.addEventListener("input", () => {
      const value = input.value.slice(0, MAX_NOTE_TEXT);
      autosize();
      if (annotation.text === value) return;
      annotation.text = value;
      scheduleAnnotationSave();
    });
    input.addEventListener("blur", () => {
      if (annotation.text !== input.value.slice(0, MAX_NOTE_TEXT)) {
        annotation.text = input.value.slice(0, MAX_NOTE_TEXT);
      }
      if (emitAnnotationsTimer) {
        clearTimeout(emitAnnotationsTimer);
        emitAnnotationsTimer = null;
      }
      saveCurrent();
      emit();
    });
    // Keep the page's drag / click / shortcut handling from messing with the annotation input.
    for (const type of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "keydown"]) {
      card.addEventListener(type, (event) => event.stopPropagation());
    }
    card.appendChild(remove);
    card.appendChild(input);
    noteInputs.set(annotation.id, input);
    setTimeout(autosize, 0);

    if (focusNoteId === annotation.id) {
      focusNoteId = null;
      setTimeout(() => {
        try {
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        } catch {
          // The input is no longer in the document
        }
      }, 0);
    }
    return card;
  }

  function rebuild(): void {
    if (!document.body) return;
    const layerEl = ensureLayer();
    if (!layerEl) return;
    const info = collectText();
    const sx = window.scrollX;
    const sy = window.scrollY;
    const frag = document.createDocumentFragment();
    const nextHits: Array<DocRect & { id: string }> = [];
    noteInputs = new Map();
    for (const a of items) {
      const range = rangeOf(a, info);
      if (!range) continue;
      const boxes = Array.from(range.getClientRects())
        .filter((r) => r.width > 1 && r.height > 1)
        .map((r) => ({ x: r.left + sx, y: r.top + sy, w: r.width, h: r.height }));
      if (boxes.length === 0) continue;
      const merged = helpers.mergeLineRects(boxes, 8);
      for (const r of merged) {
        const el = document.createElement("div");
        styleMark(el, a.kind);
        el.style.left = `${r.x - sx}px`;
        el.style.top = `${r.y - sy}px`;
        el.style.width = `${r.w}px`;
        el.style.height = `${r.h}px`;
        frag.appendChild(el);
        nextHits.push({ id: a.id, ...r });
      }
      if (a.kind === "note") frag.appendChild(buildNoteCard(a, merged, sx, sy));
    }
    layerEl.replaceChildren(frag);
    hitRects = nextHits;
    buildScrollX = sx;
    buildScrollY = sy;
    applyScrollTransform();
  }

  function scheduleRebuild(delay: number): void {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      // While typing in an annotation card: do not rebuild for this DOM change (that would replace the input and lose the focus),
      // the next content change / interaction schedules one again.
      if (host && document.activeElement === host) return;
      rebuild();
    }, delay);
  }

  function watchDom(): void {
    if (observer || !mode || !document.body) return;
    observer = new MutationObserver(() => {
      if (items.length > 0) scheduleRebuild(700);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function unwatchDom(): void {
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  // ---- Interaction ----

  function isEditable(el: Element | null): boolean {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    const html = el as HTMLElement;
    if (html.isContentEditable) return true;
    return !!el.closest("[contenteditable]:not([contenteditable='false'])");
  }

  function hitAt(clientX: number, clientY: number): string | null {
    const x = clientX + window.scrollX;
    const y = clientY + window.scrollY;
    for (let i = hitRects.length - 1; i >= 0; i--) {
      const r = hitRects[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.id;
    }
    return null;
  }

  function removeAnnotation(id: string): void {
    items = items.filter((a) => a.id !== id);
    saveCurrent();
    rebuild();
    emit();
  }

  /** Focus an existing annotation card; when the card is not drawn yet, remember its id and focus it after the rebuild. */
  function focusNote(id: string): void {
    const input = noteInputs.get(id);
    if (input) {
      try {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      } catch {
        // The input is no longer in the document
      }
      return;
    }
    focusNoteId = id;
    rebuild();
  }

  function createFromSelection(range: Range): void {
    const kind = mode;
    if (!kind) return;
    const info = collectText();
    const start0 = offsetOfPoint(info.entries, range.startContainer, range.startOffset);
    const end0 = offsetOfPoint(info.entries, range.endContainer, range.endOffset);
    if (start0 === null || end0 === null || end0 <= start0) return;
    let start = start0;
    let end = end0;
    while (start < end && /\s/.test(info.text[start])) start++;
    while (end > start && /\s/.test(info.text[end - 1])) end--;
    if (end <= start) return;
    if (end - start > MAX_QUOTE) end = start + MAX_QUOTE;
    const quote = info.text.slice(start, end);
    if (!quote.trim()) return;
    // A repeated mouseup at the same spot (a double click / the end of a drag selection) does not create a second annotation.
    const existing = items.find((a) => a.offset === start && a.quote === quote);
    if (existing) {
      // A sentence that was already highlighted is switched to a text annotation: it is upgraded in place instead of stacking another one.
      if (kind === "note" && existing.kind !== "note") {
        existing.kind = "note";
        focusNoteId = existing.id;
        saveCurrent();
        rebuild();
        emit();
      }
      return;
    }
    const annotation: WebAnnotation = {
      id: newId(),
      quote,
      prefix: info.text.slice(Math.max(0, start - CONTEXT), start),
      suffix: info.text.slice(end, end + CONTEXT),
      offset: start,
      kind,
      text: "",
      createdAt: Date.now(),
    };
    if (kind === "note") focusNoteId = annotation.id;
    items.push(annotation);
    saveCurrent();
    rebuild();
    emit();
  }

  // ---- Selection translation ----
  // The word/sentence split happens in Rust: a single word only queries the built-in dictionary (a miss is returned, no network),
  // two or more words call the model. The page here only collects the selection, sends the request and draws the result card.
  const TRANSLATE_W = 340;
  const MAX_TRANSLATE_TEXT = 4000;

  function ensureTranslateHost(): HTMLElement | null {
    if (translateHost && translateHost.isConnected) return translateHost;
    const doc = document;
    if (!doc.documentElement) return null;
    const el = doc.createElement("div");
    el.id = "bnote-web-translate-host";
    const s = el.style;
    s.position = "fixed";
    s.left = "0";
    s.top = "0";
    s.width = "0";
    s.height = "0";
    s.overflow = "visible";
    s.pointerEvents = "none";
    s.zIndex = "2147483646";
    if (typeof el.attachShadow === "function") {
      el.attachShadow({ mode: "open" });
    }
    doc.documentElement.appendChild(el);
    translateHost = el;
    return el;
  }

  /** Close the card and bump the request number by 1: every translation result that arrives later is void. */
  function hideTranslation(): void {
    translateSeq++;
    if (translateCard) {
      translateCard.remove();
      translateCard = null;
    }
  }

  type TranslateRow = { text: string; tone?: "phonetic" | "dim" | "error" };

  /**
   * The card is drawn in its own shadow root with a fixed light appearance
   * (the page may be dark; the card has to be readable). It is positioned
   * fixed and clamped to the viewport; a pointerdown outside the card closes
   * it.
   */
  function renderTranslationCard(title: string, rows: TranslateRow[], foot: string): void {
    const hostEl = ensureTranslateHost();
    if (!hostEl) return;
    if (translateCard) translateCard.remove();
    const card = document.createElement("div");
    const s = card.style;
    s.position = "fixed";
    s.boxSizing = "border-box";
    const width = Math.min(TRANSLATE_W, Math.max(200, window.innerWidth - 20));
    s.width = `${width}px`;
    s.maxHeight = `${Math.max(160, window.innerHeight - 20)}px`;
    s.overflowY = "auto";
    s.padding = "10px 12px";
    s.background = "rgba(255, 255, 255, 0.98)";
    s.color = "#1f2328";
    s.border = "1px solid rgba(31, 35, 40, 0.18)";
    s.borderRadius = "10px";
    s.boxShadow = "0 10px 30px rgba(0, 0, 0, 0.22)";
    s.font =
      "13px/1.55 -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', sans-serif";
    s.pointerEvents = "auto";
    s.cursor = "auto";
    s.zIndex = "2";
    s.colorScheme = "light";
    s.textAlign = "left";
    s.userSelect = "text";

    const head = document.createElement("div");
    head.style.display = "flex";
    head.style.alignItems = "center";
    head.style.gap = "8px";
    const titleEl = document.createElement("div");
    titleEl.style.flex = "1";
    titleEl.style.minWidth = "0";
    titleEl.style.fontWeight = "600";
    titleEl.style.overflowWrap = "anywhere";
    titleEl.textContent = title;
    const close = document.createElement("button");
    close.textContent = "×";
    close.title = "关闭";
    const cs = close.style;
    cs.flex = "0 0 auto";
    cs.width = "22px";
    cs.height = "22px";
    cs.padding = "0";
    cs.border = "none";
    cs.borderRadius = "5px";
    cs.background = "transparent";
    cs.color = "#8a8f98";
    cs.font = "16px/22px -apple-system, sans-serif";
    cs.cursor = "pointer";
    close.addEventListener("mousedown", (event) => event.preventDefault());
    close.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideTranslation();
    });
    head.appendChild(titleEl);
    head.appendChild(close);
    card.appendChild(head);

    const body = document.createElement("div");
    body.style.display = "flex";
    body.style.flexDirection = "column";
    body.style.gap = "3px";
    body.style.marginTop = "6px";
    for (const row of rows) {
      const line = document.createElement("div");
      line.textContent = row.text;
      line.style.whiteSpace = "pre-wrap";
      line.style.overflowWrap = "anywhere";
      if (row.tone === "phonetic") {
        line.style.color = "#6b7280";
        line.style.fontSize = "11.5px";
      } else if (row.tone === "dim") {
        line.style.color = "#6b7280";
        line.style.fontSize = "12px";
      } else if (row.tone === "error") {
        line.style.color = "#c0392b";
      }
      body.appendChild(line);
    }
    card.appendChild(body);

    const footEl = document.createElement("div");
    footEl.textContent = foot;
    footEl.style.marginTop = "7px";
    footEl.style.paddingTop = "5px";
    footEl.style.borderTop = "1px solid rgba(31, 35, 40, 0.12)";
    footEl.style.color = "#8a8f98";
    footEl.style.fontSize = "11px";
    card.appendChild(footEl);

    // Clicks and drag selections on the card belong to the card itself and must not fall back to the page's selection / link handling.
    for (const type of ["pointerdown", "mousedown", "mouseup", "click", "dblclick"]) {
      card.addEventListener(type, (event) => event.stopPropagation());
    }

    const root = hostEl.shadowRoot ?? hostEl;
    root.appendChild(card);

    let left = translateX + 12;
    if (left + width + 10 > window.innerWidth) left = translateX - width - 12;
    left = Math.max(10, Math.min(left, window.innerWidth - width - 10));
    let top = translateY + 18;
    const height = card.offsetHeight;
    if (top + height + 10 > window.innerHeight) top = translateY - height - 12;
    top = Math.max(10, Math.min(top, window.innerHeight - height - 10));
    s.left = `${Math.round(left)}px`;
    s.top = `${Math.round(top)}px`;
    translateCard = card;
  }

  /** Send one translation request. The page only sends the text / request number / mouse position and never touches an API key. */
  function requestTranslation(text: string, x: number, y: number): void {
    // Annotation mode wins: even if a call site forgot the state check, no request is sent here.
    if (!translateEnabled || mode) return;
    translateX = x;
    translateY = y;
    const id = ++translateSeq;
    if (text.length > MAX_TRANSLATE_TEXT) {
      renderTranslationCard(
        "选中内容过长",
        [{ text: `一次最多 ${MAX_TRANSLATE_TEXT} 字符。`, tone: "error" }],
        "未发送",
      );
      return;
    }
    renderTranslationCard("查询中…", [{ text: "正在查询内置词典或翻译模型…", tone: "dim" }], "…");
    try {
      document.title = "bnote-translate:" + JSON.stringify({ id, doc: TRANSLATE_DOC, text, x, y });
    } catch {
      hideTranslation();
    }
  }

  /** Rust evals the translation result back in; only the current request number is accepted, a late result is dropped. */
  function showTranslation(id: unknown, doc: unknown, payload: unknown): void {
    if (doc !== TRANSLATE_DOC) return;
    if (!translateEnabled || mode) return;
    if (typeof id !== "number" || id !== translateSeq) return;
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;
    const kind = typeof p.kind === "string" ? p.kind : "";
    if (kind === "none") {
      hideTranslation();
      return;
    }
    if (kind === "word") {
      const entry = p.entry as Record<string, unknown> | undefined;
      if (!entry) return;
      const word = typeof entry.word === "string" ? entry.word : "";
      const phonetic = typeof entry.phonetic === "string" ? entry.phonetic.trim() : "";
      const translation = typeof entry.translation === "string" ? entry.translation : "";
      const rows: TranslateRow[] = [];
      if (phonetic) rows.push({ text: `/${phonetic}/`, tone: "phonetic" });
      for (const line of translation.split("\n")) {
        if (line.trim()) rows.push({ text: line.trim() });
      }
      renderTranslationCard(word || "单词", rows, "内置词典");
      return;
    }
    if (kind === "miss") {
      const word = typeof p.word === "string" ? p.word : "";
      renderTranslationCard(
        word || "未收录",
        [
          { text: "内置词典未收录这个词。" },
          { text: "选中两个及以上单词可调用模型翻译。", tone: "dim" },
        ],
        "本地查询 · 未收录",
      );
      return;
    }
    if (kind === "sentence") {
      const translation = typeof p.translation === "string" ? p.translation : "";
      renderTranslationCard("句子翻译", [{ text: translation }], "模型翻译");
      return;
    }
    if (kind === "error") {
      const message = typeof p.message === "string" ? p.message : "翻译失败";
      renderTranslationCard("翻译失败", [{ text: message, tone: "error" }], "未发送译文");
    }
  }

  /** The master switch pushed in by the main window. When it is off the card is closed at once; annotation mode still wins through setMode. */
  function setTranslate(value: unknown): void {
    translateEnabled = value === true;
    if (!translateEnabled) hideTranslation();
  }

  function onMouseUp(event: MouseEvent): void {
    // Operations on the translation card belong to the card itself (events inside the shadow are redirected to the host).
    if (translateHost && translateHost.contains(event.target as Node)) return;
    if (!mode) {
      // Ordinary reading: only the selection translation; with the switch off nothing is handled. Annotation mode is below,
      // the two gestures are mutually exclusive — this branch is never reached when mode is non-null.
      if (!translateEnabled) return;
      if (host && event.target === host) return;
      if (isEditable(event.target as Element | null)) return;
      const x = event.clientX;
      const y = event.clientY;
      window.setTimeout(() => {
        if (mode || !translateEnabled) return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        if (!document.body || !document.body.contains(range.commonAncestorContainer)) return;
        const text = sel.toString().trim();
        if (!text) return;
        requestTranslation(text, x, y);
      }, 0);
      return;
    }
    // Landing on an annotation card (redirected to the host through the shadow): the input and the card removal belong to the card itself.
    if (host && event.target === host) return;
    if (isEditable(event.target as Element | null)) return;
    // Wait for the browser to settle the selection of this mouseup (end of a drag selection / a double click).
    setTimeout(() => {
      if (!mode) return;
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        if (!document.body || !document.body.contains(range.commonAncestorContainer)) return;
        createFromSelection(range);
        sel.removeAllRanges();
        suppressClickUntil = Date.now() + 500;
        return;
      }
      // Some environments clear the selection after a single or double click (rangeCount 0); removing a highlight must not depend on it.
      const hit = hitAt(event.clientX, event.clientY);
      const annotation = hit ? items.find((a) => a.id === hit) : undefined;
      if (!annotation) return;
      // Same as in the PDF: the highlight tool only removes a highlight, the text tool only focuses a text annotation,
      // neither deletes the other kind of annotation by accident.
      if (mode === "note" && annotation.kind === "note") {
        focusNote(annotation.id);
        suppressClickUntil = Date.now() + 500;
      } else if (mode === "highlight" && annotation.kind === "highlight") {
        removeAnnotation(annotation.id);
        suppressClickUntil = Date.now() + 500;
      }
    }, 0);
  }

  function onClickCapture(event: MouseEvent): void {
    if (!mode) return;
    if (Date.now() > suppressClickUntil) return;
    // An annotation was just created or removed at that spot: do not let the same click also trigger a page link.
    if (hitAt(event.clientX, event.clientY) === null) {
      const target = event.target as Element | null;
      if (target && target.closest("a[href],button,[role='button']")) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
  }

  function onScroll(): void {
    if (scrollPending || !layer) return;
    scrollPending = true;
    requestAnimationFrame(() => {
      scrollPending = false;
      applyScrollTransform();
    });
  }

  function onUrlChange(): void {
    if (location.href === url) return;
    hideTranslation();
    url = location.href;
    items = loadFromStorage(url);
    userScrolled = false;
    restoreRatio = location.hash ? null : loadPosition(url);
    scheduleRestore();
    scheduleRebuild(0);
  }

  function patchHistory(): void {
    try {
      const h = window.history;
      const rawPush = h.pushState.bind(h);
      const rawReplace = h.replaceState.bind(h);
      h.pushState = (data: unknown, _unused: string, next?: string | URL | null) => {
        rawPush(data, _unused, next);
        onUrlChange();
      };
      h.replaceState = (data: unknown, _unused: string, next?: string | URL | null) => {
        rawReplace(data, _unused, next);
        onUrlChange();
      };
    } catch {
      // The page froze history (very rare): the popstate/hashchange tracking still works.
    }
  }

  /**
   * The cursor in the web page is fixed to a pen shape, but **the pen is not in
   * the CSS**: every mouse move makes WKWebView send the whole cursor to the
   * UI process over IPC, and `PageClientImpl::setCursor` only skips the set
   * when "the newly created platform cursor is the current cursor". A native
   * keyword returns the AppKit singleton, always identical; a `url(...)` image
   * cursor creates a new NSCursor through `createCustomCursor` every time,
   * never identical -> the cursor is reset on every mouse move and the pointer
   * flickers (see the note in src-tauri/src/commands/pen_cursor.rs).
   *
   * So only a native keyword is written here, which makes WebKit always get
   * the same system cursor; the real pen is substituted by the native layer
   * with an NSCursor of the same PNG over the area of this webview. crosshair
   * is the fallback when the native layer does not kick in (debug pages /
   * non-macOS): at least a crosshair, never back to an arrow.
   *
   * The style sheet is installed when the runtime starts and never changed
   * afterwards (switching the annotation mode does not touch it). Its
   * specificity is lifted to id level with `:not(#…)`, so even a
   * page-authored `a:hover{cursor:pointer!important}` cannot override it.
   */
  function installCursorSheet(): void {
    // :not(#bnote-cursor) adds no selector semantics, it only borrows the weight of an id (twice = (2,1,0)).
    const guard = ":not(#bnote-cursor):not(#bnote-cursor)";
    const css = [
      `html${guard} { cursor: crosshair !important; }`,
      `html${guard} * { cursor: inherit !important; }`,
    ].join("\n");
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {
      // Old WebKit has no constructable style sheet: fall back to an inline cursor on <html> (a cursor the page writes itself in a
      // descendant still overrides it, but most of the page stays a crosshair).
      try {
        document.documentElement.style.setProperty("cursor", "crosshair", "important");
      } catch {
        // The page refuses style changes: the cursor looks bad, but the annotations still work.
      }
    }
  }

  function setMode(value: unknown): void {
    const next: WebAnnotationKind | null =
      value === "note" ? "note" : value === true || value === "highlight" ? "highlight" : null;
    if (mode === next) return;
    mode = next;
    if (mode) {
      // Annotation mode wins: entering the annotation mode closes the translation card at once and voids the requests in flight.
      hideTranslation();
      watchDom();
      rebuild();
    } else {
      unwatchDom();
    }
  }

  function merge(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const p = payload as { url?: unknown; annotations?: unknown };
    const target = typeof p.url === "string" && p.url ? p.url : url;
    const incoming = helpers.normalizeWebAnnotations(p.annotations);
    if (incoming.length === 0) return;
    const base = target === url ? items : loadFromStorage(target);
    const ids = new Set(base.map((a) => a.id));
    let changed = false;
    for (const a of incoming) {
      if (ids.has(a.id)) continue;
      ids.add(a.id);
      base.push(a);
      changed = true;
    }
    if (!changed) return;
    if (base.length > 800) base.length = 800;
    saveToStorage(target, base);
    if (target === url) {
      items = base;
      rebuild(); // The merge does not write the title back, avoiding a main window <-> page ping-pong.
    }
  }

  function exportState(): { url: string; annotations: WebAnnotation[] } {
    return { url, annotations: items };
  }

  w.__bnoteAnno = {
    setMode,
    setTranslate,
    showTranslation,
    merge,
    export: exportState,
    refresh: rebuild,
    page: scrollPage,
    setStep: setPageStep,
    setKeys,
    setHostKeys,
  };
  // Rust's page-turn command only knows this entry point: it is decoupled from the annotation switch, so ordinary reading can turn pages by step too.
  (w as { __bnoteReader?: Record<string, unknown> }).__bnoteReader = {
    page: scrollPage,
    setStep: setPageStep,
    setKeys,
    setHostKeys,
  };

  /** A scroll of the card itself (a long translation) is not a page scroll: only page scrolls are taken. */
  function onTranslateScroll(event: Event): void {
    if (translateHost && event.target instanceof Node && translateHost.contains(event.target)) {
      return;
    }
    hideTranslation();
  }

  // ---- Startup ----
  window.addEventListener("mouseup", onMouseUp, true);
  // Selection translation: a click outside the card, a scroll or Esc all close the card. The capture phase runs before the page's own handling;
  // the card's own events are already redirected to translateHost, so they are not closed by accident here.
  window.addEventListener(
    "pointerdown",
    (event: PointerEvent) => {
      if (translateHost && translateHost.contains(event.target as Node)) return;
      hideTranslation();
    },
    true,
  );
  window.addEventListener("scroll", onTranslateScroll, { passive: true, capture: true });
  window.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      if (event.key === "Escape") hideTranslation();
    },
    true,
  );
  window.addEventListener("click", onClickCapture, true);
  window.addEventListener("keydown", onPageKey, true);
  window.addEventListener("scroll", onScroll, { passive: true });
  // Reading position: the ratio is stored once the scroll stops; only the capture phase receives the scroll of an inner scroll container.
  window.addEventListener("scroll", scheduleSavePosition, { passive: true, capture: true });
  // As soon as the user acts, the "landing spot of the initial open" is given up, and the later layout changes no longer fight for the scroll position.
  window.addEventListener("wheel", userTookOver, { passive: true, capture: true });
  window.addEventListener("touchstart", userTookOver, { passive: true, capture: true });
  window.addEventListener("pointerdown", userTookOver, true);
  window.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      if (/^(PageUp|PageDown|ArrowUp|ArrowDown|Home|End| )$/.test(event.key)) userTookOver();
    },
    true,
  );
  window.addEventListener("resize", () => {
    hideTranslation();
    scheduleRebuild(200);
    applyStoredScroll();
  });
  window.addEventListener("hashchange", onUrlChange);
  window.addEventListener("popstate", onUrlChange);
  window.addEventListener("load", () => {
    scheduleRebuild(0);
    scheduleRestore();
  });
  window.addEventListener("pagehide", () => {
    if (savePositionTimer) {
      clearTimeout(savePositionTimer);
      savePositionTimer = null;
    }
    // The annotation text being typed must also be persisted before leaving the page (localStorage in the page + the main window).
    if (emitAnnotationsTimer) {
      clearTimeout(emitAnnotationsTimer);
      emitAnnotationsTimer = null;
    }
    saveCurrent();
    emit();
    savePositionNow();
  });
  patchHistory();
  installCursorSheet();
  ensureShade();
  scheduleRestore();
  document.addEventListener("DOMContentLoaded", () => {
    ensureShade();
    scheduleRebuild(0);
    scheduleRestore();
    watchDom();
  });
  if (document.readyState !== "loading") {
    ensureShade();
    scheduleRebuild(0);
  }
  try {
    if (document.fonts && document.fonts.ready) {
      void document.fonts.ready.then(() => {
        scheduleRebuild(0);
        scheduleRestore();
      });
    }
  } catch {
    // Old WebKit has no FontFaceSet
  }
}
