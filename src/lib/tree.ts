import type { FileNode } from "@/lib/tauri";
import { ancestorDirs } from "@/lib/path";

/** Visible rows in display order (expanded folders traversed depth-first). */
export function flattenVisible(tree: FileNode[], expanded: Set<string>): FileNode[] {
  const out: FileNode[] = [];
  const walk = (nodes: FileNode[]) => {
    for (const n of nodes) {
      out.push(n);
      if (n.kind === "dir" && expanded.has(n.relPath) && n.children) walk(n.children);
    }
  };
  walk(tree);
  return out;
}

export function findNode(tree: FileNode[], relPath: string): FileNode | null {
  for (const n of tree) {
    if (n.relPath === relPath) return n;
    if (n.kind === "dir" && n.children) {
      const hit = findNode(n.children, relPath);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 把「relPath 这一行露出来」拆成可重复求值的施工计划——纯函数，只看树现在长
 * 什么样，不看异步过程，所以可以每次树变化都重算一遍而不怕重复。
 *
 * - `load`：已经进树、但子节点还没读的祖先目录，调用方去 loadDirChildren。
 * - `pending`：链上还有层没进树——树本身还没就绪（首帧、刚换库）。此时
 *   「树里没有这一行」不构成「条目不存在」的证据，不能据此放弃露出请求。
 *
 * 父层没进树时子层必然也找不到，所以一次遍历就够：父层读完后重算这一层
 * 自然会出现，收敛由树的更新驱动。
 */
export function chainLoadPlan(
  tree: FileNode[],
  relPath: string,
): { load: string[]; pending: boolean } {
  const load: string[] = [];
  let pending = false;
  for (const dir of ancestorDirs(relPath)) {
    const node = findNode(tree, dir);
    if (!node) {
      pending = true;
      continue;
    }
    if (node.kind === "dir" && node.children === null) load.push(dir);
  }
  return { load, pending };
}
