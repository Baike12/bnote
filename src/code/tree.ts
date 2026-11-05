import type { CodeEntry, GitFileState } from "./types";

/**
 * File tree: fold the backend's flat entry list into a directory tree.
 *
 * The backend scans the disk once and returns a "relative path → entry" list;
 * the tree shape is folded on the frontend, so expanding a directory never
 * touches the disk again (the study mode middle column is narrow, and
 * round-tripping to disk would stutter).
 */

export interface TreeNode {
  name: string;
  /** Path relative to the project root (a directory node carries its own path). */
  path: string;
  isDir: boolean;
  size: number;
  children: TreeNode[];
  /** The git status of this file (files only). */
  git?: GitFileState;
}

/** Directories first, then files; within a group by name (natural order: digits compare numerically). */
export function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return naturalCompare(a.name, b.name);
}

/** Natural order comparison: `file10` sorts after `file9` (lexicographic order reverses that). */
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
 * Fold the flat entries into a tree.
 *
 * Directory nodes may be missing from the entries (the backend scans with
 * gitignore, so empty directories never show up), so the missing intermediate
 * directories are **synthesized from the path**: given `a/b/c.rs`, both `a`
 * and `a/b` must exist on the tree or `c.rs` has nowhere to go.
 *
 * **One path, one node**: a directory node can come from an entry (the
 * backend scanned that directory) or be synthesized from a path. Both must
 * land in the same node — creating one each would show the same directory
 * twice on the tree (once empty, once with files) and the empty one would
 * still open empty.
 */
export function buildTree(entries: CodeEntry[], git?: Map<string, GitFileState>): TreeNode[] {
  const root: TreeNode = {
    name: "",
    path: "",
    isDir: true,
    size: 0,
    children: [],
  };
  const dirs = new Map<string, TreeNode>([["", root]]);

  /** Get (or create) the node of a directory. */
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
      // The directory entry *is* that directory's node on the tree: register it
      // as the canonical node instead of pushing a duplicate.
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

/** Sort recursively (directories first). */
export function sortTree(node: TreeNode): void {
  node.children.sort(compareNodes);
  for (const child of node.children) {
    if (child.isDir) sortTree(child);
  }
}

/** Walk the tree depth-first, yielding file nodes in display order. */
export function walkFiles(node: TreeNode, out: TreeNode[] = []): TreeNode[] {
  for (const child of node.children) {
    if (child.isDir) walkFiles(child, out);
    else out.push(child);
  }
  return out;
}

/** One row of the file tree (a flattened visible row). */
export interface VisibleRow {
  node: TreeNode;
  /** Indent level (0 for the root). */
  depth: number;
}

/**
 * Flatten the tree into the rows that are currently visible, for virtual
 * scrolling.
 *
 * The file tree is the only list that grows with the size of the repository
 * (node_modules is kept out by gitignore, but a decent repository still holds
 * 10k-20k files). Rendering all of them as DOM costs hundreds of milliseconds
 * to seconds up front and keeps ten thousand nodes alive while scrolling;
 * flattened into rows, only the few dozen rows near the viewport reach the
 * DOM.
 *
 * `expanded` is the **set of expanded directory paths**: a directory outside
 * it contributes only its own row, its children stay out of the list — an
 * empty set by default means top level only (no folder is expanded by
 * default). Returns a new array and leaves the tree untouched.
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
 * All ancestor directories of a path (excluding itself; a top-level item gets
 * an empty array).
 *
 * Used to "expose" a file: focusing the file tree has to expand every
 * directory on the way to it, otherwise the virtual-scroll row array does not
 * even contain that row.
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
 * Quick open: fuzzy-search the already scanned entries by **file name**.
 *
 * The search runs against the local index and skips IPC: opening the project
 * already scanned the whole file tree, so making Rust walk the repository
 * again on every keystroke (gitignore rules, one stat per directory) is pure
 * waste for the same result. Only a truncated file tree (`truncated`) leaves
 * the index incomplete; in that case the caller falls back to a backend scan.
 *
 * Ranking: exact match > prefix > substring > subsequence; ties break by
 * path in lexicographic order.
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
    const rank =
      name === q
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
  hits.sort(
    (a, b) =>
      a.rank - b.rank || (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0),
  );
  return hits.slice(0, limit).map((hit) => hit.entry);
}

/** Whether `abc` is a subsequence of `a_b_c` (same matching as the backend `code_search_files`). */
function isSubsequence(text: string, query: string): boolean {
  let i = 0;
  for (let k = 0; k < text.length && i < query.length; k++) {
    if (text[k] === query[i]) i++;
  }
  return i === query.length;
}

/**
 * Filter the tree by name (used by quick open).
 *
 * A directory is kept as soon as it **has** a matching descendant; files
 * match by a fuzzy name test. Returns a new tree and leaves the original
 * untouched.
 */
export function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
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
