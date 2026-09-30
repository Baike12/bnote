import { WidgetType } from "@codemirror/view";
import { renderMathHtml } from "@/editor/widgets";
import { defaultFold, foldSig, toggleGroup, toggleZone, type FoldState, type FootprintView } from "./view";

/**
 * 日记末尾的「今日足迹」块级 widget。数据是不可变的视图快照(FootprintView
 * + 折叠签名),索引或折叠变化时 extension 换新实例,DOM 整体重画——足迹区
 * 是低频更新的聚合视图,不做增量。
 *
 * 折叠是会话内的 UI 状态(模块级持有,不持久化):区级一个开关、每组一个,
 * 默认全部展开。交互协议在 DOM 上用 data-footprint-* 标记,点击由 extension
 * 的全局 mousedown handler 路由(与 livePreview 的 data-math-from 同一套)。
 */

/** 会话内的折叠状态(所有编辑器实例共享同一份足迹)。 */
let fold: FoldState = defaultFold();

export function currentFold(): FoldState {
  return fold;
}

export function foldSignature(): string {
  return foldSig(fold);
}

export function flipZoneFold(): void {
  fold = toggleZone(fold);
}

export function flipGroupFold(path: string): void {
  fold = toggleGroup(fold, path);
}

export function resetFoldForTest(): void {
  fold = defaultFold();
}

// ---------------------------------------------------------------- 轻渲染

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const INLINE_SPAN_RE = /(\$[^$\n]+$)|(`[^`\n]+`)/g;

/** 行内轻渲染:`$…$` 出公式、`` `…` `` 出行内码,其余转义原样。 */
function inlineHtml(line: string): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(INLINE_SPAN_RE)) {
    const at = m.index ?? 0;
    out += escapeHtml(line.slice(last, at));
    if (m[1] !== undefined) {
      out += renderMathHtml(m[1].slice(1, -1), false);
    } else {
      out += `<code>${escapeHtml(m[2].slice(1, -1))}</code>`;
    }
    last = at + m[0].length;
  }
  out += escapeHtml(line.slice(last));
  return out;
}

/** 块体:逐行渲染,`$$` 围栏内出块级公式。列表缩进靠 CSS pre-wrap 保真。 */
function renderBlockHtml(text: string): string {
  const lines = text.split("\n");
  let html = "";
  let inMath = false;
  let mathBuf: string[] = [];
  const flushMath = () => {
    html += `<div class="footprint-math">${renderMathHtml(mathBuf.join("\n"), true)}</div>`;
    mathBuf = [];
  };
  for (const line of lines) {
    const t = line.trim();
    if (inMath) {
      if (t === "$$") {
        inMath = false;
        flushMath();
      } else {
        mathBuf.push(line);
      }
      continue;
    }
    if (t === "$$") {
      inMath = true;
      continue;
    }
    html += `<div class="footprint-line">${inlineHtml(line)}</div>`;
  }
  if (inMath && mathBuf.length > 0) flushMath(); // 未闭合围栏:照常渲染已有内容
  return html;
}

// ---------------------------------------------------------------- widget

const ARROW_OPEN = "▾";
const ARROW_CLOSED = "▸";

export class FootprintWidget extends WidgetType {
  constructor(
    readonly viewData: FootprintView,
    readonly foldSnapshot: FoldState,
  ) {
    super();
  }

  eq(other: FootprintWidget): boolean {
    return (
      other.foldSnapshot.zoneCollapsed === this.foldSnapshot.zoneCollapsed &&
      other.viewData === this.viewData &&
      other.foldSigStr === this.foldSigStr
    );
  }

  /** eq 里用的签名(构造后缓存,避免每次比较重算集合序列化)。 */
  get foldSigStr(): string {
    return foldSig(this.foldSnapshot);
  }

  toDOM(): HTMLElement {
    const zone = document.createElement("div");
    zone.className = "footprint-zone";

    const head = document.createElement("div");
    head.className = "footprint-zone-head";
    head.dataset.footprintAction = "toggle-zone";
    head.textContent = `${this.foldSnapshot.zoneCollapsed ? ARROW_CLOSED : ARROW_OPEN} 今日足迹 · ${this.viewData.fileCount} 个文件 · ${this.viewData.blockCount} 段`;
    zone.appendChild(head);

    if (this.foldSnapshot.zoneCollapsed) return zone;

    for (const group of this.viewData.groups) {
      const groupEl = document.createElement("div");
      groupEl.className = "footprint-group";
      const collapsed = this.foldSnapshot.groups.has(group.path);

      const groupHead = document.createElement("div");
      groupHead.className = "footprint-group-head";
      groupHead.dataset.footprintAction = "toggle-group";
      groupHead.dataset.footprintPath = group.path;
      const arrow = document.createElement("span");
      arrow.textContent = collapsed ? ARROW_CLOSED : ARROW_OPEN;
      const title = document.createElement("span");
      title.className = "footprint-group-title";
      title.dataset.footprintAction = "open-group";
      title.dataset.footprintPath = group.path;
      title.textContent = `《${group.label}》`;
      const count = document.createElement("span");
      count.className = "footprint-group-count";
      count.textContent = ` · ${group.blocks.length} 段`;
      groupHead.append(arrow, title, count);
      groupEl.appendChild(groupHead);

      if (!collapsed) {
        for (const block of group.blocks) {
          const body = document.createElement("div");
          body.className = "footprint-block";
          body.dataset.footprintAction = "open-block";
          body.dataset.footprintPath = group.path;
          body.dataset.footprintLine = String(block.start);
          body.innerHTML = renderBlockHtml(block.text);
          groupEl.appendChild(body);
        }
      }
      zone.appendChild(groupEl);
    }
    return zone;
  }

  ignoreEvent(): boolean {
    return false; // 事件冒泡给 CM,点击路由在 extension 的 mousedown handler
  }
}
