import { createVaultJsonStore, vaultDotPath } from "./vaultJson";
import { mergeLineRects } from "./pdfAnnotations";
import { normalizePageStep, snapScrollTopToLine } from "./reading";
// 页面里的笔形光标:与 PDF 阅读器同一套 PNG(热点 12 22),以 data URL 注入,
// 不依赖远端页面能否访问应用资源。`?inline` 让 Vite 直接给 base64。
import cursorHighlight from "@/assets/cursors/pdf-highlight.png?inline";
import cursorNote from "@/assets/cursors/pdf-note.png?inline";

/**
 * 网页批注:高亮(亮黄)与文字批注(亮蓝 + 页内批注卡)。
 *
 * 网页在中栏是**原生子 webview**(不是 iframe,见 commands/agent.rs),主应用
 * 拿不到它的 DOM。所以批注逻辑以初始化脚本的形式注入页面:
 *
 *  1. 页面里的运行时负责选区、锚点、高亮层与批注卡(自己开 shadow root,不吃
 *     页面 CSS;CSP 下也能用,样式全部走 CSSOM)。
 *  2. 批注变化时把 `{url, annotations}` 写进 `document.title` 的
 *     `bnote-anno:` 前缀;Rust 的 title 回调把它转成 Tauri 事件发给主窗口,
 *     主窗口落盘到 `<vault>/.bnote/web-annotations/<host>-<hash>.json`
 *     (一个网址一个文件)。不开远程 IPC——任意网页都拿不到应用命令。
 *  3. 打开网页时主窗口把仓库里的锚点推回页面(`__bnoteAnno.merge`),页面
 *     按「原文片段 + 前后文 + 偏移」重新定位,并把数据也存一份在 localStorage
 *     (页面自己刷新时立即可用)。
 *
 * 锚点不用像素:广告/懒加载会让元素位移,重启后像素必然失效。文本片段
 * (±40 字上下文 + 偏移提示)才是稳定的定位依据。阅读位置也一样存比例,
 * 见 `POS_PREFIX`。
 */
export type WebAnnotationKind = "highlight" | "note";

export interface WebAnnotation {
  id: string;
  quote: string;
  prefix: string;
  suffix: string;
  /** 创建时在正文文本流里的起始偏移,重建锚点时的消歧提示。 */
  offset: number;
  /** 亮黄高亮 / 亮蓝文字批注。旧数据没有这个字段,按高亮读。 */
  kind: WebAnnotationKind;
  /** 文字批注内容;高亮批注为空。 */
  text: string;
  createdAt: number;
}

export interface WebAnnotationFile {
  version: 1;
  /** 文件里带上原网址,便于人工辨认(文件名只有域名 + 哈希)。 */
  url: string;
  annotations: WebAnnotation[];
}

export const MAX_WEB_QUOTE = 2000;
export const MAX_WEB_CONTEXT = 40;
export const MAX_WEB_NOTE_TEXT = 2000;
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
      kind: a.kind === "note" ? "note" : "highlight",
      text: typeof a.text === "string" ? a.text.slice(0, 2000) : "",
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
// 持久化(<vault>/.bnote/web-annotations/<host>-<hash>.json,一个网址一个文件)
// ---------------------------------------------------------------------------

export function parseWebAnnotationFile(raw: string | null): WebAnnotationFile {
  const empty: WebAnnotationFile = { version: 1, url: "", annotations: [] };
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  if (!record) return empty;
  return {
    version: 1,
    url: typeof record.url === "string" ? record.url : "",
    annotations: normalizeWebAnnotations(record.annotations),
  };
}

export function parseWebAnnotations(raw: string | null): WebAnnotation[] {
  return parseWebAnnotationFile(raw).annotations;
}

/** 网址 → 批注文件名:可读域名 + 稳定哈希,同一网址永远落到同一文件。 */
export function webAnnotationFileName(url: string): string {
  let host = "page";
  try {
    host = new URL(url).hostname || "page";
  } catch {
    // 非标准 URL(about:blank 等)也给它一个稳定名字。
  }
  const slug =
    host
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "page";
  return `${slug}-${hash53(url)}.json`;
}

export function webAnnotationRelPath(url: string): string {
  return `web-annotations/${webAnnotationFileName(url)}`;
}

export function webAnnotationPath(vaultRoot: string, url: string): string {
  return vaultDotPath(vaultRoot, webAnnotationRelPath(url));
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
  pathFor: (vaultRoot, url) => webAnnotationPath(vaultRoot, url),
  empty: () => ({ version: 1, url: "", annotations: [] }),
  parse: parseWebAnnotationFile,
  serialize: (file) => JSON.stringify(file),
});

export async function loadWebAnnotations(
  vaultRoot: string,
  url: string,
): Promise<WebAnnotation[]> {
  const file = await store.load(vaultRoot, url);
  return file.annotations;
}

export function saveWebAnnotations(
  vaultRoot: string,
  url: string,
  list: WebAnnotation[],
): void {
  store.update(vaultRoot, url, () => ({
    version: 1,
    url,
    annotations: normalizeWebAnnotations(list),
  }));
}

export function flushWebAnnotations(): void {
  store.flush();
}

function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// ---------------------------------------------------------------------------
// 注入页面的运行时
// ---------------------------------------------------------------------------

interface RuntimeHelpers {
  locateQuote: typeof locateQuote;
  mergeLineRects: typeof mergeLineRects;
  normalizeWebAnnotations: typeof normalizeWebAnnotations;
  normalizePageStep: typeof normalizePageStep;
  snapScrollTopToLine: typeof snapScrollTopToLine;
  /** 笔形光标 PNG 的 data URL(高亮=荧光笔,文字批注=蓝笔尖)。 */
  cursorHighlight: string;
  cursorNote: string;
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
  const POS_PREFIX = "bnote:web-position:v1:";
  const TITLE_PREFIX = "bnote-anno:";
  const CONTEXT = 40;
  const MAX_QUOTE = 2000;
  const MAX_NOTE_TEXT = 2000;
  /** 批注卡宽度(px);放不下时贴到视口右侧。 */
  const NOTE_CARD_W = 240;
  /** 与 commands/keys.ts 的 eventToKey 同一张表：Shift+符号 的绑定按物理键记。 */
  const SHIFT_SYMBOL_BASE: Record<string, string> = {
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
    BracketLeft: "[",
    BracketRight: "]",
    Minus: "-",
    Equal: "=",
    Backquote: "`",
  };

  let mode: WebAnnotationKind | null = null;
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
  /** 笔形光标用一张 CSSOM 样式表(不走内联 style,也不吃页面 CSP)。 */
  let cursorSheet: CSSStyleSheet | null = null;
  /** 没有构造样式表时的退路:直接写在 `<html>` 上的两条光标值。 */
  let cursorFallback: { highlight: string; note: string } | null = null;
  /** 刚创建/点中的文字批注:重建后把输入框聚焦并把光标放到末尾。 */
  let focusNoteId: string | null = null;
  /** 每张批注卡里的输入框(按批注 id),重建/聚焦都走这张表。 */
  let noteInputs: Map<string, HTMLTextAreaElement> = new Map();
  /** 打开页面时待恢复的滚动比例;null = 没有记录或用户已接管。 */
  let restoreRatio: number | null = location.hash ? null : loadPosition(url);
  /** 用户主动滚动/点击/按键后,之后的定时恢复都不再抢位置。 */
  let userScrolled = false;
  /** 程序化恢复滚动的瞬间,别把它当成用户的阅读进度再存一遍。 */
  let applyingScroll = false;
  let savePositionTimer: ReturnType<typeof setTimeout> | null = null;
  let emitAnnotationsTimer: ReturnType<typeof setTimeout> | null = null;
  /** 翻页步长(可见高度的比例),由主窗口推入;默认 50%。 */
  let pageStep = helpers.normalizePageStep(0.5);
  /** 可配置的翻页键(命令层解析后的绑定字符串),由主窗口推入。 */
  let prevKeys: string[] = ["PageUp", "ArrowLeft"];
  let nextKeys: string[] = ["PageDown", "ArrowRight"];
  let shadeHost: HTMLElement | null = null;
  let shadeLayer: HTMLElement | null = null;
  let shadeCornerLeft: HTMLElement | null = null;
  let shadeCornerRight: HTMLElement | null = null;
  let frameLayer: HTMLElement | null = null;
  /**
   * 阅读分区只在「真的翻过页」之后才画。打开时就画出来等于给整屏盖一条
   * 固定在半屏的分界线——它不随任何进度变化,看起来就是一条卡住的加载
   * 进度条。翻页后它标记「这一屏之前看过的部分」,自由滚动后分区失去意义,
   * 再收起来。
   */
  let shadeVisible = false;

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

  // ---- 阅读位置:每个网址在 localStorage 里记一个滚动比例 --------------------
  // 网页的 DOM 不在主窗口,页面自己存最省事;比例而不是像素,窗口宽度变了
  // 也还能回到同一段文字。URL 带 #锚点时让链接锚点优先,不做恢复。

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

  /** 当前主滚动容器的阅读比例;没有可滚内容时返回 null。 */
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
      // 隐私模式/配额满:位置记不住,但阅读不受影响。
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
    // scroll 事件的派发时机在各引擎间不一致;给一整拍再允许存盘。
    setTimeout(() => {
      applyingScroll = false;
    }, 150);
  }

  /**
   * 多次尝试:页面脚本/图片/懒加载会在 load 之后继续长高,一次落位往往
   * 还量不到最终高度。用户一动手(见 userTookOver)所有尝试立即失效。
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

  /** 自由滚动(滚轮/触摸/键盘)后,翻页分界线不再对应任何位置,收起。 */
  function freeScrolled(): void {
    userTookOver();
    if (shadeVisible) {
      shadeVisible = false;
      paintShade();
    }
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

  // ---- 翻页与上半屏遮罩 ----

  /**
   * 翻页后的阅读分区：上方旧内容压暗，下方新内容的顶部用一条淡色圆角线
   * 标出（不画完整框）。两层都在 shadow root 里，不吃页面 CSS；不接鼠标事件。
   *
   * 平时是隐藏的（见 shadeVisible）：这条固定停在步长边界的分界线在打开
   * 网页时就画出来，看起来就是一条永远加载不完的进度条。只有真的翻过页，
   * 它才表示「上一屏读到这里」。
   */
  function ensureShade(): void {
    if (
      shadeHost &&
      shadeHost.isConnected &&
      shadeLayer &&
      shadeCornerLeft &&
      shadeCornerRight &&
      frameLayer
    ) {
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
    const frame = doc.createElement("div");
    if (typeof hostEl.attachShadow === "function") {
      const root = hostEl.attachShadow({ mode: "open" });
      root.appendChild(shade);
      root.appendChild(cornerLeft);
      root.appendChild(cornerRight);
      root.appendChild(frame);
    } else {
      hostEl.appendChild(shade);
      hostEl.appendChild(cornerLeft);
      hostEl.appendChild(cornerRight);
      hostEl.appendChild(frame);
    }
    const ss = shade.style;
    ss.position = "fixed";
    ss.left = "0";
    ss.top = "0";
    ss.width = "100%";
    ss.pointerEvents = "none";
    // 线两端向下弯出圆角；圆角外侧（线上方）补同色压暗，圆内透明。
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
    const fs = frame.style;
    fs.position = "fixed";
    fs.left = "0";
    fs.right = "0";
    fs.height = "16px";
    fs.borderTop = "2px solid rgba(230, 155, 60, 0.45)";
    fs.borderTopLeftRadius = "12px";
    fs.borderTopRightRadius = "12px";
    fs.pointerEvents = "none";
    shadeHost = hostEl;
    shadeLayer = shade;
    shadeCornerLeft = cornerLeft;
    shadeCornerRight = cornerRight;
    frameLayer = frame;
    doc.documentElement.appendChild(hostEl);
    paintShade();
  }

  function paintShade(): void {
    if (shadeHost) shadeHost.style.display = shadeVisible ? "" : "none";
    // 旧内容占上方 1-step；线压在压暗结束的那条线上，不留缝。
    const old = ((1 - pageStep) * 100).toFixed(2);
    if (shadeLayer) {
      shadeLayer.style.height = `${old}%`;
      shadeLayer.style.background =
        "linear-gradient(to bottom, rgba(0, 0, 0, 0.24), rgba(0, 0, 0, 0.12))";
    }
    if (shadeCornerLeft) shadeCornerLeft.style.top = `${old}%`;
    if (shadeCornerRight) shadeCornerRight.style.top = `${old}%`;
    if (frameLayer) frameLayer.style.top = `${old}%`;
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

  /** 主窗口把命令层的绑定原样推过来（空数组 = 用户解绑）。 */
  function setKeys(prev: unknown, next: unknown): void {
    const prevList = keyList(prev);
    const nextList = keyList(next);
    if (prevList) prevKeys = prevList;
    if (nextList) nextKeys = nextList;
  }

  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  /** 与 commands/keys.ts::eventToKey 同一套规范化，用来匹配推入的绑定。 */
  function bindingMatches(event: KeyboardEvent, binding: string): boolean {
    const parts = binding.split("-");
    const key = parts[parts.length - 1];
    if (!key) return false;
    if (parts.includes("Mod") !== (IS_MAC ? event.metaKey : event.ctrlKey)) return false;
    if (parts.includes("Shift") !== event.shiftKey) return false;
    if (parts.includes("Alt") !== event.altKey) return false;
    if (parts.includes("Ctrl") !== (IS_MAC && event.ctrlKey)) return false;
    if (parts.includes("Meta") !== (!IS_MAC && event.metaKey)) return false;
    let actual = event.key;
    if (actual === " ") actual = "Space";
    else if (actual.length === 1) actual = actual.toLowerCase();
    if (event.shiftKey && actual.length === 1 && !/[a-z0-9]/.test(actual)) {
      actual = SHIFT_SYMBOL_BASE[event.code] ?? actual;
    }
    return actual === key;
  }

  /** 页面的主滚动容器：窗口可滚时就是文档，否则找视口中心下最近的可滚祖先。 */
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

  /** 视口分界线上、文字节点的行矩形（客户区坐标）。 */
  function lineBandsAtViewportY(y: number): Array<{ top: number; bottom: number }> {
    const out: Array<{ top: number; bottom: number }> = [];
    if (typeof document.caretRangeFromPoint !== "function") return out;
    const xs = [0.15, 0.3, 0.5, 0.7, 0.85].map((f) =>
      Math.round(window.innerWidth * f),
    );
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

  /** 按步长滚一页；返回是否由本运行时接管（接管了才 preventDefault）。 */
  function scrollPage(delta: number): boolean {
    if (!delta) return false;
    const target = pageTarget();
    if (!target) return false;
    // 主动翻页后不再按打开时的位置还原。
    userTookOver();
    // 翻页是分区的唯一来源:分界线标记「刚翻过去的那一屏之前」。
    if (!shadeVisible) {
      shadeVisible = true;
      paintShade();
    }
    const documentScroller =
      target === document.scrollingElement ||
      target === document.documentElement ||
      target === document.body;
    const view = documentScroller ? window.innerHeight : target.clientHeight;
    const max = Math.max(0, target.scrollHeight - target.clientHeight);
    const nominal = Math.min(max, Math.max(0, target.scrollTop + delta * view * pageStep));
    target.scrollTop = nominal;
    // 已在首尾就停住；否则在 2% 视口内把分界线对齐到文字行边。
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
    // PageUp/PageDown 是固定翻页键（与主窗口的命令分发一致）：即使被解绑，
    // 无修饰按时也仍然翻页；带修饰时交给绑定表/页面自己。
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    let delta = 0;
    if (plain && event.key === "PageDown") delta = 1;
    else if (plain && event.key === "PageUp") delta = -1;
    else if (nextKeys.some((key) => bindingMatches(event, key))) delta = 1;
    else if (prevKeys.some((key) => bindingMatches(event, key))) delta = -1;
    if (!delta) return;
    // 输入框/可编辑区里的翻页与方向键归控件自己（光标移动、文本滚动）。
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

  /** 文字批注卡的输入写回:只在停顿/失焦时落盘和上报,不打断打字。 */
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
   * 文字批注卡:贴在选区右侧(放不下就放左侧),跟着正文一起滚动。
   * 卡片在 shadow root 里,页面 CSS 影响不到;输入框是普通 textarea。
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
    // 横向夹在视口内:右边放不下就翻到选区左侧,再不行贴右缘。
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
    // 不让页面的拖拽/点击/快捷键处理把批注输入搅乱。
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
          // 输入框已经不在文档里
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
      // 正在批注卡里打字:这次页面变动先不重建(否则输入框被替换、焦点丢失),
      // 下一次内容变动/交互会再排一次。
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

  /** 聚焦已有批注卡;卡片还没画出来就先记下 id,重建后自动聚焦。 */
  function focusNote(id: string): void {
    const input = noteInputs.get(id);
    if (input) {
      try {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      } catch {
        // 输入框已经不在文档里
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
    // 同一位置重复 mouseup(双击/拖选结束)不重复建批注。
    const existing = items.find((a) => a.offset === start && a.quote === quote);
    if (existing) {
      // 已经高亮过的句子改用文字批注:原地升级,不再叠一条。
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

  function onMouseUp(event: MouseEvent): void {
    if (!mode) return;
    // 落在批注卡(经 shadow 重定向到 host)上:输入/删卡归卡片自己。
    if (host && event.target === host) return;
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
      const annotation = hit ? items.find((a) => a.id === hit) : undefined;
      if (!annotation) return;
      // 与 PDF 一致:高亮工具只取消高亮,文字工具只聚焦文字批注,
      // 不会误删另一种批注。
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
    userScrolled = false;
    restoreRatio = location.hash ? null : loadPosition(url);
    // 新页面还没翻过页:分区不该出现(否则看起来像一条卡住的加载条)。
    if (shadeVisible) {
      shadeVisible = false;
      paintShade();
    }
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
      // 页面冻结了 history(极少见):仍可靠 popstate/hashchange 跟踪。
    }
  }

  /**
   * 批注工具:`"highlight"` / `"note"`;`false`/`null` 退出。
   *
   * 光标分两层,都只写一次样式表(启动时),切模式只改 `<html>` 上的类:
   *
   *  - 光标图片只出现在 `<html>` 这一条规则里,后代一律 `cursor: inherit`。
   *    图片铺在 `*` 上时,页面上成千上万个元素各自持有一份 cursor 值,
   *    WebKit 在鼠标移动时逐个重建 NSCursor,表现出来就是光标一直在闪。
   *  - 规则用 `:not(#…)` 抬到 id 级权重:页面自己写的
   *    `a:hover { cursor: pointer !important }` 权重常常比一条 `*` 规则高,
   *    不抬权重就会出现「有时是笔、有时是箭头」。
   */
  function installCursorSheet(): void {
    const highlight = `url("${helpers.cursorHighlight}") 12 22, crosshair`;
    const note = `url("${helpers.cursorNote}") 12 22, crosshair`;
    // :not(#bnote-cursor) 不提选择器语义,只借用 id 的权重(两次 = (2,1,0))。
    const guard = ":not(#bnote-cursor):not(#bnote-cursor)";
    const css = [
      `html.bnote-annotating${guard} { cursor: ${highlight} !important; }`,
      `html.bnote-annotating${guard} * { cursor: inherit !important; }`,
      `html.bnote-annotating-note${guard} { cursor: ${note} !important; }`,
      `html.bnote-annotating-note${guard} * { cursor: inherit !important; }`,
      // 输入控件保留页面自己的文本光标:批注模式不改它们的编辑手感。
      // 权重(2,1,2)高于上面的 (2,1,1),同一张表里排在后面即可。
      `html.bnote-annotating${guard} input, html.bnote-annotating${guard} textarea,`,
      `html.bnote-annotating${guard} select, html.bnote-annotating${guard} [contenteditable],`,
      `html.bnote-annotating-note${guard} input, html.bnote-annotating-note${guard} textarea,`,
      `html.bnote-annotating-note${guard} select, html.bnote-annotating-note${guard} [contenteditable] {`,
      `  cursor: auto !important;`,
      `}`,
    ].join("\n");
    try {
      cursorSheet = new CSSStyleSheet();
      cursorSheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, cursorSheet];
      cursorFallback = null;
    } catch {
      // 老 WebKit 没有构造样式表:退回只给 <html> 设内联光标(后代规则压不过,
      // 但至少有笔形可用)。
      cursorSheet = null;
      cursorFallback = { highlight, note };
    }
  }

  function applyCursor(): void {
    const root = document.documentElement;
    if (cursorSheet) {
      root.classList.toggle("bnote-annotating", mode === "highlight");
      root.classList.toggle("bnote-annotating-note", mode === "note");
      return;
    }
    if (!cursorFallback) return;
    try {
      if (mode) {
        root.style.setProperty(
          "cursor",
          mode === "note" ? cursorFallback.note : cursorFallback.highlight,
          "important",
        );
      } else {
        root.style.removeProperty("cursor");
      }
    } catch {
      // 页面拒绝样式修改:光标不好看,但不影响批注。
    }
  }

  function setMode(value: unknown): void {
    const next: WebAnnotationKind | null =
      value === "note" ? "note" : value === true || value === "highlight" ? "highlight" : null;
    if (mode === next) return;
    mode = next;
    applyCursor();
    if (mode) {
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
      rebuild(); // 合并不回写 title,避免主窗口 ↔ 页面来回同步。
    }
  }

  function exportState(): { url: string; annotations: WebAnnotation[] } {
    return { url, annotations: items };
  }

  w.__bnoteAnno = {
    setMode,
    merge,
    export: exportState,
    refresh: rebuild,
    page: scrollPage,
    setStep: setPageStep,
    setKeys,
  };
  // Rust 的翻页命令只认这个入口：与批注开关解耦，普通阅读也能按步长翻页。
  (w as { __bnoteReader?: Record<string, unknown> }).__bnoteReader = {
    page: scrollPage,
    setStep: setPageStep,
    setKeys,
  };

  // ---- 启动 ----
  window.addEventListener("mouseup", onMouseUp, true);
  window.addEventListener("click", onClickCapture, true);
  window.addEventListener("keydown", onPageKey, true);
  window.addEventListener("scroll", onScroll, { passive: true });
  // 阅读位置:滚动停止后存比例;捕获阶段才能收到内层滚动容器的 scroll。
  window.addEventListener("scroll", scheduleSavePosition, { passive: true, capture: true });
  // 用户一动手就放弃「打开时的落点」,之后的布局变化不再抢滚动位置。
  window.addEventListener("wheel", freeScrolled, { passive: true, capture: true });
  window.addEventListener("touchstart", freeScrolled, { passive: true, capture: true });
  window.addEventListener("pointerdown", userTookOver, true);
  window.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      if (!/^(PageUp|PageDown|ArrowUp|ArrowDown|Home|End| )$/.test(event.key)) return;
      // 已经被翻页处理器接管的键(PageDown/自定义翻页键)不算自由滚动:
      // 它们自己会重新画分区。
      if (event.defaultPrevented) return;
      freeScrolled();
    },
    true,
  );
  window.addEventListener("resize", () => {
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
    // 正在输入的批注文字也要在离页前落盘(页面内 localStorage + 主窗口)。
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
    // 老 WebKit 没有 FontFaceSet
  }
}

/** 注入原生 webview 的完整脚本(运行时 + 它依赖的纯函数)。 */
export function buildWebAnnotationScript(): string {
  const helpers = [
    `locateQuote:${locateQuote.toString()}`,
    `mergeLineRects:${mergeLineRects.toString()}`,
    `normalizeWebAnnotations:${normalizeWebAnnotations.toString()}`,
    `normalizePageStep:${normalizePageStep.toString()}`,
    `snapScrollTopToLine:${snapScrollTopToLine.toString()}`,
    `cursorHighlight:${JSON.stringify(cursorHighlight)}`,
    `cursorNote:${JSON.stringify(cursorNote)}`,
  ].join(",");
  return `(${webAnnotationRuntime.toString()})({${helpers}});`;
}

/** 只算一次:主窗口每次打开网页都把它交给 Rust 注册成初始化脚本。 */
export const WEB_ANNOTATION_SCRIPT = buildWebAnnotationScript();
