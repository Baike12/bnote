import { WidgetType } from "@codemirror/view";
import { todayStamp } from "@/editor/ops";
import { renderBlockHtml } from "./render";
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

// ---------------------------------------------------------------- widget

const ARROW_OPEN = "▾";
const ARROW_CLOSED = "▸";

export class FootprintWidget extends WidgetType {
  constructor(
    /** 足迹归属日:今日日记显示「今日足迹」,历史日记显示该日期。 */
    readonly day: string,
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
    const title = this.day === todayStamp() ? "今日足迹" : `${this.day} 足迹`;
    head.textContent = `${this.foldSnapshot.zoneCollapsed ? ARROW_CLOSED : ARROW_OPEN} ${title} · ${this.viewData.fileCount} 个文件 · ${this.viewData.blockCount} 段`;
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
