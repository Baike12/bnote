import { sourceLabel } from "@/daily/marks";
import type { FootprintBlock } from "./model";

/**
 * 今日足迹区的纯视图模型:把索引条目组装成「区 → 组(源文件) → 块」的渲染
 * 数据,外加折叠状态的纯数据运算。无 DOM,view.test.ts 锁死组序、计数与
 * 折叠切换;widget.ts 只负责把这份不可变数据画出来。
 */

export interface FootprintEntry {
  path: string;
  blocks: FootprintBlock[];
}

export interface FootprintGroupView {
  /** 源文件绝对路径(点击跳转用)。 */
  path: string;
  /** 源笔记名(去目录与 .md),组头显示。 */
  label: string;
  blocks: FootprintBlock[];
}

export interface FootprintView {
  groups: FootprintGroupView[];
  fileCount: number;
  blockCount: number;
}

export function buildFootprintView(entries: FootprintEntry[]): FootprintView {
  const groups: FootprintGroupView[] = entries.map((e) => ({
    path: e.path,
    label: sourceLabel(e.path),
    blocks: e.blocks,
  }));
  return {
    groups,
    fileCount: groups.length,
    blockCount: groups.reduce((n, g) => n + g.blocks.length, 0),
  };
}

// ---------------------------------------------------------------- 折叠状态

/** 折叠是会话内的 UI 状态:不持久化——每次打开日记默认全部展开。 */
export interface FoldState {
  /** 整个足迹区收起(只剩区头)。 */
  zoneCollapsed: boolean;
  /** 收起的组(源文件绝对路径)。 */
  groups: ReadonlySet<string>;
}

export function defaultFold(): FoldState {
  return { zoneCollapsed: false, groups: new Set() };
}

export function toggleZone(state: FoldState): FoldState {
  return { ...state, zoneCollapsed: !state.zoneCollapsed };
}

export function toggleGroup(state: FoldState, path: string): FoldState {
  const groups = new Set(state.groups);
  if (groups.has(path)) groups.delete(path);
  else groups.add(path);
  return { ...state, groups };
}

/** 折叠状态的签名:widget eq 与 zone 重建判据用它比对。 */
export function foldSig(state: FoldState): string {
  return state.zoneCollapsed
    ? "z"
    : `Z${[...state.groups].sort().join(";")}`;
}
