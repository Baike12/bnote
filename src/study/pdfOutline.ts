/**
 * Pure helpers for the PDF outline (bookmarks) sidebar.
 *
 * pdf.js returns a recursive tree of `{ title, items, dest }`; resolving a
 * `dest` to a page index is async, so the viewer converts the tree to these
 * plain nodes once on load and everything after that (filtering, expanding,
 * jumping) is synchronous.
 */

export interface PdfOutlineNode {
  title: string;
  /** 1-based page number; null when the destination could not be resolved. */
  page: number | null;
  items: PdfOutlineNode[];
}

/** Keeps matching nodes and their ancestors; drops everything else.
 *  An empty/blank query returns the tree unchanged (same reference). */
export function filterOutline(nodes: PdfOutlineNode[], query: string): PdfOutlineNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const visit = (node: PdfOutlineNode): PdfOutlineNode | null => {
    const items = node.items.map(visit).filter((n): n is PdfOutlineNode => n !== null);
    const hit = node.title.toLowerCase().includes(q);
    if (!hit && items.length === 0) return null;
    // A matching parent keeps only matching descendants — a query should not
    // dump the whole subtree just because the chapter title matched.
    return { ...node, items };
  };
  return nodes.map(visit).filter((n): n is PdfOutlineNode => n !== null);
}

/** All page numbers present in the outline, for navigation display. */
export function outlinePages(nodes: PdfOutlineNode[]): number[] {
  const out: number[] = [];
  const visit = (node: PdfOutlineNode) => {
    if (node.page !== null) out.push(node.page);
    node.items.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

/** Page of the outline entry that contains `page`, or null when none does. */
export function outlinePageFor(nodes: PdfOutlineNode[], page: number): number | null {
  let best: number | null = null;
  for (const candidate of outlinePages(nodes)) {
    if (candidate <= page && (best === null || candidate > best)) best = candidate;
  }
  return best;
}
