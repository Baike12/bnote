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
 * Turns "reveal this relPath" into a repeatable work plan — a pure function
 * that only looks at the shape the tree has right now, never at the async
 * progress, so it can be recomputed on every tree change without duplicating
 * work.
 *
 * - `load`: ancestor directories that are in the tree but whose children have
 *   not been read yet; the caller hands them to loadDirChildren.
 * - `pending`: some level of the chain is not in the tree yet — the tree itself
 *   is not ready (first frame, vault just switched). "This row is not in the
 *   tree" is then no evidence that the entry does not exist, so the reveal
 *   request must not be dropped.
 *
 * A missing parent level implies its children are missing too, so one
 * traversal is enough: once the parent has been read, recomputing this level
 * picks it up naturally, and convergence is driven by the tree updates.
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
