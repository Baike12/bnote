import type { CodeEntry, GitFileState } from "./types";

/**
 * 文件树:把后端拍平的条目列表折成目录树。
 *
 * 后端只扫一遍磁盘、给一份「相对路径 → 条目」的列表;树形在前端折出来,
 * 展开目录不再碰磁盘(学习模式的中栏就那么宽,来回读盘会卡)。
 */

/** 树上的一个节点。 */
export interface TreeNode {
  name: string;
  /** 项目根相对路径(目录节点是它自己的路径)。 */
  path: string;
  isDir: boolean;
  size: number;
  children: TreeNode[];
  /** 该文件在 git 里的状态(只有文件有)。 */
  git?: GitFileState;
}

/** 目录在前、文件在后,同类按名字排(自然序:数字按数值比)。 */
export function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return naturalCompare(a.name, b.name);
}

/** 自然序比较:`file10` 排在 `file9` 后面(字典序会反过来)。 */
export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const ax = a.match(re) ?? [];
  const bx = b.match(re) ?? [];
  const n = Math.min(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const x = ax[i];
    const y = bx[i];
    const xn = /^\d/.test(x);
    const yn = /^\d/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

/**
 * 把拍平的条目折成树。
 *
 * 条目里的目录节点可能缺失(后端按 gitignore 扫,空目录不会出现在结果里),
 * 所以这里**按路径补出中间目录**:只要有 `a/b/c.rs`,`a` 与 `a/b` 就必须
 * 在树上,否则 `c.rs` 无处安放。
 *
 * **一个路径只有一个节点**:目录节点既可能来自条目(后端扫到了这个目录),
 * 也可能是按路径补出来的。两者必须落进同一个节点——各建一个的话,同一个
 * 目录会在树上出现两次(一次空的,一次带文件),而且点开还是空的。
 */
export function buildTree(
  entries: CodeEntry[],
  git?: Map<string, GitFileState>,
): TreeNode[] {
  const root: TreeNode = {
    name: "",
    path: "",
    isDir: true,
    size: 0,
    children: [],
  };
  const dirs = new Map<string, TreeNode>([["", root]]);

  /** 取(或造)某个目录节点。 */
  function dirOf(path: string): TreeNode {
    const hit = dirs.get(path);
    if (hit) return hit;
    const slash = path.lastIndexOf("/");
    const parentPath = slash < 0 ? "" : path.slice(0, slash);
    const name = slash < 0 ? path : path.slice(slash + 1);
    const parent = dirOf(parentPath);
    const node: TreeNode = {
      name,
      path,
      isDir: true,
      size: 0,
      children: [],
    };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  }

  for (const entry of entries) {
    if (entry.isDir) {
      // 目录条目就是树上那个目录节点本身:登记成规范节点即可,不再额外
      // push 一个副本。
      dirOf(entry.path);
      continue;
    }
    const slash = entry.path.lastIndexOf("/");
    const parentPath = slash < 0 ? "" : entry.path.slice(0, slash);
    const parent = dirOf(parentPath);
    parent.children.push({
      name: entry.name,
      path: entry.path,
      isDir: false,
      size: entry.size,
      children: [],
      git: git?.get(entry.path),
    });
  }

  sortTree(root);
  return root.children;
}

/** 递归排序(目录在前)。 */
export function sortTree(node: TreeNode): void {
  node.children.sort(compareNodes);
  for (const child of node.children) {
    if (child.isDir) sortTree(child);
  }
}

/** 深度优先遍历树,按展示顺序产出文件节点。 */
export function walkFiles(node: TreeNode, out: TreeNode[] = []): TreeNode[] {
  for (const child of node.children) {
    if (child.isDir) walkFiles(child, out);
    else out.push(child);
  }
  return out;
}

/** 文件树里的一行(拍平后的可视行)。 */
export interface VisibleRow {
  node: TreeNode;
  /** 缩进层级(根为 0)。 */
  depth: number;
}

/**
 * 把树拍成「当前看得见的行」,给虚拟滚动用。
 *
 * 文件树是唯一会随仓库规模膨胀的列表(node_modules 被 gitignore 挡掉,但
 * 一个像样的仓库也有 1–2 万个文件)。全量渲染成 DOM 是几百毫秒到几秒的
 * 一次性开销,滚起来还要一直养着上万个节点;拍平成行之后只有视口附近那
 * 几十行真的进 DOM。
 *
 * `expanded` 是**展开的目录路径集合**:不在里面的目录只留自己一行,子节点
 * 不进列表——默认空集 = 只显示顶层(不默认展开所有文件夹)。返回新数组,
 * 不改树。
 */
export function visibleRows(
  roots: readonly TreeNode[],
  expanded: ReadonlySet<string>,
): VisibleRow[] {
  const out: VisibleRow[] = [];
  const walk = (nodes: readonly TreeNode[], depth: number): void => {
    for (const node of nodes) {
      out.push({ node, depth });
      if (node.isDir && expanded.has(node.path)) walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

/**
 * 一个路径的所有祖先目录(不含自身,顶层项给空数组)。
 *
 * 用来把某个文件「露出来」:聚焦文件树时要把它所在的每一层目录都展开,
 * 否则虚拟滚动的行数组里根本没有这一行。
 */
export function ancestorDirs(path: string): string[] {
  const out: string[] = [];
  let slash = path.indexOf("/");
  while (slash > 0) {
    out.push(path.slice(0, slash));
    slash = path.indexOf("/", slash + 1);
  }
  return out;
}

/**
 * 快速打开:在已扫出的条目里按**文件名**模糊搜。
 *
 * 在本地索引里搜,不走 IPC:打开项目时后端已经把文件树扫全了,每敲一个键
 * 都让 Rust 重走一遍仓库(gitignore 规则、每个目录一次 stat)纯属浪费,
 * 结果还是同一份。只有文件树被截断(`truncated`)时索引才不完整,那种情况
 * 由调用方回退到后端补扫。
 *
 * 排序:完全相等 > 前缀 > 包含 > 子序列;同档按路径字典序。
 */
export function searchFilesByName(
  entries: readonly CodeEntry[],
  query: string,
  limit = 50,
): CodeEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: { entry: CodeEntry; rank: number }[] = [];
  for (const entry of entries) {
    if (entry.isDir) continue;
    const name = entry.name.toLowerCase();
    const rank = name === q
      ? 0
      : name.startsWith(q)
        ? 1
        : name.includes(q)
          ? 2
          : isSubsequence(name, q)
            ? 3
            : -1;
    if (rank < 0) continue;
    hits.push({ entry, rank });
  }
  hits.sort((a, b) => a.rank - b.rank || (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0));
  return hits.slice(0, limit).map((hit) => hit.entry);
}

/** `abc` 是不是 `a_b_c` 的子序列(与后端 code_search_files 同一套匹配)。 */
function isSubsequence(text: string, query: string): boolean {
  let i = 0;
  for (let k = 0; k < text.length && i < query.length; k++) {
    if (text[k] === query[i]) i++;
  }
  return i === query.length;
}

/**
 * 按名字过滤树(快速打开文件用)。
 *
 * 目录只要**有**命中的后代就保留;文件按名字模糊匹配。返回一棵新树,
 * 不改原树。
 */
export function filterTree(
  nodes: TreeNode[],
  query: string,
): TreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const out: TreeNode[] = [];
  for (const node of nodes) {
    if (node.isDir) {
      const children = filterTree(node.children, query);
      if (children.length > 0) out.push({ ...node, children });
    } else if (node.name.toLowerCase().includes(q)) {
      out.push(node);
    }
  }
  return out;
}
