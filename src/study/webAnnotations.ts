import { createVaultJsonStore } from "./vaultJson";
import { mergeLineRects } from "./pdfAnnotations";

/**
 * 网页批注:选中文字 → 亮黄色高亮。
 *
 * 网页在中栏是**原生子 webview**(不是 iframe,见 commands/agent.rs),主应用
 * 拿不到它的 DOM。所以批注逻辑以初始化脚本的形式注入页面:
 *
 *  1. 页面里的运行时负责选区、锚点、黄色高亮层(自己开 shadow root,不吃
 *     页面 CSS;CSP 下也能用,样式全部走 CSSOM)。
 *  2. 批注变化时把 `{url, annotations}` 写进 `document.title` 的
 *     `bnote-anno:` 前缀;Rust 的 title 回调把它转成 Tauri 事件发给主窗口,
 *     主窗口落盘到 `<vault>/.bnote/web-annotations.json`。不开远程 IPC——
 *     任意网页都拿不到应用命令。
 *  3. 打开网页时主窗口把仓库里的锚点推回页面(`__bnoteAnno.merge`),页面
 *     按「原文片段 + 前后文 + 偏移」重新定位,并把数据也存一份在 localStorage
 *     (页面自己刷新时立即可用)。
 *
 * 锚点不用像素:广告/懒加载会让元素位移,重启后像素必然失效。文本片段
 * (±40 字上下文 + 偏移提示)才是稳定的定位依据。
 */
export interface WebAnnotation {
  id: string;
  quote: string;
  prefix: string;
  suffix: string;
  /** 创建时在正文文本流里的起始偏移,重建锚点时的消歧提示。 */
  offset: number;
  createdAt: number;
}

export interface WebAnnotationFile {
  version: 1;
  urls: Record<string, WebAnnotation[]>;
}

export const MAX_WEB_QUOTE = 2000;
export const MAX_WEB_CONTEXT = 40;
export const MAX_WEB_PER_URL = 800;

/**
 * 校验/裁剪页面送来的批注。必须自包含(不引用模块常量):它会被序列化进
 * 页面运行时。
 */
export function normalizeWebAnnotations(value: unknown): WebAnnotation[] {
  if (!Array.isArray(value)) return [];
  const out: WebAnnotation[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, 800)) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Partial<WebAnnotation>;
    if (typeof a.id !== "string" || !a.id || seen.has(a.id)) continue;
    if (typeof a.quote !== "string" || !a.quote) continue;
    if (typeof a.offset !== "number" || !Number.isFinite(a.offset) || a.offset < 0) continue;
    seen.add(a.id);
    out.push({
      id: a.id,
      quote: a.quote.slice(0, 2000),
      prefix: typeof a.prefix === "string" ? a.prefix.slice(-40) : "",
      suffix: typeof a.suffix === "string" ? a.suffix.slice(0, 40) : "",
      offset: Math.floor(a.offset),
      createdAt: typeof a.createdAt === "number" ? a.createdAt : 0,
    });
  }
  return out;
}

/**
 * 在重建后的正文里找引用的起始偏移:候选里优先前后文吻合的,平手取离
 * 原偏移最近的。找不到返回 -1(锚点保留,只是这一轮画不出来)。
 */
export function locateQuote(
  text: string,
  quote: string,
  offset: number,
  prefix: string,
  suffix: string,
): number {
  if (!quote) return -1;
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  let from = 0;
  for (let found = 0; found < 64; found++) {
    const i = text.indexOf(quote, from);
    if (i < 0) break;
    let score = 0;
    if (prefix && i >= prefix.length && text.slice(i - prefix.length, i) === prefix) {
      score += 2;
    }
    if (suffix && text.slice(i + quote.length, i + quote.length + suffix.length) === suffix) {
      score += 2;
    }
    // 距离只做最后一级平手判定,不压过上下文。
    score -= Math.min(0.9, Math.abs(i - offset) / 100000);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
    from = i + Math.max(1, quote.length);
  }
  return best;
}

// ---------------------------------------------------------------------------
// 持久化(<vault>/.bnote/web-annotations.json)
// ---------------------------------------------------------------------------

export function parseWebAnnotationFile(raw: string | null): WebAnnotationFile {
  const empty: WebAnnotationFile = { version: 1, urls: {} };
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const urls = (parsed as { urls?: unknown }).urls;
  if (!urls || typeof urls !== "object") return empty;
  const out: Record<string, WebAnnotation[]> = {};
  for (const [url, value] of Object.entries(urls as Record<string, unknown>)) {
    const list = normalizeWebAnnotations(value);
    if (list.length > 0) out[url] = list;
  }
  return { version: 1, urls: out };
}

export function withUrlAnnotations(
  file: WebAnnotationFile,
  url: string,
  list: WebAnnotation[],
): WebAnnotationFile {
  const urls = { ...file.urls };
  if (list.length > 0) urls[url] = list.slice(0, 800);
  else delete urls[url];
  return { version: 1, urls };
}

/** 两组批注按 id 合并(仓库里的 + 页面里的),页面里较新的覆盖。 */
export function mergeUrlAnnotations(
  base: WebAnnotation[],
  incoming: WebAnnotation[],
): WebAnnotation[] {
  const byId = new Map<string, WebAnnotation>();
  for (const a of base) byId.set(a.id, a);
  for (const a of incoming) byId.set(a.id, a);
  return [...byId.values()].slice(0, 800);
}

const store = createVaultJsonStore<WebAnnotationFile>({
  fileName: "web-annotations.json",
  empty: () => ({ version: 1, urls: {} }),
  parse: parseWebAnnotationFile,
  serialize: (file) => JSON.stringify(file),
});

export async function loadWebAnnotations(
  vaultRoot: string,
  url: string,
): Promise<WebAnnotation[]> {
  const file = await store.load(vaultRoot);
  return file.urls[url] ?? [];
}

export function saveWebAnnotations(
  vaultRoot: string,
  url: string,
  list: WebAnnotation[],
): void {
  store.update(vaultRoot, (file) =>
    withUrlAnnotations(file, url, normalizeWebAnnotations(list)),
  );
}

export function flushWebAnnotations(): void {
  store.flush();
}

// ---------------------------------------------------------------------------
// 注入页面的运行时
// ---------------------------------------------------------------------------

interface RuntimeHelpers {
  locateQuote: typeof locateQuote;
  mergeLineRects: typeof mergeLineRects;
  normalizeWebAnnotations: typeof normalizeWebAnnotations;
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
 * 页面内运行时。必须自包含:脚本用 `Function.prototype.toString` 序列化后
 * 注入到原生 webview(见 `buildWebAnnotationScript`),闭包里的模块变量在
 * 页面里并不存在——需要的纯函数一律通过 `helpers` 参数传进去。
 */
function webAnnotationRuntime(helpers: RuntimeHelpers): void {
  const w = window as unknown as { __bnoteAnno?: Record<string, unknown> };
  if (w.__bnoteAnno) return;

  const HOST_ID = "bnote-web-anno-host";
  const STORE_PREFIX = "bnote:web-annotations:v1:";
  const TITLE_PREFIX = "bnote-anno:";
  const CONTEXT = 40;
  const MAX_QUOTE = 2000;

  let mode = false;
  let url = location.href;
  let items: WebAnnotation[] = loadFromStorage(url);
  let host: HTMLElement | null = null;
  let layer: HTMLElement | null = null;
  let buildScrollX = 0;
  let buildScrollY = 0;
  let hitRects: Array<DocRect & { id: string }> = [];
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  let observer: MutationObserver | null = null;
  let scrollPending = false;
  let suppressClickUntil = 0;
  let previousCursor: string | null = null;

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
      // 隐私模式/配额满:页面里的高亮仍可用,只是不落 localStorage。
    }
  }

  function saveCurrent(): void {
    saveToStorage(url, items);
  }

  function emit(): void {
    try {
      // Rust 侧 on_document_title_changed 读这个前缀,转成 Tauri 事件给主窗口。
      document.title = TITLE_PREFIX + JSON.stringify({ url, annotations: items });
    } catch {
      // title 被页面写保护时忽略:数据仍在 localStorage,主窗口下次合并会补上。
    }
  }

  function newId(): string {
    try {
      const c = globalThis.crypto;
      if (c && typeof c.randomUUID === "function") return `web-${c.randomUUID()}`;
    } catch {
      // secure context 之外没有 randomUUID
    }
    return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  // ---- 正文文本流与锚点 ----

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
      // 隐藏文字(display:none、折叠菜单)不进文本流,否则重建后偏移会漂。
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

  function nodeAt(entries: TextEntry[], offset: number): { node: Text; offset: number } | null {
    for (const e of entries) {
      if (offset >= e.start && offset <= e.end) {
        const len = e.node.nodeValue ? e.node.nodeValue.length : 0;
        return { node: e.node, offset: Math.min(offset - e.start, len) };
      }
    }
    return null;
  }

  function rangeOf(
    a: WebAnnotation,
    info: { text: string; entries: TextEntry[] },
  ): Range | null {
    const start = helpers.locateQuote(info.text, a.quote, a.offset, a.prefix, a.suffix);
    if (start < 0) return null;
    const from = nodeAt(info.entries, start);
    const to = nodeAt(info.entries, start + a.quote.length);
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

  // ---- 高亮层 ----

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

  function styleMark(el: HTMLElement): void {
    const s = el.style;
    s.position = "absolute";
    s.background = "rgba(255, 224, 0, 0.42)";
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

  function rebuild(): void {
    if (!document.body) return;
    const layerEl = ensureLayer();
    if (!layerEl) return;
    const info = collectText();
    const sx = window.scrollX;
    const sy = window.scrollY;
    const frag = document.createDocumentFragment();
    const nextHits: Array<DocRect & { id: string }> = [];
    for (const a of items) {
      const range = rangeOf(a, info);
      if (!range) continue;
      const boxes = Array.from(range.getClientRects())
        .filter((r) => r.width > 1 && r.height > 1)
        .map((r) => ({ x: r.left + sx, y: r.top + sy, w: r.width, h: r.height }));
      if (boxes.length === 0) continue;
      for (const r of helpers.mergeLineRects(boxes, 8)) {
        const el = document.createElement("div");
        styleMark(el);
        el.style.left = `${r.x - sx}px`;
        el.style.top = `${r.y - sy}px`;
        el.style.width = `${r.w}px`;
        el.style.height = `${r.h}px`;
        frag.appendChild(el);
        nextHits.push({ id: a.id, ...r });
      }
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

  // ---- 交互 ----

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

  function createFromSelection(range: Range): void {
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
    // 同一位置重复 mouseup(双击/拖选结束)不重复建批注。
    if (items.some((a) => a.offset === start && a.quote === quote)) return;
    const annotation: WebAnnotation = {
      id: newId(),
      quote,
      prefix: info.text.slice(Math.max(0, start - CONTEXT), start),
      suffix: info.text.slice(end, end + CONTEXT),
      offset: start,
      createdAt: Date.now(),
    };
    items.push(annotation);
    saveCurrent();
    rebuild();
    emit();
  }

  function onMouseUp(event: MouseEvent): void {
    if (!mode) return;
    if (isEditable(event.target as Element | null)) return;
    // 等浏览器把这次 mouseup 的选区落定(拖选结束/双击)。
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
      // 单选/双击后有些环境会清空选区(rangeCount 0);取消高亮不能依赖它。
      const hit = hitAt(event.clientX, event.clientY);
      if (hit) {
        removeAnnotation(hit);
        suppressClickUntil = Date.now() + 500;
      }
    }, 0);
  }

  function onClickCapture(event: MouseEvent): void {
    if (!mode) return;
    if (Date.now() > suppressClickUntil) return;
    // 刚在该点完成批注/取消:别让同一次点击接着触发页面链接。
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
    url = location.href;
    items = loadFromStorage(url);
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
      // 页面冻结了 history(极少见):仍可靠 popstate/hashchange 跟踪。
    }
  }

  function setMode(on: boolean): void {
    const enabled = !!on;
    if (mode === enabled) return;
    mode = enabled;
    if (mode) {
      previousCursor = document.documentElement.style.cursor;
      document.documentElement.style.cursor = "copy";
      watchDom();
      rebuild();
    } else {
      document.documentElement.style.cursor = previousCursor || "";
      previousCursor = null;
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
      rebuild(); // 合并不回写 title,避免主窗口 ↔ 页面来回同步。
    }
  }

  function exportState(): { url: string; annotations: WebAnnotation[] } {
    return { url, annotations: items };
  }

  w.__bnoteAnno = { setMode, merge, export: exportState, refresh: rebuild };

  // ---- 启动 ----
  window.addEventListener("mouseup", onMouseUp, true);
  window.addEventListener("click", onClickCapture, true);
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", () => scheduleRebuild(200));
  window.addEventListener("hashchange", onUrlChange);
  window.addEventListener("popstate", onUrlChange);
  window.addEventListener("load", () => scheduleRebuild(0));
  patchHistory();
  document.addEventListener("DOMContentLoaded", () => {
    scheduleRebuild(0);
    watchDom();
  });
  if (document.readyState !== "loading") scheduleRebuild(0);
  try {
    if (document.fonts && document.fonts.ready) {
      void document.fonts.ready.then(() => scheduleRebuild(0));
    }
  } catch {
    // 老 WebKit 没有 FontFaceSet
  }
}

/** 注入原生 webview 的完整脚本(运行时 + 它依赖的纯函数)。 */
export function buildWebAnnotationScript(): string {
  return `(${webAnnotationRuntime.toString()})({locateQuote:${locateQuote.toString()},mergeLineRects:${mergeLineRects.toString()},normalizeWebAnnotations:${normalizeWebAnnotations.toString()}});`;
}

/** 只算一次:主窗口每次打开网页都把它交给 Rust 注册成初始化脚本。 */
export const WEB_ANNOTATION_SCRIPT = buildWebAnnotationScript();
