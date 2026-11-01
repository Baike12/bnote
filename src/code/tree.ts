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
    const slash = entry.path.lastIndexOf("/");
    const parentPath = slash < 0 ? "" : entry.path.slice(0, slash);
    const parent = dirOf(parentPath);
    parent.children.push({
      name: entry.name,
      path: entry.path,
      isDir: entry.isDir,
      size: entry.size,
      children: [],
      git: entry.isDir ? undefined : git?.get(entry.path),
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
